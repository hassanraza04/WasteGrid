"""Durable, narrowly scoped organiser assessment approval and worker ownership.

The approval admits exactly the frozen backlog plus at most two new real reports.
No provider is called here. All callers hold the ordinary mutation lock before
changing a run; row locks additionally serialize admission and worker claims.
"""

import re
from datetime import datetime, timedelta, timezone
from uuid import UUID, uuid4

from pydantic import ValidationError
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from api.models import AssessmentDemoRun, Photo, Report, Task, now
from api.schemas import Location

APPROVED_REFERENCES = ("WG-19706F8BF5A2", "WG-D0820BDCA7E0")
EXCLUDED_REFERENCES = ("WG-8D724DBFF0D8", "WG-8A03FEB19474")
SCOPE_KEY = "organizer-demo-v1"
MODEL = "xai/grok-4.3"
HEARTBEAT_SECONDS = 10
STALE_SECONDS = 45


class DemoRefused(ValueError):
    """A sanitized, actionable refusal; never contains resident/provider text."""


def utc(value: datetime) -> datetime:
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value


def latest_run(db: Session, *, lock: bool = False) -> AssessmentDemoRun | None:
    query = select(AssessmentDemoRun).where(AssessmentDemoRun.scope_key == SCOPE_KEY)
    return db.scalar(query.with_for_update() if lock else query)


def create_run(db: Session, revision: str) -> AssessmentDemoRun:
    """Freeze exact report UUIDs; caller commits this entire admission transaction."""
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise DemoRefused("A verified full deployed revision is required")
    if latest_run(db, lock=True) is not None:
        raise DemoRefused(
            "An approval already exists; resume or stop its original run ID"
        )
    reports = list(
        db.scalars(
            select(Report)
            .where(Report.public_reference.in_(APPROVED_REFERENCES))
            .order_by(Report.public_reference)
            .with_for_update()
        )
    )
    if {r.public_reference for r in reports} != set(APPROVED_REFERENCES):
        raise DemoRefused("Both approved pending report references must still exist")
    tasks = []
    for report in reports:
        try:
            Location.model_validate(report.location, strict=True)
        except ValidationError as exc:
            raise DemoRefused("Approved report coordinates are invalid") from exc
        if (
            report.illustrative
            or report.job_id
            or report.assessment_status != "pending"
        ):
            raise DemoRefused("An approved report is no longer unassessed and unlinked")
        photo = db.get(Photo, report.photo_id)
        if photo is None or photo.report_id != report.id:
            raise DemoRefused("An approved report photo is missing")
        queued = list(
            db.scalars(
                select(Task)
                .where(
                    Task.payload["report_id"].as_string() == str(report.id),
                    Task.kind.in_(("assessment", "triage")),
                )
                .with_for_update()
            )
        )
        if len(queued) != 1 or not (
            queued[0].kind == "assessment"
            and queued[0].status == "pending"
            and queued[0].attempts == 0
            and queued[0].demo_run_id is None
        ):
            raise DemoRefused(
                "An approved report task has changed or was already attempted"
            )
        tasks.append(queued[0])
    activated = now()
    run = AssessmentDemoRun(
        id=uuid4(),
        scope_key=SCOPE_KEY,
        report_ids=[str(report.id) for report in reports],
        revision=revision,
        model=MODEL,
        starts_at=activated,
        expires_at=activated + timedelta(minutes=60),
    )
    db.add(run)
    db.flush()
    for task in tasks:
        task.demo_run_id = run.id
    db.flush()
    return run


def refresh_window(run: AssessmentDemoRun, timestamp: datetime) -> None:
    if run.status == "active":
        if utc(run.expires_at) <= timestamp:
            run.status, run.reason = "draining", "window_expired"
        elif run.used_attempts >= run.max_attempts:
            run.status, run.reason = "draining", "attempt_limit"


def bind_new_assessment(db: Session, report: Report, task: Task) -> bool:
    """Admit an eligible new report within the report-creation transaction.

    Admission is project-wide because report/account ownership remains device-local.
    Existing idempotent retries do not call this hook again or spend another slot.
    """
    run = latest_run(db, lock=True)
    if run is None:
        return False
    timestamp = now()
    refresh_window(run, timestamp)
    if not (
        run.status == "active"
        and utc(run.starts_at) <= utc(report.created_at) <= timestamp
        and timestamp < utc(run.expires_at)
        and run.new_reports_admitted < run.max_new_reports
        and task.kind == "assessment"
        and task.status == "pending"
        and task.attempts == 0
        and task.demo_run_id is None
        and not report.illustrative
        and report.public_reference not in EXCLUDED_REFERENCES
        and not report.job_id
        and report.assessment_status == "pending"
    ):
        return False
    try:
        Location.model_validate(report.location, strict=True)
    except ValidationError:
        return False
    if db.scalar(
        select(Task.id).where(
            Task.demo_run_id == run.id,
            Task.kind == "assessment",
            Task.payload["report_id"].as_string() == str(report.id),
        )
    ):
        return False
    task.demo_run_id = run.id
    run.new_reports_admitted += 1
    return True


def acquire_owner(db: Session, run_id: UUID, owner: UUID) -> AssessmentDemoRun:
    run = db.get(AssessmentDemoRun, run_id, with_for_update=True)
    if run is None:
        raise DemoRefused("Assessment demo run does not exist")
    timestamp = now()
    refresh_window(run, timestamp)
    if (
        run.worker_owner not in (None, owner)
        and run.worker_lease_until
        and utc(run.worker_lease_until) > timestamp
    ):
        raise DemoRefused("Another assessment demo worker owns the live lease")
    run.worker_owner = owner
    run.heartbeat_at = timestamp
    run.worker_lease_until = timestamp + timedelta(seconds=STALE_SECONDS)
    return run


def owned_run(db: Session, run_id: UUID, owner: UUID) -> AssessmentDemoRun | None:
    run = db.get(AssessmentDemoRun, run_id, with_for_update=True)
    timestamp = now()
    if (
        run is None
        or run.worker_owner != owner
        or run.worker_lease_until is None
        or utc(run.worker_lease_until) <= timestamp
    ):
        return None
    refresh_window(run, timestamp)
    return run


def claim_is_current(
    db: Session,
    run_id: UUID,
    owner: UUID,
    task_id: UUID,
    lease_id: UUID,
    *,
    lock: bool = False,
) -> bool:
    """Fence external calls and outcome writes, without renewing either lease.

    Outcome callers hold the mutation lock and lock both rows until commit so
    ownership cannot change between this check and applying success or failure.
    Stop/window expiry do not revoke an already claimed task's live ownership.
    """
    run = db.get(AssessmentDemoRun, run_id, with_for_update=lock)
    task = db.get(Task, task_id, with_for_update=lock)
    timestamp = now()
    return bool(
        run is not None
        and run.worker_owner == owner
        and run.worker_lease_until is not None
        and utc(run.worker_lease_until) > timestamp
        and task is not None
        and task.demo_run_id == run_id
        and task.status == "running"
        and task.lease_id == lease_id
        and task.leased_until is not None
        and utc(task.leased_until) > timestamp
    )


def heartbeat(db: Session, run_id: UUID, owner: UUID) -> bool:
    run = owned_run(db, run_id, owner)
    if run is None:
        return False
    run.heartbeat_at = now()
    run.worker_lease_until = now() + timedelta(seconds=STALE_SECONDS)
    return True


def release_owner(db: Session, run_id: UUID, owner: UUID) -> None:
    run = db.get(AssessmentDemoRun, run_id, with_for_update=True)
    if run is not None and run.worker_owner == owner:
        run.worker_owner = None
        run.worker_lease_until = None


def stop_run(db: Session, run_id: UUID) -> AssessmentDemoRun:
    run = db.get(AssessmentDemoRun, run_id, with_for_update=True)
    if run is None:
        raise DemoRefused("Assessment demo run does not exist")
    if run.status != "closed":
        run.status, run.reason = "draining", "operator_stopped"
    return run


def finish_drain(db: Session, run: AssessmentDemoRun) -> bool:
    """Unattempted images remain bound; earned triage and interrupted cleanup drain."""
    refresh_window(run, now())
    if run.status == "active":
        return False
    work = db.scalar(
        select(Task.id).where(
            Task.demo_run_id == run.id,
            (Task.status == "running")
            | ((Task.kind == "triage") & (Task.status == "pending")),
        )
    )
    if work is None:
        run.status = "closed"
        return True
    return False


def processing_status(db: Session) -> dict:
    """Sanitized operational facts; configuration never implies provider success."""
    run = latest_run(db)
    empty_queue = dict.fromkeys(("pending", "running", "succeeded", "failed"), 0)
    if run is None:
        return {
            "run_id": None,
            "status": "inactive",
            "reason": None,
            "starts_at": None,
            "expires_at": None,
            "model": None,
            "used_attempts": 0,
            "max_attempts": 4,
            "new_reports_admitted": 0,
            "max_new_reports": 2,
            "worker_online": False,
            "last_heartbeat_at": None,
            "last_success_at": None,
            "queue": empty_queue,
        }
    timestamp = now()
    status, reason = run.status, run.reason
    # Read endpoints derive expiry without writing operational state.
    if status == "active" and utc(run.expires_at) <= timestamp:
        status, reason = "draining", "window_expired"
    elif status == "active" and run.used_attempts >= run.max_attempts:
        status, reason = "draining", "attempt_limit"
    counts = dict(
        db.execute(
            select(Task.status, func.count())
            .where(Task.demo_run_id == run.id)
            .group_by(Task.status)
        ).all()
    )
    return {
        "run_id": str(run.id),
        "status": status,
        "reason": reason,
        "starts_at": run.starts_at,
        "expires_at": run.expires_at,
        "model": run.model,
        "used_attempts": run.used_attempts,
        "max_attempts": run.max_attempts,
        "new_reports_admitted": run.new_reports_admitted,
        "max_new_reports": run.max_new_reports,
        "worker_online": bool(
            run.worker_owner
            and run.heartbeat_at
            and run.worker_lease_until
            and timestamp - utc(run.heartbeat_at) < timedelta(seconds=STALE_SECONDS)
            and utc(run.worker_lease_until) > timestamp
        ),
        "last_heartbeat_at": run.heartbeat_at,
        "last_success_at": run.last_success_at,
        "queue": {key: counts.get(key, 0) for key in empty_queue},
    }
