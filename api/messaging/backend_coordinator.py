"""Submit inbound Photon messages and dispatch backend-owned replies."""

import logging
from typing import Protocol

from api.messaging.backend_client import (
    ClaimedOutgoingMessage,
    Conversation,
    InboundRejectedError,
)
from api.messaging.messages import InboundMessage

logger = logging.getLogger(__name__)


class Backend(Protocol):
    def resolve_conversation(
        self, channel: str, external_id: str
    ) -> Conversation | None: ...
    def submit_followup(
        self, conversation_id: str, message_id: str, text: str
    ) -> None: ...
    def claim_outgoing(self, limit: int) -> list[ClaimedOutgoingMessage]: ...
    def status_text(self, conversation_id: str) -> str: ...
    def acknowledge_delivery(
        self,
        message_id: str,
        lease_id: str,
        provider_message_id: str | None,
        sent_text: str,
    ) -> None: ...


class Sender(Protocol):
    def send_to_space(
        self, *, space_id: str, sender_id: str, text: str, idempotency_key: str
    ) -> None: ...


class BackendCoordinator:
    """Keep conversation and outgoing delivery state in the backend."""

    def __init__(self, backend: Backend, sender: Sender, agent_sender_id: str) -> None:
        self._backend = backend
        self._sender = sender
        self._agent_sender_id = agent_sender_id

    def submit_inbound(self, message: InboundMessage) -> bool:
        try:
            conversation = self._backend.resolve_conversation(
                "imessage", message.space_id
            )
            if conversation is None:
                return False
            self._backend.submit_followup(conversation.id, message.id, message.text)
            return True
        except InboundRejectedError:
            logger.warning("Photon inbound message rejected")
            return False
        except Exception as error:
            logger.warning("Photon inbound submission failed: %s", type(error).__name__)
            raise

    def dispatch_claimed(self, limit: int = 20) -> list[str]:
        try:
            claimed = self._backend.claim_outgoing(limit)
        except Exception as error:
            logger.warning("Backend message claim failed: %s", type(error).__name__)
            raise

        delivered: list[str] = []
        for message in claimed:
            if message.channel != "imessage":
                continue
            try:
                text = message.text or self._backend.status_text(
                    message.conversation_id
                )
                if not text.strip():
                    continue
                self._sender.send_to_space(
                    space_id=message.external_id,
                    sender_id=self._agent_sender_id,
                    text=text,
                    idempotency_key=message.id,
                )
            except Exception as error:
                logger.warning("Photon reply send failed: %s", type(error).__name__)
                continue
            try:
                self._backend.acknowledge_delivery(
                    message.id, message.lease_id, None, text
                )
            except Exception as error:
                logger.warning(
                    "Backend delivery acknowledgement failed: %s", type(error).__name__
                )
                continue
            delivered.append(message.id)
        return delivered
