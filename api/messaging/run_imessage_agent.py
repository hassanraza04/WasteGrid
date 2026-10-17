"""Poll Photon and deliver replies through the durable ledger."""

import logging
import os
import time
from datetime import UTC, datetime
from typing import Protocol

from api.messaging.config import load_photon_config
from api.messaging.delivery_coordinator import DeliveryCoordinator
from api.messaging.delivery_ledger import DeliveryLedger
from api.messaging.messages import extract_inbound_text
from api.messaging.photon_gateway import PhotonGateway
from api.messaging.reply_policy import SmokeTestReplyPolicy

logger = logging.getLogger(__name__)


class MessageReader(Protocol):
    """Read raw messages received after a known timestamp."""

    def list_new_messages(self, since: datetime) -> list[object]:
        """Return raw Photon messages."""


def run_once(
    gateway: MessageReader, coordinator: DeliveryCoordinator, poll_started_at: datetime
) -> list[str]:
    """Send due replies, queue fetched messages, and save the poll checkpoint."""
    checkpoint = coordinator.checkpoint_or_initialize(poll_started_at)
    coordinator.dispatch_due_replies(poll_started_at)
    messages = gateway.list_new_messages(checkpoint)
    inbound = [
        extracted
        for message in messages
        if (extracted := extract_inbound_text(message)) is not None
    ]
    queued = coordinator.queue_messages(inbound, poll_started_at)
    coordinator.advance_checkpoint(poll_started_at)
    coordinator.dispatch_due_replies(poll_started_at)
    return queued


def run_forever() -> None:
    """Poll Photon until the operator stops the process."""
    config = load_photon_config(os.environ)
    gateway = PhotonGateway(config)
    ledger = DeliveryLedger(config.delivery_db_path)
    coordinator = DeliveryCoordinator(ledger, SmokeTestReplyPolicy(), gateway)
    logger.info("Photon iMessage agent is polling for new messages")

    try:
        while True:
            try:
                poll_started_at = datetime.now(UTC)
                queued = run_once(gateway, coordinator, poll_started_at)
                if queued:
                    logger.info("Queued replies for %d message(s)", len(queued))
            except Exception as error:
                logger.error(
                    "Photon polling iteration failed: %s", type(error).__name__
                )
            time.sleep(config.poll_interval_seconds)
    except KeyboardInterrupt:
        logger.info("Photon iMessage agent stopped")


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    run_forever()
