from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

import pytest

from api.messaging.delivery_coordinator import DeliveryCoordinator
from api.messaging.delivery_ledger import DeliveryLedger
from api.messaging.messages import InboundMessage
from api.messaging.reply_policy import SmokeTestReplyPolicy

NOW = datetime(2026, 10, 16, 12, 0, tzinfo=UTC)
REPLY = "Photon Spectrum is connected. You said: Oak Street"


@dataclass
class FakeSender:
    sent: list[tuple[str, str]] = field(default_factory=list)
    fail_next: bool = False

    def send_reply(self, message: InboundMessage, text: str) -> None:
        self.sent.append((message.id, text))
        if self.fail_next:
            self.fail_next = False
            raise TimeoutError("private text and secret must not be logged")


def inbound() -> InboundMessage:
    return InboundMessage("pho_msg_1", "pho_agent", "pho_space", "Oak Street")


def test_duplicate_input_queues_once_and_first_dispatch_sends_once(tmp_path) -> None:
    ledger = DeliveryLedger(tmp_path / "delivery.db")
    sender = FakeSender()
    coordinator = DeliveryCoordinator(ledger, SmokeTestReplyPolicy(), sender)

    assert coordinator.queue_messages([inbound(), inbound()], NOW) == ["pho_msg_1"]
    assert coordinator.dispatch_due_replies(NOW) == ["pho_msg_1"]
    assert coordinator.dispatch_due_replies(NOW) == []
    assert sender.sent == [("pho_msg_1", REPLY)]


def test_timeout_retries_same_message_id_and_text_after_five_seconds(
    tmp_path, caplog: pytest.LogCaptureFixture
) -> None:
    ledger = DeliveryLedger(tmp_path / "delivery.db")
    sender = FakeSender(fail_next=True)
    coordinator = DeliveryCoordinator(ledger, SmokeTestReplyPolicy(), sender)
    coordinator.queue_messages([inbound()], NOW)

    assert coordinator.dispatch_due_replies(NOW) == []
    assert coordinator.dispatch_due_replies(NOW + timedelta(seconds=4)) == []
    assert coordinator.dispatch_due_replies(NOW + timedelta(seconds=5)) == ["pho_msg_1"]
    assert sender.sent == [("pho_msg_1", REPLY), ("pho_msg_1", REPLY)]
    assert "private text and secret" not in caplog.text
    assert "Oak Street" not in caplog.text
