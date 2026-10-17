from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from api.messaging.messages import InboundMessage
from api.messaging import run_imessage_agent
from api.messaging.config import PhotonConfig
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
class FakeGateway:
    messages: list[object]
    requested_since: datetime | None = None

    def list_new_messages(self, since: datetime) -> list[object]:
        self.requested_since = since
        return self.messages


@dataclass
class FakeAgent:
    processed: list[InboundMessage] | None = None

    def process(self, messages: list[InboundMessage]) -> list[str]:
        self.processed = messages
        return [message.id for message in messages]


def inbound_message() -> Message:
    return Message(
        id="pho_msg_test",
        platform="imessage",
        status="received",
        content=Content(type="text", text="hello"),
        receivedBy=User(id="pho_usr_agent"),
        space=Space(id="pho_spc_test"),
    )


def test_run_once_processes_only_replyable_messages_after_startup() -> None:
    gateway = FakeGateway(messages=[inbound_message(), object()])
    agent = FakeAgent()
    started_at = datetime(2026, 10, 16, 21, 0, tzinfo=UTC)

    processed = run_once(gateway, agent, started_at)  # type: ignore[arg-type]

    assert processed == ["pho_msg_test"]
    assert gateway.requested_since == started_at
    assert agent.processed == [
        InboundMessage(
            id="pho_msg_test",
            agent_sender_id="pho_usr_agent",
            space_id="pho_spc_test",
            text="hello",
        )
    ]


def test_run_forever_stops_cleanly_when_interrupted(monkeypatch: object) -> None:
    gateway = FakeGateway(messages=[])
    agent = FakeAgent()
    config = PhotonConfig(
        project_id="pho_prj_test",
        api_key="pho_sk_test",
        poll_interval_seconds=2.0,
        delivery_db_path=Path(".data/test-delivery.db"),
    )
    monkeypatch.setattr(run_imessage_agent, "load_photon_config", lambda environ: config)
    monkeypatch.setattr(run_imessage_agent, "PhotonGateway", lambda _: gateway)
    monkeypatch.setattr(run_imessage_agent, "EchoAgent", lambda _: agent)
    monkeypatch.setattr(
        run_imessage_agent.time,
        "sleep",
        lambda _: (_ for _ in ()).throw(KeyboardInterrupt()),
    )

    run_imessage_agent.run_forever()

    assert gateway.requested_since is not None
    assert agent.processed == []
