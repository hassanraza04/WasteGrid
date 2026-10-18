"""Real PostgreSQL migration, assignment ownership and concurrent dispatch checks."""

from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from uuid import uuid4

from fastapi import HTTPException, Request
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from api.auth import Principal, get_staff
from api.db import mutation_lock
from api.main import create_app
from api.models import Job, Plan, RoutingPreview, Task, now
from api.routing import compute_preview, dispatch_preview
from api.worker import process_one
from scripts.migrate import migrate
from tests.test_routing import FakeRoads, config, seed_routing


def test_postgres_scoped_preview_dispatch_and_idempotence(engine):
    ids, jobs = seed_routing(engine)
    actor, settings = uuid4(), config()
    migrate(engine)
    with Session(engine) as db:
        mutation_lock(db)
        view = compute_preview(db, ids[:2], settings, FakeRoads(), str(actor))
        assert view.dispatchable
        assert db.get(Job, jobs[0]).assigned_crew_id is None
        db.commit()
        mutation_lock(db)
        preview = db.get(RoutingPreview, view.id)
        command = uuid4()
        result = dispatch_preview(db, preview, command, actor, settings)
        assert db.get(Job, jobs[2]).assigned_crew_id == ids[2]
        assert db.get(Job, jobs[2]).version == 1
        mutation_lock(db)
        assert dispatch_preview(db, preview, command, actor, settings) == result
        assert len(list(db.scalars(select(Plan)))) == 1


def test_two_simultaneous_dispatches_cannot_overwrite_assignments(engine):
    ids, _ = seed_routing(engine)
    actor, settings = uuid4(), config()
    previews = []
    for _ in range(2):
        with Session(engine) as db:
            mutation_lock(db)
            previews.append(
                compute_preview(db, ids[:2], settings, FakeRoads(), str(actor)).id
            )
    barrier = Barrier(2)

    def dispatch(preview_id):
        with Session(engine) as db:
            barrier.wait(timeout=10)
            mutation_lock(db)
            preview = db.scalar(
                select(RoutingPreview)
                .where(RoutingPreview.id == preview_id)
                .with_for_update()
            )
            try:
                dispatch_preview(db, preview, uuid4(), actor, settings)
                return 200
            except HTTPException as exc:
                db.rollback()
                return exc.status_code

    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(dispatch, previews)) == [200, 409]
    with Session(engine) as db:
        assert len(list(db.scalars(select(Plan)))) == 1


def test_organizer_mode_worker_consumes_invalidation_without_auto_dispatch(engine):
    class Provider:
        def generate_plan(self, request):
            raise AssertionError(
                "Worker must not call automatic planning in organiser mode"
            )

    with Session(engine) as db:
        db.add(Task(kind="plan", dedupe_key="routing-invalidation", payload={}))
        db.commit()
    assert process_one(engine, Provider(), None, organizer_routing=True)
    with Session(engine) as db:
        task = db.scalar(select(Task))
        assert task.status == "succeeded"
        assert task.result == {"organizer_dispatch_required": True}
        assert not list(db.scalars(select(Plan)))


def test_postgres_preserves_unselected_legacy_execution(engine):
    from tests.test_routing import verify_preserved_legacy_start

    verify_preserved_legacy_start(engine)


def test_postgres_preserves_preview_durations_across_disjoint_dispatch(engine):
    from tests.test_routing import verify_preserved_preview_durations

    verify_preserved_preview_durations(engine)


def test_postgres_batches_approval_reads(engine):
    from tests.test_routing import verify_batched_approval_reads

    verify_batched_approval_reads(engine, 4)


def test_postgres_batches_unselected_provenance_reads(engine):
    from tests.test_routing import verify_batched_dispatch_reads

    verify_batched_dispatch_reads(engine, 30)


def test_postgres_audited_recheck_release_restores_route(engine):
    from tests.test_routing import verify_recheck_route_resolution

    ids, jobs = seed_routing(engine)
    actor = uuid4()
    app = create_app(config())
    app.state.engine = engine

    def staff(request: Request):
        if request.headers.get("Authorization") == "Bearer crew":
            return Principal(uuid4(), "crew", ids[0])
        return Principal(actor, "organizer", None)

    app.dependency_overrides[get_staff] = staff
    with TestClient(app) as client:
        verify_recheck_route_resolution(client, engine, ids, jobs)


def test_postgres_active_job_pages_preserve_crew_scope(client, engine, seeded):
    from tests.test_routing import verify_active_job_pages

    verify_active_job_pages(client, engine, seeded["crew_a"], seeded["crew_b"], "a")


def test_routed_job_completion_exposes_resident_evidence_once(
    client, engine, seeded, png
):
    from uuid import UUID

    from api.models import Report
    from tests.backend.conftest import auth, report
    from tests.backend.providers import seed_eligible_assessment

    created = report(client, png)
    rid = created["report"]["id"]
    with Session(engine) as db:
        row = db.get(Report, UUID(rid))
        seed_eligible_assessment(row)
        job = Job(
            category="mixed_waste",
            required_equipment=[],
            estimated_service_minutes=5,
            location=row.location,
        )
        db.add(job)
        db.flush()
        row.job_id, row.state = job.id, "linked_to_job"
        db.commit()
        jid = str(job.id)
    client.app.state.settings.organizer_routing_enabled = True
    client.app.state.road_times = FakeRoads()
    gps = client.post(
        "/crews/me/location",
        headers=auth("a"),
        json={
            "location": {"latitude": 24.92, "longitude": 67.09},
            "recorded_at": now().isoformat(),
        },
    )
    assert gps.status_code == 200, gps.text
    preview = client.post(
        "/routing/previews",
        headers=auth("org"),
        json={"crew_ids": [str(seeded["crew_a"])]},
    )
    assert preview.status_code == 200 and preview.json()["dispatchable"], preview.text
    dispatch = {"command_id": str(uuid4())}
    route = "/routing/previews/" + preview.json()["id"] + "/dispatch"
    assert client.post(route, headers=auth("org"), json=dispatch).status_code == 200
    assert client.post(route, headers=auth("org"), json=dispatch).status_code == 200
    job = client.get("/jobs?active_only=true", headers=auth("a")).json()[0]
    assert client.get("/jobs?active_only=true", headers=auth("b")).json() == []
    start = {
        "command_id": str(uuid4()),
        "expected_version": job["version"],
        "status": "in_progress",
    }
    started = client.patch(f"/jobs/{jid}", headers=auth("a"), json=start)
    assert started.status_code == 200, started.text
    done = {"command_id": str(uuid4()), "expected_version": started.json()["version"]}
    for _ in range(2):
        completed = client.post(
            f"/jobs/{jid}/completion",
            headers=auth("a"),
            data=done,
            files={"photo": ("cleanup.png", png, "image/png")},
        )
        assert completed.status_code == 200, completed.text
    assert client.get("/jobs?active_only=true", headers=auth("a")).json() == []
    detail = client.get(f"/jobs/{jid}", headers=auth("a")).json()
    assert (
        len(
            [
                event
                for event in detail["events"]
                if event.get("command_id") == done["command_id"]
                and event["kind"] == "job.completed"
            ]
        )
        == 1
    )
    resident = client.get(
        f"/reports/{rid}", headers=auth(created["access_token"])
    ).json()
    assert (
        resident["display_status"] == "completed"
        and len(resident["completion_photo_ids"]) == 1
    )
    assert all("command_id" not in event for event in resident["timeline"])
    photo = resident["completion_photo_ids"][0]
    assert (
        client.get(
            f"/photos/{photo}/access", headers=auth(created["access_token"])
        ).status_code
        == 200
    )
    assert client.get(f"/photos/{photo}/access", headers=auth("b")).status_code == 404


def test_preview_read_receipt_and_geometry_authorization(engine):
    ids, jobs = seed_routing(engine)
    actor, settings = uuid4(), config()
    app = create_app(settings)
    app.state.engine = engine
    app.dependency_overrides[get_staff] = lambda: Principal(actor, "organizer", None)
    with Session(engine) as db:
        mutation_lock(db)
        view = compute_preview(
            db, ids[:2], settings, FakeRoads(), str(actor), job_ids=[jobs[0], jobs[1]]
        )
    with TestClient(app) as client:
        original = client.get(f"/routing/previews/{view.id}").json()
        assert original["dispatch_receipt"] is None
        command = uuid4()
        result = client.post(
            f"/routing/previews/{view.id}/dispatch", json={"command_id": str(command)}
        )
        assert result.status_code == 200, result.text
        recovered = client.get(f"/routing/previews/{view.id}").json()
        assert recovered["dispatch_receipt"] == {
            "command_id": str(command),
            "actor_id": str(actor),
            "plan_id": result.json()["plan_id"],
            "accept_partial": False,
        }
        assert (
            client.get(f"/routing/previews/{view.id}/geometry/{uuid4()}").status_code
            == 404
        )
        app.dependency_overrides[get_staff] = lambda: Principal(actor, "crew", ids[0])
        assert (
            client.get(f"/routing/previews/{view.id}/geometry/{ids[0]}").status_code
            == 403
        )
