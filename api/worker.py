"""Durable processing worker. Run separately from Uvicorn; no work on import."""

import argparse
import logging
import time
from datetime import timedelta
from uuid import UUID, uuid4, uuid5

from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import and_, or_, select
from sqlalchemy.orm import Session

from api.assessment import calculate_priority
from api.config import Settings
from api.db import make_engine, mutation_lock
from api.integrations import ChalkAssessmentClient, load_provider
from api.models import Conversation, Event, OutgoingMessage, Photo, Report, Task, now
from api.schemas import (
    ConversationView,
    Equipment,
    FollowupInput,
    FollowupResult,
    PlanProposal,
    ResidentAnswers,
    TriageInput,
    TriageRecommendation,
    WasteAssessment,
)
from api.services import apply_clarification, apply_recheck, enqueue, event, snapshot
from api.storage import SupabaseCloud
from api.workflows import apply_plan, apply_triage, build_planning_input, distance_km

logger = logging.getLogger(__name__)


def nearby_snapshots(db, report, radius_km=1.0):
    if not report.location:
        return []
    candidates = db.scalars(
        select(Report)
        .where(Report.id != report.id)
        .order_by(Report.created_at.desc())
        .limit(200)
    )
    results = []
    for other in candidates:
        value = snapshot(db, other)
        if (
            other.location
            and distance_km(report.location, other.location) <= radius_km
            and (not value.job or value.job.status != "completed")
        ):
            results.append(value)
        if len(results) == 20:
            break
    return results


def fail_assessment(report):
    report.assessment_status = "failed"
    report.priority = None
    report.needs_review = True
    report.priority_reason = "Assessment failed; organizer review required."
    report.assessment = None
    if report.state == "received":
        report.state = "needs_review"
    report.version += 1


def process_one(
    engine, provider, cloud, assessment_client=None, *, duplicate_radius_meters=10
) -> bool:
    if provider is None and assessment_client is not None:
        from api.decisions import AssessmentDecisionProvider

        provider = AssessmentDecisionProvider(duplicate_radius_meters)
    supported_kinds = []
    if assessment_client is not None:
        supported_kinds.append("assessment")
    if provider is not None:
        supported_kinds.extend(("triage", "plan", "followup"))
    with Session(engine) as db:
        mutation_lock(db)
        task = db.scalar(
            select(Task)
            .where(
                or_(
                    and_(Task.status == "pending", Task.next_attempt_at <= now()),
                    and_(Task.status == "running", Task.leased_until < now()),
                )
            )
            .where(
                or_(
                    Task.kind.in_(supported_kinds),
                    # Recover interrupted one-call work even without credentials;
                    # this branch terminalizes it below without invoking a model.
                    and_(Task.kind == "assessment", Task.attempts > 0),
                )
            )
            .order_by(Task.created_at, Task.id)
            .with_for_update(skip_locked=True)
            .limit(1)
        )
        if task is None:
            return False
        # An expired assessment lease may already have called the model. Never replay it.
        if task.kind == "assessment" and task.attempts > 0:
            report = db.get(Report, UUID(task.payload["report_id"]))
            if report is not None and report.assessment_status == "pending":
                fail_assessment(report)
                event(db, "report.assessment_failed", report_id=report.id)
            task.status = "failed"
            task.last_error = "assessment_interrupted"
            task.leased_until = None
            db.commit()
            return True
        task.status = "running"
        task.attempts += 1
        task.lease_id = uuid4()
        task.leased_until = now() + timedelta(minutes=5)
        task_id, lease_id, kind, payload = (
            task.id,
            task.lease_id,
            task.kind,
            task.payload,
        )
        db.commit()
    try:
        # Read and release DB transaction before any remote provider invocation.
        with Session(engine) as db:
            if kind == "assessment":
                report = db.get(Report, UUID(payload["report_id"]))
                if report is None:
                    raise HTTPException(404, "Report removed")
                photo = db.get(Photo, report.photo_id)
                request = (
                    cloud.signed_url(photo.object_path),
                    report.note,
                    report.location,
                    report.resident_answers,
                )
            elif kind == "triage":
                report = db.get(Report, UUID(payload["report_id"]))
                if report is None:
                    raise HTTPException(404, "Report removed")
                if report.state == "linked_to_job":
                    request = None
                else:
                    photo = db.get(Photo, report.photo_id)
                    request = TriageInput(
                        snapshot=snapshot(db, report),
                        photo_url=cloud.signed_url(photo.object_path),
                        nearby_reports=nearby_snapshots(db, report),
                        equipment_catalog=list(Equipment),
                    )
            elif kind == "plan":
                request = build_planning_input(db)
            else:
                conversation = db.get(Conversation, UUID(payload["conversation_id"]))
                if conversation is None:
                    raise HTTPException(404, "Conversation removed")
                report = db.get(Report, conversation.report_id)
                request = FollowupInput(
                    conversation=ConversationView.model_validate(conversation),
                    incoming_message=payload["text"],
                    snapshot=snapshot(db, report),
                )
        if kind == "assessment":
            if assessment_client is None:
                raise RuntimeError("Assessment client not configured")
            output = WasteAssessment.model_validate(assessment_client.assess(*request))
        elif kind == "triage":
            output = (
                TriageRecommendation.model_validate(provider.triage_report(request))
                if request
                else None
            )
            if output and (
                output.report_id != request.snapshot.report.id
                or output.expected_version != request.snapshot.report.version
            ):
                raise HTTPException(422, "Provider changed triage target/version")
            if output:
                output.command_id = uuid5(task_id, "triage")
        elif kind == "plan":
            output = PlanProposal.model_validate(provider.generate_plan(request))
        else:
            output = FollowupResult.model_validate(provider.handle_followup(request))
        with Session(engine) as db:
            mutation_lock(db)
            task = db.get(Task, task_id)
            if task is None or task.status != "running" or task.lease_id != lease_id:
                return True
            if kind == "assessment":
                report = db.get(Report, UUID(payload["report_id"]))
                decision = calculate_priority(
                    output, ResidentAnswers.model_validate(report.resident_answers)
                )
                report.assessment = output.model_dump(mode="json")
                report.priority = decision.priority
                duplicate = db.scalar(
                    select(Event.id).where(
                        Event.report_id == report.id,
                        Event.kind == "report.possible_duplicate",
                    )
                )
                if report.organizer_review_required:
                    decision.needs_review = True
                    decision.priority_reason += " Organizer review must be resolved before automatic assignment."
                if duplicate:
                    decision.needs_review = True
                    decision.priority_reason += " Nearby report is a possible duplicate; organizer review required."
                report.needs_review = decision.needs_review
                report.priority_reason = decision.priority_reason
                report.assessment_status = (
                    "needs_review" if decision.needs_review else "assessed"
                )
                if decision.needs_review and report.state == "received":
                    report.state = "needs_review"
                report.version += 1
                event(db, "report.assessed", report_id=report.id)
                if not decision.needs_review and decision.priority is not None:
                    enqueue(
                        db,
                        "triage",
                        f"triage:{report.id}:{report.version}",
                        {"report_id": str(report.id)},
                    )
                result = {"report_id": str(report.id), **decision.model_dump()}
            elif kind == "triage":
                report = (
                    apply_triage(db, output)
                    if output
                    else db.get(Report, UUID(payload["report_id"]))
                )
                result = {"report_id": str(report.id), "state": report.state}
            elif kind == "plan":
                plan = apply_plan(db, output)
                result = {"plan_id": str(plan.id)}
            else:
                report = db.get(Report, request.snapshot.report.id)
                if snapshot(db, report) != request.snapshot:
                    raise HTTPException(
                        409, "Conversation state changed during reasoning"
                    )
                action = output.action
                if action.kind != "none":
                    action.data.command_id = uuid5(task_id, "followup-action")
                if action.kind == "clarification":
                    apply_clarification(
                        db,
                        report.id,
                        action.data,
                        actor="agent-followup",
                        duplicate_radius_meters=duplicate_radius_meters,
                    )
                elif action.kind == "recheck":
                    apply_recheck(db, report, action.data, actor="agent-followup")
                record = event(db, "conversation.reply", report_id=report.id)
                db.flush()
                # Reply is private to the originating conversation; remove the
                # generic notification for this event from all other links.
                rows = list(
                    db.scalars(
                        select(OutgoingMessage).where(
                            OutgoingMessage.event_id == record.id
                        )
                    )
                )
                for row in rows:
                    if row.conversation_id != request.conversation.id:
                        db.delete(row)
                    else:
                        row.payload = {**row.payload, "reply_text": output.reply_text}
                result = {"event_id": str(record.id), "action": action.kind}
            task.status = "succeeded"
            task.result = result
            task.last_error = None
            task.leased_until = None
            db.commit()
    except Exception as exc:
        code = (
            "state_changed"
            if isinstance(exc, HTTPException) and exc.status_code == 409
            else (
                "invalid_proposal"
                if isinstance(exc, ValidationError)
                or (isinstance(exc, HTTPException) and exc.status_code < 500)
                else "provider_unavailable"
            )
        )
        with Session(engine) as db:
            mutation_lock(db)
            task = db.get(Task, task_id)
            if (
                task is not None
                and task.status == "running"
                and task.lease_id == lease_id
            ):
                task.last_error = code
                if kind == "assessment":
                    report = db.get(Report, UUID(payload["report_id"]))
                    if report is not None:
                        fail_assessment(report)
                        event(db, "report.assessment_failed", report_id=report.id)
                    task.status = "failed"
                else:
                    task.status = "failed" if task.attempts >= 5 else "pending"
                task.next_attempt_at = now() + timedelta(
                    seconds=min(300, 2**task.attempts)
                )
                task.leased_until = None
                db.commit()
        # Never log model input/output, bearer tokens, signed URLs, or provider exception text.
        logger.warning("Task %s: %s", task_id, code)
    return True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    settings = Settings()
    engine, provider = make_engine(settings), load_provider(settings)
    assessment_client = (
        ChalkAssessmentClient(settings)
        if settings.chalk_router_api_key and settings.chalk_env_id
        else None
    )
    if engine is None or (provider is None and assessment_client is None):
        raise SystemExit(
            "Configure DATABASE_URL and CHALK_ROUTER_API_KEY/CHALK_ENV_ID or a decision provider; queued work is preserved"
        )
    if assessment_client is None:
        logger.warning(
            "Chalk assessment is not configured; unattempted assessment tasks remain pending"
        )
    cloud = SupabaseCloud(settings)
    try:
        while True:
            worked = process_one(
                engine,
                provider,
                cloud,
                assessment_client,
                duplicate_radius_meters=settings.duplicate_radius_meters,
            )
            if args.once:
                break
            if not worked:
                time.sleep(2)
    finally:
        cloud.close()
        if provider is not None:
            provider.close()
        if assessment_client is not None:
            assessment_client.close()
        engine.dispose()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    main()
