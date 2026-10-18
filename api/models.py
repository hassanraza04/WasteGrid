"""Private Postgres schema. Cloud schema changes live in supabase/migrations/."""

from datetime import datetime, timezone
from uuid import UUID, uuid4

from sqlalchemy import (
    JSON,
    Boolean,
    Computed,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    MetaData,
    String,
    Text,
    UniqueConstraint,
    Uuid,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


def now():
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    metadata = MetaData(schema="wastegrid")


class Crew(Base):
    __tablename__ = "crews"
    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    name: Mapped[str] = mapped_column(String(100))
    equipment: Mapped[list] = mapped_column(JSON)
    shift_minutes: Mapped[int] = mapped_column(Integer)
    available: Mapped[bool] = mapped_column(Boolean, default=True)
    start_location: Mapped[dict] = mapped_column(JSON)
    illustrative: Mapped[bool] = mapped_column(Boolean, default=False)
    version: Mapped[int] = mapped_column(Integer, default=1)

    location_recorded_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True)
    )
    location_received_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True)
    )
    location_revision: Mapped[int] = mapped_column(Integer, default=0)


class StaffRole(Base):
    __tablename__ = "staff_roles"
    user_id: Mapped[UUID] = mapped_column(Uuid, primary_key=True)
    role: Mapped[str] = mapped_column(String(20))
    crew_id: Mapped[UUID | None] = mapped_column(ForeignKey("wastegrid.crews.id"))


class Job(Base):
    __tablename__ = "jobs"
    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    status: Mapped[str] = mapped_column(String(30), default="unassigned")
    location: Mapped[dict] = mapped_column(JSON)
    category: Mapped[str] = mapped_column(String(100))
    required_equipment: Mapped[list] = mapped_column(JSON)
    estimated_service_minutes: Mapped[int] = mapped_column(Integer)
    assigned_crew_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("wastegrid.crews.id")
    )
    locked: Mapped[bool] = mapped_column(Boolean, default=False)
    unassigned_reason: Mapped[str | None] = mapped_column(Text)
    version: Mapped[int] = mapped_column(Integer, default=1)
    illustrative: Mapped[bool] = mapped_column(Boolean, default=False)
    held: Mapped[bool] = mapped_column(Boolean, default=False)
    route_position: Mapped[int | None] = mapped_column(Integer)
    travel_minutes: Mapped[float] = mapped_column(Float, default=0)
    decision_summary: Mapped[str] = mapped_column(Text, default="")
    collection_started_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True)
    )


class Report(Base):
    __tablename__ = "reports"
    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    public_reference: Mapped[str] = mapped_column(
        String(15), unique=True, server_default=text("wastegrid.new_report_reference()")
    )
    title: Mapped[str] = mapped_column(String(160), default="Cleanup report")
    address: Mapped[str | None] = mapped_column(String(500))
    token_hash: Mapped[str] = mapped_column(String(64))
    state: Mapped[str] = mapped_column(String(30), default="received")
    location: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    note: Mapped[str | None] = mapped_column(Text)
    photo_id: Mapped[UUID] = mapped_column(Uuid)
    job_id: Mapped[UUID | None] = mapped_column(ForeignKey("wastegrid.jobs.id"))
    version: Mapped[int] = mapped_column(Integer, default=1)
    illustrative: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    clarifications: Mapped[list] = mapped_column(JSON, default=list)
    triage: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    request_hash: Mapped[str | None] = mapped_column(String(64))
    assessment_status: Mapped[str] = mapped_column(
        String(20), default="pending", server_default="pending"
    )
    priority: Mapped[str | None] = mapped_column(String(10))
    needs_review: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default=text("false")
    )
    organizer_review_required: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default=text("false")
    )
    priority_reason: Mapped[str | None] = mapped_column(Text)
    assessment: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    resident_answers: Mapped[dict] = mapped_column(
        JSON, default=dict, server_default=text("'{}'")
    )


class Photo(Base):
    __tablename__ = "photos"
    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    object_path: Mapped[str] = mapped_column(String(300), unique=True)
    content_type: Mapped[str] = mapped_column(String(50))
    size_bytes: Mapped[int] = mapped_column(Integer)
    report_id: Mapped[UUID | None] = mapped_column(ForeignKey("wastegrid.reports.id"))
    job_id: Mapped[UUID | None] = mapped_column(ForeignKey("wastegrid.jobs.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class LinkCode(Base):
    __tablename__ = "link_codes"
    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    code_hash: Mapped[str] = mapped_column(String(64), unique=True)
    report_id: Mapped[UUID] = mapped_column(ForeignKey("wastegrid.reports.id"))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Conversation(Base):
    __tablename__ = "conversations"
    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    report_id: Mapped[UUID] = mapped_column(ForeignKey("wastegrid.reports.id"))
    channel: Mapped[str] = mapped_column(String(30))
    external_id: Mapped[str] = mapped_column(String(200))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    thread_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("wastegrid.messaging_threads.id")
    )
    active: Mapped[bool] = mapped_column(Boolean, default=True)


class ConversationMessage(Base):
    __tablename__ = "conversation_messages"
    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    conversation_id: Mapped[UUID] = mapped_column(
        ForeignKey("wastegrid.conversations.id")
    )
    direction: Mapped[str] = mapped_column(String(10))
    body: Mapped[str] = mapped_column(Text)
    provider_message_id: Mapped[str | None] = mapped_column(String(200))
    outgoing_message_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("wastegrid.outgoing_messages.id"), unique=True
    )
    pilot_outgoing_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("wastegrid.messaging_outgoing.id"), unique=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class Event(Base):
    __tablename__ = "events"
    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    report_id: Mapped[UUID | None] = mapped_column(ForeignKey("wastegrid.reports.id"))
    job_id: Mapped[UUID | None] = mapped_column(ForeignKey("wastegrid.jobs.id"))
    crew_id: Mapped[UUID | None] = mapped_column(ForeignKey("wastegrid.crews.id"))
    kind: Mapped[str] = mapped_column(String(50))
    command_id: Mapped[UUID | None] = mapped_column(Uuid, unique=True)
    request_hash: Mapped[str | None] = mapped_column(String(64))
    details: Mapped[dict] = mapped_column(JSON, default=dict)
    actor: Mapped[str] = mapped_column(String(100), default="system")
    report_state: Mapped[str | None] = mapped_column(String(30))
    job_status: Mapped[str | None] = mapped_column(String(30))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class OutgoingMessage(Base):
    __tablename__ = "outgoing_messages"
    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    event_id: Mapped[UUID] = mapped_column(ForeignKey("wastegrid.events.id"))
    conversation_id: Mapped[UUID] = mapped_column(
        ForeignKey("wastegrid.conversations.id")
    )
    payload: Mapped[dict] = mapped_column(JSON)
    delivered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    lease_id: Mapped[UUID | None] = mapped_column(Uuid)
    leased_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    next_attempt_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=now
    )
    last_error: Mapped[str | None] = mapped_column(Text)


class Plan(Base):
    __tablename__ = "plans"
    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    payload: Mapped[dict] = mapped_column(JSON)
    stale: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    routing_mode: Mapped[str] = mapped_column(String(20), default="legacy")


class RoutingPreview(Base):
    __tablename__ = "routing_previews"
    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    payload: Mapped[dict] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    dispatched_plan_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("wastegrid.plans.id")
    )
    dispatch_command_id: Mapped[UUID | None] = mapped_column(Uuid, unique=True)
    dispatched_by: Mapped[UUID | None] = mapped_column(Uuid)


class Assignment(Base):
    __tablename__ = "assignments"
    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    plan_id: Mapped[UUID] = mapped_column(ForeignKey("wastegrid.plans.id"))
    job_id: Mapped[UUID] = mapped_column(ForeignKey("wastegrid.jobs.id"))
    crew_id: Mapped[UUID] = mapped_column(ForeignKey("wastegrid.crews.id"))
    position: Mapped[int] = mapped_column(Integer)


class Task(Base):
    __tablename__ = "tasks"
    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    kind: Mapped[str] = mapped_column(String(30))
    dedupe_key: Mapped[str] = mapped_column(String(200), unique=True)
    payload: Mapped[dict] = mapped_column(JSON, default=dict)
    status: Mapped[str] = mapped_column(String(20), default="pending")
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    lease_id: Mapped[UUID | None] = mapped_column(Uuid)
    leased_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    next_attempt_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=now
    )
    last_error: Mapped[str | None] = mapped_column(Text)
    result: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class MessagingPilot(Base):
    __tablename__ = "messaging_pilots"
    __table_args__ = (UniqueConstraint("scope_key", name="messaging_pilots_scope_key"),)
    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True)
    project_id: Mapped[str] = mapped_column(String(200))
    sender_id: Mapped[str] = mapped_column(String(200))
    report_ids: Mapped[list] = mapped_column(JSON, default=list)
    chat_ids: Mapped[list] = mapped_column(JSON, default=list)
    scope_key: Mapped[list] = mapped_column(
        JSONB,
        Computed(
            "wastegrid.messaging_pilot_scope(project_id, sender_id, report_ids, chat_ids)",
            persisted=True,
        ),
    )
    image_calls: Mapped[int] = mapped_column(Integer, default=0)
    followup_calls: Mapped[int] = mapped_column(Integer, default=0)
    send_attempts: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class MessagingThread(Base):
    __tablename__ = "messaging_threads"
    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    pilot_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("wastegrid.messaging_pilots.id")
    )
    channel: Mapped[str] = mapped_column(String(30), default="imessage")
    external_id: Mapped[str] = mapped_column(String(200))
    project_id: Mapped[str] = mapped_column(String(200), default="")
    sender_id: Mapped[str] = mapped_column(String(200), default="")
    peer_id: Mapped[str] = mapped_column(String(200), default="")
    paused: Mapped[bool] = mapped_column(Boolean, default=False)
    consent_revision: Mapped[int] = mapped_column(Integer, default=1)
    selected_link_id: Mapped[UUID | None] = mapped_column(Uuid)
    selection_expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True)
    )
    pending_text: Mapped[str | None] = mapped_column(Text)
    pending_inbound_id: Mapped[UUID | None] = mapped_column(Uuid)
    pending_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_input_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_control_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class MessagingInbound(Base):
    __tablename__ = "messaging_inbound"
    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    thread_id: Mapped[UUID] = mapped_column(
        ForeignKey("wastegrid.messaging_threads.id")
    )
    project_id: Mapped[str] = mapped_column(String(200))
    provider_message_id: Mapped[str] = mapped_column(String(200))
    payload_hash: Mapped[str] = mapped_column(String(64))
    body: Mapped[str] = mapped_column(Text)
    provider_created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    conversation_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("wastegrid.conversations.id")
    )
    report_id: Mapped[UUID | None] = mapped_column(ForeignKey("wastegrid.reports.id"))
    consent_revision: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(30), default="received")
    model_attempted: Mapped[bool] = mapped_column(Boolean, default=False)
    interpretation: Mapped[dict | None] = mapped_column(JSON)
    last_error: Mapped[str | None] = mapped_column(String(100))


class MessagingOutgoing(Base):
    __tablename__ = "messaging_outgoing"
    id: Mapped[UUID] = mapped_column(Uuid, primary_key=True, default=uuid4)
    thread_id: Mapped[UUID] = mapped_column(
        ForeignKey("wastegrid.messaging_threads.id")
    )
    conversation_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("wastegrid.conversations.id")
    )
    event_id: Mapped[UUID | None] = mapped_column(ForeignKey("wastegrid.events.id"))
    kind: Mapped[str] = mapped_column(String(50))
    text: Mapped[str] = mapped_column(Text)
    external_id: Mapped[str] = mapped_column(String(200))
    sender_id: Mapped[str] = mapped_column(String(200))
    consent_revision: Mapped[int] = mapped_column(Integer)
    allow_paused: Mapped[bool] = mapped_column(Boolean, default=False)
    status: Mapped[str] = mapped_column(String(30), default="pending")
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    lease_id: Mapped[UUID | None] = mapped_column(Uuid)
    leased_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    next_attempt_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=now
    )
    provider_message_id: Mapped[str | None] = mapped_column(String(200))
    provider_status: Mapped[str | None] = mapped_column(String(30))
    accepted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    delivered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_error: Mapped[str | None] = mapped_column(String(100))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
