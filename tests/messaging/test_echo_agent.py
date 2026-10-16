from dataclasses import dataclass, field

from api.messaging.echo_agent import EchoAgent
from api.messaging.messages import InboundMessage


@dataclass
class FakeGateway:
    sent: list[tuple[str, str]] = field(default_factory=list)

    def send_reply(self, message: InboundMessage, text: str) -> None:
        self.sent.append((message.id, text))


def inbound(message_id: str = "pho_msg_inbound", text: str = "hello") -> InboundMessage:
    return InboundMessage(
        id=message_id,
        agent_sender_id="pho_usr_agent",
        space_id="pho_spc_test",
        text=text,
    )


def test_echo_agent_replies_once_per_message() -> None:
    gateway = FakeGateway()
    agent = EchoAgent(gateway)  # type: ignore[arg-type]
    message = inbound()

    processed = agent.process([message, message])

    assert processed == ["pho_msg_inbound"]
    assert gateway.sent == [
        ("pho_msg_inbound", "Photon Spectrum is connected. You said: hello")
    ]


def test_echo_agent_preserves_message_text_in_the_reply() -> None:
    gateway = FakeGateway()
    agent = EchoAgent(gateway)  # type: ignore[arg-type]

    agent.process([inbound(text="Waste on Oak Street")])

    assert gateway.sent == [
        (
            "pho_msg_inbound",
            "Photon Spectrum is connected. You said: Waste on Oak Street",
        )
    ]
