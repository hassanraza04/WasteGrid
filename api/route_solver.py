"""Small deterministic priority-aware insertion/local-search heuristic, no I/O."""

from copy import deepcopy
from time import monotonic

PRIORITY_WEIGHTS = {"high": 3, "medium": 2, "routine": 1}


def _crew_budget(snapshot, cid):
    constraints = snapshot["settings"].get("constraints", {})
    resource = snapshot.get("resources", {}).get(cid, {})
    limits = [
        value
        for value in (
            constraints.get("max_duration_minutes"),
            resource.get("shift_minutes"),
        )
        if value is not None
    ]
    return min(limits) if limits else float("inf")


def _compatible(snapshot, cid, job):
    resource = snapshot.get("resources", {}).get(cid)
    return resource is None or set(job.get("required_equipment", [])) <= set(
        resource["equipment"]
    )


def _evaluate(snapshot, matrix, routes):
    jobs = {j["id"]: j for j in snapshot["jobs"]}
    nodes = {node: i for i, node in enumerate(snapshot["node_ids"])}
    constraints = snapshot["settings"].get("constraints", {})
    returning = constraints.get("return_to_start", False)
    weighted, travel, latest, output = 0.0, 0.0, 0.0, []
    for cid in sorted(routes):
        elapsed, crew_travel, previous, stops = 0.0, 0.0, f"crew:{cid}", []
        prefix = snapshot["prefixes"][cid]
        max_stops = constraints.get("max_stops_per_crew")
        if max_stops is not None and len(routes[cid]) > max_stops:
            return None, "max_stops"
        for position, jid in enumerate(routes[cid]):
            job = jobs[jid]
            if not _compatible(snapshot, cid, job):
                return None, "equipment_mismatch"
            leg = (
                0.0 if job["ongoing"] else matrix[nodes[previous]][nodes[f"job:{jid}"]]
            )
            if leg is None:
                return None, "no_usable_route_found"
            elapsed += leg + job["service"]
            crew_travel += leg
            weighted += PRIORITY_WEIGHTS[job["priority"]] * elapsed
            stops.append(
                dict(
                    job_id=jid,
                    position=position,
                    priority=job["priority"],
                    travel_minutes=leg,
                    service_minutes=job["service"],
                    completion_minutes=elapsed,
                    fixed=position < len(prefix),
                    service_estimate_source=job["service_source"],
                )
            )
            previous = f"job:{jid}"
        return_leg = 0.0
        if returning and stops:
            return_leg = matrix[nodes[previous]][nodes[f"crew:{cid}"]]
            if return_leg is None:
                return None, "no_usable_route_found"
            elapsed += return_leg
            crew_travel += return_leg
        if elapsed > _crew_budget(snapshot, cid):
            return None, "duration_limit"
        latest = max(latest, elapsed)
        travel += crew_travel
        output.append(
            dict(
                crew_id=cid,
                stops=stops,
                duration_minutes=elapsed,
                travel_minutes=crew_travel,
                return_travel_minutes=return_leg,
                returns_to_start=returning,
            )
        )
    # Fixed denominators also make partial construction deltas comparable.
    weight = sum(PRIORITY_WEIGHTS[j["priority"]] for j in snapshot["jobs"]) or 1
    count = len(jobs) or 1
    wait = weighted / weight
    settings = snapshot["settings"]
    score = (
        settings["alpha"] * wait
        + settings["beta"] * latest
        + settings["gamma"] * travel / count
    )
    return (
        dict(
            routes=output,
            metrics=dict(
                weighted_wait=wait,
                latest_finish=latest,
                total_travel=travel,
                score=score,
            ),
        ),
        None,
    )


def evaluate(snapshot, matrix, routes):
    """Evaluate a feasible route from its current GPS origin and remaining budget."""
    return _evaluate(snapshot, matrix, routes)[0]


def objective(value):
    m = value["metrics"]
    return (m["score"], m["latest_finish"], m["total_travel"])


def _unassigned_reason(snapshot, matrix, routes, job):
    """Name provable limits; failed insertion alone is not global infeasibility."""
    crews = [cid for cid in routes if _compatible(snapshot, cid, job)]
    if not crews:
        return "equipment_mismatch"
    constraints = snapshot["settings"].get("constraints", {})
    maximum = constraints.get("max_stops_per_crew")
    if maximum is not None and all(len(routes[cid]) >= maximum for cid in crews):
        return "max_stops"
    if all(job["service"] > _crew_budget(snapshot, cid) for cid in crews):
        return "duration_limit"
    dest = snapshot["node_ids"].index(f"job:{job['id']}")
    incoming = any(row[dest] is not None for i, row in enumerate(matrix) if i != dest)
    outgoing = any(
        value is not None for i, value in enumerate(matrix[dest]) if i != dest
    )
    if not incoming or (constraints.get("return_to_start", False) and not outgoing):
        return "no_usable_route_found"
    return "search_incomplete"


def solve(snapshot, matrix, *, clock=monotonic):
    started = clock()
    limit = snapshot["settings"]["solver_seconds"]
    budget = snapshot["settings"]["improvement_budget"]
    routes = deepcopy(snapshot["prefixes"])
    jobs = {j["id"]: j for j in snapshot["jobs"]}
    required = {jid for jid, job in jobs.items() if job.get("previous_crew_id")}
    termination = "local_optimum"
    evaluations = 0

    def timed_out():
        return clock() - started >= limit

    def coverage(candidate):
        return {jid for ids in candidate.values() for jid in ids}

    def quality(candidate, value):
        covered = coverage(candidate)
        return (
            -len(covered & required),
            -sum(PRIORITY_WEIGHTS[jobs[jid]["priority"]] for jid in covered),
            -len(covered),
            *objective(value),
        )

    initial, failure = _evaluate(snapshot, matrix, routes)
    if initial is None:
        # Committed work cannot be silently removed to satisfy a new constraint.
        return dict(
            routes=[],
            unassigned=[dict(job_id=jid, reason=failure) for jid in sorted(jobs)],
            metrics=dict(weighted_wait=0, latest_finish=0, total_travel=0, score=0),
            termination_reason=(
                "fixed_prefix_no_route"
                if failure == "no_usable_route_found"
                else f"fixed_prefix_{failure}"
            ),
            dispatchable=False,
        )

    def insert_missing(candidate, *, bounded, exclude=frozenset()):
        """Greedy restoration also lets removal neighbors improve served coverage."""
        nonlocal evaluations
        value = evaluate(snapshot, matrix, candidate)
        while True:
            best = None
            pending = sorted(set(jobs) - coverage(candidate) - exclude)
            for jid in pending:
                for cid in sorted(candidate):
                    for pos in range(
                        len(snapshot["prefixes"][cid]), len(candidate[cid]) + 1
                    ):
                        if timed_out() or (bounded and evaluations >= budget):
                            return candidate, value
                        if bounded:
                            evaluations += 1
                        inserted = deepcopy(candidate)
                        inserted[cid].insert(pos, jid)
                        evaluated = evaluate(snapshot, matrix, inserted)
                        if evaluated is None:
                            continue
                        key = (*quality(inserted, evaluated), jid, cid, pos)
                        if best is None or key < best[0]:
                            best = (key, inserted, evaluated)
            if best is None:
                return candidate, value
            candidate, value = best[1:]

    routes, value = insert_missing(routes, bounded=False)
    if timed_out():
        termination = "time_limit_reached"

    # Relocation and exchange retain assignments. Dropping an optional job and
    # filling the resulting space lets higher-weight coverage replace cheap stops.
    while evaluations < budget and termination != "time_limit_reached":
        best = None
        movable = [
            (cid, p, jid)
            for cid in sorted(routes)
            for p, jid in enumerate(routes[cid])
            if p >= len(snapshot["prefixes"][cid])
        ]

        def candidates():
            for cid, p, jid in movable:
                reduced = deepcopy(routes)
                reduced[cid].pop(p)
                for target in sorted(routes):
                    for q in range(
                        len(snapshot["prefixes"][target]), len(reduced[target]) + 1
                    ):
                        candidate = deepcopy(reduced)
                        candidate[target].insert(q, jid)
                        yield candidate
                if jid not in required:
                    yield reduced
            for index, (cid, p, _) in enumerate(movable):
                for other, q, _ in movable[index + 1 :]:
                    candidate = deepcopy(routes)
                    candidate[cid][p], candidate[other][q] = (
                        candidate[other][q],
                        candidate[cid][p],
                    )
                    yield candidate

        for candidate in candidates():
            if evaluations >= budget or timed_out():
                break
            evaluations += 1
            candidate_value = evaluate(snapshot, matrix, candidate)
            if candidate_value is None:
                continue
            candidate, candidate_value = insert_missing(
                candidate, bounded=True, exclude=coverage(routes) - coverage(candidate)
            )
            key = quality(candidate, candidate_value)
            if key < quality(routes, value) and (best is None or key < best[0]):
                best = (key, candidate, candidate_value)
        if timed_out():
            termination = "time_limit_reached"
        elif evaluations >= budget:
            termination = "iteration_limit_reached"
        if best is None:
            break
        routes, value = best[1:]
    if budget == 0 and termination != "time_limit_reached":
        termination = "iteration_limit_reached"
    covered = coverage(routes)
    remaining = sorted(set(jobs) - covered)
    reasons = [
        dict(job_id=jid, reason=_unassigned_reason(snapshot, matrix, routes, jobs[jid]))
        for jid in remaining
    ]
    if remaining and termination == "local_optimum":
        termination = "search_incomplete"
    allow_partial = (
        snapshot["settings"].get("constraints", {}).get("allow_partial", False)
    )
    return {
        **value,
        "unassigned": reasons,
        "termination_reason": termination,
        "dispatchable": not remaining
        or (allow_partial and bool(covered) and required <= covered),
    }
