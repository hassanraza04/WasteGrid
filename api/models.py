"""Private Postgres schema. Cloud schema changes live in supabase/migrations/."""

from datetime import datetime, timezone
from uuid import UUID, uuid4

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    MetaData,
    String,
    Text,
    Uuid,
    text,
)
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
