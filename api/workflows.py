"""Person 2 validates recommendations and persists all business state changes."""

import hashlib
import json
import math
from uuid import uuid4

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from api.models import Assignment, Crew, Event, Job, Plan, Report
from api.schemas import (
    CrewPatch,
    CrewView,
    JobPatch,
    JobView,
    PlanningInput,
    PlanProposal,
    PlanStop,
    TriageRecommendation,
)
from api.services import assert_version, command_seen, event, invalidate_plan


def distance_km(a: dict, b: dict) -> float:
    lat1, lat2 = math.radians(a["latitude"]), math.radians(b["latitude"])
    dlat = lat2 - lat1
    dlon = math.radians(b["longitude"] - a["longitude"])
    h = (
        math.sin(dlat / 2) ** 2
        + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    )
    return 6371 * 2 * math.asin(min(1, math.sqrt(h)))


def travel_estimate(a: dict, b: dict) -> float:
    return round(distance_km(a, b) * 1.3 / 20 * 60, 2)


def eligible(job: Job, crew: Crew | None) -> bool:
    return bool(
        crew and crew.available and set(job.required_equipment) <= set(crew.equipment)
    )


def build_planning_input(db: Session) -> PlanningInput:
    jobs = list(db.scalars(select(Job).order_by(Job.id)))
    crews = list(db.scalars(select(Crew).order_by(Crew.id)))
    unfinished = [j for j in jobs if j.status != "completed"]
    completed = {str(c.id): 0.0 for c in crews}
    for record in db.scalars(select(Event).where(Event.kind == "job.completed")):
        cid = record.details.get("crew_id")
        if cid in completed:
            completed[cid] += record.details.get("consumed_minutes", 0)
    locations = [c.start_location for c in crews] + [j.location for j in unfinished]
    fixed = [
        PlanStop(
            job_id=j.id,
            crew_id=j.assigned_crew_id,
            position=j.route_position or 0,
            travel_minutes=j.travel_minutes,
            service_minutes=j.estimated_service_minutes,
        )
        for j in unfinished
        if j.assigned_crew_id and (j.locked or j.status == "in_progress")
    ]
    value = PlanningInput(
        jobs=[JobView.model_validate(j) for j in unfinished],
        crews=[CrewView.model_validate(c) for c in crews],
        fixed_assignments=fixed,
        completed_minutes=completed,
        node_ids=[f"crew:{c.id}" for c in crews] + [f"job:{j.id}" for j in unfinished],
        travel_minutes=[[travel_estimate(a, b) for b in locations] for a in locations],
        travel_estimates_label="Illustrative estimate: straight-line distance × 1.3 at 20 km/h; no live traffic",
        revision="",
    )
    value.revision = hashlib.sha256(
        json.dumps(
            value.model_dump(mode="json", exclude={"revision"}), sort_keys=True
        ).encode()
    ).hexdigest()
    return value


def apply_triage(db: Session, proposal: TriageRecommendation, actor="agent") -> Report:
    report = db.get(Report, proposal.report_id)
    if report is None:
        raise HTTPException(404, "Report not found")
    seen, fingerprint = command_seen(db, report.id, proposal, "report.triaged")
    if seen:
        return report
    assert_version(report.version, proposal.expected_version)
    if report.state == "linked_to_job":
        raise HTTPException(409, "Linked reports cannot create another job")
    evidence = set(
        db.scalars(select(Report.id).where(Report.id.in_(proposal.evidence_report_ids)))
    )
    if evidence != set(proposal.evidence_report_ids):
        raise HTTPException(422, "Evidence references an unknown report")
    report.triage = proposal.model_dump(mode="json")
    if proposal.hazard or proposal.next_action == "review":
        report.state = "needs_review"
    elif (
        report.location is None
        or proposal.missing_information
        or proposal.next_action == "request_info"
    ):
        report.state = "needs_info"
    elif not proposal.evidence_sufficient:
        report.state = "needs_review"
    elif proposal.next_action == "link_job":
        candidate = (
            db.get(Report, proposal.duplicate_candidate_id)
            if proposal.duplicate_candidate_id
            else None
        )
        job = db.get(Job, candidate.job_id) if candidate and candidate.job_id else None
        if (
            not proposal.duplicate_confirmed
            or not job
            or candidate.id == report.id
            or job.status in ("completed", "recheck_requested")
            or candidate.id not in evidence
        ):
            report.state = "needs_review"
        else:
            report.job_id = job.id
            report.state = "linked_to_job"
    elif proposal.next_action == "create_job":
        if not proposal.estimated_service_minutes or not proposal.proposed_equipment:
            raise HTTPException(
                422, "A job requires equipment and a service-time estimate"
            )
        if proposal.duplicate_candidate_id:
            report.state = "needs_review"
        else:
            job = Job(
                location=report.location,
                category=proposal.category,
                required_equipment=proposal.proposed_equipment,
                estimated_service_minutes=proposal.estimated_service_minutes,
                decision_summary=proposal.decision_summary,
                illustrative=report.illustrative,
                unassigned_reason="planning_pending",
            )
            db.add(job)
            db.flush()
            report.job_id = job.id
            report.state = "linked_to_job"
            event(db, "job.created", job_id=job.id, actor=actor)
    report.version += 1
    event(
        db,
        "report.triaged",
        report_id=report.id,
        command_id=proposal.command_id,
        request_hash=fingerprint,
        actor=actor,
        details={
            "decision": proposal.model_dump(mode="json"),
            "applied_state": report.state,
        },
    )
    if report.job_id:
        invalidate_plan(db)
    return report


def apply_plan(db: Session, proposal: PlanProposal) -> Plan:
    current = build_planning_input(db)
    if current.revision != proposal.revision:
        raise HTTPException(409, "Planning inputs changed; regenerate the plan")
    if proposal.travel_estimates_label != current.travel_estimates_label:
        raise HTTPException(422, "Preserve the travel estimate label")
    jobs = {j.id: j for j in db.scalars(select(Job).where(Job.status != "completed"))}
    crews = {c.id: c for c in db.scalars(select(Crew))}
    assignments = {s.job_id: s for s in proposal.assignments}
    unassigned = {s.job_id: s for s in proposal.unassigned}
    if (
        len(assignments) != len(proposal.assignments)
        or len(unassigned) != len(proposal.unassigned)
        or set(assignments) & set(unassigned)
        or set(assignments) | set(unassigned) != set(jobs)
    ):
        raise HTTPException(422, "Plan must cover every unfinished job exactly once")
    fixed = {s.job_id: s for s in current.fixed_assignments}
    for jid, stop in fixed.items():
        proposed = assignments.get(jid)
        if proposed is None or (
            proposed.crew_id,
            proposed.position,
            proposed.service_minutes,
        ) != (stop.crew_id, stop.position, stop.service_minutes):
            raise HTTPException(
                422, "Preserve in-progress and manually locked assignments"
            )
        if (
            jobs[jid].status == "in_progress"
            and proposed.travel_minutes != stop.travel_minutes
        ):
            raise HTTPException(422, "Preserve travel already consumed by ongoing work")
    nodes = {node: i for i, node in enumerate(current.node_ids)}
    used = dict(current.completed_minutes)
    tails = {cid: f"crew:{cid}" for cid in crews}
    for cid in {s.crew_id for s in proposal.assignments}:
        if cid not in crews:
            raise HTTPException(422, "Unknown crew")
        stops = sorted(
            (s for s in proposal.assignments if s.crew_id == cid),
            key=lambda s: s.position,
        )
        if len({s.position for s in stops}) != len(stops):
            raise HTTPException(422, "Crew stop positions must be unique")
        previous = f"crew:{cid}"
        for stop in stops:
            job = jobs[stop.job_id]
            # Ongoing work stays with its crew even if availability changes.
            if job.status != "in_progress" and (
                not eligible(job, crews[cid])
                or job.held
                or job.status in ("blocked", "recheck_requested")
            ):
                raise HTTPException(
                    422,
                    "Assignment violates availability, equipment, or job eligibility",
                )
            if stop.service_minutes != job.estimated_service_minutes:
                raise HTTPException(422, "Planner cannot shorten service estimates")
            minimum = current.travel_minutes[nodes[previous]][nodes[f"job:{job.id}"]]
            if job.status != "in_progress" and stop.travel_minutes + 0.001 < minimum:
                raise HTTPException(422, "Travel time is below the supplied estimate")
            used[str(cid)] += stop.travel_minutes + stop.service_minutes
            previous = f"job:{job.id}"
        tails[cid] = previous
        # If existing completed/ongoing work already exceeds a shortened shift,
        # preserve it but admit no further work to that crew.
        protected = current.completed_minutes[str(cid)] + sum(
            s.travel_minutes + s.service_minutes
            for s in stops
            if jobs[s.job_id].status == "in_progress"
        )
        if used[str(cid)] > max(crews[cid].shift_minutes, protected) + 0.001:
            raise HTTPException(422, "Plan exceeds crew shift capacity")
    for jid, item in unassigned.items():
        job = jobs[jid]
        required = (
            "held"
            if job.held
            else job.status if job.status in ("blocked", "recheck_requested") else None
        )
        if required:
            if item.reason_code != required:
                raise HTTPException(422, "Unassigned reason does not match job state")
            continue
        eligible_crews = [c for c in crews.values() if eligible(job, c)]
        if not eligible_crews:
            if item.reason_code != "no_eligible_crew":
                raise HTTPException(
                    422, "Use no_eligible_crew for unavailable equipment/resources"
                )
        else:
            if item.reason_code != "shift_limit":
                raise HTTPException(
                    422, "Unassigned reason is unsupported by current state"
                )
            for crew in eligible_crews:
                travel = current.travel_minutes[nodes[tails[crew.id]]][
                    nodes[f"job:{jid}"]
                ]
                if (
                    used[str(crew.id)] + travel + job.estimated_service_minutes
                    <= crew.shift_minutes
                ):
                    raise HTTPException(
                        422, "Job still fits at the end of an eligible crew route"
                    )
    plan = Plan(id=uuid4(), payload=proposal.model_dump(mode="json"))
    db.add(plan)
    db.flush()
    for jid, job in jobs.items():
        before = (
            job.status,
            job.assigned_crew_id,
            job.route_position,
            job.travel_minutes,
            job.unassigned_reason,
        )
        if jid in assignments:
            stop = assignments[jid]
            job.assigned_crew_id = stop.crew_id
            job.route_position = stop.position
            job.travel_minutes = stop.travel_minutes
            job.unassigned_reason = None
            if job.status != "in_progress":
                job.status = "assigned"
            db.add(
                Assignment(
                    plan_id=plan.id,
                    job_id=jid,
                    crew_id=stop.crew_id,
                    position=stop.position,
                )
            )
        else:
            job.assigned_crew_id = None
            job.route_position = None
            job.travel_minutes = 0
            job.unassigned_reason = unassigned[jid].reason_code
            if job.status not in ("blocked", "recheck_requested"):
                job.status = "unassigned"
        after = (
            job.status,
            job.assigned_crew_id,
            job.route_position,
            job.travel_minutes,
            job.unassigned_reason,
        )
        if before != after:
            job.version += 1
            event(
                db,
                "job.planned",
                job_id=jid,
                details={
                    "plan_id": str(plan.id),
                    "status": job.status,
                    "reason": job.unassigned_reason,
                },
            )
    return plan


def ensure_can_start(db: Session, job: Job):
    crew = db.get(Crew, job.assigned_crew_id) if job.assigned_crew_id else None
    if not eligible(job, crew) or job.held:
        raise HTTPException(409, "Crew or job is no longer eligible; replan required")
    plan = db.scalar(select(Plan).order_by(Plan.created_at.desc(), Plan.id).limit(1))
    if (
        plan is None
        or plan.stale
        or not db.scalar(
            select(Assignment.id).where(
                Assignment.plan_id == plan.id,
                Assignment.job_id == job.id,
                Assignment.crew_id == crew.id,
            )
        )
    ):
        raise HTTPException(409, "A current validated plan is required before starting")
    used = build_planning_input(db).completed_minutes[str(crew.id)] + sum(
        j.estimated_service_minutes + j.travel_minutes
        for j in db.scalars(
            select(Job).where(
                Job.assigned_crew_id == crew.id, Job.status != "completed"
            )
        )
    )
    if used > crew.shift_minutes:
        raise HTTPException(409, "Crew shift capacity changed; replan required")


def change_job(
    db: Session, job: Job, body: JobPatch, actor: str, is_organizer: bool
) -> Job:
    seen, fingerprint = command_seen(db, job.id, body, "job.changed")
    if seen:
        return job
    assert_version(job.version, body.expected_version)
    override_fields = body.model_fields_set & {"assigned_crew_id", "locked", "held"}
    if not is_organizer and override_fields:
        raise HTTPException(403, "Only organizers can override assignments")
    if body.status == "completed":
        raise HTTPException(409, "Completion requires crew photo evidence")
    transitions = {
        "assigned": {"in_progress", "blocked"},
        "in_progress": {"blocked"},
        "blocked": {"in_progress"},
    }
    if is_organizer:
        transitions = {
            **transitions,
            "blocked": {"unassigned", "in_progress"},
            "recheck_requested": {"unassigned"},
            "assigned": {"in_progress", "blocked", "unassigned"},
            "unassigned": {"assigned", "blocked"},
        }
        if not body.reason:
            raise HTTPException(422, "Organizer changes require an audit reason")
    if (
        body.status is not None
        and body.status != job.status
        and body.status not in transitions.get(job.status, set())
    ):
        raise HTTPException(409, "Transition is not permitted")
    if override_fields and job.status in ("completed", "in_progress"):
        raise HTTPException(409, "Preserve completed and in-progress work")
    if "assigned_crew_id" in body.model_fields_set:
        if body.assigned_crew_id is None:
            job.assigned_crew_id = None
            job.status = "unassigned"
            job.locked = False
        else:
            crew = db.get(Crew, body.assigned_crew_id)
            if not eligible(job, crew) or job.held:
                raise HTTPException(
                    409, "Crew lacks required availability or equipment"
                )
            used = build_planning_input(db).completed_minutes[str(crew.id)] + sum(
                j.estimated_service_minutes + j.travel_minutes
                for j in db.scalars(
                    select(Job).where(
                        Job.assigned_crew_id == crew.id,
                        Job.id != job.id,
                        Job.status != "completed",
                    )
                )
            )
            minimum = travel_estimate(crew.start_location, job.location)
            if used + job.estimated_service_minutes + minimum > crew.shift_minutes:
                raise HTTPException(409, "Crew has insufficient shift capacity")
            job.assigned_crew_id = crew.id
            job.status = "assigned"
            positions = list(
                db.scalars(
                    select(Job.route_position).where(
                        Job.assigned_crew_id == crew.id, Job.id != job.id
                    )
                )
            )
            job.route_position = (
                max((p for p in positions if p is not None), default=-1) + 1
            )
            job.travel_minutes = minimum
            job.locked = True
    if body.held is not None:
        job.held = body.held
        if job.held:
            job.status = "unassigned"
            job.assigned_crew_id = None
            job.locked = False
    if body.locked is not None:
        if body.locked and (not job.assigned_crew_id or job.held):
            raise HTTPException(409, "Only assigned jobs can be locked")
        job.locked = body.locked
    if body.status is not None:
        if body.status == "in_progress":
            ensure_can_start(db, job)
        if body.status == "assigned" and not job.assigned_crew_id:
            raise HTTPException(422, "An assigned job requires a crew")
        job.status = body.status
    if job.status == "unassigned":
        job.assigned_crew_id = None
        job.locked = False
        job.route_position = None
        job.travel_minutes = 0
    if job.held and job.status != "unassigned":
        raise HTTPException(409, "Held jobs must remain unassigned")
    job.version += 1
    event(
        db,
        "job.changed",
        job_id=job.id,
        command_id=body.command_id,
        request_hash=fingerprint,
        actor=actor,
        details=body.model_dump(mode="json"),
    )
    invalidate_plan(db)
    return job


def change_crew(db: Session, crew: Crew, body: CrewPatch, actor: str):
    seen, fingerprint = command_seen(db, crew.id, body, "crew.changed")
    if seen:
        return crew
    assert_version(crew.version, body.expected_version)
    for key in body.model_fields_set - {"command_id", "expected_version"}:
        value = getattr(body, key)
        if value is None:
            raise HTTPException(422, "Crew fields cannot be null")
        setattr(crew, key, value.model_dump() if key == "start_location" else value)
    crew.version += 1
    for job in db.scalars(
        select(Job).where(
            Job.assigned_crew_id == crew.id,
            Job.status == "assigned",
            Job.locked.is_(False),
        )
    ):
        job.assigned_crew_id = None
        job.status = "unassigned"
        job.route_position = None
        job.travel_minutes = 0
        job.unassigned_reason = "resources_changed"
        job.version += 1
        event(
            db,
            "job.unassigned",
            job_id=job.id,
            actor=actor,
            details={"reason": "resources_changed"},
        )
    event(
        db,
        "crew.changed",
        crew_id=crew.id,
        command_id=body.command_id,
        request_hash=fingerprint,
        actor=actor,
        details=body.model_dump(mode="json"),
    )
    invalidate_plan(db)
    return crew
