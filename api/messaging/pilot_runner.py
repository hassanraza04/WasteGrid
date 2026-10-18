"""Bounded paginated scans with overlap and full reconciliation after indexing lag."""

import logging
from dataclasses import replace
from datetime import datetime

from photon_api.errors import ApiError

from api.messaging.config import PhotonConfig
from api.messaging.messages import extract_pilot_inbound
from api.messaging.pilot_coordinator import PilotCoordinator
from api.messaging.pilot_ledger import PilotLedger

logger = logging.getLogger(__name__)


def run_pilot_once(
    gateway,
    coordinator: PilotCoordinator,
    ledger: PilotLedger,
    config: PhotonConfig,
    now: datetime,
) -> list[str]:
    if not config.pilot_enabled or not config.pilot_chat_ids:
        return []
    window = ledger.scan_window(now)
    seen: set[str] = set()
    submitted: list[str] = []
    while True:
        try:
            page = gateway.list_message_page(
                window.since, window.before, window.page_token
            )
        except ApiError as error:
            if window.page_token and error.status in {400, 410}:
                ledger.reset_page_token(window)
            raise
        for raw in page.items:
            message = extract_pilot_inbound(
                raw,
                project_id=config.project_id,
                agent_sender_id=config.backend.agent_sender_id,
                chat_ids=config.pilot_chat_ids,
            )
            if message is not None and coordinator.submit_inbound(message):
                submitted.append(message.message_id)
        token = page.next_page_token
        if token is not None and (token == window.page_token or token in seen):
            raise RuntimeError("Photon returned a repeated continuation token")
        ledger.page_processed(window, token)
        if token is None:
            break
        seen.add(token)
        window = replace(window, page_token=token)
    # Ingest controls such as STOP before dispatching any queued notification.
    coordinator.dispatch_claimed()
    coordinator.reconcile(now)
    return submitted
