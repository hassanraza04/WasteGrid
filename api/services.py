"""Persistence boundaries. Agent and transport code must use these validations."""

import json
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from api.auth import digest
from api.models import (
    Conversation,
    Event,
    Job,
    OutgoingMessage,
    Photo,
    Plan,
    Report,
    Task,
    now,
)
from api.schemas import (
    Clarification,
    JobView,
    Recheck,
    ReportUpdate,
    ReportView,
    Snapshot,
)

UPDATE_MESSAGES = {
    "report.received": "Your report has been received.",
    "report.assessed": "Your report has been assessed for cleanup priority.",
    "report.assessment_failed": "Automatic assessment failed; organizer review is required.",
    "report.clarified": "Additional report information was received.",
    "report.triaged": "Your report was reviewed for cleanup.",
    "job.created": "A cleanup job was created for this report.",
    "job.planned": "The cleanup plan was updated.",
    "job.changed": "The cleanup job was updated.",
    "job.unassigned": "The cleanup job is awaiting an available crew.",
    "job.completed": "The crew reported cleanup complete and submitted a photo.",
    "job.recheck_requested": "A recheck of the cleanup was requested.",
}


def dashboard_status(state: str | None):
    if state is None:
        return None
    if state == "completed":
        return "resolved"
    if state in ("assigned", "in_progress", "blocked"):
        return "in-progress"
    return "submitted"


def report_event_condition(report: Report):
    condition = Event.report_id == report.id
    return or_(condition, Event.job_id == report.job_id) if report.job_id else condition


def report_update(record: Event) -> ReportUpdate:
    # Never interpolate audit details, reasons, model text or actor identities.
    message = UPDATE_MESSAGES[record.kind]
    if record.kind in ("report.triaged", "report.assessed"):
        message = {
            "needs_info": "More information is needed about your report.",
            "needs_review": "Your report needs organizer review.",
            "linked_to_job": "Your report is linked to a cleanup job.",
        }.get(record.report_state, message)
    elif record.kind in ("job.planned", "job.changed"):
        message = {
            "assigned": "A crew has been assigned to the cleanup.",
            "in_progress": "Cleanup is in progress.",
            "blocked": "Cleanup is blocked and needs attention.",
            "unassigned": "The cleanup job is awaiting assignment.",
        }.get(record.job_status, message)
    return ReportUpdate(
        id=record.id,
        kind=record.kind,
        created_at=record.created_at,
        message=message,
        status=dashboard_status(record.job_status or record.report_state),
        report_state=record.report_state,
        job_status=record.job_status,
    )


def report_view(db: Session, report: Report) -> ReportView:
    job = db.get(Job, report.job_id) if report.job_id else None
    events = db.scalars(
        select(Event)
        .where(report_event_condition(report))
        .order_by(Event.created_at, Event.id)
    ).all()
    latest = next(
        (report_update(e) for e in reversed(events) if e.kind in UPDATE_MESSAGES), None
    )
    return ReportView(
        id=report.id,
        public_reference=report.public_reference,
        title=report.title,
        address=report.address,
        state=report.state,
        display_status=job.status if job else report.state,
        dashboard_status=dashboard_status(job.status if job else report.state),
        location=report.location,
        note=report.note,
        photo_id=report.photo_id,
        job_id=report.job_id,
        version=report.version,
        illustrative=report.illustrative,
        created_at=report.created_at,
        updated_at=latest.created_at if latest else report.created_at,
        latest_update=latest,
        timeline=events,
        clarifications=report.clarifications,
        triage=report.triage,
        assessment_status=report.assessment_status,
        priority=report.priority,
        needs_review=report.needs_review,
        priority_reason=report.priority_reason,
        assessment=report.assessment,
        resident_answers=report.resident_answers,
        completion_photo_ids=(
            list(db.scalars(select(Photo.id).where(Photo.job_id == report.job_id)))
            if job
            else []
        ),
    )


def snapshot(db: Session, report: Report) -> Snapshot:
    job = db.get(Job, report.job_id) if report.job_id else None
    return Snapshot(
        report=report_view(db, report), job=JobView.model_validate(job) if job else None
    )


def event(
    db: Session,
    kind: str,
    *,
    report_id: UUID | None = None,
    job_id: UUID | None = None,
    command_id: UUID | None = None,
    request_hash: str | None = None,
    crew_id: UUID | None = None,
    actor: str = "system",
    details: dict | None = None,
) -> Event:
    report = db.get(Report, report_id) if report_id else None
    target_job = job_id or (report.job_id if report else None)
    job = db.get(Job, target_job) if target_job else None
    record = Event(
        kind=kind,
        report_id=report_id,
        job_id=job_id,
        command_id=command_id,
        request_hash=request_hash,
        crew_id=crew_id,
        actor=actor,
        details=details or {},
        report_state=report.state if report else None,
        job_status=job.status if job else None,
    )
    db.add(record)
    db.flush()
    reports = (
        [report_id]
        if report_id
        else (
            list(db.scalars(select(Report.id).where(Report.job_id == job_id)))
            if job_id
            else []
        )
    )
    conversations = db.scalars(
        select(Conversation).where(Conversation.report_id.in_(reports))
    ).all()
    for conversation in conversations:
        db.add(
            OutgoingMessage(
                event_id=record.id,
                conversation_id=conversation.id,
                payload={
                    "event_id": str(record.id),
                    "kind": kind,
                    "report_id": str(conversation.report_id),
                },
            )
        )
    return record


def command_seen(db: Session, resource_id: UUID, body, kind: str) -> tuple[bool, str]:
    fingerprint = digest(
        kind
        + str(resource_id)
        + json.dumps(body.model_dump(mode="json", exclude_unset=True), sort_keys=True)
    )
    previous = db.scalar(select(Event).where(Event.command_id == body.command_id))
    if previous:
        if previous.request_hash != fingerprint:
            raise HTTPException(
                409, "Command ID was already used for a different request"
            )
        return True, fingerprint
    return False, fingerprint


def assert_version(actual: int, expected: int):
    if actual != expected:
        raise HTTPException(409, "State changed; fetch current state before retrying")


def apply_clarification(
    db: Session, report_id: UUID, body: Clarification, actor="messaging"
) -> Report:
    report = db.scalar(select(Report).where(Report.id == report_id).with_for_update())
    if report is None:
        raise HTTPException(404, "Report not found")
    seen, fingerprint = command_seen(db, report.id, body, "report.clarified")
    if seen:
        return report
    assert_version(report.version, body.expected_version)
    if report.state not in ("received", "needs_info", "needs_review"):
        raise HTTPException(409, "Clarification is not permitted in the current state")
    report.clarifications = [
        *report.clarifications,
        {
            "note": body.note,
            "location": body.location.model_dump() if body.location else None,
            "created_at": now().isoformat(),
        },
    ]
    if body.location:
        report.location = body.location.model_dump()
    report.state = "received"
    report.version += 1
    event(
        db,
        "report.clarified",
        report_id=report.id,
        command_id=body.command_id,
        request_hash=fingerprint,
        actor=actor,
        details=body.model_dump(mode="json"),
    )
    enqueue(
        db,
        "triage",
        f"triage:{report.id}:{report.version}",
        {"report_id": str(report.id)},
    )
    return report


def apply_recheck(db: Session, report: Report, body: Recheck, actor="messaging") -> Job:
    job = db.scalar(select(Job).where(Job.id == report.job_id).with_for_update())
    if job is None:
        raise HTTPException(409, "Report has no cleanup job")
    seen, fingerprint = command_seen(db, job.id, body, "job.recheck_requested")
    if seen:
        return job
    assert_version(job.version, body.expected_version)
    if job.status != "completed":
        raise HTTPException(409, "Only completed jobs can be submitted for recheck")
    job.status = "recheck_requested"
    job.version += 1
    # Reason is retained in an internal event detail store, never a credential.
    event_record = event(
        db,
        "job.recheck_requested",
        job_id=job.id,
        command_id=body.command_id,
        request_hash=fingerprint,
        actor=actor,
    )
    event_record.details = {"reason": body.reason}
    invalidate_plan(db)
    return job


def enqueue(db: Session, kind: str, key: str, payload: dict) -> Task:
    task = db.scalar(select(Task).where(Task.dedupe_key == key))
    if task:
        if task.payload != payload:
            raise HTTPException(
                409, "Idempotency key already used with different input"
            )
        return task
    task = Task(kind=kind, dedupe_key=key, payload=payload)
    db.add(task)
    db.flush()
    return task


def invalidate_plan(db: Session):
    for plan in db.scalars(select(Plan).where(Plan.stale.is_(False))):
        plan.stale = True
    from uuid import uuid4

    return enqueue(db, "plan", f"plan:{uuid4()}", {})
