"""Remaining route budgets, resource compatibility and deliberate partial coverage."""

from copy import deepcopy

import pytest

from api.route_solver import evaluate, solve


def scenario(priorities=("routine", "high", "medium"), crews=2, **constraints):
    snap = {
        "jobs": [
            {
                "id": f"j{i}",
                "priority": priority,
                "service": 5,
                "ongoing": False,
                "service_source": "fixed_collection_time",
                "required_equipment": [],
                "previous_crew_id": None,
            }
            for i, priority in enumerate(priorities)
        ],
        "prefixes": {f"c{i}": [] for i in range(crews)},
        "resources": {
            f"c{i}": {"equipment": [], "shift_minutes": 480} for i in range(crews)
        },
        "node_ids": [f"crew:c{i}" for i in range(crews)]
        + [f"job:j{i}" for i in range(len(priorities))],
        "settings": {
            "alpha": 1,
            "beta": 1,
            "gamma": 0.25,
            "improvement_budget": 10000,
            "solver_seconds": 5,
            "constraints": {
                "max_duration_minutes": None,
                "max_stops_per_crew": 25,
                "return_to_start": False,
                "allow_partial": False,
                **constraints,
            },
        },
    }
    n = len(snap["node_ids"])
    return snap, [[0 if a == b else 2 for b in range(n)] for a in range(n)]


def planned(result):
    return {stop["job_id"] for route in result["routes"] for stop in route["stops"]}


def test_return_leg_is_directional_and_changes_duration_without_stop_completion():
    snap, _ = scenario(("high",), return_to_start=True)
    matrix = [[0, 2, 1], [3, 0, 4], [11, 7, 0]]
    result = evaluate(snap, matrix, {"c0": ["j0"], "c1": []})
    route, empty = result["routes"]
    assert route["stops"][0]["completion_minutes"] == 6
    assert route["return_travel_minutes"] == 11
    assert route["travel_minutes"] == 12
    assert route["duration_minutes"] == 17
    assert route["returns_to_start"] is True
    assert empty["returns_to_start"] is True
    assert empty["return_travel_minutes"] == 0
    assert empty["duration_minutes"] == 0
    assert result["metrics"]["weighted_wait"] == 6
    assert result["metrics"]["latest_finish"] == 17
    assert result["metrics"]["total_travel"] == 12
    assert result["metrics"]["score"] == pytest.approx(6 + 17 + 0.25 * 12)


def test_return_budget_can_select_a_different_crew():
    snap, _ = scenario(("high",), return_to_start=True)
    snap["resources"]["c0"]["shift_minutes"] = 15
    matrix = [[0, 2, 1], [3, 0, 4], [11, 7, 0]]
    result = solve(snap, matrix, clock=lambda: 0)
    assert result["dispatchable"]
    assert not result["routes"][0]["stops"]
    assert result["routes"][1]["stops"][0]["job_id"] == "j0"
    assert result["routes"][1]["duration_minutes"] == 16


def test_missing_return_edge_only_blocks_requested_round_trip():
    snap, matrix = scenario(("routine",), crews=1)
    matrix[1][0] = None
    assert solve(snap, matrix, clock=lambda: 0)["dispatchable"]
    snap["settings"]["constraints"]["return_to_start"] = True
    result = solve(snap, matrix, clock=lambda: 0)
    assert not result["dispatchable"]
    assert result["unassigned"] == [{"job_id": "j0", "reason": "no_usable_route_found"}]


def test_equipment_matching_routes_to_compatible_crew_and_explains_no_match():
    snap, matrix = scenario(("routine", "high"))
    snap["jobs"][0]["required_equipment"] = ["gloves", "truck"]
    snap["jobs"][1]["required_equipment"] = ["hazmat"]
    snap["resources"]["c0"]["equipment"] = ["gloves"]
    snap["resources"]["c1"]["equipment"] = ["gloves", "truck", "bags"]
    snap["settings"]["constraints"]["allow_partial"] = True
    result = solve(snap, matrix, clock=lambda: 0)
    assert result["dispatchable"]
    assert planned(result) == {"j0"}
    assert result["routes"][1]["stops"][0]["job_id"] == "j0"
    assert result["unassigned"] == [{"job_id": "j1", "reason": "equipment_mismatch"}]


@pytest.mark.parametrize("partial", [False, True])
def test_max_stops_keeps_higher_weight_coverage_and_requires_explicit_partial(partial):
    snap, matrix = scenario(max_stops_per_crew=1, allow_partial=partial)
    result = solve(snap, matrix, clock=lambda: 0)
    assert result["dispatchable"] is partial
    assert planned(result) == {"j1", "j2"}
    assert result["unassigned"] == [{"job_id": "j0", "reason": "max_stops"}]
    assert all(len(route["stops"]) == 1 for route in result["routes"])


@pytest.mark.parametrize(
    "crew_budget,request_budget", [(10, None), (480, 10), (10, 20)]
)
def test_duration_uses_lower_remaining_route_or_request_budget(
    crew_budget, request_budget
):
    snap, matrix = scenario(
        ("routine", "high"),
        crews=1,
        max_duration_minutes=request_budget,
        allow_partial=True,
    )
    snap["resources"]["c0"]["shift_minutes"] = crew_budget
    result = solve(snap, matrix, clock=lambda: 0)
    assert result["dispatchable"]
    assert planned(result) == {"j1"}
    assert result["routes"][0]["duration_minutes"] == 7
    # A failed insertion does not prove another arrangement is globally impossible.
    assert result["unassigned"] == [{"job_id": "j0", "reason": "search_incomplete"}]


def test_service_exceeding_every_compatible_budget_has_provable_duration_reason():
    snap, matrix = scenario(("routine",), max_duration_minutes=4)
    result = solve(snap, matrix, clock=lambda: 0)
    assert not result["dispatchable"]
    assert result["unassigned"] == [{"job_id": "j0", "reason": "duration_limit"}]


@pytest.mark.parametrize(
    "change,reason",
    [
        ("equipment", "equipment_mismatch"),
        ("duration", "duration_limit"),
        ("stops", "max_stops"),
        ("road", "no_usable_route_found"),
    ],
)
def test_invalid_fixed_prefix_is_not_dropped_for_optional_work(change, reason):
    snap, matrix = scenario(("routine", "high"), crews=1, allow_partial=True)
    snap["prefixes"]["c0"] = ["j0"]
    snap["jobs"][0]["previous_crew_id"] = "c0"
    if change == "equipment":
        snap["jobs"][0]["required_equipment"] = ["truck"]
    elif change == "duration":
        snap["resources"]["c0"]["shift_minutes"] = 4
    elif change == "stops":
        snap["settings"]["constraints"]["max_stops_per_crew"] = 0
    else:
        matrix[0][1] = None
    result = solve(snap, matrix, clock=lambda: 0)
    assert not result["dispatchable"]
    assert result["routes"] == []
    assert {item["job_id"] for item in result["unassigned"]} == {"j0", "j1"}
    assert all(item["reason"] == reason for item in result["unassigned"])


def test_partial_preserves_existing_unlocked_assignment_before_optional_high():
    snap, matrix = scenario(
        ("routine", "high"), crews=1, max_stops_per_crew=1, allow_partial=True
    )
    snap["jobs"][0]["previous_crew_id"] = "c0"
    result = solve(snap, matrix, clock=lambda: 0)
    assert result["dispatchable"]
    assert planned(result) == {"j0"}
    assert result["unassigned"] == [{"job_id": "j1", "reason": "max_stops"}]


def test_partial_never_omits_preassigned_job_even_when_optional_job_fits():
    snap, matrix = scenario(("routine", "high"), crews=1, allow_partial=True)
    snap["jobs"][0].update(previous_crew_id="c0", required_equipment=["truck"])
    result = solve(snap, matrix, clock=lambda: 0)
    assert planned(result) == {"j1"}
    assert not result["dispatchable"]


def test_local_replacement_unblocks_high_after_two_routine_stops_fill_capacity():
    snap, _ = scenario(
        ("routine", "routine", "high"),
        crews=1,
        max_stops_per_crew=2,
        allow_partial=True,
    )
    matrix = [
        [0, 2, 1, None],
        [None, 0, 1, 1],
        [None, 1, 0, None],
        [None, None, None, 0],
    ]
    result = solve(snap, matrix, clock=lambda: 0)
    assert result["dispatchable"]
    assert [s["job_id"] for s in result["routes"][0]["stops"]] == ["j0", "j2"]
    initial_only = deepcopy(snap)
    initial_only["settings"]["improvement_budget"] = 0
    assert planned(solve(initial_only, matrix, clock=lambda: 0)) == {"j0", "j1"}


@pytest.mark.parametrize("service,covered_count", [(2, 4), (3, 3)])
def test_several_routines_can_replace_one_high_by_weight_then_count(
    service, covered_count
):
    snap, matrix = scenario(
        ("high", "routine", "routine", "routine", "routine"),
        crews=1,
        max_duration_minutes=10,
        allow_partial=True,
    )
    for row in matrix:
        row[:] = [0] * len(row)
    snap["jobs"][0]["service"] = 10
    for job in snap["jobs"][1:]:
        job["service"] = service
    # Four routines win on priority weight; three tie weight and win on stop count.
    result = solve(snap, matrix, clock=lambda: 0)
    assert result["dispatchable"]
    assert "j0" not in planned(result)
    assert len(planned(result)) == covered_count


def test_timeout_and_zero_search_budget_are_bounded_and_reported():
    snap, matrix = scenario(max_stops_per_crew=1, allow_partial=True)
    snap["settings"]["improvement_budget"] = 0
    result = solve(snap, matrix, clock=lambda: 0)
    assert result["termination_reason"] == "iteration_limit_reached"
    ticks = iter([0] + [100] * 100)
    timed = solve(snap, matrix, clock=lambda: next(ticks))
    assert timed["termination_reason"] == "time_limit_reached"
    assert not timed["dispatchable"]


def test_old_pure_snapshot_without_resource_or_constraint_fields_remains_unrestricted():
    snap, matrix = scenario(("routine", "high"), crews=1)
    del snap["resources"]
    del snap["settings"]["constraints"]
    snap["jobs"][0]["required_equipment"] = ["truck"]
    result = solve(snap, matrix, clock=lambda: 0)
    assert result["dispatchable"]
    assert planned(result) == {"j0", "j1"}
    assert result["routes"][0]["return_travel_minutes"] == 0
    assert result["routes"][0]["returns_to_start"] is False
