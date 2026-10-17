"""Upgrade populated pre-pilot PostgreSQL without losing private history."""

from uuid import uuid4

import psycopg
import pytest
from psycopg import sql
from sqlalchemy import create_engine, text
from sqlalchemy.exc import DBAPIError

from scripts.migrate import MIGRATIONS


@pytest.fixture
def legacy_database(engine):
    database = "wastegrid_pilot_upgrade_" + uuid4().hex + "_test"
    admin = engine.url.set(
        drivername="postgresql", database="postgres"
    ).render_as_string(hide_password=False)
    with psycopg.connect(admin, autocommit=True) as conn:
        conn.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(database)))
    legacy = create_engine(engine.url.set(database=database), hide_parameters=True)
    try:
        with legacy.begin() as conn:
            conn.exec_driver_sql("CREATE SCHEMA auth")
            conn.exec_driver_sql("CREATE TABLE auth.users(id uuid PRIMARY KEY)")
            conn.exec_driver_sql("CREATE SCHEMA storage")
            conn.exec_driver_sql(
                "CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,"
                "public boolean,file_size_limit bigint,allowed_mime_types text[])"
            )
            for path in sorted(MIGRATIONS.glob("*.sql")):
                if int(path.name[:4]) < 13:
                    conn.connection.driver_connection.execute(path.read_text())
        yield legacy
    finally:
        legacy.dispose()
        with psycopg.connect(admin, autocommit=True) as conn:
            conn.execute(
                sql.SQL("DROP DATABASE {} WITH (FORCE)").format(
                    sql.Identifier(database)
                )
            )


def seed_reports(conn):
    identities = []
    conn.exec_driver_sql("SET CONSTRAINTS ALL DEFERRED")
    for index in range(2):
        report_id, photo_id = uuid4(), uuid4()
        conn.execute(
            text(
                "INSERT INTO wastegrid.reports(id,token_hash,photo_id) VALUES(:id,:token,:photo)"
            ),
            {"id": report_id, "token": str(index) * 64, "photo": photo_id},
        )
        conn.execute(
            text(
                "INSERT INTO wastegrid.photos(id,object_path,content_type,size_bytes,report_id) "
                "VALUES(:id,:path,'image/png',42,:report)"
            ),
            {"id": photo_id, "path": str(photo_id), "report": report_id},
        )
        identities.append(report_id)
    return identities


def test_pilot_migration_upgrades_existing_links_and_preserves_history(legacy_database):
    old_link, old_message = uuid4(), uuid4()
    with legacy_database.begin() as conn:
        reports = seed_reports(conn)
        assert (
            conn.scalar(
                text(
                    "SELECT count(*) FROM pg_constraint "
                    "WHERE conrelid='wastegrid.conversation_messages'::regclass "
                    "AND conname='conversation_messages_check'"
                )
            )
            == 1
        )
        conn.execute(
            text(
                "INSERT INTO wastegrid.conversations(id,report_id,channel,external_id) "
                "VALUES(:id,:report,'imessage','legacy-space')"
            ),
            {"id": old_link, "report": reports[0]},
        )
        conn.execute(
            text(
                "INSERT INTO wastegrid.conversation_messages"
                "(id,conversation_id,direction,body,provider_message_id) "
                "VALUES(:id,:link,'inbound','Existing private question','provider-old')"
            ),
            {"id": old_message, "link": old_link},
        )
    with legacy_database.begin() as conn:
        conn.connection.driver_connection.execute(
            (MIGRATIONS / "0013_messaging_pilot.sql").read_text()
        )
        migrated = conn.execute(
            text("SELECT thread_id,active FROM wastegrid.conversations WHERE id=:id"),
            {"id": old_link},
        ).one()
        assert migrated == (old_link, True)
        thread = conn.execute(
            text(
                "SELECT pilot_id,project_id,sender_id FROM wastegrid.messaging_threads "
                "WHERE id=:id"
            ),
            {"id": old_link},
        ).one()
        assert thread == (
            None,
            "",
            "",
        )  # Existing links are not enrolled into the supervised pilot.
        assert (
            conn.scalar(
                text("SELECT body FROM wastegrid.conversation_messages WHERE id=:id"),
                {"id": old_message},
            )
            == "Existing private question"
        )
        conn.execute(
            text(
                "INSERT INTO wastegrid.conversations(id,report_id,channel,external_id,thread_id) "
                "VALUES(:id,:report,'imessage','legacy-space',:thread)"
            ),
            {"id": uuid4(), "report": reports[1], "thread": old_link},
        )
        assert (
            conn.scalar(
                text(
                    "SELECT count(*) FROM wastegrid.conversations WHERE thread_id=:id"
                ),
                {"id": old_link},
            )
            == 2
        )
        conn.execute(
            text(
                "INSERT INTO wastegrid.tasks(id,kind,dedupe_key,payload) "
                "VALUES(:id,'pilot_followup','pilot:test','{}')"
            ),
            {"id": uuid4()},
        )
        with pytest.raises(DBAPIError):
            with conn.begin_nested():
                conn.execute(
                    text(
                        "UPDATE wastegrid.conversation_messages SET body='changed' WHERE id=:id"
                    ),
                    {"id": old_message},
                )
        for role in ("anon", "authenticated"):
            for table in (
                "messaging_pilots",
                "messaging_threads",
                "messaging_inbound",
                "messaging_outgoing",
            ):
                assert not conn.scalar(
                    text("SELECT has_table_privilege(:role,:table,'SELECT')"),
                    {"role": role, "table": "wastegrid." + table},
                )
                assert conn.scalar(
                    text(
                        "SELECT relrowsecurity FROM pg_class "
                        "WHERE oid=CAST(:table AS regclass)"
                    ),
                    {"table": "wastegrid." + table},
                )


def test_pilot_envelope_freezes_consent_route_and_provider_identity(engine):
    thread, outgoing = uuid4(), uuid4()
    with engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO wastegrid.messaging_threads(id,channel,external_id) "
                "VALUES(:id,'imessage','private-space')"
            ),
            {"id": thread},
        )
        conn.execute(
            text(
                "INSERT INTO wastegrid.messaging_outgoing"
                "(id,thread_id,kind,text,external_id,sender_id,consent_revision) "
                "VALUES(:id,:thread,'reply','Original','private-space','agent',1)"
            ),
            {"id": outgoing, "thread": thread},
        )
        for assignment in (
            "text='Changed'",
            "allow_paused=true",
            "external_id='other-space'",
            "sender_id='other-agent'",
            "consent_revision=2",
        ):
            with pytest.raises(DBAPIError):
                with conn.begin_nested():
                    conn.exec_driver_sql(
                        "UPDATE wastegrid.messaging_outgoing SET " + assignment
                    )
        conn.execute(
            text(
                "UPDATE wastegrid.messaging_outgoing SET provider_message_id='provider-1',"
                "status='submitted' WHERE id=:id"
            ),
            {"id": outgoing},
        )
        with pytest.raises(DBAPIError):
            with conn.begin_nested():
                conn.execute(
                    text(
                        "UPDATE wastegrid.messaging_outgoing SET provider_message_id='provider-2' "
                        "WHERE id=:id"
                    ),
                    {"id": outgoing},
                )
