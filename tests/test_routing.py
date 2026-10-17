"""Directed routing, priority trade-offs and persisted preview/dispatch regressions."""

from datetime import timedelta
from itertools import permutations, product
from types import SimpleNamespace
from uuid import UUID, uuid4

import httpx
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from api.config import Settings
from api.main import create_app
from api.models import (
    Crew,
    Event,
    Job,
    Photo,
    Plan,
    Report,
    RoutingPreview,
    StaffRole,
    now,
)
from api.road_times import OSRMRoadTimes, TravelDataUnavailable
from api.route_solver import evaluate, solve
from api.routing import compute_preview, dispatch_preview, snapshot
from api.workflows import ensure_can_start
from tests.test_assessment import assessment_db  # noqa: F401 - shared pytest fixture
from tests.test_assessment import assessment


def solver_input(priorities=("routine", "high", "medium"), crews=2):
    return dict(
        jobs=[
            dict(
                id=f"j{i}",
                priority=p,
                service=5,
                ongoing=False,
                service_source="fixed_collection_time",
            )
            for i, p in enumerate(priorities)
        ],
        node_ids=[f"crew:c{i}" for i in range(crews)]
        + [f"job:j{i}" for i in range(len(priorities))],
        prefixes={f"c{i}": [] for i in range(crews)},
        settings=dict(
            alpha=1, beta=1, gamma=0.25, improvement_budget=10000, solver_seconds=5
        ),
    )


def matrix_for(snap, duration=2):
    n = len(snap["node_ids"])
    return [[0 if a == b else duration for b in range(n)] for a in range(n)]


def test_priority_changes_order_without_dropping_jobs():
    snap = solver_input(crews=1)
    matrix = matrix_for(snap)
    result = solve(snap, matrix, clock=lambda: 0)
    ids = [s["job_id"] for s in result["routes"][0]["stops"]]
    assert ids == ["j1", "j2", "j0"]
    assert result["dispatchable"] and not result["unassigned"]
    assert result == solve(snap, matrix, clock=lambda: 0)


def test_ten_nearby_low_stops_are_not_ignored_for_distant_high():
    snap = solver_input(("routine",) * 10 + ("high",), crews=1)
    matrix = matrix_for(snap, 1)
    # The high job is an expensive detour in either direction.
    dest = snap["node_ids"].index("job:j10")
    for i in range(len(matrix)):
        if i != dest:
            matrix[i][dest] = matrix[dest][i] = 30
    result = solve(snap, matrix, clock=lambda: 0)
    stops = result["routes"][0]["stops"]
    assert {s["job_id"] for s in stops} == {j["id"] for j in snap["jobs"]}
    assert stops[0]["priority"] == "routine"
    assert result["dispatchable"]


def test_directional_reordering_recomputes_edges_and_matches_tiny_optimum():
    snap = solver_input(crews=1)
    matrix = [[0, 2, 9, 7], [8, 0, 20, 1], [3, 2, 0, 25], [8, 20, 1, 0]]
    result = solve(snap, matrix, clock=lambda: 0)
    exact = min(
        evaluate(snap, matrix, {"c0": list(order)})["metrics"]["score"]
        for order in permutations(["j0", "j1", "j2"])
    )
    assert result["metrics"]["score"] == pytest.approx(exact)
    reverse = {
        "c0": list(reversed([s["job_id"] for s in result["routes"][0]["stops"]]))
    }
    assert (
        evaluate(snap, matrix, reverse)["metrics"]["total_travel"]
        != result["metrics"]["total_travel"]
    )


def test_two_crews_small_exhaustive_quality_check():
    snap = solver_input()
    matrix = matrix_for(snap)
    result = solve(snap, matrix, clock=lambda: 0)
    exact = float("inf")
    for order in permutations(["j0", "j1", "j2"]):
        for owners in product(["c0", "c1"], repeat=3):
            routes = {"c0": [], "c1": []}
            for jid, cid in zip(order, owners):
                routes[cid].append(jid)
            exact = min(exact, evaluate(snap, matrix, routes)["metrics"]["score"])
    assert result["metrics"]["score"] == pytest.approx(exact)
    assert len({s["job_id"] for r in result["routes"] for s in r["stops"]}) == 3


def test_missing_edge_can_use_another_order_and_unreachable_is_distinct():
    snap = solver_input(crews=1)
    matrix = matrix_for(snap)
    matrix[1][2] = None
    assert solve(snap, matrix, clock=lambda: 0)["dispatchable"]
    for row in matrix:
        row[2] = None
    result = solve(snap, matrix, clock=lambda: 0)
    assert not result["dispatchable"]
    assert result["unassigned"] == [dict(job_id="j1", reason="no_usable_route_found")]


def test_prefix_and_remaining_service_and_time_limit():
    snap = solver_input(crews=1)
    snap["prefixes"]["c0"] = ["j0"]
    snap["jobs"][0].update(ongoing=True, service=1.5)
    matrix = matrix_for(snap, 20)
    result = solve(snap, matrix, clock=lambda: 0)
    first = result["routes"][0]["stops"][0]
    assert first["job_id"] == "j0" and first["completion_minutes"] == 1.5
    assert first["travel_minutes"] == 0 and first["fixed"]
    ticks = iter([0] + [100] * 100)
    timed = solve(snap, matrix, clock=lambda: next(ticks))
    assert timed["termination_reason"] == "time_limit_reached"
    assert not timed["dispatchable"]


@pytest.mark.parametrize(
    "body,status",
    [
        ({"code": "Ok", "durations": [[0, 120], [None, 0]]}, 200),
        ({"code": "NoTable"}, 200),
        ({"error": "limit"}, 429),
        ({"code": "Ok", "durations": [[-1]]}, 200),
    ],
)
def test_osrm_adapter(monkeypatch, body, status):
    original = httpx.Client
    calls = []

    def respond(request):
        calls.append(request)
        assert "fallback_speed" not in request.url.params
        assert "67.0,24.0;68.0,25.0" in str(request.url)
        return httpx.Response(status, json=body)

    monkeypatch.setattr(
        "api.road_times.httpx.Client",
        lambda **kwargs: original(transport=httpx.MockTransport(respond), **kwargs),
    )
    provider = OSRMRoadTimes("https://roads.invalid")
    args = [dict(latitude=24.0, longitude=67.0), dict(latitude=25.0, longitude=68.0)]
    if body.get("durations") == [[0, 120], [None, 0]]:
        assert provider.matrix(args) == [[0, 2], [None, 0]]
    else:
        with pytest.raises(TravelDataUnavailable):
            provider.matrix(args)
    assert len(calls) == 1


def seed_routing(engine):
    """Valid photo ownership/linked reports for both SQLite and real PostgreSQL."""
    ids = [uuid4() for _ in range(3)]
    jobs = [uuid4() for _ in range(3)]
    with Session(engine) as db:
        for index, cid in enumerate(ids):
            db.add(
                Crew(
                    id=cid,
                    name=f"Routing {index}",
                    equipment=[],
                    shift_minutes=1,
                    available=True,
                    start_location=dict(latitude=24.92, longitude=67.09),
                    location_recorded_at=now(),
                    location_received_at=now(),
                )
            )
        db.flush()
        for index, jid in enumerate(jobs):
            job = Job(
                id=jid,
                category="mixed_waste",
                required_equipment=["pickup_truck"],
                estimated_service_minutes=50,
                location=dict(latitude=24.92 + index * 0.001, longitude=67.09),
            )
            if index == 2:
                job.assigned_crew_id, job.status, job.route_position = (
                    ids[2],
                    "assigned",
                    0,
                )
            db.add(job)
            db.flush()
            rid, pid = uuid4(), uuid4()
            report = Report(
                id=rid,
                photo_id=pid,
                token_hash="a" * 64,
                job_id=jid,
                state="linked_to_job",
                location=job.location,
                assessment=assessment().model_dump(mode="json"),
                assessment_status="assessed",
                priority="routine",
                needs_review=False,
            )
            db.add(report)
            db.flush()
            db.add(
                Photo(
                    id=pid,
                    report_id=rid,
                    object_path=f"routing/{pid}.png",
                    content_type="image/png",
                    size_bytes=1,
                )
            )
        db.commit()
    return ids, jobs


class FakeRoads:
    def __init__(self, failure=False):
        self.calls = 0
        self.failure = failure

    def matrix(self, locations):
        self.calls += 1
        if self.failure:
            raise TravelDataUnavailable()
        return [[0 if a == b else 1 for b in locations] for a in locations]


def config():
    return Settings(
        _env_file=None, organizer_routing_enabled=True, routing_improvement_budget=200
    )


def test_preview_dispatch_preserves_unselected_and_ignores_equipment_shift(
    assessment_db, monkeypatch
):
    monkeypatch.setattr("api.routing.mutation_lock", lambda db: None)
    ids, jobs = seed_routing(assessment_db)
    roads, settings, actor = FakeRoads(), config(), uuid4()
    with Session(assessment_db) as db:
        preview = compute_preview(db, ids[:2], settings, roads, str(actor))
        assert preview.dispatchable and roads.calls == 1
        assert db.get(Job, jobs[0]).assigned_crew_id is None
        saved = db.get(RoutingPreview, preview.id)
        result = dispatch_preview(db, saved, uuid4(), actor, settings)
        assert db.get(Job, jobs[2]).assigned_crew_id == ids[2]
        assert db.get(Job, jobs[2]).version == 1
        assert db.get(Plan, result["plan_id"]).routing_mode == "organizer"
        assert len(db.get(Plan, result["plan_id"]).payload["assignments"]) == 3
        # Equipment and one-minute legacy shifts do not block dispatched work.
        ensure_can_start(db, db.get(Job, jobs[0]))
        repeat = dispatch_preview(db, saved, saved.dispatch_command_id, actor, settings)
        assert repeat == result and roads.calls == 1


@pytest.mark.parametrize(
    "change", ["version", "scope", "location", "stale", "partial", "settings"]
)
def test_dispatch_rejects_changed_or_partial_preview(
    assessment_db, monkeypatch, change
):
    monkeypatch.setattr("api.routing.mutation_lock", lambda db: None)
    ids, jobs = seed_routing(assessment_db)
    settings, actor = config(), uuid4()
    with Session(assessment_db) as db:
        preview = compute_preview(
            db, ids[:2], settings, FakeRoads(change == "partial"), str(actor)
        )
        if change == "version":
            db.get(Job, jobs[0]).version += 1
        elif change == "scope":
            db.get(Job, jobs[2]).assigned_crew_id = ids[0]
        elif change == "location":
            db.get(Crew, ids[0]).start_location = dict(latitude=25.5, longitude=67.09)
        elif change == "stale":
            db.get(Crew, ids[0]).location_recorded_at = now() - timedelta(minutes=10)
        elif change == "settings":
            settings.routing_location_max_age_seconds = 300
        db.commit()
        with pytest.raises(HTTPException) as exc:
            dispatch_preview(
                db, db.get(RoutingPreview, preview.id), uuid4(), actor, settings
            )
        assert exc.value.status_code == 409
        assert not list(db.scalars(select(Plan)))


def test_ongoing_snapshot_locks_prefix_and_counts_only_remaining_time(assessment_db):
    ids, jobs = seed_routing(assessment_db)
    with Session(assessment_db) as db:
        job = db.get(Job, jobs[0])
        job.assigned_crew_id, job.route_position, job.status = ids[0], 0, "in_progress"
        job.collection_started_at = now() - timedelta(minutes=3)
        job.travel_minutes = 100
        db.commit()
        snap = snapshot(db, ids[:2], config(), now())
        current = next(j for j in snap["jobs"] if j["id"] == str(jobs[0]))
        assert 1.9 < current["service"] <= 2
        assert snap["prefixes"][str(ids[0])] == [str(jobs[0])]
        job.collection_started_at = None
        db.flush()
        snap = snapshot(db, ids[:2], config(), now())
        current = next(j for j in snap["jobs"] if j["id"] == str(jobs[0]))
        assert (
            current["service"] == 5
            and current["service_source"] == "full_service_fallback"
        )


def test_unknown_priority_and_hazards_excluded(assessment_db):
    ids, jobs = seed_routing(assessment_db)
    with Session(assessment_db) as db:
        rows = list(db.scalars(select(Report).where(Report.job_id.in_(jobs[:2]))))
        rows[0].priority = None
        rows[1].needs_review = True
        db.commit()
        snap = snapshot(db, ids[:2], config(), now())
        assert snap["jobs"] == [] and len(snap["exclusions"]) == 2


def test_api_auth_gps_compute_and_dispatch(assessment_db, monkeypatch):
    monkeypatch.setattr("api.routing.mutation_lock", lambda db: None)
    ids, _ = seed_routing(assessment_db)
    org, crew = uuid4(), uuid4()
    with Session(assessment_db) as db:
        db.add_all(
            [
                StaffRole(user_id=org, role="organizer"),
                StaffRole(user_id=crew, role="crew", crew_id=ids[0]),
            ]
        )
        db.commit()
    app = create_app(config())
    app.state.engine = assessment_db
    app.state.cloud.close()
    app.state.cloud = SimpleNamespace(
        user_id=lambda token: {"org": org, "crew": crew}[token], close=lambda: None
    )
    app.state.road_times = FakeRoads()
    with TestClient(app) as client:
        h = lambda token: {"Authorization": f"Bearer {token}"}
        assert (
            client.post(
                "/routing/previews", json={"crew_ids": [str(ids[0])]}, headers=h("crew")
            ).status_code
            == 403
        )
        location = dict(
            location=dict(latitude=24.92, longitude=67.09),
            recorded_at=now().isoformat(),
        )
        assert (
            client.post(
                "/crews/me/location", json=location, headers=h("org")
            ).status_code
            == 403
        )
        assert (
            client.post(
                "/crews/me/location", json=location, headers=h("crew")
            ).status_code
            == 200
        )
        assert (
            client.post(
                "/crews/me/location", json=location, headers=h("crew")
            ).status_code
            == 409
        )
        response = client.post(
            "/routing/previews",
            json={"crew_ids": [str(c) for c in ids[:2]]},
            headers=h("org"),
        )
        assert response.status_code == 200, response.text
        preview = response.json()
        command = dict(command_id=str(uuid4()))
        response = client.post(
            f"/routing/previews/{preview['id']}/dispatch",
            json=command,
            headers=h("org"),
        )
        assert response.status_code == 200, response.text
        assert client.get("/plans/current", headers=h("org")).status_code == 200
        assert (
            client.post("/plans/generate", json=command, headers=h("org")).status_code
            == 409
        )


def test_fresh_nearby_gps_does_not_invalidate_business_snapshot(
    assessment_db, monkeypatch
):
    monkeypatch.setattr("api.routing.mutation_lock", lambda db: None)
    ids, _ = seed_routing(assessment_db)
    actor, settings = uuid4(), config()
    with Session(assessment_db) as db:
        preview = compute_preview(db, ids[:2], settings, FakeRoads(), str(actor))
        crew = db.get(Crew, ids[0])
        crew.start_location = dict(latitude=24.92001, longitude=67.09)
        crew.location_recorded_at = crew.location_received_at = now()
        crew.location_revision += 1
        db.commit()
        assert dispatch_preview(
            db, db.get(RoutingPreview, preview.id), uuid4(), actor, settings
        )["plan_id"]


def test_locked_prefix_preserves_intervening_jobs_and_unselected_crew(assessment_db):
    ids, jobs = seed_routing(assessment_db)
    with Session(assessment_db) as db:
        for position, jid in enumerate(jobs[:2]):
            row = db.get(Job, jid)
            row.assigned_crew_id, row.route_position, row.status = (
                ids[0],
                position,
                "assigned",
            )
        db.get(Job, jobs[1]).locked = True
        db.commit()
        snap = snapshot(db, ids[:2], config(), now())
        assert snap["prefixes"][str(ids[0])] == [str(j) for j in jobs[:2]]
        result = solve(
            snap,
            [[0 if a == b else 2 for b in snap["node_ids"]] for a in snap["node_ids"]],
            clock=lambda: 0,
        )
        route = next(r for r in result["routes"] if r["crew_id"] == str(ids[0]))
        assert [s["job_id"] for s in route["stops"]] == [str(j) for j in jobs[:2]]


def test_legacy_worker_cannot_overwrite_dispatched_organizer_plan(
    assessment_db, monkeypatch
):
    from api.workflows import apply_plan, build_planning_input
    from tests.backend.providers import TestProvider

    monkeypatch.setattr("api.routing.mutation_lock", lambda db: None)
    ids, _ = seed_routing(assessment_db)
    actor, settings = uuid4(), config()
    with Session(assessment_db) as db:
        preview = compute_preview(db, ids[:2], settings, FakeRoads(), str(actor))
        dispatch_preview(
            db, db.get(RoutingPreview, preview.id), uuid4(), actor, settings
        )
        proposal = TestProvider().generate_plan(build_planning_input(db))
        with pytest.raises(HTTPException) as exc:
            apply_plan(db, proposal)
        assert exc.value.status_code == 409


def test_ongoing_work_does_not_prevent_other_crew_starting_after_invalidation(
    assessment_db, monkeypatch
):
    from api.schemas import JobPatch
    from api.workflows import change_job

    monkeypatch.setattr("api.routing.mutation_lock", lambda db: None)
    ids, jobs = seed_routing(assessment_db)
    actor, settings = uuid4(), config()
    with Session(assessment_db) as db:
        preview = compute_preview(db, ids[:2], settings, FakeRoads(), str(actor))
        dispatch_preview(
            db, db.get(RoutingPreview, preview.id), uuid4(), actor, settings
        )
        first, second = [db.get(Job, jid) for jid in jobs[:2]]
        assert first.assigned_crew_id != second.assigned_crew_id
        change_job(
            db,
            first,
            JobPatch(
                command_id=uuid4(), expected_version=first.version, status="in_progress"
            ),
            str(actor),
            False,
        )
        db.commit()
        assert first.collection_started_at is not None
        assert db.scalar(select(Plan)).stale
        ensure_can_start(db, second)


@pytest.mark.parametrize(
    "edit", [{"shift_minutes": 1, "equipment": []}, {"available": False}]
)
def test_legacy_resource_edits_preserve_organizer_assignments(
    assessment_db, monkeypatch, edit
):
    from api.schemas import CrewPatch
    from api.workflows import change_crew

    monkeypatch.setattr("api.routing.mutation_lock", lambda db: None)
    ids, jobs = seed_routing(assessment_db)
    actor, settings = uuid4(), config()
    with Session(assessment_db) as db:
        view = compute_preview(db, ids[:2], settings, FakeRoads(), str(actor))
        dispatch_preview(db, db.get(RoutingPreview, view.id), uuid4(), actor, settings)
        job = db.get(Job, jobs[0])
        owner = job.assigned_crew_id
        crew = db.get(Crew, owner)
        change_crew(
            db,
            crew,
            CrewPatch(
                command_id=uuid4(),
                expected_version=crew.version,
                **edit,
            ),
            str(actor),
            organizer_routing=True,
        )
        db.commit()
        assert db.get(Job, jobs[0]).assigned_crew_id == owner
        assert db.get(Job, jobs[0]).status == "assigned"


def test_osrm_timeout_is_unavailable_not_unreachable(monkeypatch):
    original = httpx.Client
    calls = []

    def respond(request):
        calls.append(request)
        raise httpx.ReadTimeout("timeout", request=request)

    monkeypatch.setattr(
        "api.road_times.httpx.Client",
        lambda **kwargs: original(transport=httpx.MockTransport(respond), **kwargs),
    )
    with pytest.raises(TravelDataUnavailable):
        OSRMRoadTimes("https://roads.invalid").matrix([dict(latitude=24, longitude=67)])
    assert len(calls) == 1


@pytest.mark.parametrize("state", ["approved", "held", "pending"])
def test_organizer_priority_choice_is_audited_without_clearing_review(
    assessment_db, state
):
    from api.models import Event

    ids, jobs = seed_routing(assessment_db)
    org, crew = uuid4(), uuid4()
    raw = assessment(obstruction="unknown", obstruction_level="unknown").model_dump(
        mode="json"
    )
    with Session(assessment_db) as db:
        row = db.scalar(select(Report).where(Report.job_id == jobs[0]))
        rid = row.id
        row.priority, row.assessment = None, raw
        row.assessment_status = "pending" if state == "pending" else "needs_review"
        row.needs_review = row.organizer_review_required = state != "approved"
        if state == "approved":
            db.add(
                Event(
                    report_id=rid,
                    kind="report.triaged",
                    actor=str(org),
                    details={
                        "organizer_override": True,
                        "job_id": str(jobs[0]),
                        "reason": "Prior audited organiser approval",
                    },
                )
            )
        db.add_all(
            [
                StaffRole(user_id=org, role="organizer"),
                StaffRole(user_id=crew, role="crew", crew_id=ids[0]),
            ]
        )
        db.commit()
    app = create_app(config())
    app.state.engine = assessment_db
    app.state.cloud.close()
    app.state.cloud = SimpleNamespace(
        user_id=lambda token: {"org": org, "crew": crew}[token], close=lambda: None
    )
    with TestClient(app) as client:
        body = dict(
            command_id=str(uuid4()),
            expected_version=1,
            priority="high",
            reason="Reviewed access obstruction on site",
        )
        url = f"/organizer/reports/{rid}/priority"
        assert (
            client.post(
                url, json=body, headers={"Authorization": "Bearer crew"}
            ).status_code
            == 403
        )
        response = client.post(url, json=body, headers={"Authorization": "Bearer org"})
        assert response.status_code == (
            409 if state == "pending" else 200
        ), response.text
        if state == "pending":
            return
        assert response.json()["priority"] == "high"
        assert response.json()["needs_review"] == (state == "held")
        assert response.json()["assessment"] == raw
        assert (
            client.post(
                url, json=body, headers={"Authorization": "Bearer org"}
            ).status_code
            == 200
        )
        with Session(assessment_db) as db:
            records = list(
                db.scalars(select(Event).where(Event.kind == "report.priority_set"))
            )
            assert len(records) == 1 and records[0].actor == str(org)
            assert records[0].details["reason"] == body["reason"]
            assert records[0].details["previous_priority"] is None
            snap = snapshot(db, ids[:2], config(), now())
            assert (str(jobs[0]) in {j["id"] for j in snap["jobs"]}) == (
                state == "approved"
            )


def seed_valid_legacy_assignment(engine):
    from api.models import Event
    from api.schemas import PlanProposal, PlanStop, UnassignedJob
    from api.workflows import apply_plan, build_planning_input

    ids, jobs = seed_routing(engine)
    with Session(engine) as db:
        crew = db.get(Crew, ids[2])
        crew.equipment, crew.shift_minutes = ["pickup_truck"], 55
        report = db.scalar(select(Report).where(Report.job_id == jobs[2]))
        report.priority = None
        report.assessment_status = "needs_review"
        report.assessment = assessment(
            obstruction="unknown", obstruction_level="unknown"
        ).model_dump(mode="json")
        db.add(
            Event(
                report_id=report.id,
                kind="report.triaged",
                details={
                    "organizer_override": True,
                    "job_id": str(jobs[2]),
                    "reason": "Manual legacy approval",
                },
            )
        )
        db.flush()
        request = build_planning_input(db)
        plan = apply_plan(
            db,
            PlanProposal(
                revision=request.revision,
                travel_estimates_label=request.travel_estimates_label,
                assignments=[
                    PlanStop(
                        job_id=jobs[2],
                        crew_id=ids[2],
                        position=0,
                        service_minutes=50,
                        travel_minutes=1,
                    )
                ],
                unassigned=[
                    UnassignedJob(job_id=jid, reason_code="shift_limit")
                    for jid in jobs[:2]
                ],
            ),
        )
        db.commit()
        ensure_can_start(db, db.get(Job, jobs[2]))
        return ids, jobs, plan.id


def verify_preserved_legacy_start(engine):
    ids, jobs, legacy_id = seed_valid_legacy_assignment(engine)
    actor, settings = uuid4(), config()
    with Session(engine) as db:
        view = compute_preview(db, ids[:2], settings, FakeRoads(), str(actor))
        result = dispatch_preview(
            db, db.get(RoutingPreview, view.id), uuid4(), actor, settings
        )
        rule = db.get(Plan, result["plan_id"]).payload["execution_rules"][str(jobs[2])]
        assert rule == {"mode": "legacy", "source_plan_id": str(legacy_id)}
        assert (
            db.scalar(select(Report).where(Report.job_id == jobs[2])).priority is None
        )
        ensure_can_start(db, db.get(Job, jobs[2]))
        # Keep the original execution rules, rather than dropping all checks.
        db.get(Crew, ids[2]).shift_minutes = 1
        db.flush()
        with pytest.raises(HTTPException) as exc:
            ensure_can_start(db, db.get(Job, jobs[2]))
        assert exc.value.status_code == 409


def test_unselected_legacy_null_priority_remains_startable(assessment_db, monkeypatch):
    monkeypatch.setattr("api.routing.mutation_lock", lambda db: None)
    verify_preserved_legacy_start(assessment_db)


def verify_preserved_preview_durations(engine):
    from api.schemas import StoredPlan

    ids, jobs = seed_routing(engine)
    actor, settings = uuid4(), config()
    with Session(engine) as db:
        ongoing = db.get(Job, jobs[0])
        ongoing.status, ongoing.assigned_crew_id, ongoing.route_position = (
            "in_progress",
            ids[0],
            0,
        )
        ongoing.collection_started_at = now() - timedelta(minutes=3)
        db.commit()
        preview = compute_preview(db, ids[:1], settings, FakeRoads(), str(actor))
        approved = {
            str(s.job_id): s.model_dump(mode="json")
            for r in preview.routes
            for s in r.stops
        }
        assert 1.9 < approved[str(jobs[0])]["service_minutes"] < 2.01
        result = dispatch_preview(
            db, db.get(RoutingPreview, preview.id), uuid4(), actor, settings
        )
        first = db.get(Plan, result["plan_id"])
        saved = {s["job_id"]: s for s in first.payload["assignments"]}
        for jid, stop in approved.items():
            assert saved[jid]["service_minutes"] == stop["service_minutes"]
            assert saved[jid]["travel_minutes"] == stop["travel_minutes"]
        StoredPlan.model_validate(
            {
                **first.payload,
                "id": first.id,
                "created_at": first.created_at,
                "stale": first.stale,
            }
        )
        # Select a different crew; neither prior stop belongs to this new scope.
        next_preview = compute_preview(db, ids[1:2], settings, FakeRoads(), str(actor))
        second_result = dispatch_preview(
            db, db.get(RoutingPreview, next_preview.id), uuid4(), actor, settings
        )
        second = db.get(Plan, second_result["plan_id"])
        next_saved = {s["job_id"]: s for s in second.payload["assignments"]}
        for jid in approved:
            assert next_saved[jid] == saved[jid]
            assert (
                second.payload["execution_rules"][jid]
                == first.payload["execution_rules"][jid]
            )
        assert db.get(Job, jobs[1]).estimated_service_minutes == 50
        assert next_saved[str(jobs[1])]["service_minutes"] == 5


def test_ongoing_preview_duration_survives_disjoint_dispatch(
    assessment_db, monkeypatch
):
    monkeypatch.setattr("api.routing.mutation_lock", lambda db: None)
    verify_preserved_preview_durations(assessment_db)


@pytest.fixture
def routing_api(assessment_db):
    ids, jobs = seed_routing(assessment_db)
    org, crew = uuid4(), uuid4()
    with Session(assessment_db) as db:
        db.add_all(
            [
                StaffRole(user_id=org, role="organizer"),
                StaffRole(user_id=crew, role="crew", crew_id=ids[0]),
            ]
        )
        db.commit()
    app = create_app(config())
    app.state.engine = assessment_db
    app.state.cloud.close()
    app.state.cloud = SimpleNamespace(
        user_id=lambda token: {"org": org, "crew": crew}[token], close=lambda: None
    )
    with TestClient(app) as client:
        yield client, ids, jobs


@pytest.mark.parametrize(
    "mutation", [{"assigned_crew_id": None}, {"status": "unassigned"}, {"held": True}]
)
def test_organizer_patch_cannot_release_route_ownership(
    routing_api, assessment_db, mutation
):
    client, ids, jobs = routing_api
    with Session(assessment_db) as db:
        original = db.get(Job, jobs[2])
        before = (
            original.assigned_crew_id,
            original.route_position,
            original.travel_minutes,
            original.version,
            original.held,
            original.status,
        )
    response = client.patch(
        f"/jobs/{jobs[2]}",
        headers={"Authorization": "Bearer org"},
        json={
            "command_id": str(uuid4()),
            "expected_version": 1,
            "reason": "Legacy ownership bypass",
            **mutation,
        },
    )
    assert response.status_code == 409, response.text
    with Session(assessment_db) as db:
        after = db.get(Job, jobs[2])
        assert (
            after.assigned_crew_id,
            after.route_position,
            after.travel_minutes,
            after.version,
            after.held,
            after.status,
        ) == before


def verify_recheck_route_resolution(client, engine, ids, jobs):
    from api.schemas import Recheck
    from api.services import apply_recheck

    actor, settings = uuid4(), config()
    with Session(engine) as db:
        preview = compute_preview(db, ids[:1], settings, FakeRoads(), str(actor))
        route = preview.routes[0]
        first_id, next_id = [stop.job_id for stop in route.stops]
        dispatch_preview(
            db, db.get(RoutingPreview, preview.id), uuid4(), actor, settings
        )
        first = db.get(Job, first_id)
        first.status = "completed"
        first.version += 1
        db.flush()
        report = db.scalar(select(Report).where(Report.job_id == first.id))
        apply_recheck(
            db,
            report,
            Recheck(
                command_id=uuid4(),
                expected_version=first.version,
                reason="Waste remains after cleanup",
            ),
        )
        db.commit()
        version = first.version
        before_other = (
            db.get(Job, jobs[2]).version,
            db.get(Job, jobs[2]).assigned_crew_id,
        )

    def patch(job_id, token, body):
        return client.patch(
            f"/jobs/{job_id}", headers={"Authorization": f"Bearer {token}"}, json=body
        )

    start = {"command_id": str(uuid4()), "expected_version": 2, "status": "in_progress"}
    assert patch(next_id, "crew", start).status_code == 409
    with Session(engine) as db:
        assert not compute_preview(
            db, ids[:1], settings, FakeRoads(), str(actor)
        ).dispatchable
    release = {
        "command_id": str(uuid4()),
        "expected_version": version,
        "status": "unassigned",
        "reason": "Reviewed resident evidence; release for replanning",
    }
    assert patch(first_id, "crew", release).status_code == 409
    stale = {**release, "command_id": str(uuid4()), "expected_version": version - 1}
    assert patch(first_id, "org", stale).status_code == 409
    assert (
        patch(
            first_id, "org", {k: v for k, v in release.items() if k != "reason"}
        ).status_code
        == 422
    )
    for extra in ({"held": True}, {"assigned_crew_id": None}, {"locked": False}):
        assert patch(first_id, "org", {**release, **extra}).status_code == 409
    response = patch(first_id, "org", release)
    assert response.status_code == 200, response.text
    for _ in range(2):
        assert patch(first_id, "org", release).status_code == 200
    assert (
        patch(
            first_id, "org", {**release, "reason": "Different command content"}
        ).status_code
        == 409
    )
    assert patch(next_id, "crew", start).status_code == 200
    with Session(engine) as db:
        first = db.get(Job, first_id)
        assert first.status == "unassigned" and first.assigned_crew_id is None
        assert (
            first.route_position is None
            and first.travel_minutes == 0
            and not first.locked
        )
        assert first.version == version + 1
        records = list(
            db.scalars(
                select(Event).where(Event.command_id == UUID(release["command_id"]))
            )
        )
        assert len(records) == 1 and records[0].details["reason"] == release["reason"]
        assert (
            db.get(Job, jobs[2]).version,
            db.get(Job, jobs[2]).assigned_crew_id,
        ) == before_other
        preview = compute_preview(db, ids[:1], settings, FakeRoads(), str(actor))
        assert preview.dispatchable
        dispatch_preview(
            db, db.get(RoutingPreview, preview.id), uuid4(), actor, settings
        )
        assert db.get(Job, first_id).assigned_crew_id == ids[0]


def test_audited_recheck_release_restores_route_and_replanning(
    routing_api, assessment_db, monkeypatch
):
    monkeypatch.setattr("api.routing.mutation_lock", lambda db: None)
    client, ids, jobs = routing_api
    verify_recheck_route_resolution(client, assessment_db, ids, jobs)


def test_disabled_routing_blocks_new_priority_and_location_writes(
    routing_api, assessment_db
):
    client, ids, jobs = routing_api
    client.app.state.settings.organizer_routing_enabled = False
    with Session(assessment_db) as db:
        report = db.scalar(select(Report).where(Report.job_id == jobs[0]))
        rid, version, priority = report.id, report.version, report.priority
        crew = db.get(Crew, ids[0])
        location, revision = crew.start_location, crew.location_revision
    assert (
        client.post(
            f"/organizer/reports/{rid}/priority",
            headers={"Authorization": "Bearer org"},
            json={
                "command_id": str(uuid4()),
                "expected_version": version,
                "priority": "high",
                "reason": "Disabled mode",
            },
        ).status_code
        == 503
    )
    assert (
        client.post(
            "/crews/me/location",
            headers={"Authorization": "Bearer crew"},
            json={
                "location": {"latitude": 25, "longitude": 68},
                "recorded_at": now().isoformat(),
            },
        ).status_code
        == 503
    )
    with Session(assessment_db) as db:
        assert db.get(Report, rid).priority == priority
        assert db.get(Report, rid).version == version
        assert db.get(Crew, ids[0]).start_location == location
        assert db.get(Crew, ids[0]).location_revision == revision


@pytest.mark.parametrize("crew_id,status", [(None, 403), (uuid4(), 404)])
def test_location_with_missing_crew_link_is_controlled(routing_api, crew_id, status):
    from api.auth import Principal, get_staff

    client, _, _ = routing_api
    client.app.dependency_overrides[get_staff] = lambda: Principal(
        uuid4(), "crew", crew_id
    )
    response = client.post(
        "/crews/me/location",
        json={
            "location": {"latitude": 24.92, "longitude": 67.09},
            "recorded_at": now().isoformat(),
        },
    )
    assert response.status_code == status, response.text


@pytest.mark.parametrize(
    "kind,promote",
    [
        ("pending", False),
        ("held", False),
        ("blocked", False),
        ("review", False),
        ("review", True),
    ],
)
def test_excluded_unassigned_changes_only_invalidate_on_eligibility(
    assessment_db, monkeypatch, kind, promote
):
    monkeypatch.setattr("api.routing.mutation_lock", lambda db: None)
    ids, jobs = seed_routing(assessment_db)
    actor, settings = uuid4(), config()
    with Session(assessment_db) as db:
        job = db.get(Job, jobs[0])
        report = db.scalar(select(Report).where(Report.job_id == job.id))
        if kind == "pending":
            report.assessment_status = "pending"
        elif kind == "held":
            job.held = True
        elif kind == "blocked":
            job.status = "blocked"
        else:
            report.needs_review = True
        db.commit()
        view = compute_preview(db, ids[:2], settings, FakeRoads(), str(actor))
        assert str(jobs[0]) in {str(i.job_id) for i in view.exclusions}
        job.version += 1
        report.version += 1
        if promote:
            report.needs_review = False
        db.commit()
        if promote:
            with pytest.raises(HTTPException) as exc:
                dispatch_preview(
                    db, db.get(RoutingPreview, view.id), uuid4(), actor, settings
                )
            assert exc.value.status_code == 409
        else:
            assert dispatch_preview(
                db, db.get(RoutingPreview, view.id), uuid4(), actor, settings
            )["plan_id"]
            assert db.get(Job, jobs[0]).assigned_crew_id is None


def count_selects(engine, run):
    from sqlalchemy import event as sa_event

    statements = []

    def capture(connection, cursor, statement, params, context, many):
        if statement.lstrip().upper().startswith("SELECT"):
            statements.append(statement)

    sa_event.listen(engine, "before_cursor_execute", capture)
    try:
        run()
    finally:
        sa_event.remove(engine, "before_cursor_execute", capture)
    return statements


def verify_batched_approval_reads(engine, extra):
    from api.models import Event

    ids, _ = seed_routing(engine)
    for _ in range(extra):
        seed_routing(engine)
    with Session(engine) as db:
        for row in db.scalars(
            select(Report)
            .join(Job, Job.id == Report.job_id)
            .where(Job.assigned_crew_id.is_(None))
        ):
            row.assessment_status = "needs_review"
            row.assessment = assessment(
                obstruction="unknown", obstruction_level="unknown"
            ).model_dump(mode="json")
            db.add(
                Event(
                    report_id=row.id,
                    kind="report.triaged",
                    details={"organizer_override": True, "job_id": str(row.job_id)},
                )
            )
        db.commit()

    def run():
        with Session(engine) as db:
            value = snapshot(db, ids[:2], config(), now())
            assert len(value["jobs"]) == 2 * (extra + 1)

    statements = count_selects(engine, run)
    # Crews, scoped jobs, reports, and all fallback approvals: four reads total.
    assert len(statements) == 4, statements


@pytest.mark.parametrize("extra", [0, 4])
def test_snapshot_batches_report_and_approval_reads(assessment_db, extra):
    verify_batched_approval_reads(assessment_db, extra)


def verify_batched_dispatch_reads(engine, extra):
    ids, jobs = seed_routing(engine)
    with Session(engine) as db:
        for position in range(1, extra + 1):
            db.add(
                Job(
                    status="assigned",
                    assigned_crew_id=ids[2],
                    route_position=position,
                    location=dict(latitude=24.92, longitude=67.09),
                    category="legacy",
                    estimated_service_minutes=50,
                    required_equipment=[],
                )
            )
        db.commit()
        actor, settings = uuid4(), config()
        view = compute_preview(db, ids[:2], settings, FakeRoads(), str(actor))
        preview = db.get(RoutingPreview, view.id)
        reads = count_selects(
            engine, lambda: dispatch_preview(db, preview, uuid4(), actor, settings)
        )
        provenance_reads = [
            s
            for s in reads
            if "wastegrid.plans" in s or "wastegrid.routing_previews" in s
        ]
        assert len(provenance_reads) <= 6, provenance_reads
        assert db.get(Job, jobs[2]).assigned_crew_id == ids[2]


@pytest.mark.parametrize("extra", [0, 30])
def test_dispatch_provenance_reads_do_not_scale_per_unselected_job(
    assessment_db, monkeypatch, extra
):
    monkeypatch.setattr("api.routing.mutation_lock", lambda db: None)
    verify_batched_dispatch_reads(assessment_db, extra)
