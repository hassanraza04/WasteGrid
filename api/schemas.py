"""Version 0.2 proposed contracts; coordinate changes with Persons 1, 3 and 4."""

from datetime import datetime
from enum import StrEnum
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator


class Contract(BaseModel):
    model_config = ConfigDict(
        extra="forbid", from_attributes=True, hide_input_in_errors=True
    )


class ResidentAnswers(Contract):
    fire: bool | None = Field(default=None, strict=True)
    sharp_objects: bool | None = Field(default=None, strict=True)


class WasteAssessment(Contract):
    description: str = Field(min_length=1, max_length=200, pattern=r"\S")
    size: Literal["small", "medium", "large", "unknown"]
    obstruction: Literal[
        "none_visible", "walkway", "road", "drain", "entrance", "unknown"
    ]
    obstruction_level: Literal["none", "partial", "complete", "unknown"]
    forces_people_into_traffic: Literal["yes", "no", "unknown"]
    special_handling: Literal["suspected", "none_identified", "unknown"]
    reason: str = Field(min_length=1, max_length=400, pattern=r"\S")
    visible_fire: Literal["yes", "no", "unknown"] = "unknown"
    visible_sharp_objects: Literal["yes", "no", "unknown"] = "unknown"
    confidence: float | None = Field(default=None, ge=0, le=1, allow_inf_nan=False)
    resident_context_agreement: Literal[
        "consistent", "conflicting", "unclear", "not_provided"
    ] = "not_provided"
    comparison_reason: str | None = Field(default=None, min_length=1, max_length=300)


class Equipment(StrEnum):
    gloves = "gloves"
    trash_bags = "trash_bags"
    broom = "broom"
    shovel = "shovel"
    wheelbarrow = "wheelbarrow"
    pickup_truck = "pickup_truck"


class ReportState(StrEnum):
    received = "received"
    needs_info = "needs_info"
    needs_review = "needs_review"
    linked_to_job = "linked_to_job"


class JobState(StrEnum):
    unassigned = "unassigned"
    assigned = "assigned"
    in_progress = "in_progress"
    blocked = "blocked"
    completed = "completed"
    recheck_requested = "recheck_requested"


Channel = Literal["imessage", "telegram", "whatsapp", "sms"]


class Location(Contract):
    latitude: float = Field(ge=-90, le=90, allow_inf_nan=False)
    longitude: float = Field(ge=-180, le=180, allow_inf_nan=False)
    landmark: str | None = Field(default=None, max_length=300)


class PublicMapMarker(Contract):
    """Approximate location only; never expose a resident report identifier or details."""

    latitude: float = Field(ge=-90, le=90, allow_inf_nan=False)
    longitude: float = Field(ge=-180, le=180, allow_inf_nan=False)


class PublicMapMarkers(Contract):
    items: list[PublicMapMarker]
    truncated: bool


class Command(Contract):
    command_id: UUID
    expected_version: int = Field(ge=1)


class TriageRecommendation(Command):
    report_id: UUID
    category: str = Field(min_length=1, max_length=100)
    proposed_equipment: list[Equipment]
    duplicate_candidate_id: UUID | None = None  # another report, not a job
    duplicate_confirmed: bool = False
    hazard: bool = False
    evidence_sufficient: bool = False
    missing_information: list[str] = Field(max_length=10)
    decision_summary: str = Field(min_length=1, max_length=2000)
    evidence_report_ids: list[UUID] = Field(max_length=30)
    next_action: Literal["create_job", "link_job", "request_info", "review"]
    estimated_service_minutes: int | None = Field(default=None, gt=0, le=1440)


class EventView(Contract):
    id: UUID
    kind: str
    created_at: datetime


class AuditEvent(EventView):
    actor: str
    details: dict


class JobAuditEvent(AuditEvent):
    """Staff-only command correlation; public report timelines stay redacted."""

    command_id: UUID | None = None


class ClarificationRecord(Contract):
    note: str
    location: Location | None
    created_at: datetime


DashboardStatus = Literal["submitted", "in-progress", "resolved"]


class ReportUpdate(Contract):
    id: UUID
    kind: str
    created_at: datetime
    message: str
    status: DashboardStatus | None
    report_state: ReportState | None
    job_status: JobState | None


class ReportUpdates(Contract):
    items: list[ReportUpdate]
    limit: int
    offset: int
    total: int


class ConversationMessageView(Contract):
    id: UUID
    created_at: datetime
    direction: Literal["inbound", "outbound"]
    body: str


class ConversationMessages(Contract):
    items: list[ConversationMessageView]
    limit: int
    offset: int
    total: int


class ReportView(Contract):
    id: UUID
    public_reference: str = Field(pattern=r"^WG-[0-9A-F]{12}$")
    title: str
    address: str | None
    state: ReportState
    display_status: str
    dashboard_status: DashboardStatus
    location: Location | None
    note: str | None
    clarifications: list[ClarificationRecord]
    photo_id: UUID
    completion_photo_ids: list[UUID]
    job_id: UUID | None
    version: int
    illustrative: bool
    created_at: datetime
    updated_at: datetime
    latest_update: ReportUpdate | None
    timeline: list[EventView]

    assessment_status: Literal["pending", "assessed", "needs_review", "failed"] = (
        "pending"
    )
    priority: Literal["high", "medium", "routine"] | None = None
    needs_review: bool = False
    priority_reason: str | None = None
    assessment: WasteAssessment | None = None
    resident_answers: ResidentAnswers = Field(default_factory=ResidentAnswers)


class OrganizerReportView(ReportView):
    """Organizer and trusted reasoning context, never a resident response."""

    triage: TriageRecommendation | None


class ReportCreated(Contract):
    report: ReportView
    access_token: str = Field(repr=False)


class PhotoAccess(Contract):
    url: str
    expires_in: int


class JobView(Contract):
    id: UUID
    status: JobState
    location: Location
    category: str
    required_equipment: list[Equipment]
    estimated_service_minutes: int
    assigned_crew_id: UUID | None
    locked: bool
    held: bool
    route_position: int | None
    travel_minutes: float
    decision_summary: str
    unassigned_reason: str | None
    version: int
    illustrative: bool


class JobDetails(Contract):
    job: JobView
    photo_ids: list[UUID]
    events: list[JobAuditEvent]


class ReportDetails(Contract):
    report: OrganizerReportView
    events: list[AuditEvent]


class CrewView(Contract):
    id: UUID
    name: str
    equipment: list[Equipment]
    shift_minutes: int
    available: bool
    start_location: Location
    illustrative: bool
    version: int
    location_recorded_at: datetime | None = None
    location_received_at: datetime | None = None
    location_revision: int = 0


class CrewPatch(Command):
    available: bool | None = None
    equipment: list[Equipment] | None = None
    shift_minutes: int | None = Field(default=None, gt=0, le=1440)
    start_location: Location | None = None


class JobPatch(Command):
    status: JobState | None = None
    assigned_crew_id: UUID | None = None
    locked: bool | None = None
    held: bool | None = None
    reason: str | None = Field(default=None, min_length=1, max_length=2000)


class CompletionCommand(Command):
    photo_hash: str | None
    note: str | None


class Clarification(Command):
    note: str = Field(min_length=1, max_length=2000)
    location: Location | None = None


class Recheck(Command):
    reason: str = Field(min_length=1, max_length=2000)


class LinkCreated(Contract):
    link_code: str = Field(repr=False)
    expires_at: datetime
    recipient: str | None = None
    channel: Channel = "imessage"


class BindConversation(Contract):
    link_code: str = Field(min_length=20, max_length=200, repr=False)
    channel: Channel
    external_id: str = Field(min_length=1, max_length=200)
    opted_in: Literal[True]


class ConversationLookup(Contract):
    channel: Channel
    external_id: str = Field(min_length=1, max_length=200)


class ConversationView(Contract):
    id: UUID
    report_id: UUID
    channel: Channel
    external_id: str


class Snapshot(Contract):
    """Explicit allowlist for reasoning; never includes resident credentials."""

    report: OrganizerReportView
    job: JobView | None


class TriageInput(Contract):
    snapshot: Snapshot
    photo_url: str
    nearby_reports: list[Snapshot]
    equipment_catalog: list[Equipment]


class PlanStop(Contract):
    job_id: UUID
    crew_id: UUID
    position: int = Field(ge=0)
    travel_minutes: float = Field(ge=0, allow_inf_nan=False)
    service_minutes: float = Field(gt=0, allow_inf_nan=False)


class UnassignedJob(Contract):
    job_id: UUID
    reason_code: Literal[
        "no_eligible_crew",
        "outside_scope",
        "shift_limit",
        "held",
        "hazard_review",
        "blocked",
        "recheck_requested",
    ]


class PlanningInput(Contract):
    jobs: list[JobView]  # unfinished jobs, sorted by UUID
    crews: list[CrewView]  # sorted by UUID
    fixed_assignments: list[PlanStop]  # in-progress, blocked with a crew, or locked
    completed_minutes: dict[str, float]  # crew UUID -> consumed shift minutes
    node_ids: list[str]  # crew:<uuid> depots followed by job:<uuid> locations
    travel_minutes: list[list[float]]
    travel_estimates_label: str
    revision: str

    @model_validator(mode="after")
    def matrix_shape(self):
        n = len(self.node_ids)
        if len(self.travel_minutes) != n or any(
            len(row) != n for row in self.travel_minutes
        ):
            raise ValueError("Travel matrix must match node_ids")
        return self


class PlanProposal(Contract):
    revision: str
    assignments: list[PlanStop]
    unassigned: list[UnassignedJob]
    travel_estimates_label: str = Field(min_length=1)


class AssignmentExecution(Contract):
    mode: Literal["legacy", "organizer"]
    source_plan_id: UUID | None


class StoredPlan(PlanProposal):
    id: UUID
    stale: bool
    created_at: datetime
    execution_rules: dict[UUID, AssignmentExecution] = Field(default_factory=dict)


class CurrentPlan(Contract):
    plan: StoredPlan | None


class GeneratePlan(Contract):
    command_id: UUID


class NoAction(Contract):
    kind: Literal["none"] = "none"


class ClarifyAction(Contract):
    kind: Literal["clarification"]
    data: Clarification


class RecheckAction(Contract):
    kind: Literal["recheck"]
    data: Recheck


class FollowupResult(Contract):
    reply_text: str = Field(min_length=1, max_length=4000)
    action: Annotated[
        NoAction | ClarifyAction | RecheckAction, Field(discriminator="kind")
    ]


class FollowupInput(Contract):
    conversation: ConversationView
    incoming_message: str = Field(min_length=1, max_length=4000)
    snapshot: Snapshot


class IncomingFollowup(Contract):
    message_id: str = Field(min_length=1, max_length=200)
    text: str = Field(min_length=1, max_length=4000)


class TaskView(Contract):
    id: UUID
    kind: str
    status: Literal["pending", "running", "succeeded", "failed"]
    attempts: int
    last_error: str | None
    result: dict | None
    created_at: datetime


class OutgoingView(Contract):
    id: UUID
    event_id: UUID
    conversation: ConversationView
    payload: dict
    attempts: int
    lease_id: UUID | None
    leased_until: datetime | None


class ClaimMessages(Contract):
    limit: int = Field(default=20, ge=1, le=100)


class DeliveryLease(Contract):
    lease_id: UUID


class DeliveryAck(DeliveryLease):
    sent_text: str = Field(min_length=1, max_length=4000)
    provider_message_id: str | None = Field(default=None, min_length=1, max_length=200)


class DeliveryFailure(DeliveryLease):
    retry_after_seconds: int = Field(default=30, ge=1, le=3600)


class DeliveryStatus(Contract):
    id: UUID
    delivered_at: datetime | None


class Health(Contract):
    status: str


class ErrorResponse(Contract):
    detail: str
