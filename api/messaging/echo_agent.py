"""The smallest safe behavior for validating Photon iMessage delivery."""

from typing import Iterable, Protocol

from api.messaging.messages import InboundMessage


class ReplyGateway(Protocol):
    """The portion of PhotonGateway needed by the echo policy."""

    def send_reply(self, message: InboundMessage, text: str) -> None:
        """Request an outbound reply for an inbound message."""


class EchoAgent:
    """Reply once to each valid message observed by this process."""

    def __init__(self, gateway: ReplyGateway) -> None:
        self._gateway = gateway
        self._handled_message_ids: set[str] = set()

    def process(self, messages: Iterable[InboundMessage]) -> list[str]:
        """Send the test reply for each previously unhandled inbound message."""
        processed: list[str] = []
        for message in messages:
            if message.id in self._handled_message_ids:
                continue
            self._gateway.send_reply(
                message,
                f"Photon Spectrum is connected. You said: {message.text}",
            )
            self._handled_message_ids.add(message.id)
            processed.append(message.id)
        return processed
