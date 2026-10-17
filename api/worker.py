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

from api.config import Settings
from api.db import make_engine, mutation_lock
from api.integrations import load_provider
from api.models import Conversation, OutgoingMessage, Photo, Report, Task, now
from api.schemas import (
    ConversationView,
    Equipment,
    FollowupInput,
    FollowupResult,
    PlanProposal,
    TriageInput,
    TriageRecommendation,
)
from api.services import apply_clarification, apply_recheck, event, snapshot
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


def process_one(engine, provider, cloud) -> bool:
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
            .order_by(Task.created_at, Task.id)
            .with_for_update(skip_locked=True)
            .limit(1)
        )
        if task is None:
            return False
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
            if kind == "triage":
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
        if kind == "triage":
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
            if kind == "triage":
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
                        db, report.id, action.data, actor="agent-followup"
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
    if engine is None or provider is None:
        raise SystemExit(
            "Configure DATABASE_URL and PERSON3_BASE_URL or INTEGRATION_FACTORY; queued work is preserved"
        )
    cloud = SupabaseCloud(settings)
    try:
        while True:
            worked = process_one(engine, provider, cloud)
            if args.once:
                break
            if not worked:
                time.sleep(2)
    finally:
        cloud.close()
        provider.close()
        engine.dispose()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    main()
