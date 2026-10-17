"""Directed routing, priority trade-offs and persisted preview/dispatch regressions."""

from datetime import timedelta
from itertools import permutations, product
from types import SimpleNamespace
from uuid import uuid4

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


def test_legacy_resource_edits_preserve_organizer_assignments(
    assessment_db, monkeypatch
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
                shift_minutes=1,
                equipment=[],
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
