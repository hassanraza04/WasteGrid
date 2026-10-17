"""Versioned messaging envelopes. User text and transport identifiers stay private."""

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import Field, field_validator

from api.schemas import Contract


class PilotInboundEnvelope(Contract):
    project_id: str = Field(min_length=1, max_length=200)
    agent_sender_id: str = Field(min_length=1, max_length=200)
    external_id: str = Field(min_length=1, max_length=200)
    message_id: str = Field(min_length=1, max_length=200)
    peer_id: str = Field(min_length=1, max_length=200)
    space_kind: Literal["direct", "group"]
    text: str = Field(min_length=1, max_length=4000, repr=False)
    created_at: datetime

    @field_validator("created_at")
    @classmethod
    def aware_timestamp(cls, value):
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("A timezone-aware timestamp is required")
        return value


class PilotInboundResult(Contract):
    id: UUID
    status: str


class PilotClaim(Contract):
    pass


class PilotOutgoingView(Contract):
    id: UUID
    lease_id: UUID | None
    thread_id: UUID
    channel: Literal["imessage"] = "imessage"
    external_id: str
    sender_id: str
    text: str
    provider_message_id: str | None
    status: str
    consent_revision: int


class PilotLease(Contract):
    lease_id: UUID


class PilotAccepted(PilotLease):
    provider_message_id: str = Field(min_length=1, max_length=200)
    provider_status: Literal["dispatched", "accepted", "delivered", "failed"]
    sent_text: str = Field(min_length=1, max_length=4000)


class PilotFailure(PilotLease):
    kind: Literal["rejected", "unknown"]
    retryable: bool = False


class PilotProviderStatus(Contract):
    provider_message_id: str = Field(min_length=1, max_length=200)
    provider_status: Literal["dispatched", "accepted", "delivered", "failed"]


class ResidentMessagingLink(Contract):
    id: UUID
    channel: str
    active: bool
    paused: bool


class ResidentMessagingLinks(Contract):
    enabled: bool
    recipient: str | None
    links: list[ResidentMessagingLink]
