"""Server-filtered organiser work queues and truthful operational summaries."""

import os
import re
from collections import defaultdict
from datetime import timedelta
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from sqlalchemy import case, func, or_, select
from sqlalchemy.orm import Session

from api.auth import organizer
from api.db import get_db
from api.models import Crew, Event, Job, Report, Task, now
from api.organizer_schemas import (
    OrganizerIndexedJob,
    OrganizerJobIndex,
    OrganizerOverview,
    OrganizerReportIndex,
    OrganizerSummaryReport,
    Priority,
    ProcessingTask,
    ReportProcessing,
)
from api.route_solver import PRIORITY_WEIGHTS
from api.schemas import JobView
from api.workflows import job_assessment_approved

SAFE_TASK_ERRORS = frozenset(
    {
        "assessment_interrupted",
        "state_changed",
        "invalid_proposal",
        "provider_unavailable",
        "assessment_timeout",
        "assessment_invalid",
        "demo_interrupted",
        "demo_stopped",
    }
)


def review_condition():
    """Current holds, independent of the original assessment outcome.

    Organiser approval clears the flags/state while retaining assessment_status
    as evidence; a historical model review must not reopen an approved report.
    """
    return or_(
        Report.needs_review.is_(True),
        Report.organizer_review_required.is_(True),
        Report.state == "needs_review",
    )


def job_routing_facts(db, job, reports, *, approval_events=None):
    """Share routing's job gate without confusing fixed assignments with a hold.

    Ownership, equipment and GPS are crew-selection constraints applied by the
    existing routing snapshot. A locked job remains eligible as fixed work.
    """
    priorities = [r.priority for r in reports if r.priority in PRIORITY_WEIGHTS]
    priority = max(priorities, key=PRIORITY_WEIGHTS.get) if priorities else None
    approved = bool(reports) and all(
        r.priority in PRIORITY_WEIGHTS
        and job_assessment_approved(
            db,
            r,
            approval_events=(
                approval_events.get(r.id, []) if approval_events is not None else None
            ),
        )
        for r in reports
    )
    reason = (
        "held"
        if job.held
        else (
            job.status
            if job.status in ("blocked", "recheck_requested", "completed")
            else "assessment_or_priority_review" if not approved else None
        )
    )
    return priority, [reason] if reason else []


def report_processing(db: Session, report_id: UUID) -> ReportProcessing:
    """Only task status and known error categories leave the private task table."""
    tasks = list(
        db.scalars(
            select(Task)
            .where(
                Task.kind.in_(["assessment", "triage"]),
                Task.payload["report_id"].as_string() == str(report_id),
            )
            .order_by(Task.created_at.desc(), Task.id.desc())
        )
    )
    latest = {}
    for task in tasks:
        latest.setdefault(task.kind, task)

    def view(kind):
        task = latest.get(kind)
        if task is None:
            return None
        return ProcessingTask(
            status=task.status,
            attempts=task.attempts,
            error_code=(
                task.last_error
                if task.last_error in SAFE_TASK_ERRORS
                else "processing_failed" if task.last_error else None
            ),
        )

    return ReportProcessing(
        assessment=view("assessment"),
        triage=view("triage"),
        demo_run_id=next(
            (t.demo_run_id for t in tasks if getattr(t, "demo_run_id", None)), None
        ),
    )


def _reports_by_job(db, job_ids):
    reports, approvals = defaultdict(list), defaultdict(list)
    if job_ids:
        for report in db.scalars(
            select(Report).where(Report.job_id.in_(job_ids)).order_by(Report.id)
        ):
            reports[report.job_id].append(report)
        report_ids = [r.id for group in reports.values() for r in group]
        if report_ids:
            for record in db.scalars(
                select(Event).where(
                    Event.report_id.in_(report_ids), Event.kind == "report.triaged"
                )
            ):
                approvals[record.report_id].append(record)
    return reports, approvals


def _job_scope(include_illustrative):
    return True if include_illustrative else Job.illustrative.is_(False)


def organizer_router(settings):
    router = APIRouter(dependencies=[Depends(organizer)])

    @router.get("/organizer/overview", response_model=OrganizerOverview)
    def overview(include_illustrative: bool = False, db: Session = Depends(get_db)):
        # Imported lazily so read contracts do not own the worker implementation.
        from api.assessment_demo import processing_status

        report_scope = True if include_illustrative else Report.illustrative.is_(False)
        job_scope = _job_scope(include_illustrative)
        jobs = list(db.scalars(select(Job).where(Job.status != "completed", job_scope)))
        reports, approvals = _reports_by_job(db, [j.id for j in jobs])
        facts = [
            job_routing_facts(db, job, reports[job.id], approval_events=approvals)
            for job in jobs
        ]
        at = now()
        completed_recently = (
            select(Event.id)
            .where(
                Event.job_id == Job.id,
                Event.kind == "job.completed",
                Event.created_at >= at - timedelta(hours=24),
                Event.created_at <= at,
            )
            .exists()
        )
        revision = os.environ.get("RENDER_GIT_COMMIT", "")
        return OrganizerOverview(
            counts=dict(
                needs_review=db.scalar(
                    select(func.count())
                    .select_from(Report)
                    .where(report_scope, review_condition())
                ),
                high_priority_jobs=sum(priority == "high" for priority, _ in facts),
                in_progress_jobs=sum(job.status == "in_progress" for job in jobs),
                available_crews=db.scalar(
                    select(func.count())
                    .select_from(Crew)
                    .where(
                        Crew.available.is_(True),
                        True if include_illustrative else Crew.illustrative.is_(False),
                    )
                ),
                blocked_jobs=sum(bool(reasons) for _, reasons in facts),
                completed_24h=db.scalar(
                    select(func.count())
                    .select_from(Job)
                    .where(job_scope, Job.status == "completed", completed_recently)
                ),
                awaiting_assessment=db.scalar(
                    select(func.count())
                    .select_from(Report)
                    .where(report_scope, Report.assessment_status == "pending")
                ),
            ),
            include_illustrative=include_illustrative,
            configuration=dict(
                revision=(
                    revision if re.fullmatch(r"[0-9a-f]{40}", revision) else "local"
                ),
                organizer_routing_enabled=settings.organizer_routing_enabled,
                road_service_configured=bool(settings.routing_osrm_base_url.strip()),
                messaging_pilot_enabled=settings.messaging_pilot_enabled,
            ),
            processing=processing_status(db),
        )

    @router.get("/organizer/report-index", response_model=OrganizerReportIndex)
    def report_index(
        q: str = Query(default="", max_length=200),
        view: Literal[
            "all", "needs_review", "awaiting_assessment", "active_cleanup"
        ] = "all",
        priority: Priority | None = None,
        assessment_status: (
            Literal["pending", "assessed", "needs_review", "failed"] | None
        ) = None,
        sort: Literal["newest", "oldest", "priority"] = "newest",
        include_illustrative: bool = False,
        limit: int = Query(default=25, ge=1, le=100),
        offset: int = Query(default=0, ge=0),
        db: Session = Depends(get_db),
    ):
        query = (
            select(Report, Job, Crew)
            .outerjoin(Job, Report.job_id == Job.id)
            .outerjoin(Crew, Job.assigned_crew_id == Crew.id)
        )
        if not include_illustrative:
            query = query.where(Report.illustrative.is_(False))
        if q.strip():
            # Escape SQL wildcard characters: the UI promises text search.
            pattern = (
                "%"
                + q.strip()
                .replace("\\", "\\\\")
                .replace("%", "\\%")
                .replace("_", "\\_")
                + "%"
            )
            query = query.where(
                or_(
                    Report.public_reference.ilike(pattern, escape="\\"),
                    Report.title.ilike(pattern, escape="\\"),
                    Report.address.ilike(pattern, escape="\\"),
                )
            )
        if view == "needs_review":
            query = query.where(review_condition())
        elif view == "awaiting_assessment":
            query = query.where(Report.assessment_status == "pending")
        elif view == "active_cleanup":
            query = query.where(Job.id.is_not(None), Job.status != "completed")
        if priority:
            query = query.where(Report.priority == priority)
        if assessment_status:
            query = query.where(Report.assessment_status == assessment_status)
        total = db.scalar(select(func.count()).select_from(query.subquery()))
        priority_rank = case(
            (Report.priority == "high", 0),
            (Report.priority == "medium", 1),
            (Report.priority == "routine", 2),
            else_=3,
        )
        ordering = (
            [Report.created_at.asc(), Report.id.asc()]
            if sort == "oldest"
            else (
                [priority_rank, Report.created_at.desc(), Report.id.asc()]
                if sort == "priority"
                else [Report.created_at.desc(), Report.id.asc()]
            )
        )
        rows = list(db.execute(query.order_by(*ordering).limit(limit).offset(offset)))
        ids = [r.id for r, _, _ in rows]
        updated = (
            dict(
                db.execute(
                    select(Event.report_id, func.max(Event.created_at))
                    .where(Event.report_id.in_(ids))
                    .group_by(Event.report_id)
                ).all()
            )
            if ids
            else {}
        )
        job_ids = [job.id for _, job, _ in rows if job]
        job_updated = (
            dict(
                db.execute(
                    select(Event.job_id, func.max(Event.created_at))
                    .where(Event.job_id.in_(job_ids))
                    .group_by(Event.job_id)
                ).all()
            )
            if job_ids
            else {}
        )
        items = []
        for report, job, crew in rows:
            category = job.category if job else (report.triage or {}).get("category")
            items.append(
                OrganizerSummaryReport(
                    id=report.id,
                    public_reference=report.public_reference,
                    category=category,
                    title=f"{category or 'Cleanup report'} · {report.public_reference}",
                    address=report.address,
                    photo_id=report.photo_id,
                    created_at=report.created_at,
                    updated_at=max(
                        report.created_at,
                        updated.get(report.id) or report.created_at,
                        job_updated.get(report.job_id) or report.created_at,
                    ),
                    display_status=job.status if job else report.state,
                    state=report.state,
                    assessment_status=report.assessment_status,
                    priority=report.priority,
                    needs_review=bool(
                        report.needs_review
                        or report.organizer_review_required
                        or report.state == "needs_review"
                    ),
                    illustrative=report.illustrative,
                    job_id=report.job_id,
                    job_status=job.status if job else None,
                    crew_id=job.assigned_crew_id if job else None,
                    crew_name=crew.name if crew else None,
                    route_position=job.route_position if job else None,
                )
            )
        return OrganizerReportIndex(
            items=items, total=total, limit=limit, offset=offset
        )

    @router.get("/organizer/job-index", response_model=OrganizerJobIndex)
    def job_index(
        include_illustrative: bool = False,
        limit: int = Query(default=100, ge=1, le=100),
        offset: int = Query(default=0, ge=0),
        db: Session = Depends(get_db),
    ):
        query = select(Job).where(
            Job.status != "completed", _job_scope(include_illustrative)
        )
        total = db.scalar(select(func.count()).select_from(query.subquery()))
        jobs = list(db.scalars(query.order_by(Job.id).limit(limit).offset(offset)))
        reports, approvals = _reports_by_job(db, [j.id for j in jobs])
        items = []
        for job in jobs:
            linked = reports[job.id]
            priority, reasons = job_routing_facts(
                db, job, linked, approval_events=approvals
            )
            items.append(
                OrganizerIndexedJob(
                    **JobView.model_validate(job).model_dump(),
                    priority=priority,
                    eligible=not reasons,
                    eligibility_reasons=reasons,
                    public_references=[r.public_reference for r in linked],
                    address=next((r.address for r in linked if r.address), None),
                    photo_id=linked[0].photo_id if linked else None,
                )
            )
        return OrganizerJobIndex(items=items, total=total, limit=limit, offset=offset)

    return router
