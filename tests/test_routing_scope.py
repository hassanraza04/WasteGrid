"""Explicit job scopes must never absorb or rewrite unrelated operational work."""

from contextlib import contextmanager
from copy import deepcopy
from uuid import uuid4

import pytest
from fastapi import HTTPException, Request
from fastapi.testclient import TestClient
from sqlalchemy import inspect, select
from sqlalchemy.orm import Session

from api.auth import Principal, get_staff
from api.main import create_app
from api.models import Assignment, Crew, Event, Job, Plan, Report, RoutingPreview
from api.routing import compute_preview, dispatch_preview
from api.workflows import ensure_can_start
from tests.test_assessment import assessment_db  # noqa: F401
from tests.test_routing import (
    FakeRoads,
    config,
    seed_routing,
    seed_valid_legacy_assignment,
)


class RecordingRoads(FakeRoads):
    def matrix(self, locations):
        self.locations = deepcopy(locations)
        return super().matrix(locations)


def rows(db, model, ids):
    """Compare every persisted business column, not only assignment IDs."""
    names = [column.key for column in inspect(model).column_attrs]
    return {
        str(record.id): deepcopy({name: getattr(record, name) for name in names})
        for record in db.scalars(select(model).where(model.id.in_(ids)))
    }


@contextmanager
def api_client(engine, roads=None):
    actor = uuid4()
    app = create_app(config())
    app.state.engine = engine
    app.state.road_times = roads or RecordingRoads()

    def staff(request: Request):
        role = (
            "crew"
            if request.headers.get("Authorization") == "Bearer crew"
            else "organizer"
        )
        return Principal(actor, role, None)

    app.dependency_overrides[get_staff] = staff
    with TestClient(app) as client:
        try:
            yield client
        finally:
            # The fixture owns this shared in-memory engine, not the app lifespan.
            app.state.engine = None


@pytest.fixture
def scope_db(assessment_db, monkeypatch):  # noqa: F811 - imported pytest fixture
    monkeypatch.setattr("api.routing.mutation_lock", lambda db: None)
    return assessment_db


def verify_explicit_scope_preserves_unrelated(engine):
    ids, jobs, legacy_id = seed_valid_legacy_assignment(engine)
    roads, settings, actor = RecordingRoads(), config(), uuid4()
    with Session(engine) as db:
        other_reports = list(
            db.scalars(select(Report.id).where(Report.job_id.in_(jobs[1:])))
        )
        old_jobs = rows(db, Job, jobs[1:])
        target_version = db.get(Job, jobs[0]).version
        old_reports = rows(db, Report, other_reports)
        old_assignment_ids = list(db.scalars(select(Assignment.id)))
        old_assignments = rows(db, Assignment, old_assignment_ids)
        old_plan = deepcopy(db.get(Plan, legacy_id).payload)
        old_planned = set(
            db.scalars(select(Event.id).where(Event.kind == "job.planned"))
        )
        view = compute_preview(
            db, ids[:1], settings, roads, str(actor), job_ids=jobs[:1]
        )
        assert view.job_ids == jobs[:1]
        assert view.dispatchable
        assert {stop.job_id for route in view.routes for stop in route.stops} == set(
            jobs[:1]
        )
        assert len(roads.locations) == 2
        assert roads.locations == [
            db.get(Crew, ids[0]).start_location,
            db.get(Job, jobs[0]).location,
        ]
        assert rows(db, Job, jobs[1:]) == old_jobs
        assert rows(db, Report, other_reports) == old_reports
        assert (
            set(db.scalars(select(Event.id).where(Event.kind == "job.planned")))
            == old_planned
        )
        saved = db.get(RoutingPreview, view.id)
        assert saved.payload["snapshot"]["job_ids"] == [str(jobs[0])]
        command = uuid4()
        result = dispatch_preview(db, saved, command, actor, settings)
        assert rows(db, Job, jobs[1:]) == old_jobs
        assert rows(db, Report, other_reports) == old_reports
        assert rows(db, Assignment, old_assignment_ids) == old_assignments
        assert db.get(Plan, legacy_id).payload == old_plan
        assert db.get(Job, jobs[0]).version == target_version + 1
        plan = db.get(Plan, result["plan_id"])
        assert {
            item["job_id"]: item["reason_code"] for item in plan.payload["unassigned"]
        }[str(jobs[1])] == "outside_scope"
        assert plan.payload["execution_rules"][str(jobs[2])] == {
            "mode": "legacy",
            "source_plan_id": str(legacy_id),
        }
        ensure_can_start(db, db.get(Job, jobs[2]))
        assert dispatch_preview(db, saved, command, actor, settings) == result
        assert db.get(Job, jobs[0]).version == target_version + 1
        new_planned = (
            set(db.scalars(select(Event.id).where(Event.kind == "job.planned")))
            - old_planned
        )
        assert len(new_planned) == 1
        assert len(list(db.scalars(select(Plan)))) == 2


def test_explicit_scope_preserves_unrelated_business_and_legacy_execution(scope_db):
    verify_explicit_scope_preserves_unrelated(scope_db)


@pytest.mark.parametrize("invalid", [[], "duplicate", "too_many", ["not-a-uuid"]])
def test_scope_schema_rejects_invalid_lists_before_provider(scope_db, invalid):
    ids, jobs = seed_routing(scope_db)
    if invalid == "duplicate":
        invalid = [str(jobs[0]), str(jobs[0])]
    elif invalid == "too_many":
        invalid = [str(uuid4()) for _ in range(26)]
    roads = RecordingRoads()
    with api_client(scope_db, roads) as client:
        response = client.post(
            "/routing/previews", json={"crew_ids": [str(ids[0])], "job_ids": invalid}
        )
        assert response.status_code == 422, response.text
    assert roads.calls == 0
    with Session(scope_db) as db:
        assert not list(db.scalars(select(RoutingPreview)))


@pytest.mark.parametrize("invalid", ["empty", "duplicate", "too_many"])
def test_direct_compute_also_rejects_invalid_scope(scope_db, invalid):
    ids, jobs = seed_routing(scope_db)
    selected = (
        []
        if invalid == "empty"
        else (
            [jobs[0], jobs[0]]
            if invalid == "duplicate"
            else [uuid4() for _ in range(26)]
        )
    )
    roads = RecordingRoads()
    with Session(scope_db) as db:
        with pytest.raises(HTTPException) as caught:
            compute_preview(
                db, ids[:1], config(), roads, str(uuid4()), job_ids=selected
            )
        assert caught.value.status_code == 422
    assert roads.calls == 0


@pytest.mark.parametrize(
    "kind,status",
    [
        ("unknown", 404),
        ("completed", 409),
        ("held", 409),
        ("blocked", 409),
        ("recheck", 409),
        ("pending", 409),
        ("review", 409),
        ("organizer_hold", 409),
        ("priority", 409),
        ("foreign_crew", 409),
    ],
)
def test_unavailable_requested_work_fails_closed_before_provider(
    scope_db, kind, status
):
    ids, jobs = seed_routing(scope_db)
    target = (
        uuid4() if kind == "unknown" else jobs[2] if kind == "foreign_crew" else jobs[0]
    )
    with Session(scope_db) as db:
        job = db.get(Job, jobs[0])
        report = db.scalar(select(Report).where(Report.job_id == jobs[0]))
        if kind == "completed":
            job.status = "completed"
        elif kind == "held":
            job.held = True
        elif kind == "blocked":
            job.status = "blocked"
        elif kind == "recheck":
            job.status = "recheck_requested"
        elif kind == "pending":
            report.assessment_status = "pending"
        elif kind == "review":
            report.needs_review = True
        elif kind == "organizer_hold":
            report.organizer_review_required = True
        elif kind == "priority":
            report.priority = None
        db.commit()
    roads = RecordingRoads()
    with api_client(scope_db, roads) as client:
        response = client.post(
            "/routing/previews",
            json={"crew_ids": [str(ids[0])], "job_ids": [str(target)]},
        )
        assert response.status_code == status, response.text
    assert roads.calls == 0
    with Session(scope_db) as db:
        assert not list(db.scalars(select(Plan)))
        assert not list(db.scalars(select(RoutingPreview)))


def verify_selected_crew_outside_scope_rejected(engine, kind="assigned"):
    ids, jobs = seed_routing(engine)
    with Session(engine) as db:
        outside = db.get(Job, jobs[2])
        outside.assigned_crew_id = ids[0]
        if kind == "held":
            outside.held = True
        elif kind == "locked":
            outside.locked = True
        else:
            outside.status = kind
        db.commit()
        before = rows(db, Job, jobs)
        roads = RecordingRoads()
        with pytest.raises(HTTPException) as caught:
            compute_preview(
                db, ids[:1], config(), roads, str(uuid4()), job_ids=jobs[:1]
            )
        assert caught.value.status_code == 409
        assert roads.calls == 0
        assert rows(db, Job, jobs) == before
        assert not list(db.scalars(select(Plan)))


@pytest.mark.parametrize(
    "kind",
    ["assigned", "in_progress", "blocked", "recheck_requested", "held", "locked"],
)
def test_every_unfinished_outside_assignment_blocks_selected_crew(scope_db, kind):
    verify_selected_crew_outside_scope_rejected(scope_db, kind)


def test_completed_outside_assignment_does_not_block_selected_crew(scope_db):
    ids, jobs = seed_routing(scope_db)
    with Session(scope_db) as db:
        outside = db.get(Job, jobs[2])
        outside.assigned_crew_id, outside.status = ids[0], "completed"
        db.commit()
        view = compute_preview(
            db, ids[:1], config(), RecordingRoads(), str(uuid4()), job_ids=jobs[:1]
        )
        assert view.dispatchable
        assert view.job_ids == jobs[:1]


def verify_unrelated_changes_do_not_widen_scope(engine):
    ids, jobs = seed_routing(engine)
    actor, settings = uuid4(), config()
    with Session(engine) as db:
        view = compute_preview(
            db, ids[:1], settings, RecordingRoads(), str(actor), job_ids=jobs[:1]
        )
        unrelated = db.get(Job, jobs[1])
        unrelated.version += 1
        unrelated.decision_summary = "An unrelated organiser edit"
        report = db.scalar(select(Report).where(Report.job_id == jobs[1]))
        report.priority, report.version = "high", report.version + 1
        db.commit()
        before = rows(db, Job, jobs[1:])
    _, new_jobs = seed_routing(engine)
    with Session(engine) as db:
        result = dispatch_preview(
            db, db.get(RoutingPreview, view.id), uuid4(), actor, settings
        )
        assert rows(db, Job, jobs[1:]) == before
        assert all(db.get(Job, jid).assigned_crew_id is None for jid in new_jobs[:2])
        planned = set(
            db.scalars(select(Event.job_id).where(Event.kind == "job.planned"))
        )
        assert planned == set(jobs[:1])
        unassigned = db.get(Plan, result["plan_id"]).payload["unassigned"]
        assert {
            item["job_id"]
            for item in unassigned
            if item["reason_code"] == "outside_scope"
        } == {str(jobs[1]), *(str(jid) for jid in new_jobs[:2])}


def test_new_and_changed_unrelated_jobs_never_enter_scoped_dispatch(scope_db):
    verify_unrelated_changes_do_not_widen_scope(scope_db)


def verify_outside_assignment_during_provider_io(engine):
    ids, jobs = seed_routing(engine)
    actor, settings = uuid4(), config()

    class ConcurrentRoads(RecordingRoads):
        def matrix(self, locations):
            with Session(engine) as concurrent:
                outside = concurrent.get(Job, jobs[1])
                outside.assigned_crew_id, outside.status, outside.route_position = (
                    ids[0],
                    "assigned",
                    0,
                )
                outside.version += 1
                concurrent.commit()
            return super().matrix(locations)

    with Session(engine) as db:
        view = compute_preview(
            db, ids[:1], settings, ConcurrentRoads(), str(actor), job_ids=jobs[:1]
        )
        before = rows(db, Job, jobs)
        with pytest.raises(HTTPException) as caught:
            dispatch_preview(
                db, db.get(RoutingPreview, view.id), uuid4(), actor, settings
            )
        assert caught.value.status_code == 409
        db.rollback()
        assert rows(db, Job, jobs) == before
        assert not list(db.scalars(select(Plan)))


def test_outside_assignment_added_during_provider_io_blocks_dispatch(scope_db):
    verify_outside_assignment_during_provider_io(scope_db)


@pytest.mark.parametrize(
    "change",
    [
        "job_version",
        "report_version",
        "held",
        "review",
        "priority",
        "completed",
        "foreign_crew",
        "location",
        "deleted",
    ],
)
def test_scoped_business_changes_require_new_preview(scope_db, change):
    ids, jobs = seed_routing(scope_db)
    actor, settings = uuid4(), config()
    with Session(scope_db) as db:
        view = compute_preview(
            db, ids[:1], settings, RecordingRoads(), str(actor), job_ids=jobs[:1]
        )
        job = db.get(Job, jobs[0])
        report = db.scalar(select(Report).where(Report.job_id == jobs[0]))
        if change == "job_version":
            job.version += 1
        elif change == "report_version":
            report.version += 1
        elif change == "held":
            job.held = True
        elif change == "review":
            report.needs_review = True
        elif change == "priority":
            report.priority = "high"
        elif change == "completed":
            job.status = "completed"
        elif change == "foreign_crew":
            job.assigned_crew_id, job.status, job.route_position = ids[2], "assigned", 1
        elif change == "location":
            job.location = {"latitude": 25.0, "longitude": 67.1}
        else:
            report.job_id = None
            db.flush()
            db.delete(job)
        db.commit()
        with pytest.raises(HTTPException) as caught:
            dispatch_preview(
                db, db.get(RoutingPreview, view.id), uuid4(), actor, settings
            )
        assert caught.value.status_code == 409
        db.rollback()
        assert not list(db.scalars(select(Plan)))
        assert db.get(Job, jobs[1]).version == 1


def verify_legacy_preview_missing_scope_is_compatible(engine):
    ids, _ = seed_routing(engine)
    actor, settings = uuid4(), config()
    with Session(engine) as db:
        view = compute_preview(db, ids[:1], settings, RecordingRoads(), str(actor))
        preview = db.get(RoutingPreview, view.id)
        payload = deepcopy(preview.payload)
        payload["view"].pop("job_ids", None)
        payload["snapshot"].pop("job_ids", None)
        preview.payload = payload
        db.commit()
        assert dispatch_preview(db, preview, uuid4(), actor, settings)["plan_id"]


def test_legacy_preview_without_scope_remains_dispatchable(scope_db):
    verify_legacy_preview_missing_scope_is_compatible(scope_db)


@pytest.mark.parametrize(
    "tamper",
    [
        "view_widen",
        "snapshot_widen",
        "drop_view",
        "drop_snapshot",
        "drop_both",
        "empty_view",
        "duplicate_view",
    ],
)
def test_stored_scope_forgery_never_widens_dispatch(scope_db, tamper):
    ids, jobs = seed_routing(scope_db)
    actor, settings = uuid4(), config()
    with Session(scope_db) as db:
        view = compute_preview(
            db, ids[:1], settings, RecordingRoads(), str(actor), job_ids=jobs[:2]
        )
        preview = db.get(RoutingPreview, view.id)
        payload = deepcopy(preview.payload)
        scope = [str(jid) for jid in view.job_ids]
        if tamper == "view_widen":
            payload["view"]["job_ids"] = scope + [str(jobs[2])]
        elif tamper == "snapshot_widen":
            payload["snapshot"]["job_ids"] = scope + [str(jobs[2])]
        elif tamper == "empty_view":
            payload["view"]["job_ids"] = []
        elif tamper == "duplicate_view":
            payload["view"]["job_ids"] = [scope[0], scope[0]]
        else:
            if tamper in ("drop_view", "drop_both"):
                payload["view"].pop("job_ids")
            if tamper in ("drop_snapshot", "drop_both"):
                payload["snapshot"].pop("job_ids")
        preview.payload = payload
        db.commit()
        before = rows(db, Job, jobs)
        with pytest.raises(HTTPException) as caught:
            dispatch_preview(db, preview, uuid4(), actor, settings)
        assert caught.value.status_code == 409
        db.rollback()
        assert rows(db, Job, jobs) == before
        assert not list(db.scalars(select(Plan)))


def test_scope_is_canonical_and_dispatch_body_cannot_replace_it(scope_db):
    ids, jobs = seed_routing(scope_db)
    with api_client(scope_db) as client:
        created = client.post(
            "/routing/previews",
            json={"crew_ids": [str(ids[0])], "job_ids": [str(jobs[1]), str(jobs[0])]},
        )
        assert created.status_code == 200, created.text
        assert created.json()["job_ids"] == sorted(str(jid) for jid in jobs[:2])
        shown = client.get("/routing/previews/" + created.json()["id"])
        assert shown.status_code == 200
        assert shown.json()["job_ids"] == created.json()["job_ids"]
        denied = client.post(
            "/routing/previews/" + created.json()["id"] + "/dispatch",
            json={"command_id": str(uuid4()), "job_ids": [str(jobs[2])]},
        )
        assert denied.status_code == 422
        forbidden = client.post(
            "/routing/previews",
            headers={"Authorization": "Bearer crew"},
            json={"crew_ids": [str(ids[0])], "job_ids": [str(jobs[0])]},
        )
        assert forbidden.status_code == 403
    with Session(scope_db) as db:
        assert not list(db.scalars(select(Plan)))


def test_explicit_limit_allows_25_selected_jobs_even_when_more_work_is_eligible(
    scope_db,
):
    ids, jobs = seed_routing(scope_db)
    eligible = jobs[:2]
    for _ in range(12):
        _, additional = seed_routing(scope_db)
        eligible.extend(additional[:2])
    scope = eligible[:25]
    roads = RecordingRoads()
    with Session(scope_db) as db:
        view = compute_preview(
            db, ids[:1], config(), roads, str(uuid4()), job_ids=scope
        )
        assert set(view.job_ids) == set(scope)
        assert len(roads.locations) == 26
        represented = {stop.job_id for route in view.routes for stop in route.stops}
        represented.update(issue.job_id for issue in view.unassigned)
        assert represented == set(scope)
        assert not list(db.scalars(select(Plan)))


def test_omitted_and_null_scope_keep_legacy_all_eligible_selection(scope_db):
    ids, jobs = seed_routing(scope_db)
    with api_client(scope_db) as client:
        for body in (
            {"crew_ids": [str(ids[0])]},
            {"crew_ids": [str(ids[0])], "job_ids": None},
        ):
            response = client.post("/routing/previews", json=body)
            assert response.status_code == 200, response.text
            assert response.json()["job_ids"] is None
            assert {
                stop["job_id"]
                for route in response.json()["routes"]
                for stop in route["stops"]
            } == {str(jid) for jid in jobs[:2]}
