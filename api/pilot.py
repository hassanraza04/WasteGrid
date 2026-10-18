"""Durable, report-authorized messaging for a deliberately bounded pilot."""

import json
import re
from datetime import timedelta
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from api.auth import authorization_header, digest, messaging_access, require_resident
from api.db import get_db
from api.models import (
    Conversation,
    ConversationMessage,
    Job,
    LinkCode,
    MessagingInbound,
    MessagingOutgoing,
    MessagingPilot,
    MessagingThread,
    Report,
    Task,
    now,
)
from api.pilot_schemas import (
    PilotAccepted,
    PilotClaim,
    PilotFailure,
    PilotInboundEnvelope,
    PilotInboundResult,
    PilotLease,
    PilotOutgoingView,
    PilotProviderStatus,
    ResidentMessagingLink,
    ResidentMessagingLinks,
)

router = APIRouter()
internal = APIRouter(
    prefix="/internal/messaging", dependencies=[Depends(messaging_access)]
)
REFERENCE = re.compile(r"\bWG-[0-9a-f]{12}\b", re.I)


def enabled(settings):
    return bool(
        settings.messaging_pilot_enabled
        and settings.messaging_pilot_id
        and len(settings.messaging_pilot_report_ids) == 2
        and len(set(settings.messaging_pilot_report_ids)) == 2
        and settings.messaging_pilot_chat_ids
        and settings.photon_project_id
        and settings.photon_agent_sender_id
        and settings.messaging_imessage_recipient
        and settings.organizer_routing_enabled
    )


def configured_scope(settings):
    """Match the database key: allowlist order and duplicates do not define scope."""
    return [
        settings.photon_project_id,
        settings.photon_agent_sender_id,
        sorted({str(value) for value in settings.messaging_pilot_report_ids}),
        sorted(set(settings.messaging_pilot_chat_ids)),
    ]


def scope_matches(run, settings):
    return bool(run and run.scope_key == configured_scope(settings))


def matching_run(db, settings):
    """Read the scope's durable budget even if configuration names a different UUID."""
    return db.scalar(
        select(MessagingPilot).where(
            MessagingPilot.scope_key == configured_scope(settings)
        )
    )


def ensure_run(db, settings):
    """Freeze one lifetime budget per scope under the database mutation lock."""
    if not enabled(settings):
        raise HTTPException(503, "The supervised messaging pilot is not configured")
    run = db.get(MessagingPilot, settings.messaging_pilot_id)
    if run is not None:
        if not scope_matches(run, settings):
            raise HTTPException(
                409, "The persisted pilot scope differs from configuration"
            )
        return run
    if matching_run(db, settings) is not None:
        raise HTTPException(409, "The persisted pilot scope uses a different pilot ID")
    _, _, reports, chats = configured_scope(settings)
    run = MessagingPilot(
        id=settings.messaging_pilot_id,
        project_id=settings.photon_project_id,
        sender_id=settings.photon_agent_sender_id,
        report_ids=reports,
        chat_ids=chats,
    )
    try:
        with db.begin_nested():
            db.add(run)
            db.flush()
    except IntegrityError as error:
        # The unique scope constraint also protects callers without the MVP lock.
        if getattr(getattr(error.orig, "diag", None), "constraint_name", None) in (
            "messaging_pilots_scope_key",
            "messaging_pilots_pkey",
        ):
            raise HTTPException(409, "The pilot scope was already persisted") from error
        raise
    return run


def allowed_report(settings, report):
    return bool(
        enabled(settings)
        and report
        and not report.illustrative
        and report.id in settings.messaging_pilot_report_ids
    )


def allowed_thread(settings, thread):
    return bool(
        enabled(settings)
        and thread
        and thread.pilot_id == settings.messaging_pilot_id
        and thread.project_id == settings.photon_project_id
        and thread.sender_id == settings.photon_agent_sender_id
        and thread.external_id in settings.messaging_pilot_chat_ids
    )


def allowed_link(db, settings, conversation):
    return bool(
        conversation
        and conversation.active
        and allowed_report(settings, db.get(Report, conversation.report_id))
        and allowed_thread(settings, db.get(MessagingThread, conversation.thread_id))
    )


def queue_text(
    db,
    thread,
    text,
    *,
    kind="reply",
    conversation=None,
    event_id=None,
    allow_paused=False,
    message_id=None,
):
    """Freeze text and destination in the same transaction as its business outcome."""
    if thread.paused and not allow_paused:
        return None
    if kind in ("status", "completion", "recheck") and conversation:
        for old in db.scalars(
            select(MessagingOutgoing).where(
                MessagingOutgoing.conversation_id == conversation.id,
                MessagingOutgoing.kind == "status",
                MessagingOutgoing.status.in_(["pending", "leased"]),
            )
        ):
            old.status = "superseded"
            old.lease_id = old.leased_until = None
    outgoing = MessagingOutgoing(
        id=message_id or uuid4(),
        thread_id=thread.id,
        conversation_id=conversation.id if conversation else None,
        event_id=event_id,
        kind=kind,
        text=text[:4000],
        external_id=thread.external_id,
        sender_id=thread.sender_id,
        consent_revision=thread.consent_revision,
        allow_paused=allow_paused,
    )
    db.add(outgoing)
    db.flush()
    return outgoing


def active_links(db, settings, thread):
    return [
        link
        for link in db.scalars(
            select(Conversation)
            .where(
                Conversation.thread_id == thread.id,
                Conversation.active.is_(True),
            )
            .order_by(Conversation.created_at, Conversation.id)
        )
        if allowed_link(db, settings, link)
    ]


def current_text(db, report):
    job = db.get(Job, report.job_id) if report.job_id else None
    state = job.status if job else report.state
    text = {
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
    }.get(state, "Your report is being reviewed.")
    if report.needs_review or report.organizer_review_required:
        text = "Your report needs organizer review."
    return f"{report.public_reference}: {text}"


def cancel_unsent(db, thread, conversation=None):
    query = select(MessagingOutgoing).where(
        MessagingOutgoing.thread_id == thread.id,
        MessagingOutgoing.status.in_(["pending", "leased"]),
    )
    if conversation:
        query = query.where(MessagingOutgoing.conversation_id == conversation.id)
    for message in db.scalars(query):
        message.status = "cancelled"
        message.lease_id = message.leased_until = None
    inputs = select(MessagingInbound).where(
        MessagingInbound.thread_id == thread.id,
        MessagingInbound.status.in_(["received", "queued", "running"]),
    )
    if conversation:
        inputs = inputs.where(MessagingInbound.conversation_id == conversation.id)
    for inbound in db.scalars(inputs):
        inbound.status = "cancelled"
    # Running model results independently recheck this consent revision.
    thread.pending_text = thread.pending_inbound_id = thread.pending_expires_at = None


def _ask(db, settings, thread, links):
    references = [db.get(Report, link.report_id).public_reference for link in links]
    text = (
        "Which report do you mean? Reply with " + ", ".join(references) + "."
        if references
        else "Open a report in WasteGrid and choose Get iMessage updates to link it."
    )
    if not references and (
        settings.messaging_pilot_peer_id == thread.peer_id
        and settings.messaging_pilot_phone_label
        and allowed_thread(settings, thread)
    ):
        text = (
            "Your phone is connected. Open a report in WasteGrid and type Status "
            "under Report updates to receive its current status here. "
            "Send STOP to pause phone updates."
        )
    queue_text(db, thread, text)


def _bind(db, settings, thread, code):
    link_code = db.scalar(select(LinkCode).where(LinkCode.code_hash == digest(code)))
    if link_code is None or link_code.expires_at < now():
        return None
    report = db.get(Report, link_code.report_id)
    if not allowed_report(settings, report):
        return None
    link = db.scalar(
        select(Conversation).where(
            Conversation.thread_id == thread.id,
            Conversation.report_id == report.id,
        )
    )
    if link_code.consumed_at is not None:
        # A consumed code cannot reactivate an unlinked report or authorize another chat.
        return link if link and link.active else None
    link_code.consumed_at = now()
    if link is None:
        link = Conversation(
            report_id=report.id,
            channel="imessage",
            external_id=thread.external_id,
            thread_id=thread.id,
        )
        db.add(link)
    else:
        link.active = True
    db.flush()
    thread.selected_link_id = link.id
    thread.selection_expires_at = now() + timedelta(minutes=10)
    return link


@internal.post("/inbound", response_model=PilotInboundResult)
def receive(
    body: PilotInboundEnvelope, request: Request, db: Session = Depends(get_db)
):
    settings = request.app.state.settings
    run = ensure_run(db, settings)
    if body.created_at > now() + timedelta(minutes=1):
        raise HTTPException(422, "Provider timestamp is in the future")
    if (
        body.project_id != run.project_id
        or body.agent_sender_id != run.sender_id
        or body.external_id not in run.chat_ids
        or body.space_kind != "direct"
        or body.peer_id == run.sender_id
    ):
        raise HTTPException(403, "The message is outside the authorized pilot chat")
    fingerprint = digest(json.dumps(body.model_dump(mode="json"), sort_keys=True))
    prior = db.scalar(
        select(MessagingInbound).where(
            MessagingInbound.project_id == body.project_id,
            MessagingInbound.provider_message_id == body.message_id,
        )
    )
    if prior:
        if prior.payload_hash != fingerprint:
            raise HTTPException(409, "Provider message ID has conflicting payloads")
        return PilotInboundResult(id=prior.id, status=prior.status)
    thread = db.scalar(
        select(MessagingThread).where(
            MessagingThread.channel == "imessage",
            MessagingThread.external_id == body.external_id,
        )
    )
    if thread is None:
        thread = MessagingThread(
            pilot_id=run.id,
            channel="imessage",
            external_id=body.external_id,
            project_id=run.project_id,
            sender_id=run.sender_id,
            peer_id=body.peer_id,
        )
        db.add(thread)
        db.flush()
    elif thread.pilot_id is None and not thread.project_id and not thread.sender_id:
        thread.pilot_id, thread.project_id = run.id, run.project_id
        thread.sender_id, thread.peer_id = run.sender_id, body.peer_id
    if not allowed_thread(settings, thread) or thread.peer_id != body.peer_id:
        raise HTTPException(
            403, "The chat identity does not match its authorized thread"
        )
    words = body.text.strip().split()
    control = words[0].upper() if words else ""
    is_link = control == "LINK"
    inbound = MessagingInbound(
        thread_id=thread.id,
        project_id=body.project_id,
        provider_message_id=body.message_id,
        payload_hash=fingerprint,
        body="LINK [redacted]" if is_link else body.text,
        provider_created_at=body.created_at,
        consent_revision=thread.consent_revision,
    )
    db.add(inbound)
    db.flush()
    if thread.last_control_at and body.created_at < thread.last_control_at:
        inbound.status = "stale"
    elif control == "STOP" and len(words) == 1:
        thread.paused = True
        thread.consent_revision += 1
        thread.last_control_at = body.created_at
        cancel_unsent(db, thread)
        queue_text(
            db,
            thread,
            "Updates paused. Send START to resume active report links.",
            kind="control",
            allow_paused=True,
        )
        inbound.status = "processed"
    elif control == "START" and len(words) == 1:
        thread.paused = False
        thread.consent_revision += 1
        thread.last_control_at = body.created_at
        cancel_unsent(db, thread)
        queue_text(
            db,
            thread,
            "Updates resumed for active links. Paused updates will not be replayed.",
            kind="control",
        )
        inbound.status = "processed"
    elif control == "HELP" and len(words) == 1:
        queue_text(
            db,
            thread,
            "Link an app report with LINK <code>. Ask for status, add information, "
            "or request a recheck after completion. Use a report reference when several are "
            "linked. STOP pauses updates; START resumes them.",
            kind="control",
            allow_paused=True,
        )
        inbound.status = "processed"
    elif is_link:
        link = _bind(db, settings, thread, words[1]) if len(words) == 2 else None
        if link:
            queue_text(
                db,
                thread,
                "Report linked. "
                + current_text(db, db.get(Report, link.report_id))
                + (
                    " Updates remain paused; send START to resume."
                    if thread.paused
                    else ""
                ),
                kind="link",
                conversation=link,
                allow_paused=True,
            )
        else:
            queue_text(
                db,
                thread,
                "That link code is invalid, expired, already used elsewhere, "
                "or outside this pilot. Request a new code in the app.",
                kind="control",
                allow_paused=True,
            )
        inbound.status = "processed"
    elif thread.paused:
        inbound.status = "cancelled"
    elif thread.last_input_at and body.created_at < thread.last_input_at:
        queue_text(
            db,
            thread,
            "An earlier message arrived late. Please send your request again.",
        )
        inbound.status = "stale"
    else:
        links = active_links(db, settings, thread)
        references = {r.upper() for r in REFERENCE.findall(body.text)}
        by_reference = {
            db.get(Report, link.report_id).public_reference.upper(): link
            for link in links
        }
        link = None
        if references:
            if len(references) == 1:
                link = by_reference.get(next(iter(references)))
        elif len(links) == 1:
            link = links[0]
        elif thread.selection_expires_at and thread.selection_expires_at >= now():
            link = next((x for x in links if x.id == thread.selected_link_id), None)
        if link is None:
            # Unknown references do not disclose or select reports outside active authorization.
            if not references:
                thread.pending_text = body.text
                thread.pending_inbound_id = inbound.id
                thread.pending_expires_at = now() + timedelta(minutes=10)
            _ask(db, settings, thread, links)
            inbound.status = "awaiting_selection"
        else:
            if references:
                thread.selected_link_id = link.id
                thread.selection_expires_at = now() + timedelta(minutes=10)
            only_reference = bool(references) and not REFERENCE.sub(
                "", body.text
            ).strip(" .,!?:;")
            if (
                only_reference
                and thread.pending_text
                and thread.pending_expires_at >= now()
            ):
                inbound.body = thread.pending_text
                old = db.get(MessagingInbound, thread.pending_inbound_id)
                if old:
                    old.status = "resolved"
                thread.pending_text = thread.pending_inbound_id = (
                    thread.pending_expires_at
                ) = None
            elif only_reference:
                inbound.status = "processed"
                queue_text(
                    db,
                    thread,
                    "Selected " + current_text(db, db.get(Report, link.report_id)),
                    conversation=link,
                )
            if not only_reference and thread.pending_inbound_id:
                previous_question = db.get(MessagingInbound, thread.pending_inbound_id)
                if (
                    previous_question
                    and previous_question.status == "awaiting_selection"
                ):
                    previous_question.status = "cancelled"
                thread.pending_text = thread.pending_inbound_id = (
                    thread.pending_expires_at
                ) = None
            if inbound.status != "processed":
                inbound.report_id, inbound.conversation_id = link.report_id, link.id
                inbound.status = "queued"
                db.add(
                    ConversationMessage(
                        conversation_id=link.id,
                        direction="inbound",
                        body=inbound.body,
                        provider_message_id=body.message_id,
                    )
                )
                db.add(
                    Task(
                        kind="pilot_followup",
                        dedupe_key=f"pilot-followup:{inbound.id}",
                        payload={
                            "inbound_id": str(inbound.id),
                            "conversation_id": str(link.id),
                            "thread_id": str(thread.id),
                            "report_id": str(link.report_id),
                        },
                    )
                )
        thread.last_input_at = body.created_at
    db.commit()
    return PilotInboundResult(id=inbound.id, status=inbound.status)


def _outgoing_view(message):
    return PilotOutgoingView.model_validate(message)


def _eligible(db, settings, message, *, consent=True):
    thread = db.get(MessagingThread, message.thread_id)
    if not allowed_thread(settings, thread):
        return False
    if message.kind == "phone_status" and (
        not settings.messaging_pilot_peer_id
        or thread.peer_id != settings.messaging_pilot_peer_id
        or not settings.messaging_pilot_phone_label
    ):
        return False
    if message.conversation_id:
        link = db.get(Conversation, message.conversation_id)
        if consent and message.kind != "phone_status":
            if not allowed_link(db, settings, link):
                return False
        elif (
            link is None
            or link.thread_id != thread.id
            or not allowed_report(settings, db.get(Report, link.report_id))
        ):
            return False
    return not consent or (
        message.consent_revision == thread.consent_revision
        and (not thread.paused or message.allow_paused)
    )


@internal.post("/outgoing/claim", response_model=list[PilotOutgoingView])
def claim(body: PilotClaim, request: Request, db: Session = Depends(get_db)):
    settings = request.app.state.settings
    run = ensure_run(db, settings)
    rows = db.scalars(
        select(MessagingOutgoing)
        .join(MessagingThread)
        .where(
            MessagingThread.pilot_id == run.id,
            MessagingThread.external_id.in_(settings.messaging_pilot_chat_ids),
        )
        .order_by(MessagingOutgoing.created_at, MessagingOutgoing.id)
    ).all()
    for message in rows:
        if not _eligible(db, settings, message, consent=False):
            continue
        if message.status == "sending" and message.leased_until <= now():
            message.status, message.last_error = "unknown", "submission_outcome_unknown"
        elif message.status == "leased" and message.leased_until <= now():
            message.status = "pending"
            message.lease_id = message.leased_until = None
        if (
            message.status in ("submitted", "unknown")
            and message.provider_message_id
            and message.provider_status != "accepted"
        ):
            if message.next_attempt_at <= now():
                message.next_attempt_at = now() + timedelta(seconds=30)
                db.commit()
                return [_outgoing_view(message)]
        if message.status != "pending" or message.next_attempt_at > now():
            continue
        if not _eligible(db, settings, message):
            message.status = "cancelled"
            continue
        if run.send_attempts >= 30 or message.attempts >= 3:
            continue
        message.status, message.lease_id = "leased", uuid4()
        message.leased_until = now() + timedelta(minutes=2)
        db.commit()
        return [_outgoing_view(message)]
    db.commit()
    return []


def _leased(db, settings, message_id, lease_id):
    message = db.get(MessagingOutgoing, message_id)
    if message is None or not _eligible(db, settings, message, consent=False):
        raise HTTPException(404, "Message not found")
    if message.lease_id != lease_id:
        raise HTTPException(409, "Message lease no longer matches")
    return message


@internal.post("/outgoing/{message_id}/sending", response_model=PilotOutgoingView)
def sending(
    message_id: UUID, body: PilotLease, request: Request, db: Session = Depends(get_db)
):
    settings = request.app.state.settings
    run = ensure_run(db, settings)
    message = _leased(db, settings, message_id, body.lease_id)
    if message.status == "sending":
        raise HTTPException(
            409, "Submission was already authorized; reconcile its outcome"
        )
    if (
        message.status != "leased"
        or message.leased_until <= now()
        or not _eligible(db, settings, message)
        or run.send_attempts >= 30
        or message.attempts >= 3
    ):
        raise HTTPException(409, "The message is no longer authorized for submission")
    message.status = "sending"
    message.attempts += 1
    run.send_attempts += 1
    message.leased_until = now() + timedelta(minutes=2)
    db.commit()
    return _outgoing_view(message)


def _provider_state(message, status):
    if message.status == "delivered":
        return
    ranks = {None: 0, "dispatched": 1, "accepted": 2, "delivered": 3, "failed": 3}
    if ranks[status] < ranks[message.provider_status]:
        return
    message.provider_status = status
    message.status = {"delivered": "delivered", "failed": "failed"}.get(
        status, "submitted"
    )
    if status == "delivered":
        message.delivered_at = now()
    message.next_attempt_at = now() + timedelta(seconds=30)


@internal.post("/outgoing/{message_id}/accepted", response_model=PilotOutgoingView)
def accepted(
    message_id: UUID,
    body: PilotAccepted,
    request: Request,
    db: Session = Depends(get_db),
):
    settings = request.app.state.settings
    ensure_run(db, settings)
    message = _leased(db, settings, message_id, body.lease_id)
    if message.text != body.sent_text or (
        message.provider_message_id
        and message.provider_message_id != body.provider_message_id
    ):
        raise HTTPException(409, "The receipt conflicts with the frozen submission")
    if message.status not in ("sending", "unknown", "submitted", "delivered", "failed"):
        raise HTTPException(409, "No submission was authorized for this message")
    if message.status == "failed" and message.provider_message_id is None:
        raise HTTPException(409, "A rejected submission cannot acquire a receipt")
    message.provider_message_id = body.provider_message_id
    message.accepted_at = message.accepted_at or now()
    _provider_state(message, body.provider_status)
    if (
        message.conversation_id
        and body.provider_status != "failed"
        and not db.scalar(
            select(ConversationMessage.id).where(
                ConversationMessage.pilot_outgoing_id == message.id,
            )
        )
    ):
        db.add(
            ConversationMessage(
                conversation_id=message.conversation_id,
                direction="outbound",
                body=message.text,
                provider_message_id=body.provider_message_id,
                pilot_outgoing_id=message.id,
            )
        )
    db.commit()
    return _outgoing_view(message)


@internal.post("/outgoing/{message_id}/failed", response_model=PilotOutgoingView)
def failed(
    message_id: UUID,
    body: PilotFailure,
    request: Request,
    db: Session = Depends(get_db),
):
    settings = request.app.state.settings
    ensure_run(db, settings)
    message = _leased(db, settings, message_id, body.lease_id)
    if message.status not in ("sending", "unknown"):
        raise HTTPException(409, "Message is not awaiting a submission outcome")
    if message.status == "unknown" and body.kind != "unknown":
        raise HTTPException(
            409, "An uncertain submission requires provider reconciliation"
        )
    if body.kind == "unknown":
        message.status, message.last_error = "unknown", "submission_outcome_unknown"
    elif body.retryable and message.attempts < 3:
        message.status, message.last_error = "pending", "provider_rejected"
        message.next_attempt_at = now() + timedelta(seconds=5 * message.attempts)
        message.lease_id = message.leased_until = None
    else:
        message.status, message.last_error = "failed", "provider_rejected"
    db.commit()
    return _outgoing_view(message)


@internal.post("/outgoing/{message_id}/status", response_model=PilotOutgoingView)
def provider_status(
    message_id: UUID,
    body: PilotProviderStatus,
    request: Request,
    db: Session = Depends(get_db),
):
    settings = request.app.state.settings
    ensure_run(db, settings)
    message = db.get(MessagingOutgoing, message_id)
    if message is None or not _eligible(db, settings, message, consent=False):
        raise HTTPException(404, "Message not found")
    if message.provider_message_id != body.provider_message_id:
        raise HTTPException(409, "Provider message ID does not match")
    _provider_state(message, body.provider_status)
    db.commit()
    return _outgoing_view(message)


@router.get(
    "/reports/{report_id}/messaging-links", response_model=ResidentMessagingLinks
)
def link_status(
    report_id: UUID,
    request: Request,
    db: Session = Depends(get_db),
    authorization: str | None = Depends(authorization_header),
):
    report = db.get(Report, report_id)
    if report is None:
        raise HTTPException(404, "Report not found")
    require_resident(report, authorization)
    settings = request.app.state.settings
    available = allowed_report(settings, report)
    links = []
    for link in db.scalars(
        select(Conversation).where(
            Conversation.report_id == report.id,
            Conversation.channel == "imessage",
        )
    ):
        thread = db.get(MessagingThread, link.thread_id) if link.thread_id else None
        if thread:
            links.append(
                ResidentMessagingLink(
                    id=link.id,
                    channel=link.channel,
                    active=link.active,
                    paused=thread.paused,
                )
            )
    return ResidentMessagingLinks(
        enabled=available,
        recipient=settings.messaging_imessage_recipient if available else None,
        links=links,
    )


@router.post("/reports/{report_id}/messaging-links/{link_id}/unlink", status_code=204)
def unlink(
    report_id: UUID,
    link_id: UUID,
    db: Session = Depends(get_db),
    authorization: str | None = Depends(authorization_header),
):
    report = db.get(Report, report_id)
    if report is None:
        raise HTTPException(404, "Report not found")
    require_resident(report, authorization)
    link = db.get(Conversation, link_id)
    if link is None or link.report_id != report_id:
        raise HTTPException(404, "Link not found")
    link.active = False
    if link.thread_id:
        thread = db.get(MessagingThread, link.thread_id)
        cancel_unsent(db, thread, link)
        if thread.selected_link_id == link.id:
            thread.selected_link_id = thread.selection_expires_at = None
    db.commit()


def emit_event(db, record, reports):
    """Create only notifications supported by committed persisted event snapshots."""
    from api.services import report_update

    if record.kind not in {
        "report.assessed",
        "report.triaged",
        "report.assessment_failed",
        "report.priority_set",
        "job.planned",
        "job.changed",
        "job.completed",
        "job.recheck_requested",
    }:
        return
    if record.kind in (
        "report.assessed",
        "report.triaged",
    ) and record.report_state not in ("needs_info", "needs_review"):
        return
    for link in db.scalars(
        select(Conversation).where(
            Conversation.report_id.in_(reports),
            Conversation.active.is_(True),
            Conversation.thread_id.is_not(None),
        )
    ):
        report = db.get(Report, link.report_id)
        thread = db.get(MessagingThread, link.thread_id)
        run = db.get(MessagingPilot, thread.pilot_id) if thread.pilot_id else None
        if (
            run is None
            or thread.paused
            or report.illustrative
            or str(report.id) not in run.report_ids
            or thread.external_id not in run.chat_ids
            or thread.project_id != run.project_id
            or thread.sender_id != run.sender_id
        ):
            continue
        recheck_outcome = (
            record.kind == "job.changed"
            and record.details.get("previous_status") == "recheck_requested"
        )
        kind = (
            "completion"
            if record.kind == "job.completed"
            else (
                "recheck"
                if record.kind == "job.recheck_requested" or recheck_outcome
                else "status"
            )
        )
        text = (
            "The crew reported cleanup complete."
            if kind == "completion"
            else report_update(record).message
        )
        if recheck_outcome:
            text = (
                "An organizer reviewed the recheck; cleanup is awaiting reassignment."
            )
        queue_text(
            db,
            thread,
            f"{report.public_reference}: {text}",
            kind=kind,
            conversation=link,
            event_id=record.id,
        )


router.include_router(internal)
