"""Choose reply text for an inbound message."""

from typing import Protocol

from api.messaging.messages import InboundMessage


class ReplyPolicy(Protocol):
    """Turn a validated inbound message into reply text."""

    def reply_for(self, message: InboundMessage) -> str:
        """Return the text to send for this message."""


class SmokeTestReplyPolicy:
    """Keep the existing connection test reply."""

    def reply_for(self, message: InboundMessage) -> str:
        return f"Photon Spectrum is connected. You said: {message.text}"
