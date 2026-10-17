"""Queue and dispatch replies through the durable delivery ledger."""

from datetime import datetime
import logging
from typing import Iterable, Protocol

from api.messaging.delivery_ledger import DeliveryLedger
from api.messaging.messages import InboundMessage
from api.messaging.reply_policy import ReplyPolicy

logger = logging.getLogger(__name__)


class ReplySender(Protocol):
    """The transport operation needed to send a reply."""

    def send_reply(self, message: InboundMessage, text: str) -> None:
        """Send text using the inbound message's routing fields."""


class DeliveryCoordinator:
    """Persist replies before sending and retry saved replies when due."""

    def __init__(
        self, ledger: DeliveryLedger, policy: ReplyPolicy, sender: ReplySender
    ) -> None:
        self._ledger = ledger
        self._policy = policy
        self._sender = sender

    def checkpoint_or_initialize(self, now: datetime) -> datetime:
        return self._ledger.checkpoint_or_initialize(now)

    def advance_checkpoint(self, checkpoint: datetime) -> None:
        self._ledger.advance_checkpoint(checkpoint)

    def queue_messages(
        self, messages: Iterable[InboundMessage], now: datetime
    ) -> list[str]:
        queued: list[str] = []
        for message in messages:
            if self._ledger.enqueue_reply(message, self._policy.reply_for(message), now):
                queued.append(message.id)
        return queued

    def dispatch_due_replies(self, now: datetime) -> list[str]:
        sent: list[str] = []
        for reply in self._ledger.due_replies(now):
            try:
                self._sender.send_reply(reply.message, reply.text)
            except Exception as error:
                state = self._ledger.mark_send_failed(reply.message.id, now, error)
                logger.warning(
                    "Photon reply attempt failed: message_id=%s state=%s attempt_count=%d",
                    reply.message.id,
                    state,
                    reply.attempt_count + 1,
                )
            else:
                self._ledger.mark_sent(reply.message.id, now)
                sent.append(reply.message.id)
        return sent
