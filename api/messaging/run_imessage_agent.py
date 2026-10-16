"""Run the minimal Photon Beta iMessage echo agent."""

import logging
import os
import time
from datetime import UTC, datetime
from typing import Protocol

from api.messaging.config import load_photon_config
from api.messaging.echo_agent import EchoAgent, ReplyGateway
from api.messaging.messages import InboundMessage, extract_inbound_text
from api.messaging.photon_gateway import PhotonGateway

logger = logging.getLogger(__name__)


class MessageReader(Protocol):
    """Read raw messages received after a known timestamp."""

    def list_new_messages(self, since: datetime) -> list[object]:
        """Return raw Photon messages."""


class MessageProcessor(Protocol):
    """Process validated inbound messages."""

    def process(self, messages: list[InboundMessage]) -> list[str]:
        """Return the IDs for which an action was requested."""


def run_once(
    gateway: MessageReader, agent: MessageProcessor, started_at: datetime
) -> list[str]:
    """Fetch fresh messages and hand replyable iMessages to the agent."""
    messages = gateway.list_new_messages(started_at)
    inbound = [
        extracted
        for message in messages
        if (extracted := extract_inbound_text(message)) is not None
    ]
    return agent.process(inbound)


def run_forever() -> None:
    """Poll Photon until the operator stops the process."""
    config = load_photon_config(os.environ)
    gateway = PhotonGateway(config)
    agent = EchoAgent(gateway)
    started_at = datetime.now(UTC)
    logger.info("Photon iMessage agent is polling for new messages")

    try:
        while True:
            try:
                processed = run_once(gateway, agent, started_at)
                if processed:
                    logger.info("Requested replies for %d message(s)", len(processed))
            except Exception:
                logger.exception("Photon polling iteration failed")
            time.sleep(config.poll_interval_seconds)
    except KeyboardInterrupt:
        logger.info("Photon iMessage agent stopped")


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    run_forever()
