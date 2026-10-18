"""Additive, lean organiser read contracts; original report evidence stays private."""

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import Field

from api.schemas import Contract, JobView, ReportDetails

Priority = Literal["high", "medium", "routine"]


class ProcessingTask(Contract):
    status: Literal["pending", "running", "succeeded", "failed"]
    attempts: int
    error_code: str | None


class ReportProcessing(Contract):
    assessment: ProcessingTask | None
    triage: ProcessingTask | None
    demo_run_id: UUID | None


class OrganizerReportDetailsView(ReportDetails):
    processing: ReportProcessing


class ProcessingQueue(Contract):
    pending: int = 0
    running: int = 0
    succeeded: int = 0
    failed: int = 0


class DemoProcessingStatus(Contract):
    run_id: UUID | None = None
    status: Literal["inactive", "active", "draining", "closed"] = "inactive"
    reason: str | None = None
    starts_at: datetime | None = None
    expires_at: datetime | None = None
    model: str | None = None
    used_attempts: int = 0
    max_attempts: int = 4
    new_reports_admitted: int = 0
    max_new_reports: int = 2
    worker_online: bool = False
    last_heartbeat_at: datetime | None = None
    last_success_at: datetime | None = None
    queue: ProcessingQueue = Field(default_factory=ProcessingQueue)


class OrganizerCounts(Contract):
    needs_review: int
    high_priority_jobs: int
    in_progress_jobs: int
    available_crews: int
    blocked_jobs: int
    completed_24h: int
    awaiting_assessment: int


class OrganizerConfiguration(Contract):
    revision: str
    organizer_routing_enabled: bool
    road_service_configured: bool
    messaging_pilot_enabled: bool


class OrganizerOverview(Contract):
    counts: OrganizerCounts
    include_illustrative: bool
    configuration: OrganizerConfiguration
    processing: DemoProcessingStatus


class OrganizerSummaryReport(Contract):
    id: UUID
    public_reference: str
    category: str | None
    title: str
    address: str | None
    photo_id: UUID
    created_at: datetime
    updated_at: datetime
    display_status: str
    state: str
    assessment_status: str
    priority: Priority | None
    needs_review: bool
    illustrative: bool
    job_id: UUID | None
    job_status: str | None
    crew_id: UUID | None
    crew_name: str | None
    route_position: int | None


class OrganizerReportIndex(Contract):
    items: list[OrganizerSummaryReport]
    total: int
    limit: int
    offset: int


class OrganizerIndexedJob(JobView):
    priority: Priority | None
    eligible: bool
    eligibility_reasons: list[str]
    public_references: list[str]
    address: str | None
    photo_id: UUID | None


class OrganizerJobIndex(Contract):
    items: list[OrganizerIndexedJob]
    total: int
    limit: int
    offset: int
