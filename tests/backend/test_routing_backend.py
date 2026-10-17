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
from api.models import Job, Plan, RoutingPreview, Task
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
