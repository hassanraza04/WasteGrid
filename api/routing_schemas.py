"""Organiser routing contracts; resident and legacy planning APIs stay compatible."""

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import AwareDatetime, Field, model_validator

from api.schemas import Command, Contract, Location, RoutingConstraints


class ComputeRoutes(Contract):
    crew_ids: list[UUID] = Field(min_length=1, max_length=5)
    job_ids: list[UUID] | None = Field(default=None, min_length=1, max_length=25)
    constraints: RoutingConstraints = Field(default_factory=RoutingConstraints)

    @model_validator(mode="after")
    def unique_crews(self):
        if len(set(self.crew_ids)) != len(self.crew_ids):
            raise ValueError("Select each crew once")
        if self.job_ids is not None and len(set(self.job_ids)) != len(self.job_ids):
            raise ValueError("Select each job once")
        return self


class CrewLocationUpdate(Contract):
    location: Location
    recorded_at: AwareDatetime


class CrewLocationView(Contract):
    crew_id: UUID
    location: Location
    recorded_at: datetime
    received_at: datetime
    revision: int


class DispatchRoutes(Contract):
    command_id: UUID
    accept_partial: bool = False


class PriorityDecision(Command):
    priority: Literal["high", "medium", "routine"]
    reason: str = Field(min_length=1, max_length=1000, pattern=r"\S")


class RoutingStop(Contract):
    job_id: UUID
    position: int
    priority: Literal["high", "medium", "routine"]
    travel_minutes: float
    service_minutes: float
    completion_minutes: float
    fixed: bool
    service_estimate_source: str


class CrewRoute(Contract):
    crew_id: UUID
    stops: list[RoutingStop]
    duration_minutes: float
    travel_minutes: float
    return_travel_minutes: float = 0
    returns_to_start: bool = False


class RoutingIssue(Contract):
    job_id: UUID
    reason: str


class RoutingMetrics(Contract):
    weighted_wait: float
    latest_finish: float
    total_travel: float
    score: float


class Reassignment(Contract):
    job_id: UUID
    previous_crew_id: UUID | None
    proposed_crew_id: UUID
    previous_position: int | None
    proposed_position: int


class RoutePreviewView(Contract):
    id: UUID
    job_ids: list[UUID] | None = Field(default=None, min_length=1, max_length=25)
    computed_at: datetime
    expires_at: datetime
    matrix_id: str | None
    travel_label: str
    routes: list[CrewRoute]
    unassigned: list[RoutingIssue]
    exclusions: list[RoutingIssue]
    metrics: RoutingMetrics
    termination_reason: str
    dispatchable: bool
    reassignments: list[Reassignment]
    settings: dict
    plan_id: UUID | None = None


class RouteDispatchView(Contract):
    preview_id: UUID
    plan_id: UUID
