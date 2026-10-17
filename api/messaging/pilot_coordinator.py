"""Fenced sends and receipt recovery; uncertain submissions are never repeated."""

import logging
from datetime import datetime, timedelta

from photon_api.errors import ApiError

from api.messaging.backend_client import BackendClientError
from api.messaging.config import PhotonConfig
from api.messaging.messages import PilotInboundMessage
from api.messaging.pilot_backend_client import PilotBackendClient, PilotOutgoing
from api.messaging.pilot_ledger import PilotLedger

logger = logging.getLogger(__name__)
# Photon acceptance is terminal when delivery confirmation is unavailable; it
# never means the recipient received or read the message.
TERMINAL_PROVIDER_STATUSES = {"accepted", "delivered", "failed"}


class PilotCoordinator:
    def __init__(
        self,
        backend: PilotBackendClient,
        gateway,
        ledger: PilotLedger,
        config: PhotonConfig,
    ):
        ledger.bind_identity(config.project_id, config.backend.agent_sender_id)
        self.backend, self.gateway, self.ledger, self.config = (
            backend,
            gateway,
            ledger,
            config,
        )

    def submit_inbound(self, message: PilotInboundMessage) -> bool:
        try:
            self.backend.submit_pilot_inbound(message)
            return True
        except BackendClientError as error:
            if error.status_code in {400, 409, 413, 415, 422}:
                logger.warning("Pilot inbound rejected by backend")
                return False
            raise

    def recover_receipts(self) -> None:
        for receipt in self.ledger.receipts(unacknowledged=True):
            try:
                self.backend.acknowledge_pilot_receipt(receipt)
                self.ledger.acknowledge_receipt(receipt.message_id)
            except Exception as error:
                logger.warning(
                    "Pilot receipt acknowledgement failed: %s", type(error).__name__
                )

    def reconcile(self, now: datetime) -> None:
        for receipt in self.ledger.receipts():
            if (
                not receipt.acknowledged
                or receipt.latest_status in TERMINAL_PROVIDER_STATUSES
                or receipt.checked_at is not None
                and now - receipt.checked_at < timedelta(seconds=30)
            ):
                continue
            try:
                status = self.gateway.message_status(receipt.provider_message_id)
                if status is not None:
                    if status.provider_message_id != receipt.provider_message_id:
                        raise ValueError("Provider status identity changed")
                    self.backend.reconcile_pilot_status(
                        receipt.message_id,
                        receipt.provider_message_id,
                        status.provider_status,
                    )
                    self.ledger.checked_receipt(
                        receipt.message_id, status.provider_status, now
                    )
                else:
                    self.ledger.checked_receipt(
                        receipt.message_id, receipt.latest_status, now
                    )
            except Exception as error:
                logger.warning(
                    "Pilot status reconciliation failed: %s", type(error).__name__
                )

    def _allowed(self, message: PilotOutgoing) -> bool:
        return (
            message.channel == "imessage"
            and message.external_id in self.config.pilot_chat_ids
            and message.sender_id == self.config.backend.agent_sender_id
        )

    def dispatch_claimed(self) -> list[str]:
        self.recover_receipts()
        local_receipts = {
            receipt.message_id: receipt for receipt in self.ledger.receipts()
        }
        delivered: list[str] = []
        for claimed in self.backend.claim_pilot_outgoing():
            if claimed.provider_message_id is not None:
                previous = local_receipts.get(claimed.id)
                if (
                    previous
                    and previous.acknowledged
                    and previous.provider_message_id == claimed.provider_message_id
                    and previous.latest_status in TERMINAL_PROVIDER_STATUSES
                ):
                    continue
                status = self.gateway.message_status(claimed.provider_message_id)
                if status is not None:
                    if status.provider_message_id != claimed.provider_message_id:
                        raise ValueError("Provider status identity changed")
                    self.backend.reconcile_pilot_status(
                        claimed.id, claimed.provider_message_id, status.provider_status
                    )
                continue
            if claimed.id in local_receipts:
                # Provider identities are reconciled, never submitted a second time.
                continue
            if not self._allowed(claimed):
                logger.warning("Pilot destination rejected by local allowlist")
                self.backend.fail_pilot_outgoing(
                    claimed, kind="rejected", retryable=False
                )
                continue
            try:
                message = self.backend.mark_sending(claimed)
            except BackendClientError as error:
                if error.status_code == 409:
                    continue  # Consent or the lease changed before provider contact.
                raise
            if (
                not self._allowed(message)
                or message.id != claimed.id
                or message.lease_id != claimed.lease_id
                or message.external_id != claimed.external_id
                or message.sender_id != claimed.sender_id
                or message.text != claimed.text
                or message.consent_revision != claimed.consent_revision
                or message.provider_message_id is not None
            ):
                self.backend.fail_pilot_outgoing(
                    claimed, kind="rejected", retryable=False
                )
                continue
            try:
                receipt = self.gateway.send_to_space(
                    space_id=message.external_id,
                    sender_id=message.sender_id,
                    text=message.text,
                    idempotency_key=message.id,
                )
                if receipt is None:
                    raise ValueError("Provider did not return a submission receipt")
            except Exception as error:
                rejected = (
                    isinstance(error, ApiError)
                    and error.status is not None
                    and (400 <= error.status < 500 and error.status != 408)
                )
                self.backend.fail_pilot_outgoing(
                    message,
                    kind="rejected" if rejected else "unknown",
                    retryable=rejected and error.status == 429,
                )
                logger.warning(
                    "Pilot provider submission failed: %s", type(error).__name__
                )
                continue
            # Persist the actual provider ID before any acknowledgement network call.
            # A crash before this write leaves backend 'sending', then 'unknown';
            # it cannot silently re-enter the send queue.
            self.ledger.record_receipt(
                message.id,
                message.lease_id,
                receipt.provider_message_id,
                receipt.provider_status,
                message.text,
            )
            self.recover_receipts()
            delivered.append(message.id)
        return delivered
