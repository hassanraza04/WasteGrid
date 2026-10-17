from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from api.messaging import run_imessage_agent
from api.messaging.config import BackendConfig, PhotonConfig
from api.messaging.delivery_ledger import DeliveryLedger
from api.messaging.messages import InboundMessage
from api.messaging.run_imessage_agent import run_once


@dataclass(frozen=True)
class Content:
    type: str
    text: str


@dataclass(frozen=True)
class Entity:
    id: str


@dataclass(frozen=True)
class Message:
    id: str
    platform: str
    status: str
    content: Content
    receivedBy: Entity
    space: Entity


def inbound_message() -> Message:
    return Message(
        "photon-1",
        "imessage",
        "received",
        Content("text", "hello"),
        Entity("agent-1"),
        Entity("space-1"),
    )


@dataclass
class FakeCoordinator:
    events: list[str] = field(default_factory=list)
    submitted: list[InboundMessage] = field(default_factory=list)
    fail_submit: bool = False
    reject_submit: bool = False

    def dispatch_claimed(self) -> list[str]:
        self.events.append("dispatch")
        return []

    def submit_inbound(self, message: InboundMessage) -> bool:
        self.events.append("submit")
        self.submitted.append(message)
        if self.fail_submit:
            raise TimeoutError("private text https://secret.example")
        if self.reject_submit:
            return False
        return True


@dataclass
class FakeGateway:
    messages: list[object] = field(default_factory=list)
    events: list[str] = field(default_factory=list)
    requested_since: datetime | None = None
    fail_fetch: bool = False

    def list_new_messages(self, since: datetime) -> list[object]:
        self.events.append("fetch")
        self.requested_since = since
        if self.fail_fetch:
            raise TimeoutError("private text https://secret.example")
        return self.messages


def test_run_once_dispatches_before_fetch_and_after_submitting_then_advances_checkpoint(
    tmp_path: Path,
) -> None:
    checkpoint = datetime(2026, 10, 16, 20, tzinfo=UTC)
    started = checkpoint + timedelta(minutes=5)
    ledger = DeliveryLedger(tmp_path / "delivery.db")
    ledger.checkpoint_or_initialize(checkpoint)
    events: list[str] = []
    gateway = FakeGateway(messages=[inbound_message(), object()], events=events)
    coordinator = FakeCoordinator(events=events)

    assert run_once(gateway, coordinator, ledger, started) == ["photon-1"]

    assert events == ["dispatch", "fetch", "submit", "dispatch"]
    assert gateway.requested_since == checkpoint
    assert coordinator.submitted == [
        InboundMessage("photon-1", "agent-1", "space-1", "hello")
    ]
    assert ledger.checkpoint_or_initialize(started + timedelta(minutes=1)) == started


@pytest.mark.parametrize("failure", ["fetch", "submit"])
def test_run_once_keeps_checkpoint_when_processing_fails(
    tmp_path: Path, failure: str
) -> None:
    checkpoint = datetime(2026, 10, 16, 20, tzinfo=UTC)
    started = checkpoint + timedelta(minutes=5)
    ledger = DeliveryLedger(tmp_path / "delivery.db")
    ledger.checkpoint_or_initialize(checkpoint)
    gateway = FakeGateway(messages=[inbound_message()], fail_fetch=failure == "fetch")
    coordinator = FakeCoordinator(fail_submit=failure == "submit")

    with pytest.raises(TimeoutError):
        run_once(gateway, coordinator, ledger, started)

    assert coordinator.events == (
        ["dispatch"] if failure == "fetch" else ["dispatch", "submit"]
    )
    assert ledger.checkpoint_or_initialize(started + timedelta(minutes=1)) == checkpoint


def test_run_once_advances_checkpoint_after_permanent_rejection(
    tmp_path: Path,
) -> None:
    checkpoint = datetime(2026, 10, 16, 20, tzinfo=UTC)
    started = checkpoint + timedelta(minutes=5)
    ledger = DeliveryLedger(tmp_path / "delivery.db")
    ledger.checkpoint_or_initialize(checkpoint)
    rejected = inbound_message()
    accepted = Message(
        "photon-2",
        "imessage",
        "received",
        Content("text", "valid"),
        Entity("agent-1"),
        Entity("space-1"),
    )
    gateway = FakeGateway(messages=[rejected, accepted])

    @dataclass
    class RejectFirstCoordinator(FakeCoordinator):
        def submit_inbound(self, message: InboundMessage) -> bool:
            self.events.append("submit")
            self.submitted.append(message)
            return message.id != "photon-1"

    coordinator = RejectFirstCoordinator()

    assert run_once(gateway, coordinator, ledger, started) == ["photon-2"]
    assert [message.id for message in coordinator.submitted] == ["photon-1", "photon-2"]
    assert ledger.checkpoint_or_initialize(started + timedelta(minutes=1)) == started


def config(tmp_path: Path) -> PhotonConfig:
    return PhotonConfig(
        project_id="project-1",
        api_key="photon-key",
        backend=BackendConfig(
            "https://backend.example.test/api", "backend-key", "agent-1", 10.0
        ),
        poll_interval_seconds=2.0,
        delivery_db_path=tmp_path / "delivery.db",
    )


def test_run_forever_constructs_backend_coordinator(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    selected = config(tmp_path)
    gateway = FakeGateway()
    backend = object()
    constructed: list[tuple[object, object, str]] = []
    coordinator = FakeCoordinator()
    monkeypatch.setattr(
        run_imessage_agent, "load_photon_config", lambda environ: selected
    )
    monkeypatch.setattr(run_imessage_agent, "PhotonGateway", lambda value: gateway)
    monkeypatch.setattr(
        run_imessage_agent,
        "WasteGridBackendClient",
        lambda value: backend if value == selected.backend else None,
    )
    monkeypatch.setattr(
        run_imessage_agent,
        "BackendCoordinator",
        lambda b, g, a: constructed.append((b, g, a)) or coordinator,
    )
    monkeypatch.setattr(
        run_imessage_agent.time,
        "sleep",
        lambda _: (_ for _ in ()).throw(KeyboardInterrupt()),
    )

    run_imessage_agent.run_forever()

    assert constructed == [(backend, gateway, "agent-1")]
    assert gateway.requested_since is not None
    assert coordinator.events == ["dispatch", "dispatch"]


def test_run_forever_logs_no_fetch_error_details(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    selected = config(tmp_path)
    gateway = FakeGateway(fail_fetch=True)
    monkeypatch.setattr(
        run_imessage_agent, "load_photon_config", lambda environ: selected
    )
    monkeypatch.setattr(run_imessage_agent, "PhotonGateway", lambda value: gateway)
    monkeypatch.setattr(
        run_imessage_agent, "WasteGridBackendClient", lambda value: object()
    )
    monkeypatch.setattr(
        run_imessage_agent, "BackendCoordinator", lambda *args: FakeCoordinator()
    )
    monkeypatch.setattr(
        run_imessage_agent.time,
        "sleep",
        lambda _: (_ for _ in ()).throw(KeyboardInterrupt()),
    )

    run_imessage_agent.run_forever()

    assert "Photon polling iteration failed: TimeoutError" in caplog.text
    assert "private text" not in caplog.text
    assert "secret.example" not in caplog.text
