"""Resource-aware previews, explicit partial consent and frozen execution terms."""

from copy import deepcopy
from uuid import uuid4

import pytest
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from api.models import Crew, Job, Plan, RoutingPreview
from api.routing import compute_preview, dispatch_preview
from api.routing_schemas import RoutingConstraints
from api.workflows import ensure_can_start
from tests.test_assessment import assessment_db  # noqa: F401
from tests.test_routing import FakeRoads, config, seed_routing
from tests.test_routing_scope import api_client, rows


@pytest.fixture
def control_db(assessment_db, monkeypatch):  # noqa: F811
    monkeypatch.setattr("api.routing.mutation_lock", lambda db: None)
    return assessment_db


def verify_partial_dispatch(engine):
    ids, jobs = seed_routing(engine)
    actor, settings = uuid4(), config()
    constraints = RoutingConstraints(max_stops_per_crew=1, allow_partial=True)
    with Session(engine) as db:
        before = rows(db, Job, jobs)
        view = compute_preview(
            db,
            ids[:1],
            settings,
            FakeRoads(),
            str(actor),
            job_ids=jobs[:2],
            constraints=constraints,
        )
        assert view.dispatchable and len(view.unassigned) == 1
        routed = {stop.job_id for route in view.routes for stop in route.stops}
        assert len(routed) == 1
        missing = view.unassigned[0]
        assert missing.job_id in set(jobs[:2]) - routed
        preview = db.get(RoutingPreview, view.id)
        command = uuid4()
        with pytest.raises(HTTPException) as caught:
            dispatch_preview(db, preview, command, actor, settings)
        assert caught.value.status_code == 409
        assert rows(db, Job, jobs) == before
        assert not list(db.scalars(select(Plan)))
        result = dispatch_preview(
            db, preview, command, actor, settings, accept_partial=True
        )
        assert rows(db, Job, [missing.job_id]) == {
            str(missing.job_id): before[str(missing.job_id)]
        }
        assert rows(db, Job, jobs[2:]) == {str(jobs[2]): before[str(jobs[2])]}
        plan = db.get(Plan, result["plan_id"])
        assert {
            item["job_id"]: item["reason_code"] for item in plan.payload["unassigned"]
        }[str(missing.job_id)] == missing.reason
        assert (
            dispatch_preview(db, preview, command, actor, settings, accept_partial=True)
            == result
        )
        with pytest.raises(HTTPException) as changed:
            dispatch_preview(db, preview, command, actor, settings)
        assert changed.value.status_code == 409
        assert len(list(db.scalars(select(Plan)))) == 1


def test_partial_dispatch_requires_and_remembers_explicit_consent(control_db):
    verify_partial_dispatch(control_db)


@pytest.mark.parametrize(
    "constraints",
    [
        {"max_duration_minutes": 0},
        {"max_duration_minutes": -1},
        {"max_duration_minutes": 481},
        {"max_duration_minutes": "Infinity"},
        {"max_duration_minutes": "NaN"},
        {"max_stops_per_crew": 0},
        {"max_stops_per_crew": 26},
        {"max_stops_per_crew": 1.5},
        {"unknown_limit": 1},
    ],
)
def test_invalid_route_controls_fail_before_road_requests(control_db, constraints):
    ids, jobs = seed_routing(control_db)
    roads = FakeRoads()
    with api_client(control_db, roads) as client:
        result = client.post(
            "/routing/previews",
            json={
                "crew_ids": [str(ids[0])],
                "job_ids": [str(jobs[0])],
                "constraints": constraints,
            },
        )
        assert result.status_code == 422, result.text
    assert roads.calls == 0


@pytest.mark.parametrize("change", ["equipment", "shift", "required_equipment"])
def verify_resource_change(engine, change):
    ids, jobs = seed_routing(engine)
    actor, settings = uuid4(), config()
    with Session(engine) as db:
        view = compute_preview(
            db, ids[:1], settings, FakeRoads(), str(actor), job_ids=jobs[:1]
        )
        crew, job = db.get(Crew, ids[0]), db.get(Job, jobs[0])
        crew_version, job_version = crew.version, job.version
        if change == "equipment":
            crew.equipment = []
        elif change == "shift":
            crew.shift_minutes = 1
        else:
            job.required_equipment = ["hazmat"]
        db.commit()
        assert crew.version == crew_version and job.version == job_version
        before = rows(db, Job, jobs)
        with pytest.raises(HTTPException) as caught:
            dispatch_preview(
                db, db.get(RoutingPreview, view.id), uuid4(), actor, settings
            )
        assert caught.value.status_code == 409
        db.rollback()
        assert rows(db, Job, jobs) == before
        assert not list(db.scalars(select(Plan)))


@pytest.mark.parametrize("change", ["equipment", "shift", "required_equipment"])
def test_unversioned_resource_changes_still_invalidate_preview(control_db, change):
    verify_resource_change(control_db, change)


@pytest.mark.parametrize("change", ["equipment", "shift", "required_equipment"])
def verify_execution_resource_change(engine, change):
    ids, jobs = seed_routing(engine)
    actor, settings = uuid4(), config()
    with Session(engine) as db:
        view = compute_preview(
            db,
            ids[:1],
            settings,
            FakeRoads(),
            str(actor),
            job_ids=jobs[1:2],
            constraints=RoutingConstraints(return_to_start=True),
        )
        result = dispatch_preview(
            db, db.get(RoutingPreview, view.id), uuid4(), actor, settings
        )
        job, crew = db.get(Job, jobs[1]), db.get(Crew, ids[0])
        ensure_can_start(db, job)
        rule = db.get(Plan, result["plan_id"]).payload["execution_rules"][str(job.id)]
        assert rule["return_travel_minutes"] == 1
        if change == "equipment":
            crew.equipment = []
        elif change == "shift":
            # One outbound minute + five service + one return minute.
            crew.shift_minutes = 6
        else:
            job.required_equipment = ["hazmat"]
        db.flush()
        with pytest.raises(HTTPException) as caught:
            ensure_can_start(db, job)
        assert caught.value.status_code == 409
        assert job.assigned_crew_id == ids[0] and job.status == "assigned"


@pytest.mark.parametrize("change", ["equipment", "shift", "required_equipment"])
def test_start_rechecks_dispatched_resource_and_return_budget(control_db, change):
    verify_execution_resource_change(control_db, change)


def test_completion_history_is_not_a_lifetime_shift_deduction(control_db):
    from api.models import Event

    ids, jobs = seed_routing(control_db)
    actor, settings = uuid4(), config()
    with Session(control_db) as db:
        db.add(
            Event(
                kind="job.completed",
                job_id=jobs[2],
                details={"crew_id": str(ids[0]), "consumed_minutes": 100000},
            )
        )
        db.get(Crew, ids[0]).shift_minutes = 6
        db.commit()
        view = compute_preview(
            db, ids[:1], settings, FakeRoads(), str(actor), job_ids=jobs[:1]
        )
        assert view.dispatchable
        dispatch_preview(db, db.get(RoutingPreview, view.id), uuid4(), actor, settings)
        ensure_can_start(db, db.get(Job, jobs[0]))


@pytest.mark.parametrize(
    "tamper",
    ["drop_unassigned", "duplicate", "metrics", "partial_policy", "old_contract"],
)
def test_partial_preview_tampering_cannot_weaken_coverage_or_policy(control_db, tamper):
    ids, jobs = seed_routing(control_db)
    actor, settings = uuid4(), config()
    with Session(control_db) as db:
        view = compute_preview(
            db,
            ids[:1],
            settings,
            FakeRoads(),
            str(actor),
            job_ids=jobs[:2],
            constraints=RoutingConstraints(max_stops_per_crew=1, allow_partial=True),
        )
        saved = db.get(RoutingPreview, view.id)
        payload = deepcopy(saved.payload)
        if tamper == "drop_unassigned":
            payload["view"]["unassigned"] = []
        elif tamper == "duplicate":
            payload["view"]["unassigned"] *= 2
        elif tamper == "metrics":
            payload["view"]["metrics"]["score"] += 100
        elif tamper == "partial_policy":
            for target in (payload["view"], payload["snapshot"]):
                target["settings"]["constraints"]["allow_partial"] = False
        else:
            for target in (payload["view"], payload["snapshot"]):
                target["settings"].pop("routing_contract_version")
        saved.payload = payload
        db.commit()
        with pytest.raises(HTTPException) as caught:
            dispatch_preview(db, saved, uuid4(), actor, settings, accept_partial=True)
        assert caught.value.status_code == 409
        db.rollback()
        assert not list(db.scalars(select(Plan)))


def test_partial_never_silently_omits_preassigned_work(control_db):
    ids, jobs = seed_routing(control_db)
    actor, settings = uuid4(), config()
    with Session(control_db) as db:
        for index, jid in enumerate(jobs[:2]):
            job = db.get(Job, jid)
            job.assigned_crew_id, job.route_position, job.status = (
                ids[0],
                index,
                "assigned",
            )
        db.commit()
        view = compute_preview(
            db,
            ids[:1],
            settings,
            FakeRoads(),
            str(actor),
            job_ids=jobs[:2],
            constraints=RoutingConstraints(max_stops_per_crew=1, allow_partial=True),
        )
        assert not view.dispatchable
        with pytest.raises(HTTPException) as caught:
            dispatch_preview(
                db,
                db.get(RoutingPreview, view.id),
                uuid4(),
                actor,
                settings,
                accept_partial=True,
            )
        assert caught.value.status_code == 409
        assert all(db.get(Job, jid).assigned_crew_id == ids[0] for jid in jobs[:2])
        assert not list(db.scalars(select(Plan)))


def test_impossible_constraints_never_allow_empty_dispatch(control_db):
    ids, jobs = seed_routing(control_db)
    actor, settings = uuid4(), config()
    with Session(control_db) as db:
        view = compute_preview(
            db,
            ids[:1],
            settings,
            FakeRoads(),
            str(actor),
            job_ids=jobs[:1],
            constraints=RoutingConstraints(max_duration_minutes=1, allow_partial=True),
        )
        assert not view.dispatchable
        assert not any(route.stops for route in view.routes)
        with pytest.raises(HTTPException) as caught:
            dispatch_preview(
                db,
                db.get(RoutingPreview, view.id),
                uuid4(),
                actor,
                settings,
                accept_partial=True,
            )
        assert caught.value.status_code == 409


def test_api_partial_dispatch_remains_readable_as_current_plan(control_db):
    ids, jobs = seed_routing(control_db)
    with api_client(control_db) as client:
        preview = client.post(
            "/routing/previews",
            json={
                "crew_ids": [str(ids[0])],
                "job_ids": [str(jid) for jid in jobs[:2]],
                "constraints": {"max_stops_per_crew": 1, "allow_partial": True},
            },
        )
        assert preview.status_code == 200, preview.text
        dispatched = client.post(
            "/routing/previews/" + preview.json()["id"] + "/dispatch",
            json={"command_id": str(uuid4()), "accept_partial": True},
        )
        assert dispatched.status_code == 200, dispatched.text
        current = client.get("/plans/current")
        assert current.status_code == 200, current.text
        assert any(
            item["reason_code"] == "max_stops"
            for item in current.json()["plan"]["unassigned"]
        )


def test_removed_unfinished_stop_requires_fresh_preview_before_start(control_db):
    ids, jobs = seed_routing(control_db)
    actor, settings = uuid4(), config()
    with Session(control_db) as db:
        view = compute_preview(
            db, ids[:1], settings, FakeRoads(), str(actor), job_ids=jobs[:2]
        )
        result = dispatch_preview(
            db, db.get(RoutingPreview, view.id), uuid4(), actor, settings
        )
        route = view.routes[0]
        first, last = (db.get(Job, stop.job_id) for stop in route.stops)
        # Audited organiser recheck release can remove a later stop; its incoming
        # edge cannot simply disappear from the already frozen route budget.
        last.assigned_crew_id, last.route_position, last.status = (
            None,
            None,
            "unassigned",
        )
        db.flush()
        ensure_rule = db.get(Plan, result["plan_id"]).payload["execution_rules"][
            str(first.id)
        ]
        assert set(ensure_rule["route_job_ids"]) == {str(jid) for jid in jobs[:2]}
        with pytest.raises(HTTPException) as caught:
            ensure_can_start(db, first)
        assert caught.value.status_code == 409
        assert "route changed" in caught.value.detail


def test_completed_preceding_stop_releases_remaining_capacity(control_db):
    ids, jobs = seed_routing(control_db)
    actor, settings = uuid4(), config()
    with Session(control_db) as db:
        view = compute_preview(
            db, ids[:1], settings, FakeRoads(), str(actor), job_ids=jobs[:2]
        )
        dispatch_preview(db, db.get(RoutingPreview, view.id), uuid4(), actor, settings)
        route = view.routes[0]
        first, last = (db.get(Job, stop.job_id) for stop in route.stops)
        first.status = "completed"
        remaining_cost = route.stops[1].travel_minutes + route.stops[1].service_minutes
        db.get(Crew, ids[0]).shift_minutes = int(remaining_cost)
        db.flush()
        ensure_can_start(db, last)
