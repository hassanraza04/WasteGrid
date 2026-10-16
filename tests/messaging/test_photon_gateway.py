from dataclasses import dataclass
from datetime import UTC, datetime
from types import SimpleNamespace

from api.messaging.config import PhotonConfig
from api.messaging.messages import InboundMessage
from api.messaging.photon_gateway import PhotonGateway


@dataclass
class FakeProjects:
    messages: list[object]
    list_input: object | None = None
    send_input: object | None = None

    def list_messages(self, input: object) -> object:
        self.list_input = input
        return SimpleNamespace(items=self.messages)

    def send_message(self, input: object) -> object:
        self.send_input = input
        return SimpleNamespace()


@dataclass
class FakeClient:
    projects: FakeProjects


def gateway(client: FakeClient) -> PhotonGateway:
    return PhotonGateway(
        PhotonConfig(
            project_id="pho_prj_test",
            api_key="pho_sk_test",
            poll_interval_seconds=2.0,
        ),
        client=client,  # type: ignore[arg-type]
    )


def test_list_new_messages_uses_received_imessage_filters() -> None:
    projects = FakeProjects(messages=["message"])

    messages = gateway(FakeClient(projects)).list_new_messages(
        datetime(2026, 10, 16, 21, 0, tzinfo=UTC)
    )

    assert messages == ["message"]
    assert projects.list_input is not None
    assert projects.list_input.path.id == "pho_prj_test"
    assert projects.list_input.query.platform.root == "imessage"
    assert projects.list_input.query.direction.root == "received"
    assert projects.list_input.query.created_since == "2026-10-16T21:00:00Z"


def test_send_reply_targets_the_same_space_from_the_agent_identity() -> None:
    projects = FakeProjects(messages=[])
    inbound = InboundMessage(
        id="pho_msg_inbound",
        agent_sender_id="pho_usr_agent",
        space_id="pho_spc_test",
        text="hello",
    )

    gateway(FakeClient(projects)).send_reply(inbound, "Photon Spectrum is connected. You said: hello")

    assert projects.send_input is not None
    assert projects.send_input.path.id == "pho_prj_test"
    assert projects.send_input.headers.idempotency_key == "wastegrid-reply-pho_msg_inbound"
    assert projects.send_input.body.senderId == "pho_usr_agent"
    assert projects.send_input.body.spaceId == "pho_spc_test"
    assert "parentMessageId" not in projects.send_input.body.model_dump(exclude_unset=True)
    assert projects.send_input.body.content.type == "text"
    assert projects.send_input.body.content.format == "plain"
    assert projects.send_input.body.content.text == "Photon Spectrum is connected. You said: hello"
