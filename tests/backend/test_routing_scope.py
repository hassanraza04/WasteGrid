"""Job-scoped routing safeguards exercised against disposable real PostgreSQL."""

from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from uuid import uuid4

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from api.db import mutation_lock
from api.models import Job, Plan, RoutingPreview
from api.routing import compute_preview, dispatch_preview
from tests.test_routing import FakeRoads, config, seed_routing
from tests.test_routing_scope import (
    verify_explicit_scope_preserves_unrelated,
    verify_legacy_preview_missing_scope_is_compatible,
    verify_outside_assignment_during_provider_io,
    verify_selected_crew_outside_scope_rejected,
    verify_unrelated_changes_do_not_widen_scope,
)


def test_postgres_explicit_scope_preserves_business_rows_and_legacy_provenance(engine):
    verify_explicit_scope_preserves_unrelated(engine)


def test_postgres_outside_assignments_fail_closed(engine):
    verify_selected_crew_outside_scope_rejected(engine)


def test_postgres_assignment_appearing_during_provider_io_blocks_dispatch(engine):
    verify_outside_assignment_during_provider_io(engine)


def test_postgres_unrelated_changes_do_not_widen_or_invalidate_scope(engine):
    verify_unrelated_changes_do_not_widen_scope(engine)


def test_postgres_legacy_preview_missing_optional_scope_remains_compatible(engine):
    verify_legacy_preview_missing_scope_is_compatible(engine)


def test_postgres_concurrent_scoped_dispatches_cannot_overwrite_each_other(engine):
    ids, jobs = seed_routing(engine)
    actor, settings = uuid4(), config()
    previews = []
    for _ in range(2):
        with Session(engine) as db:
            mutation_lock(db)
            view = compute_preview(
                db, ids[:1], settings, FakeRoads(), str(actor), job_ids=jobs[:1]
            )
            previews.append(view.id)
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
            except HTTPException as error:
                db.rollback()
                return error.status_code

    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(dispatch, previews)) == [200, 409]
    with Session(engine) as db:
        assert len(list(db.scalars(select(Plan)))) == 1
        assert db.get(Job, jobs[0]).version == 2
        assert db.get(Job, jobs[1]).version == 1
        assert db.get(Job, jobs[1]).assigned_crew_id is None
