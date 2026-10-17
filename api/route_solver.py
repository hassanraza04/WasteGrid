"""Small deterministic priority-aware insertion/local-search heuristic, no I/O."""

from copy import deepcopy
from time import monotonic

PRIORITY_WEIGHTS = {"high": 3, "medium": 2, "routine": 1}


def evaluate(snapshot, matrix, routes):
    jobs = {j["id"]: j for j in snapshot["jobs"]}
    nodes = {node: i for i, node in enumerate(snapshot["node_ids"])}
    weighted, travel, latest, output = 0.0, 0.0, 0.0, []
    for cid in sorted(routes):
        elapsed, crew_travel, previous, stops = 0.0, 0.0, f"crew:{cid}", []
        prefix = snapshot["prefixes"][cid]
        for position, jid in enumerate(routes[cid]):
            job = jobs[jid]
            leg = (
                0.0 if job["ongoing"] else matrix[nodes[previous]][nodes[f"job:{jid}"]]
            )
            if leg is None:
                return None
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
        latest = max(latest, elapsed)
        travel += crew_travel
        output.append(
            dict(
                crew_id=cid,
                stops=stops,
                duration_minutes=elapsed,
                travel_minutes=crew_travel,
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
    return dict(
        routes=output,
        metrics=dict(
            weighted_wait=wait, latest_finish=latest, total_travel=travel, score=score
        ),
    )


def objective(value):
    m = value["metrics"]
    return (m["score"], m["latest_finish"], m["total_travel"])


def solve(snapshot, matrix, *, clock=monotonic):
    started = clock()
    limit = snapshot["settings"]["solver_seconds"]
    routes = deepcopy(snapshot["prefixes"])
    fixed = {jid for ids in routes.values() for jid in ids}
    remaining = sorted(j["id"] for j in snapshot["jobs"] if j["id"] not in fixed)
    termination = "local_optimum"

    def timed_out():
        return clock() - started >= limit

    if evaluate(snapshot, matrix, routes) is None:
        # A committed prefix cannot be silently reordered around a missing road.
        return dict(
            routes=[],
            unassigned=[
                dict(job_id=j["id"], reason="no_usable_route_found")
                for j in snapshot["jobs"]
            ],
            metrics=dict(weighted_wait=0, latest_finish=0, total_travel=0, score=0),
            termination_reason="fixed_prefix_no_route",
            dispatchable=False,
        )
    while remaining:
        best = None
        for jid in remaining:
            for cid in sorted(routes):
                for pos in range(len(snapshot["prefixes"][cid]), len(routes[cid]) + 1):
                    if timed_out():
                        termination = "time_limit_reached"
                        break
                    candidate = deepcopy(routes)
                    candidate[cid].insert(pos, jid)
                    value = evaluate(snapshot, matrix, candidate)
                    if value is not None:
                        key = (*objective(value), jid, cid, pos)
                        if best is None or key < best[0]:
                            best = (key, candidate, jid)
                if termination == "time_limit_reached":
                    break
            if termination == "time_limit_reached":
                break
        if termination == "time_limit_reached" or best is None:
            break
        routes = best[1]
        remaining.remove(best[2])

    # Relocations include within-route reordering; swaps cover cross-crew exchanges.
    # In incomplete construction, accept coverage-increasing insertions after moves.
    budget = snapshot["settings"]["improvement_budget"]
    evaluations = 0
    while evaluations < budget and termination != "time_limit_reached":
        current = evaluate(snapshot, matrix, routes)
        best = None
        movable = [
            (cid, p, jid)
            for cid in sorted(routes)
            for p, jid in enumerate(routes[cid])
            if p >= len(snapshot["prefixes"][cid])
        ]

        def candidates():
            for cid, p, jid in movable:
                for target in sorted(routes):
                    reduced = deepcopy(routes)
                    reduced[cid].pop(p)
                    for q in range(
                        len(snapshot["prefixes"][target]), len(reduced[target]) + 1
                    ):
                        value = deepcopy(reduced)
                        value[target].insert(q, jid)
                        yield value
            for index, (cid, p, _) in enumerate(movable):
                for other, q, _ in movable[index + 1 :]:
                    value = deepcopy(routes)
                    value[cid][p], value[other][q] = value[other][q], value[cid][p]
                    yield value

        for candidate in candidates():
            if evaluations >= budget or timed_out():
                break
            evaluations += 1
            value = evaluate(snapshot, matrix, candidate)
            if value is None:
                continue
            # Try restoring missing coverage using each connectivity-changing move.
            pending = list(remaining)
            for jid in list(pending):
                insertion = None
                for cid in sorted(candidate):
                    for pos in range(
                        len(snapshot["prefixes"][cid]), len(candidate[cid]) + 1
                    ):
                        if evaluations >= budget or timed_out():
                            break
                        evaluations += 1
                        inserted = deepcopy(candidate)
                        inserted[cid].insert(pos, jid)
                        evaluated = evaluate(snapshot, matrix, inserted)
                        if evaluated and (
                            insertion is None or objective(evaluated) < insertion[0]
                        ):
                            insertion = (objective(evaluated), inserted, evaluated)
                if insertion:
                    candidate, value = insertion[1:]
                    pending.remove(jid)
            key = (len(pending), *objective(value))
            baseline = (len(remaining), *objective(current))
            if key < baseline and (best is None or key < best[0]):
                best = (key, candidate, pending)
        if timed_out():
            termination = "time_limit_reached"
        elif evaluations >= budget:
            termination = "iteration_limit_reached"
        if best is None:
            break
        routes, remaining = best[1:]
    value = evaluate(snapshot, matrix, routes)
    complete = not remaining
    # With no incomplete matrix elements, an insertion failure is still a search
    # outcome, not a proof that a job has no road connection in every possible plan.
    reasons = []
    for jid in remaining:
        dest = snapshot["node_ids"].index(f"job:{jid}")
        known_incoming = any(
            row[dest] is not None for i, row in enumerate(matrix) if i != dest
        )
        reason = "search_incomplete" if known_incoming else "no_usable_route_found"
        reasons.append(dict(job_id=jid, reason=reason))
    if remaining and termination == "local_optimum":
        termination = "search_incomplete"
    return {
        **value,
        "unassigned": reasons,
        "termination_reason": termination,
        "dispatchable": complete,
    }
