from dataclasses import dataclass, field

import pytest

from api.messaging.backend_client import ClaimedOutgoingMessage, Conversation
from api.messaging.backend_coordinator import BackendCoordinator
from api.messaging.messages import InboundMessage


@dataclass
class FakeBackend:
    conversation: Conversation | None = None
    claims: list[ClaimedOutgoingMessage] = field(default_factory=list)
    resolved: list[tuple[str, str]] = field(default_factory=list)
    submitted: list[tuple[str, str, str]] = field(default_factory=list)
    acknowledged: list[tuple[str, str, str | None, str]] = field(default_factory=list)

    def resolve_conversation(
        self, channel: str, external_id: str
    ) -> Conversation | None:
        self.resolved.append((channel, external_id))
        return self.conversation

    def submit_followup(self, conversation_id: str, message_id: str, text: str) -> None:
        self.submitted.append((conversation_id, message_id, text))

    def claim_outgoing(self, limit: int) -> list[ClaimedOutgoingMessage]:
        return self.claims

    def acknowledge_delivery(
        self,
        message_id: str,
        lease_id: str,
        provider_message_id: str | None,
        sent_text: str,
    ) -> None:
        self.acknowledged.append((message_id, lease_id, provider_message_id, sent_text))


@dataclass
class FakeGateway:
    sent: list[dict[str, str]] = field(default_factory=list)
    fail_send: bool = False

    def send_to_space(self, **kwargs: str) -> None:
        self.sent.append(kwargs)
        if self.fail_send:
            raise TimeoutError("private reply https://secret.example token")


def inbound() -> InboundMessage:
    return InboundMessage("photon-1", "received-by", "space-1", "  exact text  ")


def outgoing(channel: str = "imessage", text: str = "Reply") -> ClaimedOutgoingMessage:
    return ClaimedOutgoingMessage("out-1", "lease-1", channel, "space-1", text)


def test_unlinked_inbound_is_not_submitted() -> None:
    backend = FakeBackend()
    coordinator = BackendCoordinator(backend, FakeGateway(), "agent-1")

    assert coordinator.submit_inbound(inbound()) is False
    assert backend.resolved == [("imessage", "space-1")]
    assert backend.submitted == []


def test_linked_inbound_submits_original_id_and_text() -> None:
    backend = FakeBackend(
        conversation=Conversation("conversation-1", "imessage", "space-1")
    )
    coordinator = BackendCoordinator(backend, FakeGateway(), "agent-1")

    assert coordinator.submit_inbound(inbound()) is True
    assert backend.submitted == [("conversation-1", "photon-1", "  exact text  ")]


def test_failed_send_is_not_acknowledged(caplog: pytest.LogCaptureFixture) -> None:
    backend = FakeBackend(claims=[outgoing()])
    gateway = FakeGateway(fail_send=True)
    coordinator = BackendCoordinator(backend, gateway, "agent-1")

    assert coordinator.dispatch_claimed() == []
    assert backend.acknowledged == []
    assert "private reply" not in caplog.text
    assert "secret.example" not in caplog.text


def test_successful_send_is_acknowledged_without_provider_id() -> None:
    backend = FakeBackend(claims=[outgoing()])
    gateway = FakeGateway()
    coordinator = BackendCoordinator(backend, gateway, "agent-1")

    assert coordinator.dispatch_claimed() == ["out-1"]
    assert gateway.sent == [
        {
            "space_id": "space-1",
            "sender_id": "agent-1",
            "text": "Reply",
            "idempotency_key": "out-1",
        }
    ]
    assert backend.acknowledged == [("out-1", "lease-1", None, "Reply")]


def test_non_imessage_and_blank_replies_are_skipped() -> None:
    backend = FakeBackend(claims=[outgoing("sms"), outgoing(text="  ")])
    gateway = FakeGateway()
    coordinator = BackendCoordinator(backend, gateway, "agent-1")

    assert coordinator.dispatch_claimed() == []
    assert gateway.sent == []
    assert backend.acknowledged == []
