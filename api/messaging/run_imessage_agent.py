"""Poll Photon and hand messaging work to the backend."""

import logging
import os
import time
from datetime import UTC, datetime
from typing import Protocol

from api.messaging.backend_client import WasteGridBackendClient
from api.messaging.backend_coordinator import BackendCoordinator
from api.messaging.config import load_photon_config
from api.messaging.delivery_ledger import DeliveryLedger
from api.messaging.messages import extract_inbound_text
from api.messaging.photon_gateway import PhotonGateway

logger = logging.getLogger(__name__)


class MessageReader(Protocol):
    """Read raw messages received after a known timestamp."""

    def list_new_messages(self, since: datetime) -> list[object]:
        """Return raw Photon messages."""


def run_once(
    gateway: MessageReader,
    coordinator: BackendCoordinator,
    ledger: DeliveryLedger,
    poll_started_at: datetime,
) -> list[str]:
    """Dispatch backend replies, submit new messages, and save the poll checkpoint."""
    checkpoint = ledger.checkpoint_or_initialize(poll_started_at)
    coordinator.dispatch_claimed()
    messages = gateway.list_new_messages(checkpoint)
    inbound = [
        extracted
        for message in messages
        if (extracted := extract_inbound_text(message)) is not None
    ]
    submitted = [
        message.id for message in inbound if coordinator.submit_inbound(message)
    ]
    ledger.advance_checkpoint(poll_started_at)
    coordinator.dispatch_claimed()
    return submitted


def run_forever() -> None:
    """Poll Photon until the operator stops the process."""
    config = load_photon_config(os.environ)
    gateway = PhotonGateway(config)
    backend = WasteGridBackendClient(config.backend)
    ledger = DeliveryLedger(config.delivery_db_path)
    coordinator = BackendCoordinator(backend, gateway, config.backend.agent_sender_id)
    logger.info("Photon iMessage agent is polling for new messages")

    try:
        while True:
            try:
                poll_started_at = datetime.now(UTC)
                submitted = run_once(gateway, coordinator, ledger, poll_started_at)
                if submitted:
                    logger.info("Submitted %d inbound message(s)", len(submitted))
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
