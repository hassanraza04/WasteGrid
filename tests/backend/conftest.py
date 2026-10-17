"""Disposable real PostgreSQL; fake only external Supabase Auth/Storage calls."""

import os
from io import BytesIO
from uuid import uuid4

import psycopg
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from PIL import Image
from psycopg import sql
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session

from api.config import Settings
from api.main import create_app
from api.models import Crew, StaffRole
from scripts.migrate import migrate


@pytest.fixture(scope="session")
def engine():
    value = os.getenv("TEST_DATABASE_URL")
    if not value:
        pytest.skip("Set TEST_DATABASE_URL to a disposable localhost PostgreSQL server")
    url = make_url(value)
    if url.host not in ("127.0.0.1", "localhost"):
        raise RuntimeError("Backend tests require a localhost disposable database")
    database = "wastegrid_" + uuid4().hex + "_test"
    admin = str(url.set(drivername="postgresql").render_as_string(hide_password=False))
    with psycopg.connect(admin, autocommit=True) as connection:
        connection.execute(
            sql.SQL("CREATE DATABASE {}").format(sql.Identifier(database))
        )
        for role in ("anon", "authenticated"):
            if not connection.execute(
                "select 1 from pg_roles where rolname=%s", (role,)
            ).fetchone():
                connection.execute(
                    sql.SQL("CREATE ROLE {} NOLOGIN").format(sql.Identifier(role))
                )
    test_url = url.set(drivername="postgresql+psycopg", database=database)
    eng = create_engine(test_url, pool_pre_ping=True, hide_parameters=True)
    try:
        with eng.begin() as conn:
            conn.exec_driver_sql("CREATE SCHEMA auth")
            conn.exec_driver_sql("CREATE TABLE auth.users(id uuid PRIMARY KEY)")
            conn.exec_driver_sql("CREATE SCHEMA storage")
            conn.exec_driver_sql(
                "CREATE TABLE storage.buckets(id text PRIMARY KEY, name text, public boolean, file_size_limit bigint, allowed_mime_types text[])"
            )
        migrate(eng)
        yield eng
    finally:
        eng.dispose()
        with psycopg.connect(admin, autocommit=True) as connection:
            connection.execute(
                sql.SQL("DROP DATABASE {} WITH (FORCE)").format(
                    sql.Identifier(database)
                )
            )


@pytest.fixture(autouse=True)
def reset_backend(request):
    if "engine" not in request.fixturenames:
        return
    eng = request.getfixturevalue("engine")
    with eng.begin() as conn:
        tables = (
            conn.execute(
                text(
                    "select tablename from pg_tables where schemaname='wastegrid' and tablename <> 'schema_migrations'"
                )
            )
            .scalars()
            .all()
        )
        conn.exec_driver_sql(
            "TRUNCATE " + ", ".join("wastegrid." + t for t in tables) + " CASCADE"
        )
        conn.exec_driver_sql("TRUNCATE auth.users CASCADE")


class FakeCloud:
    def __init__(self, users):
        self.users, self.uploads = users, {}
        self.fail_upload = False

    def user_id(self, token):
        if token not in self.users:
            raise HTTPException(401, "Invalid session")
        return self.users[token]

    def upload(self, path, content, mime):
        if self.fail_upload:
            raise HTTPException(503, "Storage unavailable")
        self.uploads[path] = content

    def delete(self, path):
        self.uploads.pop(path, None)

    def signed_url(self, path):
        return "https://test.invalid/signed/" + path

    def close(self):
        pass


@pytest.fixture
def seeded(engine):
    ids = {
        k: uuid4()
        for k in ("organizer", "crew_a", "crew_b", "a_user", "b_user", "outsider")
    }
    with engine.begin() as c:
        for key in ("organizer", "a_user", "b_user", "outsider"):
            c.execute(text("insert into auth.users(id) values (:id)"), {"id": ids[key]})
    with Session(engine) as db:
        db.add_all(
            [
                Crew(
                    id=ids["crew_a"],
                    name="Illustrative Crew A",
                    equipment=["gloves", "trash_bags", "broom", "shovel"],
                    shift_minutes=120,
                    start_location={"latitude": 24.92, "longitude": 67.09},
                    illustrative=True,
                ),
                Crew(
                    id=ids["crew_b"],
                    name="Illustrative Crew B",
                    equipment=[
                        "gloves",
                        "trash_bags",
                        "shovel",
                        "wheelbarrow",
                        "pickup_truck",
                    ],
                    shift_minutes=180,
                    start_location={"latitude": 24.93, "longitude": 67.10},
                    illustrative=True,
                ),
            ]
        )
        db.flush()
        db.add_all(
            [
                StaffRole(user_id=ids["organizer"], role="organizer"),
                StaffRole(user_id=ids["a_user"], role="crew", crew_id=ids["crew_a"]),
                StaffRole(user_id=ids["b_user"], role="crew", crew_id=ids["crew_b"]),
            ]
        )
        db.commit()
    return ids


@pytest.fixture
def client(engine, seeded):
    app = create_app(
        Settings(
            _env_file=None,
            duplicate_radius_meters=0,  # Legacy fixtures intentionally reuse a location.
            supabase_url="https://test.supabase.co",
            supabase_secret_key="fake-key",
            messaging_api_key="message-test-key",
            agent_api_key="agent-test-key",
        )
    )
    app.state.engine = engine
    app.state.cloud.close()
    app.state.cloud = FakeCloud(
        {
            "org": seeded["organizer"],
            "a": seeded["a_user"],
            "b": seeded["b_user"],
            "outsider": seeded["outsider"],
        }
    )
    with TestClient(app) as value:
        yield value


@pytest.fixture
def png():
    buffer = BytesIO()
    Image.new("RGB", (8, 8), color="green").save(buffer, format="PNG")
    return buffer.getvalue()


def auth(token):
    return {"Authorization": "Bearer " + token}


def report(client, png, note="Routine litter", **data):
    result = client.post(
        "/reports",
        files={"photo": ("test.png", png, "image/png")},
        data={"latitude": 24.92, "longitude": 67.09, "note": note, **data},
    )
    assert result.status_code == 201, result.text
    return result.json()


INTERNAL = {"X-Integration-Key": "message-test-key"}


def bind(client, created, external="chat-1"):
    rid = created["report"]["id"]
    link = client.post(
        f"/reports/{rid}/followup-link", headers=auth(created["access_token"])
    )
    assert link.status_code == 201, link.text
    result = client.post(
        "/internal/conversations/bind",
        headers=INTERNAL,
        json={
            "link_code": link.json()["link_code"],
            "channel": "imessage",
            "external_id": external,
            "opted_in": True,
        },
    )
    assert result.status_code == 200, result.text
    return result.json()
