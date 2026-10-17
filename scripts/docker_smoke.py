"""Exercise the built Docker image over HTTP against disposable local Postgres.

Supabase Auth/Storage are explicit local HTTP doubles, not a live cloud claim.
"""

import argparse
import json
import os
import subprocess
import time
from pathlib import Path
from uuid import uuid4


def inside():
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    from io import BytesIO
    from threading import Thread

    import httpx
    from PIL import Image
    from sqlalchemy import text
    from sqlalchemy.orm import Session

    from api.config import Settings
    from api.db import make_engine
    from api.models import StaffRole

    uid = uuid4()
    engine = make_engine(Settings())
    with engine.begin() as conn:
        conn.execute(text("insert into auth.users(id) values (:id)"), {"id": uid})
    with Session(engine) as db:
        db.add(StaffRole(user_id=uid, role="organizer"))
        db.commit()

    class Cloud(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def response(self, status, value):
            data = json.dumps(value).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if (
                self.path == "/auth/v1/user"
                and self.headers.get("Authorization") == "Bearer smoke-organizer"
            ):
                self.response(200, {"id": str(uid)})
            else:
                self.response(401, {})

        def do_POST(self):
            self.rfile.read(int(self.headers.get("Content-Length", "0")))
            if self.path.startswith("/storage/v1/object/sign/"):
                self.response(
                    200,
                    {
                        "signedURL": self.path.removeprefix("/storage/v1")
                        + "?token=smoke-only"
                    },
                )
            else:
                self.response(200, {})

        def do_DELETE(self):
            self.response(200, {})

    server = ThreadingHTTPServer(("127.0.0.1", 18081), Cloud)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    client = httpx.Client(base_url="http://127.0.0.1:" + os.environ["PORT"], timeout=20)
    try:
        for _ in range(30):
            try:
                if client.get("/health").status_code == 200:
                    break
            except httpx.ConnectError:
                pass
            time.sleep(0.5)
        assert client.get("/ready").status_code == 200
        buffer = BytesIO()
        Image.new("RGB", (8, 8)).save(buffer, format="PNG")
        response = client.post(
            "/reports",
            data={
                "note": "Docker smoke report",
                "latitude": 24.92,
                "longitude": 67.09,
                "title": "Illustrative overflowing bin",
                "address": "Illustrative park gate, Gulshan-e-Iqbal",
            },
            files={"photo": ("smoke.png", buffer.getvalue(), "image/png")},
        )
        assert response.status_code == 201, response.text
        created = response.json()
        rid = created["report"]["id"]
        pid = created["report"]["photo_id"]
        resident = {"Authorization": "Bearer " + created["access_token"]}
        reference = created["report"]["public_reference"]
        assert created["report"]["location"] == {
            "latitude": 24.92,
            "longitude": 67.09,
            "landmark": None,
        }
        assert created["report"]["address"] == "Illustrative park gate, Gulshan-e-Iqbal"
        assert client.get("/reports/by-reference/" + reference).status_code == 401
        assert (
            client.get(
                "/reports/by-reference/" + reference.lower(), headers=resident
            ).json()["id"]
            == rid
        )
        assert client.get("/reports/" + rid).status_code == 401
        assert client.get("/reports/" + rid, headers=resident).status_code == 200
        assert (
            client.get("/photos/" + pid + "/access", headers=resident).status_code
            == 200
        )
        org = {"Authorization": "Bearer smoke-organizer"}
        assert client.get("/auth/me", headers=org).json()["role"] == "organizer"
        listing = client.get("/organizer/reports", headers=org)
        assert (
            listing.status_code == 200 and created["access_token"] not in listing.text
        )
        assert client.get("/tasks", headers=org).json()[0]["status"] == "pending"
        updates = client.get(f"/reports/{rid}/updates", headers=resident)
        assert updates.json()["items"][0]["status"] == "submitted"
        assert (
            client.get(f"/organizer/reports/{rid}", headers=org).json()["report"][
                "public_reference"
            ]
            == reference
        )
        integration = {"X-Integration-Key": "smoke-messaging-only"}
        link = client.post(f"/reports/{rid}/followup-link", headers=resident).json()
        bound = client.post(
            "/internal/conversations/bind",
            headers=integration,
            json={
                "link_code": link["link_code"],
                "channel": "imessage",
                "external_id": "smoke-conversation",
                "opted_in": True,
            },
        )
        assert bound.status_code == 200, bound.text
        conversation = bound.json()["id"]
        inbound = {"message_id": "smoke-inbound", "text": "What is the status?"}
        tasks = [
            client.post(
                f"/internal/conversations/{conversation}/followup",
                headers=integration,
                json=inbound,
            )
            for _ in range(2)
        ]
        assert all(t.status_code == 202 for t in tasks)
        assert tasks[0].json()["id"] == tasks[1].json()["id"]
        clarified = client.post(
            f"/internal/conversations/{conversation}/clarification",
            headers=integration,
            json={
                "command_id": str(uuid4()),
                "expected_version": 1,
                "note": "Near the gate",
            },
        )
        assert clarified.status_code == 200, clarified.text
        outgoing = client.post(
            "/internal/outgoing-messages/claim", headers=integration, json={"limit": 1}
        ).json()[0]
        ack = client.post(
            "/internal/outgoing-messages/" + outgoing["id"] + "/delivered",
            headers=integration,
            json={
                "lease_id": outgoing["lease_id"],
                "sent_text": "Additional information received.",
            },
        )
        assert ack.status_code == 200, ack.text
        history = client.get(f"/reports/{rid}/messages", headers=resident).json()
        assert history["total"] == 2
        assert [m["direction"] for m in history["items"]] == ["inbound", "outbound"]
        print(
            json.dumps(
                {
                    "docker_http_smoke": "passed",
                    "port": os.environ["PORT"],
                    "checks": [
                        "ready",
                        "report persistence",
                        "resident authorization",
                        "private photo signing",
                        "Supabase Auth HTTP verification",
                        "organizer token isolation",
                        "durable task enqueue",
                        "title/address and authorized reference lookup",
                        "customer update history",
                        "idempotent inbound message history",
                        "acknowledged outbound history",
                    ],
                }
            )
        )
    finally:
        client.close()
        server.shutdown()
        server.server_close()
        engine.dispose()


def host(image, postgres_container):
    import psycopg
    from psycopg import sql
    from sqlalchemy import create_engine
    from sqlalchemy.engine import make_url

    from scripts.migrate import migrate

    url = make_url(os.environ["TEST_DATABASE_URL"])
    if url.host not in ("127.0.0.1", "localhost"):
        raise SystemExit("Smoke tests require a disposable localhost database")
    database = "wastegrid_docker_" + uuid4().hex + "_test"
    name = "wastegrid-smoke-" + uuid4().hex[:8]
    admin = url.set(drivername="postgresql").render_as_string(hide_password=False)
    with psycopg.connect(admin, autocommit=True) as conn:
        conn.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(database)))
    engine = create_engine(url.set(drivername="postgresql+psycopg", database=database))
    try:
        with engine.begin() as conn:
            conn.exec_driver_sql("CREATE SCHEMA auth")
            conn.exec_driver_sql("CREATE TABLE auth.users(id uuid PRIMARY KEY)")
            conn.exec_driver_sql("CREATE SCHEMA storage")
            conn.exec_driver_sql(
                "CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[])"
            )
        migrate(engine)
        internal_url = url.set(
            drivername="postgresql+psycopg",
            host="127.0.0.1",
            port=5432,
            database=database,
        ).render_as_string(hide_password=False)
        subprocess.run(
            [
                "docker",
                "run",
                "--detach",
                "--rm",
                "--name",
                name,
                "--network",
                "container:" + postgres_container,
                "-e",
                "DATABASE_URL=" + internal_url,
                "-e",
                "SUPABASE_URL=http://127.0.0.1:18081",
                "-e",
                "SUPABASE_SECRET_KEY=sb_secret_smoke_only",
                "-e",
                "MESSAGING_API_KEY=smoke-messaging-only",
                "-e",
                "PORT=18765",
                image,
            ],
            check=True,
            capture_output=True,
        )
        result = subprocess.run(
            ["docker", "exec", "-i", name, "python", "-", "--inside"],
            input=Path(__file__).read_text(),
            text=True,
            capture_output=True,
        )
        print(result.stdout)
        if result.returncode:
            print(result.stderr)
            raise SystemExit("Docker HTTP smoke failed")
    finally:
        subprocess.run(["docker", "rm", "-f", name], capture_output=True)
        engine.dispose()
        with psycopg.connect(admin, autocommit=True) as conn:
            conn.execute(
                sql.SQL("DROP DATABASE {} WITH (FORCE)").format(
                    sql.Identifier(database)
                )
            )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--inside", action="store_true")
    parser.add_argument("--image", default="wastegrid-api:verify")
    parser.add_argument("--postgres-container", default="wastegrid-backend-test")
    args = parser.parse_args()
    if args.inside:
        inside()
    else:
        host(args.image, args.postgres_container)


if __name__ == "__main__":
    main()
