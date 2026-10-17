"""Scoped, ordered and replay-safe natural-language pilot follow-ups."""

import logging
from datetime import timedelta
from uuid import uuid4, uuid5

from fastapi import HTTPException
from sqlalchemy import String, and_, cast, or_, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session, aliased

from api.db import mutation_lock
from api.followup_ai import validate_intent
from api.models import (
    Conversation,
    Job,
    MessagingInbound,
    MessagingThread,
    Report,
    Task,
    now,
)
from api.pilot import allowed_link, enabled, ensure_run, queue_text
from api.schemas import Clarification, Location, Recheck
from api.services import apply_clarification, apply_recheck

logger = logging.getLogger(__name__)


def _authorized(db, settings, inbound, thread, conversation):
    return (
        inbound.status in ("queued", "running")
        and not thread.paused
        and inbound.consent_revision == thread.consent_revision
        and conversation.thread_id == thread.id
        and conversation.report_id == inbound.report_id
        and allowed_link(db, settings, conversation)
    )


def _finish(db, inbound, task, thread, conversation, *, text=None, error=None):
    if text is not None:
        queue_text(db, thread, text, conversation=conversation)
    inbound.status = "failed" if error else "processed"
    inbound.last_error = error
    task.status = "failed" if error else "succeeded"
    task.last_error = error
    task.leased_until = task.lease_id = None
    task.result = {"inbound_id": str(inbound.id), "outcome": error or "processed"}


def _cancel(inbound, task):
    inbound.status, inbound.last_error = "cancelled", "consent_changed"
    task.status, task.last_error = "succeeded", None
    task.leased_until = task.lease_id = None
    task.result = {"skipped": "consent_changed", "inbound_id": str(inbound.id)}


def _context(db, inbound, report):
    job = db.get(Job, report.job_id) if report.job_id else None
    messages = list(
        db.scalars(
            select(MessagingInbound.body)
            .where(
                MessagingInbound.thread_id == inbound.thread_id,
                MessagingInbound.report_id == inbound.report_id,
                MessagingInbound.received_at < inbound.received_at,
            )
            .order_by(MessagingInbound.received_at.desc(), MessagingInbound.id.desc())
            .limit(6)
        )
    )
    return {
        "report": {
            "public_reference": report.public_reference,
            "state": report.state,
            "display_status": job.status if job else report.state,
            "version": report.version,
            "assessment_status": report.assessment_status,
            "needs_review": report.needs_review,
        },
        "job": {"status": job.status, "version": job.version} if job else None,
        "resident_transcript": list(reversed(messages)),
    }, {
        "report_version": report.version,
        "job_id": str(job.id) if job else None,
        "job_version": job.version if job else None,
    }


def _status(report, job):
    state = job.status if job else report.state
    messages = {
        "received": "Your report has been received.",
        "needs_info": "More information is needed about your report.",
        "needs_review": "Your report needs organizer review.",
        "linked_to_job": "Your report is linked to a cleanup job.",
        "unassigned": "The cleanup job is awaiting assignment.",
        "assigned": "A crew has been assigned to the cleanup.",
        "in_progress": "Cleanup is in progress.",
        "blocked": "Cleanup is blocked and needs attention.",
        "completed": "The crew reported cleanup complete.",
        "recheck_requested": "A recheck of the cleanup was requested.",
    }
    if report.needs_review or report.organizer_review_required:
        return "Your report needs organizer review."
    return messages.get(state, "Your report is being reviewed.")


def _apply(db, settings, inbound, report, saved):
    intent = validate_intent(inbound.body, saved["intent"])
    job = db.get(Job, report.job_id) if report.job_id else None
    prefix = f"{report.public_reference}: "
    if intent.kind == "status":
        return prefix + _status(report, job)
    if intent.kind == "help":
        return prefix + (
            "Ask for report status, send additional information or explicit GPS "
            "coordinates, or request a recheck after the crew reports "
            "cleanup complete. "
            "Please send one request at a time."
        )
    current_job = str(job.id) if job else None
    if (
        report.version != saved["report_version"]
        or current_job != saved["job_id"]
        or (job.version if job else None) != saved["job_version"]
    ):
        return prefix + (
            "The report changed while your message was being processed. "
            "No change was made; please check the status and send your request again."
        )
    command_id = uuid5(inbound.id, "action")
    if intent.kind == "clarification":
        if report.state not in ("received", "needs_info", "needs_review"):
            return prefix + (
                "Additional information cannot change a report after job linking. "
                "Please contact the organizer about changes."
            )
        if intent.note is not None:
            report.needs_review = True
            report.state = "needs_review"
            reason = "Resident clarification requires organizer review."
            if reason not in (report.priority_reason or ""):
                report.priority_reason = (
                    f"{report.priority_reason or ''} {reason}".strip()
                )
        apply_clarification(
            db,
            report.id,
            Clarification(
                command_id=command_id,
                expected_version=saved["report_version"],
                note=intent.note or "Resident supplied explicit coordinates.",
                location=(
                    Location.model_validate(intent.location.model_dump())
                    if intent.location
                    else None
                ),
            ),
            actor="resident-chalk-followup",
            duplicate_radius_meters=settings.duplicate_radius_meters,
        )
        return prefix + (
            "Your additional information was recorded for organizer review."
            if report.needs_review
            else "Your location clarification was recorded."
        )
    if job is None or job.status != "completed":
        return prefix + (
            "A recheck can be requested after the crew reports cleanup complete. "
            "No change was made."
        )
    apply_recheck(
        db,
        report,
        Recheck(
            command_id=command_id,
            expected_version=saved["job_version"],
            reason=intent.reason,
        ),
        actor="resident-chalk-followup",
    )
    return prefix + "Your cleanup recheck request was recorded for organizer review."


def _claim(db, settings):
    older = aliased(MessagingInbound)
    predecessor = select(older.id).where(
        older.thread_id == MessagingInbound.thread_id,
        older.status.in_(("queued", "running")),
        or_(
            older.received_at < MessagingInbound.received_at,
            and_(
                older.received_at == MessagingInbound.received_at,
                older.id < MessagingInbound.id,
            ),
        ),
    )
    return db.execute(
        select(Task, MessagingInbound, MessagingThread, Conversation, Report)
        .join(
            MessagingInbound,
            Task.payload["inbound_id"].as_string() == cast(MessagingInbound.id, String),
        )
        .join(MessagingThread, MessagingThread.id == MessagingInbound.thread_id)
        .join(Conversation, Conversation.id == MessagingInbound.conversation_id)
        .join(Report, Report.id == MessagingInbound.report_id)
        .where(
            Task.kind == "pilot_followup",
            or_(
                and_(Task.status == "pending", Task.next_attempt_at <= now()),
                and_(Task.status == "running", Task.leased_until < now()),
            ),
            Report.id.in_(settings.messaging_pilot_report_ids),
            Report.illustrative.is_(False),
            MessagingThread.channel == "imessage",
            MessagingThread.external_id.in_(settings.messaging_pilot_chat_ids),
            MessagingThread.pilot_id == settings.messaging_pilot_id,
            MessagingThread.project_id == settings.photon_project_id,
            MessagingThread.sender_id == settings.photon_agent_sender_id,
            MessagingInbound.project_id == settings.photon_project_id,
            ~predecessor.exists(),
        )
        .order_by(MessagingInbound.received_at, MessagingInbound.id)
        .with_for_update(skip_locked=True)
    )


def process_followup(engine, settings, client) -> bool:
    """Process one eligible chat item without replaying an already attempted call."""
    if not enabled(settings):
        return False
    with Session(engine) as db:
        mutation_lock(db)
        run = ensure_run(db, settings)
        claimed = None
        for row in _claim(db, settings):
            task, inbound, thread, conversation, report = row
            if any(
                task.payload.get(key) != str(value)
                for key, value in (
                    ("conversation_id", conversation.id),
                    ("thread_id", thread.id),
                    ("report_id", report.id),
                )
            ):
                continue
            if not _authorized(db, settings, inbound, thread, conversation):
                _cancel(inbound, task)
                db.commit()
                return True
            claimed = row
            break
        if claimed is None:
            return False
        task, inbound, thread, conversation, report = claimed
        prefix = f"{report.public_reference}: "
        if inbound.model_attempted and inbound.interpretation is None:
            _finish(
                db,
                inbound,
                task,
                thread,
                conversation,
                text=prefix
                + (
                    "Processing was interrupted. No change was made; "
                    "please send your request again."
                ),
                error="followup_interrupted",
            )
            db.commit()
            return True
        if inbound.interpretation is None:
            if client is None:
                return False
            if run.followup_calls >= 12:
                _finish(
                    db,
                    inbound,
                    task,
                    thread,
                    conversation,
                    text=prefix
                    + (
                        "The pilot message limit has been reached. No change was made; "
                        "please use the app or contact the organizer."
                    ),
                    error="followup_budget_exhausted",
                )
                db.commit()
                return True
            run.followup_calls += 1
            inbound.model_attempted = True
        task.status, inbound.status = "running", "running"
        task.attempts += 1
        task.lease_id, task.leased_until = uuid4(), now() + timedelta(minutes=5)
        task_id, inbound_id, lease_id = task.id, inbound.id, task.lease_id
        text, saved = inbound.body, inbound.interpretation
        context, capture = _context(db, inbound, report)
        db.commit()

    if saved is None:
        try:
            intent = client.interpret(text, context)
            saved = {
                "intent": validate_intent(
                    text, intent.model_dump(mode="json")
                ).model_dump(mode="json"),
                **capture,
            }
        except Exception:
            logger.warning("Pilot follow-up %s: interpretation_failed", task_id)
            with Session(engine) as db:
                mutation_lock(db)
                task, inbound = db.get(Task, task_id), db.get(
                    MessagingInbound, inbound_id
                )
                if not task or task.status != "running" or task.lease_id != lease_id:
                    return True
                thread = db.get(MessagingThread, inbound.thread_id)
                conversation = db.get(Conversation, inbound.conversation_id)
                if not _authorized(db, settings, inbound, thread, conversation):
                    _cancel(inbound, task)
                else:
                    _finish(
                        db,
                        inbound,
                        task,
                        thread,
                        conversation,
                        text=prefix
                        + (
                            "I could not understand or process that request. "
                            "No change was made; please send one clear request "
                            "or use the app."
                        ),
                        error="interpretation_failed",
                    )
                db.commit()
            return True
        with Session(engine) as db:
            mutation_lock(db)
            task, inbound = db.get(Task, task_id), db.get(MessagingInbound, inbound_id)
            if not task or task.status != "running" or task.lease_id != lease_id:
                return True
            inbound.interpretation = saved
            db.commit()

    try:
        with Session(engine) as db:
            mutation_lock(db)
            task, inbound = db.get(Task, task_id), db.get(MessagingInbound, inbound_id)
            if not task or task.status != "running" or task.lease_id != lease_id:
                return True
            thread = db.get(MessagingThread, inbound.thread_id)
            conversation = db.get(Conversation, inbound.conversation_id)
            report = db.get(Report, inbound.report_id)
            if not _authorized(db, settings, inbound, thread, conversation):
                _cancel(inbound, task)
            else:
                try:
                    with db.begin_nested():
                        reply = _apply(db, settings, inbound, report, saved)
                except (HTTPException, ValueError, KeyError):
                    reply = prefix + (
                        "That request cannot be applied to the current report. "
                        "No change was made; please check its status "
                        "or contact the organizer."
                    )
                _finish(db, inbound, task, thread, conversation, text=reply)
            db.commit()
    except SQLAlchemyError:
        # Saved interpretation and lease survive; recovery does not call Chalk again.
        logger.warning("Pilot follow-up %s: database_unavailable", task_id)
    return True
