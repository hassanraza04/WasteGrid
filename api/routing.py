"""Scoped organiser previews and atomic dispatch over existing jobs/assignments."""

import hashlib
import json
from collections import defaultdict
from datetime import timedelta, timezone
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import ValidationError
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from api.auth import Principal, get_staff, organizer
from api.db import get_db, mutation_lock
from api.models import Assignment, Crew, Event, Job, Plan, Report, RoutingPreview, now
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
    RoutingConstraints,
)
from api.schemas import OrganizerReportView
from api.services import (
    assert_version,
    command_seen,
    event,
    invalidate_plan,
    organizer_report_view,
)
from api.workflows import assessment_allows_job, distance_km, job_assessment_approved


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


def snapshot(db, crew_ids, settings, at, job_ids=None, constraints=None):
    try:
        constraints = RoutingConstraints.model_validate(constraints or {})
    except ValidationError:
        raise HTTPException(422, "Routing constraints are invalid") from None
    crew_ids = sorted(str(c) for c in crew_ids)
    job_ids = sorted(str(j) for j in job_ids) if job_ids is not None else None
    if job_ids is not None and (
        not 1 <= len(job_ids) <= 25 or len(set(job_ids)) != len(job_ids)
    ):
        raise HTTPException(422, "Select between 1 and 25 distinct jobs")
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
    candidate_query = select(Job)
    if job_ids is None:
        candidate_query = candidate_query.where(
            Job.status != "completed",
            or_(
                Job.assigned_crew_id.is_(None),
                Job.assigned_crew_id.in_([UUID(c) for c in crew_ids]),
            ),
        )
    else:
        candidate_query = candidate_query.where(Job.id.in_([UUID(j) for j in job_ids]))
    candidates = list(db.scalars(candidate_query.order_by(Job.id)))
    if job_ids is not None:
        if {str(j.id) for j in candidates} != set(job_ids):
            raise HTTPException(404, "Selected job does not exist")
        if any(
            j.status == "completed"
            or (
                j.assigned_crew_id is not None
                and str(j.assigned_crew_id) not in crew_ids
            )
            for j in candidates
        ):
            raise HTTPException(
                409, "Selected job is completed or assigned to another crew"
            )
        outside_assignment = db.scalar(
            select(Job.id)
            .where(
                Job.status != "completed",
                Job.assigned_crew_id.in_([UUID(c) for c in crew_ids]),
                Job.id.not_in([UUID(j) for j in job_ids]),
            )
            .limit(1)
        )
        if outside_assignment is not None:
            raise HTTPException(
                409, "Selected crew has unfinished work outside the selected jobs"
            )
    reports_by_job, approvals = defaultdict(list), defaultdict(list)
    reports = (
        list(
            db.scalars(
                select(Report)
                .where(Report.job_id.in_([j.id for j in candidates]))
                .order_by(Report.id)
            )
        )
        if candidates
        else []
    )
    for report in reports:
        reports_by_job[report.job_id].append(report)
    needs_audit = [
        r.id
        for r in reports
        if r.priority in PRIORITY_WEIGHTS
        and not r.needs_review
        and not r.organizer_review_required
        and not assessment_allows_job(r)
    ]
    if needs_audit:
        for record in db.scalars(
            select(Event).where(
                Event.report_id.in_(needs_audit), Event.kind == "report.triaged"
            )
        ):
            approvals[record.report_id].append(record)
    prefixes, jobs, exclusions, business = {cid: [] for cid in crew_ids}, [], [], []
    for job in candidates:
        reports = reports_by_job[job.id]
        priorities = [r.priority for r in reports if r.priority in PRIORITY_WEIGHTS]
        approved = bool(reports) and all(
            job_assessment_approved(db, r, approval_events=approvals[r.id])
            and r.priority in PRIORITY_WEIGHTS
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
        if reason is None or job.assigned_crew_id is not None:
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
                    "required_equipment": sorted(job.required_equipment),
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
            if job_ids is not None:
                raise HTTPException(
                    409, f"Selected job {job.id} is ineligible: {reason}"
                )
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
                required_equipment=sorted(job.required_equipment),
                service=service,
                service_source=source,
                ongoing=job.status == "in_progress",
                previous_crew_id=(
                    str(job.assigned_crew_id) if job.assigned_crew_id else None
                ),
                previous_position=job.route_position,
            )
        )
    if len(jobs) > 25:
        raise HTTPException(422, "MVP supports at most 25 eligible scoped jobs")
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
    resources = {
        cid: dict(
            equipment=sorted(crews[cid].equipment),
            shift_minutes=crews[cid].shift_minutes,
        )
        for cid in crew_ids
    }
    frozen = dict(
        routing_contract_version=2,
        constraints=constraints.model_dump(mode="json"),
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
    revision_data = dict(
        routing_contract_version=2,
        constraints=constraints.model_dump(mode="json"),
        jobs=business,
        crews=[
            (cid, crews[cid].version, crews[cid].available, resources[cid])
            for cid in crew_ids
        ],
    )
    if job_ids is not None:
        revision_data["job_ids"] = job_ids
    return dict(
        crews=crew_ids,
        job_ids=job_ids,
        jobs=jobs,
        prefixes=prefixes,
        exclusions=exclusions,
        node_ids=[f"crew:{cid}" for cid in crew_ids] + [f"job:{j['id']}" for j in jobs],
        locations=locations,
        settings=frozen,
        resources=resources,
        revision=digest(revision_data),
    )


def compute_preview(
    db, crew_ids, settings, road_times, actor, job_ids=None, constraints=None
):
    at = now()
    snap = snapshot(
        db, crew_ids, settings, at, job_ids=job_ids, constraints=constraints
    )
    locations = [snap["locations"][cid]["location"] for cid in snap["crews"]] + [
        j["location"] for j in snap["jobs"]
    ]
    db.commit()  # Release mutation lock and DB transaction BEFORE road provider I/O.
    matrix, matrix_id = None, None
    label = "OSRM directional driving-time estimates using OpenStreetMap data (ODbL); no live traffic guarantee"
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
    routed_ids = {
        stop["job_id"] for route in result["routes"] for stop in route["stops"]
    }
    if any(
        job["previous_crew_id"] and job["id"] not in routed_ids for job in snap["jobs"]
    ):
        result["dispatchable"] = False
        result["termination_reason"] = "assigned_job_infeasible"
    if not routed_ids:
        result["dispatchable"] = False
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
        job_ids=snap["job_ids"],
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


def dispatch_preview(db, preview, command_id, actor, settings, accept_partial=False):
    if preview.dispatched_plan_id:
        if (
            preview.dispatch_command_id != command_id
            or preview.dispatched_by != actor
            or preview.payload.get("dispatch_accept_partial", False) != accept_partial
        ):
            raise HTTPException(409, "Preview has already been dispatched")
        return dict(preview_id=preview.id, plan_id=preview.dispatched_plan_id)
    if db.scalar(
        select(RoutingPreview.id).where(
            RoutingPreview.dispatch_command_id == command_id
        )
    ):
        raise HTTPException(409, "Dispatch command already used for another preview")
    data, at = preview.payload, now()
    try:
        view = RoutePreviewView.model_validate(data["view"])
    except (ValidationError, KeyError, TypeError):
        raise HTTPException(409, "Preview route data is invalid") from None
    if not view.dispatchable or utc(view.expires_at) < at:
        raise HTTPException(409, "Preview is incomplete or expired; recompute required")
    old = data["snapshot"]
    try:
        constraints = RoutingConstraints.model_validate(
            old["settings"].get("constraints", {})
        )
    except (ValidationError, KeyError, TypeError):
        raise HTTPException(409, "Preview routing constraints are invalid") from None
    if view.settings != old["settings"]:
        raise HTTPException(409, "Preview routing settings are invalid")
    if view.unassigned and not (constraints.allow_partial and accept_partial):
        raise HTTPException(409, "Confirm the omitted jobs before partial dispatch")
    frozen_job_ids = old.get("job_ids")
    visible_job_ids = (
        [str(j) for j in view.job_ids] if view.job_ids is not None else None
    )
    if visible_job_ids != frozen_job_ids:
        raise HTTPException(409, "Preview job scope is invalid")
    try:
        current = snapshot(
            db,
            old["crews"],
            settings,
            at,
            job_ids=frozen_job_ids,
            constraints=constraints,
        )
    except HTTPException as error:
        if frozen_job_ids is not None and error.status_code in (404, 422):
            raise HTTPException(
                409, "Preview job scope changed; recompute required"
            ) from None
        raise
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
    omitted = [str(item.job_id) for item in view.unassigned]
    assigned_before = {job["id"] for job in old["jobs"] if job.get("previous_crew_id")}
    if (
        len(routes) != len(view.routes)
        or set(routes) != set(old["crews"])
        or not actual
        or set(actual) | set(omitted) != expected
        or len(actual) + len(omitted) != len(expected)
        or set(actual) & set(omitted)
        or assigned_before - set(actual)
    ):
        raise HTTPException(409, "Preview coverage is invalid")
    for cid, prefix in old["prefixes"].items():
        if routes[cid][: len(prefix)] != prefix:
            raise HTTPException(409, "Preview changed fixed work")
    # Revalidate directed travel and all stored stop metrics against the frozen input.
    evaluated = evaluate(old, data["matrix"], routes)
    if (
        evaluated is None
        or evaluated["routes"] != [r.model_dump(mode="json") for r in view.routes]
        or evaluated["metrics"] != view.metrics.model_dump(mode="json")
    ):
        raise HTTPException(409, "Preview route data is invalid")
    unfinished = list(
        db.scalars(select(Job).where(Job.status != "completed").order_by(Job.id))
    )
    proposed = {str(s.job_id): (r.crew_id, s) for r in view.routes for s in r.stops}
    preserved = preserved_assignments(
        db,
        [
            j
            for j in unfinished
            if j.assigned_crew_id is not None and str(j.id) not in proposed
        ],
    )
    plan = Plan(id=uuid4(), routing_mode="organizer", payload={})
    db.add(plan)
    db.flush()
    assignments, unassigned, execution_rules = [], [], {}
    selected = set(old["crews"])
    explicit_scope = set(frozen_job_ids) if frozen_job_ids is not None else None
    excluded = {str(i.job_id): i.reason for i in view.exclusions}
    omitted_reasons = {str(i.job_id): i.reason for i in view.unassigned}
    route_by_crew = {str(route.crew_id): route for route in view.routes}
    for job in unfinished:
        jid = str(job.id)
        saved_stop, saved_rule = preserved.get(jid, (None, None))
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
                {
                    "mode": "organizer",
                    "source_plan_id": str(plan.id),
                    "routing_contract_version": 2,
                    "constraints": constraints.model_dump(mode="json"),
                    "route_job_ids": [
                        str(stop.job_id)
                        for stop in route_by_crew[str(job.assigned_crew_id)].stops
                    ],
                    "return_travel_minutes": route_by_crew[
                        str(job.assigned_crew_id)
                    ].return_travel_minutes,
                }
                if jid in proposed
                else saved_rule
            )
        else:
            reason = omitted_reasons.get(jid) or (
                "outside_scope"
                if explicit_scope is not None and jid not in explicit_scope
                else (
                    "held"
                    if job.held
                    else (
                        job.status
                        if job.status in ("blocked", "recheck_requested")
                        else "hazard_review"
                    )
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
    preview.payload = {**data, "dispatch_accept_partial": accept_partial}
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


def preserved_assignments(db, jobs):
    """Batch provenance reads. Normal plans resolve from the latest payload once.

    Only old draft rows missing execution metadata require historical fallback;
    those histories and their previews are also loaded together, never per job.
    """
    if not jobs:
        return {}
    pending = {str(j.id): j for j in jobs}
    result = {}
    latest = db.scalar(select(Plan).order_by(Plan.created_at.desc(), Plan.id).limit(1))

    def read_plan(previous, sources):
        terms = {s["job_id"]: s for s in previous.payload["assignments"]}
        rules = previous.payload.get("execution_rules", {})
        for jid in list(pending):
            job, stop = pending[jid], terms.get(jid)
            if stop is None or (stop["crew_id"], stop["position"]) != (
                str(job.assigned_crew_id),
                job.route_position,
            ):
                continue
            rule = rules.get(jid)
            if rule is None and previous.routing_mode == "legacy":
                rule = {"mode": "legacy", "source_plan_id": str(previous.id)}
            if rule is None and jid in sources.get(previous.id, set()):
                rule = {"mode": "organizer", "source_plan_id": str(previous.id)}
            if rule is not None:
                result[jid] = (stop, rule)
                del pending[jid]

    # Common case: no assignment history or preview queries at all.
    if latest:
        read_plan(latest, {})
    if pending:
        plans = list(
            db.scalars(
                select(Plan)
                .join(Assignment, Assignment.plan_id == Plan.id)
                .where(Assignment.job_id.in_([UUID(jid) for jid in pending]))
                .order_by(Plan.created_at.desc(), Plan.id)
            ).unique()
        )
        legacy_drafts = [
            p.id
            for p in plans
            if p.routing_mode == "organizer"
            and any(jid not in p.payload.get("execution_rules", {}) for jid in pending)
        ]
        sources = {}
        if legacy_drafts:
            for preview in db.scalars(
                select(RoutingPreview).where(
                    RoutingPreview.dispatched_plan_id.in_(legacy_drafts)
                )
            ):
                sources[preview.dispatched_plan_id] = {
                    s["job_id"]
                    for r in preview.payload["view"]["routes"]
                    for s in r["stops"]
                }
        for previous in plans:
            read_plan(previous, sources)
            if not pending:
                break
    for jid in pending:
        result[jid] = (None, {"mode": "legacy", "source_plan_id": None})
    return result


def routing_router(settings):
    router = APIRouter()

    def enabled():
        if not settings.organizer_routing_enabled:
            raise HTTPException(
                503, "Enable ORGANIZER_ROUTING_ENABLED for organiser routing"
            )

    @router.post(
        "/organizer/reports/{report_id}/priority",
        response_model=OrganizerReportView,
        dependencies=[Depends(enabled)],
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

    @router.post(
        "/crews/me/location",
        response_model=CrewLocationView,
        dependencies=[Depends(enabled)],
    )
    def update_location(
        body: CrewLocationUpdate,
        db: Session = Depends(get_db),
        staff: Principal = Depends(get_staff),
    ):
        if staff.role != "crew":
            raise HTTPException(403, "Crew account required")
        if staff.crew_id is None:
            raise HTTPException(403, "Crew account requires a linked crew")
        crew = db.get(Crew, staff.crew_id)
        if crew is None:
            raise HTTPException(404, "Linked crew not found")
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
            db,
            body.crew_ids,
            settings,
            provider,
            str(staff.user_id),
            job_ids=body.job_ids,
            constraints=body.constraints,
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
        return dispatch_preview(
            db,
            preview,
            body.command_id,
            staff.user_id,
            settings,
            accept_partial=body.accept_partial,
        )

    return router
