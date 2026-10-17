import re
from secrets import token_urlsafe
from uuid import UUID, uuid4

import pytest
from sqlalchemy import func, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from api.models import ConversationMessage, Event, OutgoingMessage, Report, Task
from scripts.migrate import MIGRATIONS
from tests.backend.conftest import INTERNAL, auth, bind, report
from tests.backend.test_backend import drain


def test_report_identity_without_coordinates_and_retry(client, png):
    token = "wg_r_" + token_urlsafe(32)
    data = {
        "client_report_id": str(uuid4()),
        "title": "Overflowing bin",
        "address": "Illustrative park gate, Gulshan-e-Iqbal",
    }

    def submit():
        return client.post(
            "/reports",
            data=data,
            headers={"X-Report-Token": token},
            files={"photo": ("photo.png", png, "image/png")},
        )

    first = submit()
    assert first.status_code == 201, first.text
    value = first.json()["report"]
    assert value["location"] is None
    assert value["address"] == data["address"]
    assert value["title"] == data["title"]
    assert re.fullmatch(r"WG-[0-9A-F]{12}", value["public_reference"])
    assert submit().json() == first.json()
    for key in ("title", "address"):
        original = data[key]
        data[key] = "Changed value"
        assert submit().status_code == 409
        data[key] = original
    assert client.post("/reports", data=data).status_code == 422


def test_reference_lookup_authorization_and_organizer_views(client, png):
    created = report(client, png, title="Park litter", address="Park gate")
    value, token = created["report"], created["access_token"]
    path = "/reports/by-reference/" + value["public_reference"].lower()
    assert client.get(path).status_code == 401
    assert client.get(path, headers=auth("wg_r_wrong")).status_code == 404
    assert client.get(path, headers=auth("a")).status_code == 404
    assert client.get(path, headers=auth(token)).json() == value
    assert client.get(path, headers=auth("org")).json() == value
    other = report(client, png)
    assert client.get(path, headers=auth(other["access_token"])).status_code == 404
    listing = client.get("/organizer/reports", headers=auth("org")).json()
    assert any(r["public_reference"] == value["public_reference"] for r in listing)
    detail = client.get("/organizer/reports/" + value["id"], headers=auth("org"))
    assert detail.json()["report"] == value
    assert token not in detail.text


def test_reference_is_unique_and_immutable_in_database(client, png, engine):
    first, second = report(client, png), report(client, png)
    with Session(engine) as db:
        original = db.get(Report, UUID(first["report"]["id"]))
        with pytest.raises(IntegrityError):
            with db.begin_nested():
                db.add(
                    Report(
                        token_hash="0" * 64,
                        photo_id=original.photo_id,
                        public_reference=original.public_reference,
                    )
                )
                db.flush()
        with pytest.raises(Exception, match="immutable"):
            with db.begin_nested():
                db.execute(
                    text(
                        "update wastegrid.reports set public_reference=:ref where id=:id"
                    ),
                    {"ref": second["report"]["public_reference"], "id": original.id},
                )
        assert (
            db.scalar(select(Report.public_reference).where(Report.id == original.id))
            == first["report"]["public_reference"]
        )


def test_identity_migration_upgrades_existing_reports(engine):
    # Roll back the entire legacy-schema simulation, restoring the test schema.
    with engine.connect() as conn:
        transaction = conn.begin()
        try:
            conn.exec_driver_sql("drop schema wastegrid cascade")
            for path in sorted(MIGRATIONS.glob("000[1-3]_*.sql")):
                conn.connection.driver_connection.execute(path.read_text())
            rid, pid = uuid4(), uuid4()
            conn.execute(
                text(
                    "insert into wastegrid.reports(id, token_hash, photo_id, note) values (:id, :token, :photo, 'Original report')"
                ),
                {"id": rid, "token": "0" * 64, "photo": pid},
            )
            conn.execute(
                text(
                    "insert into wastegrid.photos(id, object_path, content_type, size_bytes, report_id) values (:id, 'legacy/photo', 'image/png', 10, :report)"
                ),
                {"id": pid, "report": rid},
            )
            conn.connection.driver_connection.execute(
                (MIGRATIONS / "0004_report_identity.sql").read_text()
            )
            row = conn.execute(
                text(
                    "select public_reference, title, address, location, note from wastegrid.reports"
                )
            ).one()
            assert re.fullmatch(r"WG-[0-9A-F]{12}", row.public_reference)
            assert row.title == "Legacy report"
            assert row.address is None and row.location is None
            assert row.note == "Original report"
            conn.execute(
                text(
                    "insert into wastegrid.events(id, report_id, kind) values (:id, :report, 'report.received')"
                ),
                {"id": uuid4(), "report": rid},
            )
            conn.connection.driver_connection.execute(
                (MIGRATIONS / "0005_event_status_snapshots.sql").read_text()
            )
            snapshot = conn.execute(
                text("select report_state, job_status from wastegrid.events")
            ).one()
            assert snapshot.report_state is None and snapshot.job_status is None
            conn.connection.driver_connection.execute(
                (MIGRATIONS / "0006_conversation_history.sql").read_text()
            )
            assert (
                conn.scalar(
                    text("select count(*) from wastegrid.conversation_messages")
                )
                == 0
            )
            assert conn.scalar(
                text(
                    "select relrowsecurity from pg_class where oid='wastegrid.conversation_messages'::regclass"
                )
            )
            assert conn.scalar(text("select count(*) from wastegrid.reports")) == 1
        finally:
            transaction.rollback()


def test_update_history_pagination_and_private_details(client, png, engine):
    created = report(client, png)
    convo = bind(client, created)
    rid = created["report"]["id"]
    headers = auth(created["access_token"])
    command = {
        "command_id": str(uuid4()),
        "expected_version": 1,
        "note": "PRIVATE-RAW-NOTE",
    }
    path = "/internal/conversations/" + convo["id"] + "/clarification"
    assert client.post(path, headers=INTERNAL, json=command).status_code == 200
    assert client.post(path, headers=INTERNAL, json=command).status_code == 200
    path = f"/reports/{rid}/updates"
    page = client.get(path, headers=headers).json()
    assert page["total"] == 2
    assert [v["kind"] for v in page["items"]] == ["report.received", "report.clarified"]
    assert all(v["status"] == "submitted" for v in page["items"])
    assert "PRIVATE-RAW-NOTE" not in str(page)
    assert "actor" not in str(page) and "details" not in str(page)
    second = client.get(path + "?limit=1&offset=1", headers=headers).json()
    assert second == {"items": [page["items"][1]], "total": 2, "limit": 1, "offset": 1}
    assert client.get(path + "?offset=100", headers=headers).json()["items"] == []
    assert client.get(path + "?limit=101", headers=headers).status_code == 422
    assert client.get(path).status_code == 401
    assert client.get(path, headers=auth("wg_r_wrong")).status_code == 404
    current = client.get("/reports/" + rid, headers=headers).json()
    assert current["latest_update"] == page["items"][-1]
    assert current["updated_at"] == page["items"][-1]["created_at"]
    # Legacy events keep their real timestamp/text but never infer a past status.
    with Session(engine) as db:
        record = db.get(Event, UUID(page["items"][0]["id"]))
        record.report_state = None
        db.commit()
    legacy = client.get(path, headers=headers).json()["items"][0]
    assert legacy["status"] is None and legacy["report_state"] is None


def test_update_history_keeps_completion_snapshot_after_recheck(
    client, png, engine, seeded
):
    created = report(client, png)
    convo = bind(client, created)
    drain(client, engine)
    job = client.get("/jobs", headers=auth("org")).json()[0]
    owner = "a" if job["assigned_crew_id"] == str(seeded["crew_a"]) else "b"
    started = client.patch(
        "/jobs/" + job["id"],
        headers=auth(owner),
        json={
            "command_id": str(uuid4()),
            "expected_version": job["version"],
            "status": "in_progress",
        },
    )
    assert started.status_code == 200
    command = {
        "command_id": str(uuid4()),
        "expected_version": started.json()["version"],
        "note": "PRIVATE-COMPLETION-NOTE",
    }
    done_url = "/jobs/" + job["id"] + "/completion"
    for _ in range(2):
        done = client.post(
            done_url,
            headers=auth(owner),
            data=command,
            files={"photo": ("after.png", png, "image/png")},
        )
        assert done.status_code == 200
    url = "/reports/" + created["report"]["id"]
    headers = auth(created["access_token"])
    completed_view = client.get(url, headers=headers).json()
    assert completed_view["dashboard_status"] == "resolved"
    assert completed_view["latest_update"]["job_status"] == "completed"
    recheck = client.post(
        "/internal/conversations/" + convo["id"] + "/recheck",
        headers=INTERNAL,
        json={
            "command_id": str(uuid4()),
            "expected_version": done.json()["version"],
            "reason": "PRIVATE-RECHECK-REASON",
        },
    )
    assert recheck.status_code == 200
    page = client.get(url + "/updates", headers=headers)
    assert "PRIVATE-" not in page.text
    items = page.json()["items"]
    completed = [item for item in items if item["kind"] == "job.completed"]
    assert completed == [completed_view["latest_update"]]
    assert items[-1]["job_status"] == "recheck_requested"
    assert items[-1]["status"] == "submitted"
    assert any(
        item["job_status"] == "assigned" and item["status"] == "in-progress"
        for item in items
    )
    assert client.get(url + "/updates", headers=auth(owner)).status_code == 200
    other = "b" if owner == "a" else "a"
    assert client.get(url + "/updates", headers=auth(other)).status_code == 404


def test_inbound_history_is_idempotent_private_and_paginated(
    client, png, engine, seeded
):
    created = report(client, png)
    convo = bind(client, created, external="private-photon-space")
    path = "/internal/conversations/" + convo["id"] + "/followup"
    body = {"message_id": "private-provider-id", "text": "What is the status?"}
    first = client.post(path, headers=INTERNAL, json=body)
    assert first.status_code == 202
    assert (
        client.post(path, headers=INTERNAL, json=body).json()["id"]
        == first.json()["id"]
    )
    assert (
        client.post(
            path, headers=INTERNAL, json={**body, "text": "Different text"}
        ).status_code
        == 409
    )
    assert (
        client.post(
            path,
            headers=INTERNAL,
            json={"message_id": "second", "text": "A second question"},
        ).status_code
        == 202
    )
    history = "/reports/" + created["report"]["id"] + "/messages"
    headers = auth(created["access_token"])
    page = client.get(history, headers=headers)
    assert page.json()["total"] == 2
    assert [m["body"] for m in page.json()["items"]] == [
        body["text"],
        "A second question",
    ]
    assert all(
        set(m) == {"id", "created_at", "direction", "body"}
        for m in page.json()["items"]
    )
    assert (
        "private-photon-space" not in page.text
        and "private-provider-id" not in page.text
    )
    second = client.get(history + "?limit=1&offset=1", headers=headers).json()
    assert second["items"] == page.json()["items"][1:]
    assert client.get(history + "?offset=-1", headers=headers).status_code == 422
    assert client.get(history + "?limit=101", headers=headers).status_code == 422
    assert client.get(history).status_code == 401
    assert client.get(history, headers=auth("org")).json() == page.json()
    other = report(client, png)
    assert client.get(history, headers=auth(other["access_token"])).status_code == 404
    drain(client, engine)
    # Even the crew assigned to this report must not see conversation transcripts.
    for crew_token in ("a", "b"):
        assert client.get(history, headers=auth(crew_token)).status_code == 403
    assert (
        client.get(history, headers=headers).json()["total"] == 2
    )  # Replies still queued.
    with Session(engine) as db:
        assert (
            db.scalar(
                select(func.count()).select_from(Task).where(Task.kind == "followup")
            )
            == 2
        )
        with pytest.raises(Exception, match="cannot be edited"):
            with db.begin_nested():
                db.execute(
                    text("update wastegrid.conversation_messages set body='tampered'")
                )


def test_outbound_history_requires_success_and_exact_ack_retries(client, png, engine):
    from datetime import timedelta

    from api.models import now

    created = report(client, png)
    bind(client, created)
    drain(client, engine)
    row = client.post(
        "/internal/outgoing-messages/claim", headers=INTERNAL, json={"limit": 1}
    ).json()[0]
    base = "/internal/outgoing-messages/" + row["id"]
    history = "/reports/" + created["report"]["id"] + "/messages"
    headers = auth(created["access_token"])
    assert client.get(history, headers=headers).json()["total"] == 0
    assert (
        client.post(
            base + "/failed",
            headers=INTERNAL,
            json={"lease_id": row["lease_id"], "retry_after_seconds": 1},
        ).status_code
        == 200
    )
    assert client.get(history, headers=headers).json()["total"] == 0
    with Session(engine) as db:
        db.get(OutgoingMessage, UUID(row["id"])).next_attempt_at = now() - timedelta(
            seconds=2
        )
        db.commit()
    reclaimed = client.post(
        "/internal/outgoing-messages/claim", headers=INTERNAL, json={"limit": 100}
    ).json()
    retry = next(item for item in reclaimed if item["id"] == row["id"])
    body = {
        "lease_id": retry["lease_id"],
        "sent_text": "Your cleanup has been assigned.",
        "provider_message_id": "private-send-id",
    }
    assert (
        client.post(
            base + "/delivered",
            headers=INTERNAL,
            json={**body, "lease_id": row["lease_id"]},
        ).status_code
        == 409
    )
    assert (
        client.post(
            base + "/delivered", headers=INTERNAL, json={"lease_id": retry["lease_id"]}
        ).status_code
        == 422
    )
    for _ in range(2):
        assert (
            client.post(base + "/delivered", headers=INTERNAL, json=body).status_code
            == 200
        )
    for key in ("sent_text", "provider_message_id"):
        assert (
            client.post(
                base + "/delivered", headers=INTERNAL, json={**body, key: "changed"}
            ).status_code
            == 409
        )
    page = client.get(history, headers=headers)
    assert page.json()["total"] == 1
    message = page.json()["items"][0]
    assert message["direction"] == "outbound" and message["body"] == body["sent_text"]
    assert "private-send-id" not in page.text


def test_history_and_task_or_ack_commit_atomically(client, png, engine, monkeypatch):
    created = report(client, png)
    convo = bind(client, created)

    def fail_commit(db):
        db.flush()
        raise RuntimeError("simulated transaction interruption")

    with monkeypatch.context() as patch:
        patch.setattr(Session, "commit", fail_commit)
        with pytest.raises(RuntimeError, match="simulated transaction"):
            client.post(
                "/internal/conversations/" + convo["id"] + "/followup",
                headers=INTERNAL,
                json={"message_id": "interrupted", "text": "Status?"},
            )
    with Session(engine) as db:
        assert db.scalar(select(func.count()).select_from(ConversationMessage)) == 0
        assert (
            db.scalar(
                select(func.count()).select_from(Task).where(Task.kind == "followup")
            )
            == 0
        )
    drain(client, engine)
    row = client.post(
        "/internal/outgoing-messages/claim", headers=INTERNAL, json={"limit": 1}
    ).json()[0]
    with monkeypatch.context() as patch:
        patch.setattr(Session, "commit", fail_commit)
        with pytest.raises(RuntimeError, match="simulated transaction"):
            client.post(
                "/internal/outgoing-messages/" + row["id"] + "/delivered",
                headers=INTERNAL,
                json={"lease_id": row["lease_id"], "sent_text": "Sent update"},
            )
    with Session(engine) as db:
        assert db.scalar(select(func.count()).select_from(ConversationMessage)) == 0
        assert db.get(OutgoingMessage, UUID(row["id"])).delivered_at is None


def test_demo_reset_clears_demo_conversation_history(engine, client):
    from api.models import Conversation
    from scripts.seed_demo import seed

    seed(engine, client.app.state.cloud)
    with Session(engine) as db:
        rid = db.scalar(select(Report.id))
        conversation = Conversation(
            report_id=rid, channel="imessage", external_id="illustrative-history"
        )
        db.add(conversation)
        db.flush()
        db.add(
            ConversationMessage(
                conversation_id=conversation.id,
                direction="inbound",
                body="Illustrative question",
                provider_message_id="illustrative-inbound",
            )
        )
        db.commit()
    assert seed(engine, client.app.state.cloud, reset=True)["status"] == "seeded"
    with Session(engine) as db:
        assert db.scalar(select(func.count()).select_from(ConversationMessage)) == 0
        assert db.scalar(select(func.count()).select_from(Report)) == 10
