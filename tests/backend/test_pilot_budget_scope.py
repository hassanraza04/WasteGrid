"""A caller-supplied run UUID cannot create a fresh allowance for a used scope."""

import json
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from uuid import uuid4

import pytest
from fastapi import HTTPException
from sqlalchemy import func, select, text
from sqlalchemy.exc import DBAPIError, IntegrityError
from sqlalchemy.orm import Session

from api import pilot as pilot_module
from api.config import Settings
from api.db import mutation_lock
from api.models import MessagingPilot
from api.pilot import configured_scope, ensure_run
from scripts.migrate import MIGRATIONS
from tests.backend import test_pilot_migration

legacy_database = test_pilot_migration.legacy_database


@pytest.fixture
def settings():
    return Settings(
        _env_file=None,
        messaging_pilot_enabled=True,
        messaging_pilot_id=uuid4(),
        messaging_pilot_report_ids=[uuid4(), uuid4()],
        messaging_pilot_chat_ids=["private-a"],
        photon_project_id="scope-project",
        photon_agent_sender_id="scope-agent",
        messaging_imessage_recipient="resident@example.test",
        organizer_routing_enabled=True,
    )


def test_replacement_run_id_cannot_reset_persisted_budget_after_restart(
    engine, settings
):
    original_id = settings.messaging_pilot_id
    with Session(engine) as db:
        mutation_lock(db)
        run = ensure_run(db, settings)
        run.image_calls, run.followup_calls, run.send_attempts = 2, 12, 30
        db.commit()

    # A replacement process has a fresh Settings object and database session.
    replacement = settings.model_copy(deep=True)
    replacement.messaging_pilot_id = uuid4()
    replacement.messaging_pilot_report_ids.reverse()
    replacement.messaging_pilot_chat_ids.reverse()
    with Session(engine) as db:
        mutation_lock(db)
        with pytest.raises(HTTPException) as rejected:
            ensure_run(db, replacement)
        assert rejected.value.status_code == 409
        db.rollback()

    with Session(engine) as db:
        mutation_lock(db)
        restarted = ensure_run(db, settings.model_copy(deep=True))
        assert restarted.id == original_id
        assert (
            restarted.image_calls,
            restarted.followup_calls,
            restarted.send_attempts,
        ) == (
            2,
            12,
            30,
        )
        assert db.get(MessagingPilot, replacement.messaging_pilot_id) is None
        assert db.scalar(select(func.count()).select_from(MessagingPilot)) == 1


def insert_run(conn, settings, *, identity=None, reports=None, chats=None):
    conn.execute(
        text(
            "INSERT INTO wastegrid.messaging_pilots"
            "(id,project_id,sender_id,report_ids,chat_ids,image_calls,followup_calls,send_attempts) "
            "VALUES(:id,:project,:sender,CAST(:reports AS json),CAST(:chats AS json),2,7,9)"
        ),
        {
            "id": identity or settings.messaging_pilot_id,
            "project": settings.photon_project_id,
            "sender": settings.photon_agent_sender_id,
            "reports": json.dumps(
                reports
                if reports is not None
                else [str(value) for value in settings.messaging_pilot_report_ids]
            ),
            "chats": json.dumps(
                chats if chats is not None else settings.messaging_pilot_chat_ids
            ),
        },
    )


def test_database_rejects_replacement_uuid_with_reordered_duplicate_allowlists(
    engine, settings
):
    with engine.begin() as conn:
        insert_run(conn, settings)
        reports = [
            str(value).upper()
            for value in reversed(settings.messaging_pilot_report_ids)
        ]
        with pytest.raises(IntegrityError) as duplicate:
            with conn.begin_nested():
                insert_run(
                    conn,
                    settings,
                    identity=uuid4(),
                    reports=reports + reports,
                    chats=settings.messaging_pilot_chat_ids * 2,
                )
        assert duplicate.value.orig.diag.constraint_name == "messaging_pilots_scope_key"


@pytest.mark.parametrize(
    "statement",
    [
        "UPDATE wastegrid.messaging_pilots SET id=:replacement",
        "UPDATE wastegrid.messaging_pilots SET project_id='other-project'",
        "UPDATE wastegrid.messaging_pilots SET sender_id='other-sender'",
        "UPDATE wastegrid.messaging_pilots SET report_ids='[]'",
        "UPDATE wastegrid.messaging_pilots SET chat_ids='[]'",
        "UPDATE wastegrid.messaging_pilots SET image_calls=0",
        "UPDATE wastegrid.messaging_pilots SET followup_calls=0",
        "UPDATE wastegrid.messaging_pilots SET send_attempts=0",
        "DELETE FROM wastegrid.messaging_pilots",
    ],
)
def test_database_preserves_pilot_scope_and_budget_history(engine, settings, statement):
    with engine.begin() as conn:
        insert_run(conn, settings)
        with pytest.raises(DBAPIError):
            with conn.begin_nested():
                conn.execute(text(statement), {"replacement": uuid4()})
        assert conn.execute(
            text(
                "SELECT image_calls,followup_calls,send_attempts FROM wastegrid.messaging_pilots"
            )
        ).one() == (2, 7, 9)


def test_concurrent_first_runs_cannot_allocate_two_budgets(
    engine, settings, monkeypatch
):
    # Deliberately omit the MVP advisory lock to exercise the unique DB constraint.
    barrier = Barrier(2)
    original_match = pilot_module.matching_run

    def simultaneous_match(db, config):
        result = original_match(db, config)
        barrier.wait(timeout=10)
        return result

    monkeypatch.setattr(pilot_module, "matching_run", simultaneous_match)

    def start(identity):
        config = settings.model_copy(update={"messaging_pilot_id": identity}, deep=True)
        with Session(engine) as db:
            try:
                run = ensure_run(db, config)
                db.commit()
                return run.id
            except HTTPException as rejected:
                assert rejected.status_code == 409
                db.rollback()
                return None

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(start, [settings.messaging_pilot_id, uuid4()]))
    assert sum(identity is not None for identity in results) == 1
    with Session(engine) as db:
        assert db.scalar(select(func.count()).select_from(MessagingPilot)) == 1


def test_scope_budget_migration_preserves_prior_usage(legacy_database, settings):
    with legacy_database.begin() as conn:
        conn.connection.driver_connection.execute(
            (MIGRATIONS / "0013_messaging_pilot.sql").read_text()
        )
        insert_run(conn, settings)
    with legacy_database.begin() as conn:
        conn.connection.driver_connection.execute(
            (MIGRATIONS / "0014_messaging_pilot_scope_budget.sql").read_text()
        )
        assert conn.execute(
            text(
                "SELECT image_calls,followup_calls,send_attempts,scope_key FROM wastegrid.messaging_pilots"
            )
        ).one() == (2, 7, 9, configured_scope(settings))
        with pytest.raises(IntegrityError):
            with conn.begin_nested():
                insert_run(conn, settings, identity=uuid4())
    with Session(legacy_database) as db:
        run = ensure_run(db, settings)
        assert (run.image_calls, run.followup_calls, run.send_attempts) == (2, 7, 9)
