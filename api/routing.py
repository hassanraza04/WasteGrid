"""Scoped organiser previews and atomic dispatch over existing jobs/assignments."""

import hashlib
import json
from datetime import timedelta, timezone
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from api.auth import Principal, get_staff, organizer
from api.db import get_db, mutation_lock
from api.models import Assignment, Crew, Job, Plan, Report, RoutingPreview, now
from api.road_times import OSRMRoadTimes, TravelDataUnavailable
from api.route_solver import PRIORITY_WEIGHTS, evaluate, solve
from api.routing_schemas import (
    ComputeRoutes,
    CrewLocationUpdate,
    CrewLocationView,
    DispatchRoutes,
    PriorityDecision,
    RouteDispatchView,
    RoutePreviewView,
)
from api.schemas import OrganizerReportView
from api.services import (
    assert_version,
    command_seen,
    event,
    invalidate_plan,
    organizer_report_view,
)
from api.workflows import distance_km, job_assessment_approved


def utc(value):
    return (
        value.replace(tzinfo=timezone.utc)
        if value.tzinfo is None
        else value.astimezone(timezone.utc)
    )


def digest(value):
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, default=str).encode()
    ).hexdigest()


def fresh_location(crew, settings, at):
    recorded, received = crew.location_recorded_at, crew.location_received_at
    if recorded is None or received is None:
        raise HTTPException(409, f"Crew {crew.id} needs a timestamped location update")
    for value in (recorded, received):
        age = (at - utc(value)).total_seconds()
        if age < 0 or age > settings.routing_location_max_age_seconds:
            raise HTTPException(409, f"Crew {crew.id} location is stale or invalid")


def snapshot(db, crew_ids, settings, at):
    crew_ids = sorted(str(c) for c in crew_ids)
    crews = {
        str(c.id): c
        for c in db.scalars(
            select(Crew).where(Crew.id.in_([UUID(c) for c in crew_ids]))
        )
    }
    if len(crews) != len(crew_ids):
        raise HTTPException(404, "Selected crew does not exist")
    for crew in crews.values():
        if not crew.available:
            raise HTTPException(409, f"Crew {crew.id} is not available")
        fresh_location(crew, settings, at)
    candidates = [
        j
        for j in db.scalars(select(Job).order_by(Job.id))
        if j.status != "completed"
        and (j.assigned_crew_id is None or str(j.assigned_crew_id) in crews)
    ]
    # Bound all planning inputs before a quadratic provider request.
    if len(candidates) > 25:
        raise HTTPException(422, "MVP supports at most 25 scoped unfinished jobs")
    prefixes, jobs, exclusions, business = {cid: [] for cid in crew_ids}, [], [], []
    for job in candidates:
        reports = list(
            db.scalars(
                select(Report).where(Report.job_id == job.id).order_by(Report.id)
            )
        )
        priorities = [r.priority for r in reports if r.priority in PRIORITY_WEIGHTS]
        approved = bool(reports) and all(
            job_assessment_approved(db, r) and r.priority in PRIORITY_WEIGHTS
            for r in reports
        )
        reason = (
            "held"
            if job.held
            else (
                job.status
                if job.status in ("blocked", "recheck_requested")
                else "assessment_or_priority_review" if not approved else None
            )
        )
        business.append(
            {
                "job": {
                    k: str(getattr(job, k))
                    for k in (
                        "id",
                        "version",
                        "status",
                        "assigned_crew_id",
                        "locked",
                        "held",
                        "route_position",
                        "collection_started_at",
                    )
                },
                "location": job.location,
                "eligibility_reason": reason,
                "reports": [
                    (
                        str(r.id),
                        r.version,
                        r.priority,
                        r.needs_review,
                        r.organizer_review_required,
                        r.assessment_status,
                        digest(r.assessment),
                    )
                    for r in reports
                ],
            }
        )
        if reason:
            exclusions.append(dict(job_id=str(job.id), reason=reason))
            continue
        service, source = settings.routing_service_minutes, "fixed_collection_time"
        if job.status == "in_progress":
            source = (
                "remaining_from_start"
                if job.collection_started_at
                else "full_service_fallback"
            )
            if job.collection_started_at:
                elapsed = (at - utc(job.collection_started_at)).total_seconds() / 60
                if elapsed < 0:
                    raise HTTPException(409, "Collection start time is invalid")
                service = max(1.0, service - elapsed)
        jobs.append(
            dict(
                id=str(job.id),
                location=job.location,
                priority=max(priorities, key=PRIORITY_WEIGHTS.get),
                service=service,
                service_source=source,
                ongoing=job.status == "in_progress",
                previous_crew_id=(
                    str(job.assigned_crew_id) if job.assigned_crew_id else None
                ),
                previous_position=job.route_position,
            )
        )
    eligible_ids = {j["id"] for j in jobs}
    for cid in crew_ids:
        assigned = sorted(
            [j for j in candidates if str(j.assigned_crew_id) == cid],
            key=lambda j: (
                j.status != "in_progress",
                j.route_position if j.route_position is not None else 10**9,
                str(j.id),
            ),
        )
        if sum(j.status == "in_progress" for j in assigned) > 1:
            raise HTTPException(409, "A crew cannot collect two jobs simultaneously")
        fixed_until = max(
            (
                i
                for i, j in enumerate(assigned)
                if j.locked or j.status == "in_progress"
            ),
            default=-1,
        )
        prefix = [str(j.id) for j in assigned[: fixed_until + 1]]
        if any(jid not in eligible_ids for jid in prefix):
            raise HTTPException(
                409,
                "Fixed prefix contains held or ineligible work; organiser resolution required",
            )
        prefixes[cid] = prefix
    frozen = dict(
        service_minutes=settings.routing_service_minutes,
        priority_weights=PRIORITY_WEIGHTS,
        alpha=settings.routing_wait_weight,
        beta=settings.routing_finish_weight,
        gamma=settings.routing_travel_weight,
        improvement_budget=settings.routing_improvement_budget,
        solver_seconds=settings.routing_solver_timeout_seconds,
        location_max_age_seconds=settings.routing_location_max_age_seconds,
        preview_max_age_seconds=settings.routing_preview_max_age_seconds,
        max_displacement_meters=settings.routing_max_displacement_meters,
    )
    locations = {
        cid: dict(
            location=crews[cid].start_location,
            recorded_at=utc(crews[cid].location_recorded_at).isoformat(),
            revision=crews[cid].location_revision,
        )
        for cid in crew_ids
    }
    return dict(
        crews=crew_ids,
        jobs=jobs,
        prefixes=prefixes,
        exclusions=exclusions,
        node_ids=[f"crew:{cid}" for cid in crew_ids] + [f"job:{j['id']}" for j in jobs],
        locations=locations,
        settings=frozen,
        revision=digest(
            dict(
                jobs=business,
                crews=[
                    (cid, crews[cid].version, crews[cid].available) for cid in crew_ids
                ],
            )
        ),
    )


def compute_preview(db, crew_ids, settings, road_times, actor):
    at = now()
    snap = snapshot(db, crew_ids, settings, at)
    locations = [snap["locations"][cid]["location"] for cid in snap["crews"]] + [
        j["location"] for j in snap["jobs"]
    ]
    db.commit()  # Release mutation lock and DB transaction BEFORE road provider I/O.
    matrix, matrix_id = None, None
    label = "OSRM directional driving-time estimates; no live traffic guarantee"
    try:
        matrix = (
            road_times.matrix(locations)
            if snap["jobs"]
            else [[0.0 for _ in locations] for _ in locations]
        )
        matrix_id = digest(dict(nodes=snap["node_ids"], matrix=matrix, mode="driving"))
        result = solve(snap, matrix)
    except TravelDataUnavailable:
        result = dict(
            routes=[],
            unassigned=[
                dict(job_id=j["id"], reason="travel_data_unavailable")
                for j in snap["jobs"]
            ],
            metrics=dict(weighted_wait=0, latest_finish=0, total_travel=0, score=0),
            termination_reason="travel_data_unavailable",
            dispatchable=False,
        )
    excluded_ids = {i["job_id"] for i in snap["exclusions"]}
    if excluded_ids:
        # Read after provider I/O without relying on it for freshness; dispatch
        # still revalidates the complete business snapshot under the write lock.
        assigned_excluded = db.scalar(
            select(Job.id).where(
                Job.id.in_([UUID(jid) for jid in excluded_ids]),
                Job.assigned_crew_id.in_([UUID(cid) for cid in snap["crews"]]),
            )
        )
        if assigned_excluded:
            result["dispatchable"] = False
            result["termination_reason"] = "assigned_job_ineligible"
    reassignments = []
    by_id = {j["id"]: j for j in snap["jobs"]}
    for route in result["routes"]:
        for stop in route["stops"]:
            job = by_id[stop["job_id"]]
            if (job["previous_crew_id"], job["previous_position"]) != (
                route["crew_id"],
                stop["position"],
            ):
                reassignments.append(
                    dict(
                        job_id=job["id"],
                        previous_crew_id=job["previous_crew_id"],
                        proposed_crew_id=route["crew_id"],
                        previous_position=job["previous_position"],
                        proposed_position=stop["position"],
                    )
                )
    preview = RoutingPreview(id=uuid4(), payload={})
    view = RoutePreviewView(
        id=preview.id,
        computed_at=at,
        expires_at=at + timedelta(seconds=settings.routing_preview_max_age_seconds),
        matrix_id=matrix_id,
        travel_label=label,
        exclusions=snap["exclusions"],
        reassignments=reassignments,
        settings=snap["settings"],
        **result,
    )
    preview.payload = dict(
        snapshot=snap, matrix=matrix, view=view.model_dump(mode="json"), actor=actor
    )
    mutation_lock(db)
    db.add(preview)
    db.commit()
    return view


def dispatch_preview(db, preview, command_id, actor, settings):
    if preview.dispatched_plan_id:
        if preview.dispatch_command_id != command_id or preview.dispatched_by != actor:
            raise HTTPException(409, "Preview has already been dispatched")
        return dict(preview_id=preview.id, plan_id=preview.dispatched_plan_id)
    if db.scalar(
        select(RoutingPreview.id).where(
            RoutingPreview.dispatch_command_id == command_id
        )
    ):
        raise HTTPException(409, "Dispatch command already used for another preview")
    data, at = preview.payload, now()
    view = RoutePreviewView.model_validate(data["view"])
    if not view.dispatchable or utc(view.expires_at) < at:
        raise HTTPException(409, "Preview is incomplete or expired; recompute required")
    old = data["snapshot"]
    current = snapshot(db, old["crews"], settings, at)
    if current["revision"] != old["revision"] or current["settings"] != old["settings"]:
        raise HTTPException(
            409, "Planning business state or settings changed; recompute required"
        )
    for cid in old["crews"]:
        if (
            distance_km(
                old["locations"][cid]["location"], current["locations"][cid]["location"]
            )
            * 1000
            > settings.routing_max_displacement_meters
        ):
            raise HTTPException(
                409, "Crew moved too far from preview; recompute required"
            )
    routes = {str(r.crew_id): [str(s.job_id) for s in r.stops] for r in view.routes}
    expected = {j["id"] for j in old["jobs"]}
    actual = [jid for ids in routes.values() for jid in ids]
    if (
        set(routes) != set(old["crews"])
        or set(actual) != expected
        or len(actual) != len(expected)
    ):
        raise HTTPException(409, "Preview coverage is invalid")
    for cid, prefix in old["prefixes"].items():
        if routes[cid][: len(prefix)] != prefix:
            raise HTTPException(409, "Preview changed fixed work")
    # Revalidate directed travel and all stored stop metrics against the frozen input.
    evaluated = evaluate(old, data["matrix"], routes)
    if evaluated is None or evaluated["routes"] != [
        r.model_dump(mode="json") for r in view.routes
    ]:
        raise HTTPException(409, "Preview route data is invalid")
    unfinished = list(
        db.scalars(select(Job).where(Job.status != "completed").order_by(Job.id))
    )
    plan = Plan(id=uuid4(), routing_mode="organizer", payload={})
    db.add(plan)
    db.flush()
    proposed = {str(s.job_id): (r.crew_id, s) for r in view.routes for s in r.stops}
    assignments, unassigned, execution_rules = [], [], {}
    selected = set(old["crews"])
    excluded = {str(i.job_id): i.reason for i in view.exclusions}
    for job in unfinished:
        jid = str(job.id)
        saved_stop, saved_rule = (
            preserved_assignment(db, job) if jid not in proposed else (None, None)
        )
        if jid in proposed:
            cid, stop = proposed[jid]
            previous = (job.assigned_crew_id, job.route_position)
            job.assigned_crew_id, job.route_position = cid, stop.position
            job.travel_minutes = stop.travel_minutes
            job.unassigned_reason = None
            if job.status != "in_progress":
                job.status = "assigned"
            job.version += 1
            event(
                db,
                "job.planned",
                job_id=job.id,
                actor=str(actor),
                details={
                    "plan_id": str(plan.id),
                    "status": job.status,
                    "previous_crew_id": str(previous[0]) if previous[0] else None,
                },
            )
        elif str(job.assigned_crew_id) in selected and jid in excluded:
            # Do not silently drop an existing selected assignment from its route.
            raise HTTPException(
                409, "Selected crew has excluded assigned work; resolve before dispatch"
            )
        if job.assigned_crew_id is not None:
            position = job.route_position
            if position is None:
                raise HTTPException(409, "Existing assignment has no route position")
            db.add(
                Assignment(
                    plan_id=plan.id,
                    job_id=job.id,
                    crew_id=job.assigned_crew_id,
                    position=position,
                )
            )
            assignments.append(
                dict(
                    job_id=jid,
                    crew_id=str(job.assigned_crew_id),
                    position=position,
                    travel_minutes=job.travel_minutes,
                    service_minutes=(
                        proposed[jid][1].service_minutes
                        if jid in proposed
                        else (
                            saved_stop["service_minutes"]
                            if saved_stop
                            else job.estimated_service_minutes
                        )
                    ),
                )
            )
            if jid not in proposed and saved_stop:
                assignments[-1]["travel_minutes"] = saved_stop["travel_minutes"]
            execution_rules[jid] = (
                {"mode": "organizer", "source_plan_id": str(plan.id)}
                if jid in proposed
                else saved_rule
            )
        else:
            reason = (
                "held"
                if job.held
                else (
                    job.status
                    if job.status in ("blocked", "recheck_requested")
                    else "hazard_review"
                )
            )
            unassigned.append(dict(job_id=jid, reason_code=reason))
    plan.payload = dict(
        revision=old["revision"],
        assignments=assignments,
        unassigned=unassigned,
        travel_estimates_label=view.travel_label,
        execution_rules=execution_rules,
    )
    preview.dispatched_plan_id, preview.dispatch_command_id, preview.dispatched_by = (
        plan.id,
        command_id,
        actor,
    )
    event(
        db,
        "routing.dispatched",
        crew_id=UUID(old["crews"][0]),
        actor=str(actor),
        details={"plan_id": str(plan.id), "preview_id": str(preview.id)},
    )
    db.commit()
    return dict(preview_id=preview.id, plan_id=plan.id)


def preserved_assignment(db, job):
    """Keep the last assignment's terms and authority, not the global plan mode.

    Older draft organiser plans have no per-assignment rules. Their previews tell
    us which jobs they actually routed; walk past copied rows to their origin.
    """
    plans = db.scalars(
        select(Plan)
        .join(Assignment, Assignment.plan_id == Plan.id)
        .where(
            Assignment.job_id == job.id,
            Assignment.crew_id == job.assigned_crew_id,
            Assignment.position == job.route_position,
        )
        .order_by(Plan.created_at.desc(), Plan.id)
    )
    for previous in plans:
        stop = next(
            (
                s
                for s in previous.payload["assignments"]
                if s["job_id"] == str(job.id)
                and s["crew_id"] == str(job.assigned_crew_id)
                and s["position"] == job.route_position
            ),
            None,
        )
        if stop is None:
            continue
        rule = previous.payload.get("execution_rules", {}).get(str(job.id))
        if rule:
            return stop, rule
        if previous.routing_mode == "legacy":
            return stop, {"mode": "legacy", "source_plan_id": str(previous.id)}
        source = db.scalar(
            select(RoutingPreview).where(
                RoutingPreview.dispatched_plan_id == previous.id
            )
        )
        if source and any(
            s["job_id"] == str(job.id)
            for r in source.payload["view"]["routes"]
            for s in r["stops"]
        ):
            return stop, {"mode": "organizer", "source_plan_id": str(previous.id)}
    # Do not turn an assignment with no validated origin into an approved one.
    return None, {"mode": "legacy", "source_plan_id": None}


def routing_router(settings):
    router = APIRouter()

    @router.post(
        "/organizer/reports/{report_id}/priority", response_model=OrganizerReportView
    )
    def set_priority(
        report_id: UUID,
        body: PriorityDecision,
        db: Session = Depends(get_db),
        staff: Principal = Depends(organizer),
    ):
        report = db.get(Report, report_id)
        if report is None:
            raise HTTPException(404, "Report not found")
        seen, fingerprint = command_seen(db, report.id, body, "report.priority_set")
        if seen:
            return organizer_report_view(db, report)
        assert_version(report.version, body.expected_version)
        if report.assessment_status == "pending":
            raise HTTPException(
                409, "Wait for the pending assessment before setting priority"
            )
        previous = report.priority
        report.priority = body.priority
        report.priority_reason = "Priority set by an organiser after review."
        report.version += 1
        # This decision never clears safety/review gates or changes AI observations.
        event(
            db,
            "report.priority_set",
            report_id=report.id,
            actor=str(staff.user_id),
            command_id=body.command_id,
            request_hash=fingerprint,
            details={
                "previous_priority": previous,
                "priority": body.priority,
                "reason": body.reason,
            },
        )
        if report.job_id:
            invalidate_plan(db)
        db.commit()
        return organizer_report_view(db, report)

    def enabled():
        if not settings.organizer_routing_enabled:
            raise HTTPException(
                503, "Enable ORGANIZER_ROUTING_ENABLED for organiser routing"
            )

    @router.post("/crews/me/location", response_model=CrewLocationView)
    def update_location(
        body: CrewLocationUpdate,
        db: Session = Depends(get_db),
        staff: Principal = Depends(get_staff),
    ):
        if staff.role != "crew":
            raise HTTPException(403, "Crew account required")
        crew = db.get(Crew, staff.crew_id)
        at, recorded = now(), utc(body.recorded_at)
        if (
            recorded > at
            or (at - recorded).total_seconds()
            > settings.routing_location_max_age_seconds
        ):
            raise HTTPException(422, "Location timestamp is stale or in the future")
        if crew.location_recorded_at and recorded <= utc(crew.location_recorded_at):
            raise HTTPException(
                409, "Location update is older than the stored observation"
            )
        crew.start_location = body.location.model_dump(mode="json")
        crew.location_recorded_at, crew.location_received_at = recorded, at
        crew.location_revision += 1
        # GPS must not increment crew business version, clear assignments or trigger plans.
        db.commit()
        return dict(
            crew_id=crew.id,
            location=crew.start_location,
            recorded_at=recorded,
            received_at=at,
            revision=crew.location_revision,
        )

    @router.post(
        "/routing/previews",
        response_model=RoutePreviewView,
        dependencies=[Depends(enabled)],
    )
    def compute(
        body: ComputeRoutes,
        request: Request,
        db: Session = Depends(get_db),
        staff: Principal = Depends(organizer),
    ):
        provider = getattr(request.app.state, "road_times", None)
        if provider is None:
            if not settings.routing_osrm_base_url:
                raise HTTPException(
                    503, "Configure ROUTING_OSRM_BASE_URL for road travel times"
                )
            provider = OSRMRoadTimes(
                settings.routing_osrm_base_url,
                settings.routing_provider_timeout_seconds,
            )
        return compute_preview(
            db, body.crew_ids, settings, provider, str(staff.user_id)
        )

    @router.get("/routing/previews/{preview_id}", response_model=RoutePreviewView)
    def read_preview(
        preview_id: UUID,
        db: Session = Depends(get_db),
        staff: Principal = Depends(organizer),
    ):
        preview = db.get(RoutingPreview, preview_id)
        if preview is None:
            raise HTTPException(404, "Preview not found")
        view = RoutePreviewView.model_validate(preview.payload["view"])
        return view.model_copy(update={"plan_id": preview.dispatched_plan_id})

    @router.post(
        "/routing/previews/{preview_id}/dispatch",
        response_model=RouteDispatchView,
        dependencies=[Depends(enabled)],
    )
    def dispatch(
        preview_id: UUID,
        body: DispatchRoutes,
        db: Session = Depends(get_db),
        staff: Principal = Depends(organizer),
    ):
        preview = db.scalar(
            select(RoutingPreview)
            .where(RoutingPreview.id == preview_id)
            .with_for_update()
        )
        if preview is None:
            raise HTTPException(404, "Preview not found")
        return dispatch_preview(db, preview, body.command_id, staff.user_id, settings)

    return router
