from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from api.messaging import run_imessage_agent
from api.messaging.config import BackendConfig, PhotonConfig
from api.messaging.delivery_coordinator import DeliveryCoordinator
from api.messaging.delivery_ledger import DeliveryLedger
from api.messaging.messages import InboundMessage
from api.messaging.reply_policy import SmokeTestReplyPolicy
from api.messaging.run_imessage_agent import run_once


@dataclass(frozen=True)
class Content:
    type: str
    text: str


@dataclass(frozen=True)
class User:
    id: str


@dataclass(frozen=True)
class Space:
    id: str


@dataclass(frozen=True)
class Message:
    id: str
    platform: str
    status: str
    content: Content
    receivedBy: User
    space: Space


@dataclass
class FakeSender:
    sent: list[tuple[str, str]] = field(default_factory=list)

    def send_reply(self, message: InboundMessage, text: str) -> None:
        self.sent.append((message.id, text))


@dataclass
class FakeGateway(FakeSender):
    messages: list[object] = field(default_factory=list)
    requested_since: datetime | None = None
    before_fetch: list[tuple[str, str]] | None = None
    fail_fetch: bool = False

    def list_new_messages(self, since: datetime) -> list[object]:
        self.requested_since = since
        if self.before_fetch is not None:
            assert self.sent == self.before_fetch
        if self.fail_fetch:
            raise TimeoutError("Photon fetch failed with private text and secret")
        return self.messages


def inbound_message(message_id: str = "pho_msg_test") -> Message:
    return Message(
        id=message_id,
        platform="imessage",
        status="received",
        content=Content(type="text", text="hello"),
        receivedBy=User(id="pho_usr_agent"),
        space=Space(id="pho_spc_test"),
    )


def test_run_once_resumes_checkpoint_and_sends_due_replies_before_fetch(
    tmp_path: Path,
) -> None:
    path = tmp_path / "delivery.db"
    checkpoint = datetime(2026, 10, 16, 20, 0, tzinfo=UTC)
    poll_started_at = checkpoint + timedelta(minutes=5)
    ledger = DeliveryLedger(path)
    ledger.checkpoint_or_initialize(checkpoint)
    ledger.enqueue_reply(
        InboundMessage("pho_retry", "pho_usr_agent", "pho_spc_test", "earlier"),
        "saved reply",
        checkpoint,
    )
    gateway = FakeGateway(
        messages=[inbound_message(), object()],
        before_fetch=[("pho_retry", "saved reply")],
    )
    coordinator = DeliveryCoordinator(ledger, SmokeTestReplyPolicy(), gateway)

    run_once(gateway, coordinator, poll_started_at)

    assert gateway.requested_since == checkpoint
    assert gateway.sent == [
        ("pho_retry", "saved reply"),
        ("pho_msg_test", "Photon Spectrum is connected. You said: hello"),
    ]
    assert (
        DeliveryLedger(path).checkpoint_or_initialize(
            poll_started_at + timedelta(minutes=1)
        )
        == poll_started_at
    )


def test_run_once_keeps_checkpoint_when_fetch_fails_after_due_retry(
    tmp_path: Path,
) -> None:
    path = tmp_path / "delivery.db"
    checkpoint = datetime(2026, 10, 16, 20, 0, tzinfo=UTC)
    poll_started_at = checkpoint + timedelta(minutes=5)
    ledger = DeliveryLedger(path)
    ledger.checkpoint_or_initialize(checkpoint)
    ledger.enqueue_reply(
        InboundMessage("pho_retry", "pho_usr_agent", "pho_spc_test", "earlier"),
        "saved reply",
        checkpoint,
    )
    gateway = FakeGateway(fail_fetch=True)
    coordinator = DeliveryCoordinator(ledger, SmokeTestReplyPolicy(), gateway)

    with pytest.raises(TimeoutError, match="Photon fetch failed"):
        run_once(gateway, coordinator, poll_started_at)

    assert gateway.requested_since == checkpoint
    assert gateway.sent == [("pho_retry", "saved reply")]
    assert (
        DeliveryLedger(path).checkpoint_or_initialize(
            poll_started_at + timedelta(minutes=1)
        )
        == checkpoint
    )


def test_run_forever_stops_cleanly_when_interrupted(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    gateway = FakeGateway()
    config = PhotonConfig(
        project_id="pho_prj_test",
        api_key="pho_sk_test",
        backend=BackendConfig(
            base_url="https://backend.example.test/api",
            messaging_api_key="backend-key",
            agent_sender_id="pho_usr_agent",
            timeout_seconds=10.0,
        ),
        poll_interval_seconds=2.0,
        delivery_db_path=tmp_path / "delivery.db",
    )
    monkeypatch.setattr(
        run_imessage_agent, "load_photon_config", lambda environ: config
    )
    monkeypatch.setattr(run_imessage_agent, "PhotonGateway", lambda _: gateway)
    monkeypatch.setattr(
        "api.messaging.run_imessage_agent.time.sleep",
        lambda _: (_ for _ in ()).throw(KeyboardInterrupt()),
    )

    run_imessage_agent.run_forever()

    assert gateway.requested_since is not None
    assert (
        DeliveryLedger(config.delivery_db_path).checkpoint_or_initialize(
            gateway.requested_since + timedelta(minutes=1)
        )
        == gateway.requested_since
    )


def test_run_forever_logs_no_fetch_error_details(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    gateway = FakeGateway(fail_fetch=True)
    config = PhotonConfig(
        project_id="pho_prj_test",
        api_key="pho_sk_test",
        backend=BackendConfig(
            base_url="https://backend.example.test/api",
            messaging_api_key="backend-key",
            agent_sender_id="pho_usr_agent",
            timeout_seconds=10.0,
        ),
        poll_interval_seconds=2.0,
        delivery_db_path=tmp_path / "delivery.db",
    )
    monkeypatch.setattr(
        run_imessage_agent, "load_photon_config", lambda environ: config
    )
    monkeypatch.setattr(run_imessage_agent, "PhotonGateway", lambda _: gateway)
    monkeypatch.setattr(
        "api.messaging.run_imessage_agent.time.sleep",
        lambda _: (_ for _ in ()).throw(KeyboardInterrupt()),
    )

    run_imessage_agent.run_forever()

    assert "Photon polling iteration failed: TimeoutError" in caplog.text
    assert "private text and secret" not in caplog.text
