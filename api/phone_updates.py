"""Resident-authorized status snapshots to one operator-verified phone chat."""

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from api.auth import authorization_header, require_resident
from api.db import get_db
from api.models import (
    Conversation,
    MessagingOutgoing,
    MessagingPilot,
    MessagingThread,
    Report,
    now,
)
from api.pilot import (
    allowed_report,
    allowed_thread,
    current_text,
    ensure_run,
    matching_run,
    queue_text,
    scope_matches,
)
from api.pilot_schemas import PhoneUpdateCommand, PhoneUpdateReceipt, PhoneUpdates

router = APIRouter()


def _report(db, report_id, authorization):
    report = db.get(Report, report_id)
    if report is None:
        raise HTTPException(404, "Report not found")
    require_resident(report, authorization)
    return report


def _configured(settings, report):
    return bool(
        allowed_report(settings, report)
        and len(settings.messaging_pilot_chat_ids) == 1
        and settings.messaging_pilot_peer_id.strip()
        and settings.messaging_pilot_phone_label
    )


def _thread(db, settings):
    if len(settings.messaging_pilot_chat_ids) != 1:
        return None
    return db.scalar(
        select(MessagingThread).where(
            MessagingThread.channel == "imessage",
            MessagingThread.external_id == settings.messaging_pilot_chat_ids[0],
        )
    )


def _trusted_thread(settings, thread):
    return bool(
        allowed_thread(settings, thread)
        and thread.peer_id == settings.messaging_pilot_peer_id
    )


def _receipt(message):
    status = {
        "pending": "queued",
        "leased": "queued",
        "sending": "sending",
        "submitted": "submitted",
        "delivered": "delivered",
        "failed": "failed",
        "unknown": "uncertain",
        "cancelled": "cancelled",
        "superseded": "cancelled",
    }.get(message.status, "uncertain")
    if message.status == "sending" and (
        message.leased_until is None or message.leased_until <= now()
    ):
        status = "uncertain"
    return PhoneUpdateReceipt(
        id=message.id,
        status=status,
        message=message.text,
        created_at=message.created_at,
    )


def _latest(db, report_id):
    return db.scalar(
        select(MessagingOutgoing)
        .join(Conversation, MessagingOutgoing.conversation_id == Conversation.id)
        .where(
            Conversation.report_id == report_id,
            MessagingOutgoing.kind == "phone_status",
        )
        .order_by(MessagingOutgoing.created_at.desc(), MessagingOutgoing.id.desc())
        .limit(1)
    )


@router.get("/reports/{report_id}/phone-updates", response_model=PhoneUpdates)
def phone_updates(
    report_id: UUID,
    request: Request,
    db: Session = Depends(get_db),
    authorization: str | None = Depends(authorization_header),
):
    report = _report(db, report_id, authorization)
    settings = request.app.state.settings
    available = _configured(settings, report)
    if available:
        run = db.get(MessagingPilot, settings.messaging_pilot_id)
        scope_run = matching_run(db, settings)
        thread = _thread(db, settings)
        available = bool(
            (scope_run is None or scope_run.id == settings.messaging_pilot_id)
            and (
                run is None
                or (
                    run.id == settings.messaging_pilot_id
                    and scope_matches(run, settings)
                    and run.send_attempts < 30
                )
            )
            and (
                thread is None
                or (_trusted_thread(settings, thread) and not thread.paused)
            )
        )
    latest = _latest(db, report.id)
    return PhoneUpdates(
        enabled=available,
        phone_label=settings.messaging_pilot_phone_label if available else None,
        latest_request=_receipt(latest) if latest else None,
    )


@router.post("/reports/{report_id}/phone-updates", response_model=PhoneUpdateReceipt)
def request_phone_update(
    report_id: UUID,
    body: PhoneUpdateCommand,
    request: Request,
    db: Session = Depends(get_db),
    authorization: str | None = Depends(authorization_header),
):
    report = _report(db, report_id, authorization)
    # Replay the original snapshot even after pause/disable or later report changes.
    # A UUID collision cannot switch reports or convert another kind of message.
    prior = db.get(MessagingOutgoing, body.command_id)
    if prior:
        link = (
            db.get(Conversation, prior.conversation_id)
            if prior.conversation_id
            else None
        )
        if prior.kind != "phone_status" or link is None or link.report_id != report.id:
            raise HTTPException(409, "This command ID is already used")
        return _receipt(prior)
    settings = request.app.state.settings
    if not _configured(settings, report):
        raise HTTPException(503, "Phone updates are not available for this report")
    run = ensure_run(db, settings)
    thread = _thread(db, settings)
    if thread is not None and not _trusted_thread(settings, thread):
        raise HTTPException(409, "The registered phone identity does not match")
    if thread is not None and thread.paused:
        raise HTTPException(409, "Updates are paused on the registered phone")
    if run.send_attempts >= 30:
        raise HTTPException(429, "The phone update send budget is exhausted")
    latest = _latest(db, report.id)
    if latest and latest.status in ("pending", "leased", "sending", "unknown"):
        raise HTTPException(409, "A phone update is still pending; refresh its receipt")
    if thread is None:
        thread = MessagingThread(
            pilot_id=run.id,
            channel="imessage",
            external_id=settings.messaging_pilot_chat_ids[0],
            project_id=run.project_id,
            sender_id=run.sender_id,
            peer_id=settings.messaging_pilot_peer_id,
        )
        db.add(thread)
        db.flush()
    link = db.scalar(
        select(Conversation).where(
            Conversation.thread_id == thread.id,
            Conversation.report_id == report.id,
        )
    )
    if link is None:
        link = Conversation(
            report_id=report.id,
            channel="imessage",
            external_id=thread.external_id,
            thread_id=thread.id,
            # This request authorizes one snapshot, not an event subscription.
            active=False,
        )
        db.add(link)
    db.flush()
    outgoing = queue_text(
        db,
        thread,
        current_text(db, report),
        kind="phone_status",
        conversation=link,
        message_id=body.command_id,
    )
    db.commit()
    return _receipt(outgoing)
