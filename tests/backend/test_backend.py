from datetime import timedelta
from secrets import token_urlsafe
from uuid import UUID, uuid4

import pytest
from fastapi import HTTPException
from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from api.models import Event, OutgoingMessage, Photo, Plan, Report, Task, now
from api.schemas import TriageRecommendation
from api.worker import process_one
from api.workflows import apply_plan, apply_triage, build_planning_input
from scripts.migrate import migrate
from tests.backend.conftest import INTERNAL, auth, bind, report
from tests.backend.providers import TestProvider


def drain(client, engine, provider=None):
    provider = provider or TestProvider()
    for _ in range(50):
        if not process_one(engine, provider, client.app.state.cloud):
            break
    with Session(engine) as db:
        bad = db.scalars(select(Task).where(Task.status != "succeeded")).all()
        assert not bad, [(t.kind, t.status, t.last_error) for t in bad]


def test_migration_repeat_and_private_permissions(engine):
    migrate(engine)
    with engine.connect() as c:
        from scripts.migrate import MIGRATIONS

        assert c.scalar(
            text("select count(*) from wastegrid.schema_migrations")
        ) == len(list(MIGRATIONS.glob("*.sql")))
        assert (
            c.scalar(
                text("select public from storage.buckets where id='report-photos'")
            )
            is False
        )
    for role in ("anon", "authenticated"):
        with pytest.raises(Exception):
            with engine.begin() as c:
                c.exec_driver_sql("SET LOCAL ROLE " + role)
                c.execute(text("select * from wastegrid.staff_roles"))


def test_report_tokens_photos_and_auth(client, png):
    created = report(client, png)
    rid = created["report"]["id"]
    token = created["access_token"]
    pid = created["report"]["photo_id"]
    assert client.get("/health").status_code == 200
    assert client.get("/ready").status_code == 200
    assert client.get("/reports/" + rid).status_code == 401
    assert client.get("/reports/" + rid, headers=auth("wg_r_wrong")).status_code == 404
    assert client.get("/reports/" + rid, headers=auth(token)).status_code == 200
    assert (
        client.get("/photos/" + pid + "/access", headers=auth(token)).status_code == 200
    )
    assert (
        client.get("/photos/" + pid + "/access", headers=auth("wg_r_wrong")).status_code
        == 404
    )
    assert client.get("/organizer/reports", headers=auth("a")).status_code == 403
    assert client.get("/auth/me", headers=auth("outsider")).status_code == 403
    listing = client.get("/organizer/reports", headers=auth("org"))
    assert token not in listing.text and "token_hash" not in listing.text
    assert listing.headers["cache-control"] == "no-store"


def test_retry_safe_report_creation(client, png, engine):
    rid = str(uuid4())
    token = "wg_r_" + token_urlsafe(32)
    kwargs = {
        "headers": {"X-Report-Token": token},
        "data": {"client_report_id": rid, "note": "first"},
        "files": {"photo": ("image.png", png, "image/png")},
    }
    first = client.post("/reports", **kwargs)
    second = client.post("/reports", **kwargs)
    assert first.status_code == second.status_code == 201
    assert first.json() == second.json()
    kwargs["data"]["note"] = "changed"
    assert client.post("/reports", **kwargs).status_code == 409
    with Session(engine) as db:
        assert db.scalar(select(func.count()).select_from(Report)) == 1
        assert db.get(Report, UUID(rid)).token_hash != token
    assert len(client.app.state.cloud.uploads) == 1


def test_upload_failure_is_atomic(client, png, engine):
    client.app.state.cloud.fail_upload = True
    result = client.post("/reports", files={"photo": ("image.png", png, "image/png")})
    assert result.status_code == 503
    with Session(engine) as db:
        for model in (Report, Photo, Event, Task):
            assert db.scalar(select(func.count()).select_from(model)) == 0


@pytest.mark.parametrize(
    "content,mime,status",
    [(b"not a photo", "image/png", 415), (b"x" * 8388609, "image/png", 413)],
)
def test_invalid_uploads(client, content, mime, status):
    assert (
        client.post(
            "/reports", files={"photo": ("image.png", content, mime)}
        ).status_code
        == status
    )


def test_invalid_coordinates_and_token_errors_redacted(client, png):
    assert (
        client.post(
            "/reports",
            data={"latitude": 91, "longitude": 67},
            files={"photo": ("a.png", png, "image/png")},
        ).status_code
        == 422
    )
    result = client.post(
        "/reports",
        headers={"X-Report-Token": "secret-invalid-value"},
        files={"photo": ("a.png", png, "image/png")},
    )
    assert result.status_code == 422 and "secret-invalid-value" not in result.text


def test_clarification_preserves_history_and_replays(client, png, engine):
    created = report(client, png, note="Original evidence")
    convo = bind(client, created)
    resolved = client.post(
        "/internal/conversations/resolve",
        headers=INTERNAL,
        json={"channel": "imessage", "external_id": "chat-1"},
    )
    assert resolved.json()["id"] == convo["id"]
    body = {
        "command_id": str(uuid4()),
        "expected_version": 1,
        "note": "A useful new detail",
    }
    url = "/internal/conversations/" + convo["id"] + "/clarification"
    assert client.post(url, headers=INTERNAL, json=body).status_code == 200
    assert client.post(url, headers=INTERNAL, json=body).status_code == 200
    assert (
        client.post(
            url, headers=INTERNAL, json={**body, "note": "different"}
        ).status_code
        == 409
    )
    snapshot = client.get(
        "/internal/conversations/" + convo["id"] + "/snapshot", headers=INTERNAL
    )
    assert created["access_token"] not in snapshot.text
    assert snapshot.json()["report"]["note"] == "Original evidence"
    assert (
        snapshot.json()["report"]["clarifications"][0]["note"] == "A useful new detail"
    )
    with Session(engine) as db:
        assert (
            db.scalar(
                select(func.count())
                .select_from(Event)
                .where(Event.kind == "report.clarified")
            )
            == 1
        )


def test_end_to_end_report_plan_complete_followup(client, png, engine, seeded):
    created = report(client, png)
    convo = bind(client, created)
    drain(client, engine)
    snapshot = client.get(
        "/reports/" + created["report"]["id"], headers=auth(created["access_token"])
    ).json()
    jid = snapshot["job_id"]
    detail = client.get("/jobs/" + jid, headers=auth("org")).json()["job"]
    owner = "a" if detail["assigned_crew_id"] == str(seeded["crew_a"]) else "b"
    other = "b" if owner == "a" else "a"
    assert client.get("/jobs/" + jid, headers=auth(other)).status_code == 404
    assert (
        client.get(
            "/reports/" + created["report"]["id"], headers=auth(other)
        ).status_code
        == 404
    )
    start = {
        "command_id": str(uuid4()),
        "expected_version": detail["version"],
        "status": "in_progress",
    }
    started = client.patch("/jobs/" + jid, headers=auth(owner), json=start)
    assert started.status_code == 200, started.text
    assert (
        client.patch("/jobs/" + jid, headers=auth(owner), json=start).status_code == 200
    )
    done = {
        "command_id": str(uuid4()),
        "expected_version": started.json()["version"],
        "note": "Evidence supplied",
    }
    completed = client.post(
        "/jobs/" + jid + "/completion",
        headers=auth(owner),
        data=done,
        files={"photo": ("after.png", png, "image/png")},
    )
    assert completed.status_code == 200, completed.text
    assert (
        client.post(
            "/jobs/" + jid + "/completion",
            headers=auth(owner),
            data=done,
            files={"photo": ("after.png", png, "image/png")},
        ).status_code
        == 200
    )
    drain(client, engine)
    result = client.post(
        "/internal/conversations/" + convo["id"] + "/followup",
        headers=INTERNAL,
        json={"message_id": "photon-123", "text": "What is the status?"},
    )
    assert result.status_code == 202
    same = client.post(
        "/internal/conversations/" + convo["id"] + "/followup",
        headers=INTERNAL,
        json={"message_id": "photon-123", "text": "What is the status?"},
    )
    assert result.json()["id"] == same.json()["id"]
    drain(client, engine)
    outgoing = client.post(
        "/internal/outgoing-messages/claim", headers=INTERNAL, json={"limit": 100}
    ).json()
    assert any("completed" in r["payload"].get("reply_text", "") for r in outgoing)
    assert all(r["conversation"]["external_id"] == "chat-1" for r in outgoing)
    assert (
        client.post(
            "/internal/outgoing-messages/claim", headers=INTERNAL, json={}
        ).json()
        == []
    )
    first = outgoing[0]
    ack = "/internal/outgoing-messages/" + first["id"] + "/delivered"
    assert (
        client.post(
            ack,
            headers=INTERNAL,
            json={"lease_id": str(uuid4()), "sent_text": "Status update"},
        ).status_code
        == 409
    )
    assert (
        client.post(
            ack,
            headers=INTERNAL,
            json={"lease_id": first["lease_id"], "sent_text": "Status update"},
        ).status_code
        == 200
    )
    assert (
        client.post(
            ack,
            headers=INTERNAL,
            json={"lease_id": first["lease_id"], "sent_text": "Status update"},
        ).status_code
        == 200
    )
    recheck = {
        "command_id": str(uuid4()),
        "expected_version": completed.json()["version"],
        "reason": "Some waste remains",
    }
    assert (
        client.post(
            "/internal/conversations/" + convo["id"] + "/recheck",
            headers=INTERNAL,
            json=recheck,
        ).status_code
        == 200
    )
    assert (
        client.post(
            "/internal/conversations/" + convo["id"] + "/recheck",
            headers=INTERNAL,
            json=recheck,
        ).status_code
        == 200
    )
    audit = client.get(
        "/organizer/reports/" + created["report"]["id"], headers=auth("org")
    ).json()
    assert any(
        e["details"].get("reason") == "Some waste remains" for e in audit["events"]
    )
    assert audit["report"]["completion_photo_ids"]
    with Session(engine) as db:
        assert (
            db.scalar(
                select(func.count())
                .select_from(Event)
                .where(Event.kind == "job.completed")
            )
            == 1
        )


def test_removed_crew_cannot_start_and_replan_is_feasible(client, png, engine, seeded):
    report(client, png)
    drain(client, engine)
    job = client.get("/jobs", headers=auth("org")).json()[0]
    cid = job["assigned_crew_id"]
    owner = "a" if cid == str(seeded["crew_a"]) else "b"
    crew = next(
        c for c in client.get("/crews", headers=auth("org")).json() if c["id"] == cid
    )
    body = {
        "command_id": str(uuid4()),
        "expected_version": crew["version"],
        "available": False,
        "equipment": [],
        "shift_minutes": 1,
    }
    assert (
        client.patch("/crews/" + cid, headers=auth("org"), json=body).status_code == 200
    )
    assert (
        client.patch("/crews/" + cid, headers=auth("org"), json=body).status_code == 200
    )
    assert client.patch(
        "/jobs/" + job["id"],
        headers=auth(owner),
        json={
            "command_id": str(uuid4()),
            "expected_version": job["version"],
            "status": "in_progress",
        },
    ).status_code in (404, 409)
    drain(client, engine)
    new = client.get("/jobs", headers=auth("org")).json()[0]
    assert new["assigned_crew_id"] != cid
    assert new["status"] == "assigned"


def test_missing_information_and_hazard_do_not_create_jobs(client, png, engine):
    report(client, png, note="Suspected hazard")
    missing = client.post("/reports", files={"photo": ("a.png", png, "image/png")})
    assert missing.status_code == 201
    drain(client, engine)
    listing = client.get("/organizer/reports", headers=auth("org")).json()
    assert {r["state"] for r in listing} == {"needs_review", "needs_info"}
    assert client.get("/jobs", headers=auth("org")).json() == []


def test_invalid_and_stale_plans_are_atomic(client, png, engine):
    report(client, png)
    drain(client, engine)
    with Session(engine) as db:
        inputs = build_planning_input(db)
        proposal = TestProvider().generate_plan(inputs)
        proposal.assignments[0].service_minutes = 1
        with pytest.raises(HTTPException, match="service estimates"):
            apply_plan(db, proposal)
        db.rollback()
        proposal = TestProvider().generate_plan(build_planning_input(db))
        proposal.revision = "stale"
        with pytest.raises(HTTPException, match="inputs changed"):
            apply_plan(db, proposal)
        assert db.scalar(select(func.count()).select_from(Plan)) == 1


@pytest.mark.parametrize("http_unavailable", [False, True])
def test_worker_failures_are_durable_and_retryable(
    client, png, engine, http_unavailable
):
    report(client, png)

    class Broken(TestProvider):
        def triage_report(self, request):
            if http_unavailable:
                raise HTTPException(503, "sensitive-provider-secret")
            raise RuntimeError("sensitive-provider-secret")

    assert process_one(engine, Broken(), client.app.state.cloud)
    tasks = client.get("/tasks", headers=auth("org")).json()
    assert tasks[0]["last_error"] == "provider_unavailable"
    assert "sensitive-provider-secret" not in str(tasks)
    with Session(engine) as db:
        task = db.get(Task, UUID(tasks[0]["id"]))
        task.attempts = 4
        task.next_attempt_at = now() - timedelta(seconds=1)
        db.commit()
    process_one(engine, Broken(), client.app.state.cloud)
    assert (
        client.post(
            "/tasks/" + tasks[0]["id"] + "/retry", headers=auth("org")
        ).status_code
        == 200
    )
    drain(client, engine)


def test_contracts_expose_security_and_typed_delivery(client):
    spec = client.get("/openapi.json").json()
    assert {"ReportOrStaffBearer", "MessagingKey", "AgentKey"} <= spec["components"][
        "securitySchemes"
    ].keys()
    assert spec["paths"]["/internal/outgoing-messages/claim"]["post"]["responses"][
        "200"
    ]["content"]["application/json"]["schema"]["items"]
    assert (
        client.post(
            "/internal/conversations/resolve",
            json={"channel": "imessage", "external_id": "x"},
        ).status_code
        == 401
    )


def test_seed_reset_and_scenarios(engine, client):
    from scripts.seed_demo import seed

    result = seed(engine, client.app.state.cloud)
    assert result["reports"] == 10
    assert seed(engine, client.app.state.cloud)["status"] == "already_seeded"
    listing = client.get("/organizer/reports", headers=auth("org")).json()
    assert len(listing) == 10 and all(r["illustrative"] for r in listing)
    assert {"needs_info", "needs_review", "linked_to_job"} <= {
        r["state"] for r in listing
    }
    assert len({r["job_id"] for r in listing if r["job_id"]}) == 6
    jobs = client.get("/jobs", headers=auth("org")).json()
    assert any(j["unassigned_reason"] == "shift_limit" for j in jobs)
    assert seed(engine, client.app.state.cloud, reset=True)["status"] == "seeded"
    with Session(engine) as db:
        assert db.scalar(select(func.count()).select_from(Report)) == 10
    assert len(client.app.state.cloud.uploads) == 10


def test_locked_and_in_progress_assignments_are_preserved(client, png, engine):
    report(client, png)
    report(client, png, note="Second incident")
    drain(client, engine)
    jobs = client.get("/jobs", headers=auth("org")).json()
    first = jobs[0]
    locked = client.patch(
        "/jobs/" + first["id"],
        headers=auth("org"),
        json={
            "command_id": str(uuid4()),
            "expected_version": first["version"],
            "locked": True,
            "reason": "Keep this assignment for demo",
        },
    )
    assert locked.status_code == 200, locked.text
    drain(client, engine)
    with Session(engine) as db:
        inputs = build_planning_input(db)
        proposal = TestProvider().generate_plan(inputs)
        assert any(s.job_id == UUID(first["id"]) for s in inputs.fixed_assignments)
        fixed = next(s for s in proposal.assignments if s.job_id == UUID(first["id"]))
        fixed.position += 10
        with pytest.raises(HTTPException, match="locked assignments"):
            apply_plan(db, proposal)


def test_organizer_overrides_and_crew_restrictions(client, png, engine):
    report(client, png)
    drain(client, engine)
    job = client.get("/jobs", headers=auth("org")).json()[0]
    body = {
        "command_id": str(uuid4()),
        "expected_version": job["version"],
        "held": True,
        "reason": "Access blocked",
    }
    # Both crews are forbidden to apply organizer-only changes, even if assigned.
    statuses = [
        client.patch("/jobs/" + job["id"], headers=auth(owner), json=body).status_code
        for owner in ("a", "b")
    ]
    assert set(statuses) <= {403, 404}
    response = client.patch("/jobs/" + job["id"], headers=auth("org"), json=body)
    assert response.status_code == 200, response.text
    assert response.json()["held"] and response.json()["assigned_crew_id"] is None
    drain(client, engine)
    assert (
        client.get("/jobs/" + job["id"], headers=auth("org")).json()["job"][
            "unassigned_reason"
        ]
        == "held"
    )


def test_triage_safety_duplicate_and_stale_decision(client, png, engine):
    first = report(client, png)
    drain(client, engine)
    second = report(client, png, note="Second report")
    rid = UUID(second["report"]["id"])
    proposal = TriageRecommendation(
        command_id=uuid4(),
        expected_version=1,
        report_id=rid,
        category="litter",
        proposed_equipment=["gloves"],
        duplicate_candidate_id=UUID(first["report"]["id"]),
        duplicate_confirmed=False,
        evidence_sufficient=True,
        missing_information=[],
        decision_summary="Candidate is uncertain",
        evidence_report_ids=[UUID(first["report"]["id"])],
        next_action="link_job",
        estimated_service_minutes=10,
    )
    with Session(engine) as db:
        row = apply_triage(db, proposal)
        assert row.state == "needs_review" and row.job_id is None
        db.commit()
        stale = proposal.model_copy(update={"command_id": uuid4()})
        with pytest.raises(HTTPException, match="State changed"):
            apply_triage(db, stale)
        confirmed = proposal.model_copy(
            update={
                "command_id": uuid4(),
                "expected_version": 2,
                "duplicate_confirmed": True,
            }
        )
        row = apply_triage(db, confirmed)
        assert row.job_id == db.get(Report, UUID(first["report"]["id"])).job_id
        db.commit()


def test_followup_action_is_validated_and_persisted(client, png, engine):
    created = client.post(
        "/reports", files={"photo": ("a.png", png, "image/png")}
    ).json()
    convo = bind(client, created)
    drain(client, engine)

    class Clarifier(TestProvider):
        def handle_followup(self, request):
            from api.schemas import FollowupResult

            return FollowupResult(
                reply_text="Location saved for triage",
                action={
                    "kind": "clarification",
                    "data": {
                        "command_id": uuid4(),
                        "expected_version": request.snapshot.report.version,
                        "note": "Near the park gate",
                        "location": {"latitude": 24.92, "longitude": 67.09},
                    },
                },
            )

    result = client.post(
        "/internal/conversations/" + convo["id"] + "/followup",
        headers=INTERNAL,
        json={"message_id": "location-reply", "text": "Near park gate at the pin"},
    )
    assert result.status_code == 202
    drain(client, engine, Clarifier())
    current = client.get(
        "/reports/" + created["report"]["id"], headers=auth(created["access_token"])
    ).json()
    assert current["state"] == "linked_to_job"
    assert current["clarifications"][0]["note"] == "Near the park gate"


def test_outbox_retry_and_expired_lease_recovery(client, png, engine):
    created = report(client, png)
    bind(client, created)
    drain(client, engine)
    first = client.post(
        "/internal/outgoing-messages/claim", headers=INTERNAL, json={"limit": 1}
    ).json()[0]
    failed = client.post(
        "/internal/outgoing-messages/" + first["id"] + "/failed",
        headers=INTERNAL,
        json={"lease_id": first["lease_id"], "retry_after_seconds": 1},
    )
    assert failed.status_code == 200
    with Session(engine) as db:
        row = db.get(OutgoingMessage, UUID(first["id"]))
        row.next_attempt_at = now() - timedelta(seconds=1)
        db.commit()
    rows = client.post(
        "/internal/outgoing-messages/claim", headers=INTERNAL, json={"limit": 100}
    ).json()
    retried = next(r for r in rows if r["id"] == first["id"])
    assert retried["attempts"] == 2 and retried["lease_id"] != first["lease_id"]
    assert (
        client.post(
            "/internal/outgoing-messages/" + first["id"] + "/delivered",
            headers=INTERNAL,
            json={"lease_id": first["lease_id"], "sent_text": "Status update"},
        ).status_code
        == 409
    )


def test_concurrent_submission_retries_create_one_report(client, png, engine):
    from concurrent.futures import ThreadPoolExecutor

    token = "wg_r_" + token_urlsafe(32)
    rid = str(uuid4())

    def submit():
        return client.post(
            "/reports",
            headers={"X-Report-Token": token},
            data={"client_report_id": rid},
            files={"photo": ("a.png", png, "image/png")},
        )

    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(lambda _: submit(), range(2)))
    assert [r.status_code for r in responses] == [201, 201]
    assert responses[0].json() == responses[1].json()
    with Session(engine) as db:
        assert db.scalar(select(func.count()).select_from(Report)) == 1


def test_completed_time_remains_consumed_after_recheck(client, png, engine, seeded):
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
    ).json()
    done = client.post(
        "/jobs/" + job["id"] + "/completion",
        headers=auth(owner),
        data={"command_id": str(uuid4()), "expected_version": started["version"]},
        files={"photo": ("a.png", png, "image/png")},
    ).json()
    with Session(engine) as db:
        consumed = build_planning_input(db).completed_minutes[job["assigned_crew_id"]]
        assert consumed >= 15
    client.post(
        "/internal/conversations/" + convo["id"] + "/recheck",
        headers=INTERNAL,
        json={
            "command_id": str(uuid4()),
            "expected_version": done["version"],
            "reason": "Please recheck",
        },
    )
    drain(client, engine)
    with Session(engine) as db:
        assert (
            build_planning_input(db).completed_minutes[job["assigned_crew_id"]]
            == consumed
        )


def test_contract_exports_match_source():
    import json

    from scripts.export_contracts import DEST, artifacts

    for relative, value in artifacts().items():
        assert json.loads((DEST / relative).read_text()) == value, relative


def test_commit_acknowledgement_loss_preserves_committed_photo(
    client, png, engine, monkeypatch
):
    original = Session.commit
    state = {"raised": False}

    def commit_then_disconnect(db):
        original(db)
        if not state["raised"]:
            state["raised"] = True
            from sqlalchemy.exc import OperationalError

            raise OperationalError(
                "COMMIT", {}, RuntimeError("simulated acknowledgement loss")
            )

    monkeypatch.setattr(Session, "commit", commit_then_disconnect)
    token = "wg_r_" + token_urlsafe(32)
    rid = str(uuid4())
    params = {
        "headers": {"X-Report-Token": token},
        "data": {"client_report_id": rid},
        "files": {"photo": ("a.png", png, "image/png")},
    }
    response = client.post("/reports", **params)
    assert response.status_code == 503
    retry = client.post("/reports", **params)
    assert retry.status_code == 201
    assert len(client.app.state.cloud.uploads) == 1
    assert (
        client.get(
            "/photos/" + retry.json()["report"]["photo_id"] + "/access",
            headers=auth(token),
        ).status_code
        == 200
    )


def test_seed_cleanup_failure_does_not_delete_new_photos(engine, client):
    from scripts.seed_demo import seed

    cloud = client.app.state.cloud
    seed(engine, cloud)
    old = set(cloud.uploads)
    original = cloud.delete

    def failing_delete(path):
        if path in old:
            raise RuntimeError("storage temporarily unavailable")
        original(path)

    cloud.delete = failing_delete
    result = seed(engine, cloud, reset=True)
    assert len(result["orphan_cleanup_pending"]) == 10
    with Session(engine) as db:
        paths = set(db.scalars(select(Photo.object_path)))
    assert len(paths) == 10 and paths <= cloud.uploads.keys() and not paths & old


def test_partial_patch_retry_distinguishes_explicit_null(client, png, engine):
    report(client, png)
    drain(client, engine)
    job = client.get("/jobs", headers=auth("org")).json()[0]
    body = {
        "command_id": str(uuid4()),
        "expected_version": job["version"],
        "locked": True,
        "reason": "Retain crew",
    }
    assert (
        client.patch("/jobs/" + job["id"], headers=auth("org"), json=body).status_code
        == 200
    )
    assert (
        client.patch(
            "/jobs/" + job["id"],
            headers=auth("org"),
            json={**body, "assigned_crew_id": None},
        ).status_code
        == 409
    )


def test_chunked_upload_limit_is_enforced(client):
    def chunks():
        yield b'--boundary\r\nContent-Disposition: form-data; name="photo"; filename="large.png"\r\nContent-Type: image/png\r\n\r\n'
        for _ in range(11):
            yield b"x" * (1024 * 1024)
        yield b"\r\n--boundary--\r\n"

    result = client.post(
        "/reports",
        headers={"Content-Type": "multipart/form-data; boundary=boundary"},
        content=chunks(),
    )
    assert result.status_code == 413, result.text


@pytest.mark.parametrize(
    "violation",
    ["duplicate", "missing", "travel", "shift", "equipment", "false_reason"],
)
def test_infeasible_plan_proposals_are_rejected(client, png, engine, violation):
    report(client, png)
    drain(client, engine)
    with Session(engine) as db:
        inputs = build_planning_input(db)
        proposal = TestProvider().generate_plan(inputs)
        stop = proposal.assignments[0]
        if violation == "duplicate":
            proposal.assignments.append(stop.model_copy())
        elif violation == "missing":
            proposal.assignments = []
        elif violation == "travel":
            # Move the job away so a zero-minute leg is demonstrably invalid.
            from api.models import Job

            job = db.get(Job, stop.job_id)
            job.location = {"latitude": 24.95, "longitude": 67.12}
            job.version += 1
            db.flush()
            inputs = build_planning_input(db)
            proposal = TestProvider().generate_plan(inputs)
            proposal.assignments[0].travel_minutes = 0
        elif violation == "shift":
            stop.travel_minutes = 10000
        elif violation == "equipment":
            from api.models import Crew

            db.get(Crew, stop.crew_id).equipment = []
            db.flush()
            proposal.revision = build_planning_input(db).revision
        else:
            from api.schemas import UnassignedJob

            proposal.assignments = []
            proposal.unassigned = [
                UnassignedJob(job_id=stop.job_id, reason_code="no_eligible_crew")
            ]
        with pytest.raises(HTTPException) as error:
            apply_plan(db, proposal)
        assert error.value.status_code == 422
        db.rollback()
        assert db.scalar(select(func.count()).select_from(Plan)) == 1


def test_in_progress_work_survives_crew_removal(client, png, engine, seeded):
    report(client, png)
    drain(client, engine)
    job = client.get("/jobs", headers=auth("org")).json()[0]
    cid = job["assigned_crew_id"]
    owner = "a" if cid == str(seeded["crew_a"]) else "b"
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
    crew = next(
        c for c in client.get("/crews", headers=auth("org")).json() if c["id"] == cid
    )
    changed = client.patch(
        "/crews/" + cid,
        headers=auth("org"),
        json={
            "command_id": str(uuid4()),
            "expected_version": crew["version"],
            "available": False,
            "shift_minutes": 1,
        },
    )
    assert changed.status_code == 200
    drain(client, engine)
    preserved = client.get("/jobs/" + job["id"], headers=auth(owner)).json()["job"]
    assert preserved["status"] == "in_progress" and preserved["assigned_crew_id"] == cid


def test_manual_reassignment_is_audited_and_planned(client, png, engine, seeded):
    report(client, png)
    drain(client, engine)
    job = client.get("/jobs", headers=auth("org")).json()[0]
    target = (
        seeded["crew_b"]
        if job["assigned_crew_id"] == str(seeded["crew_a"])
        else seeded["crew_a"]
    )
    result = client.patch(
        "/jobs/" + job["id"],
        headers=auth("org"),
        json={
            "command_id": str(uuid4()),
            "expected_version": job["version"],
            "assigned_crew_id": str(target),
            "reason": "Organizer resource adjustment",
        },
    )
    assert result.status_code == 200, result.text
    assert result.json()["locked"] and result.json()["assigned_crew_id"] == str(target)
    drain(client, engine)
    detail = client.get("/jobs/" + job["id"], headers=auth("org")).json()
    assert detail["job"]["assigned_crew_id"] == str(target)
    assert any(
        e["details"].get("reason") == "Organizer resource adjustment"
        for e in detail["events"]
    )
