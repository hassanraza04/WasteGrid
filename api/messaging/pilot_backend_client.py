"""HTTP boundary for the opt-in messaging pilot; credentials stay server-side."""

from dataclasses import asdict, dataclass
from typing import Any
from urllib.parse import quote

from api.messaging.backend_client import BackendClientError, WasteGridBackendClient
from api.messaging.messages import PilotInboundMessage
from api.messaging.pilot_ledger import ProviderReceipt


@dataclass(frozen=True)
class PilotOutgoing:
    id: str
    lease_id: str | None
    thread_id: str
    channel: str
    external_id: str
    sender_id: str
    text: str
    provider_message_id: str | None
    status: str
    consent_revision: int


def _outgoing(value: Any) -> PilotOutgoing:
    names = (
        "id",
        "thread_id",
        "channel",
        "external_id",
        "sender_id",
        "text",
        "status",
    )
    if (
        not isinstance(value, dict)
        or any(
            not isinstance(value.get(name), str) or not value[name] for name in names
        )
        or value["channel"] != "imessage"
        or not value["text"].strip()
        or len(value["text"]) > 4000
        or type(value.get("consent_revision")) is not int
        or value["consent_revision"] < 0
        or (not isinstance(value.get("lease_id"), str) or not value["lease_id"])
        and not (
            value.get("lease_id") is None
            and isinstance(value.get("provider_message_id"), str)
            and bool(value["provider_message_id"])
        )
        or value.get("provider_message_id") is not None
        and (
            not isinstance(value["provider_message_id"], str)
            or not value["provider_message_id"]
        )
    ):
        raise BackendClientError("pilot_outgoing failed (schema)")
    return PilotOutgoing(
        **{name: value.get(name) for name in PilotOutgoing.__dataclass_fields__}
    )


class PilotBackendClient(WasteGridBackendClient):
    def submit_pilot_inbound(self, message: PilotInboundMessage) -> None:
        response = self._post(
            "pilot_inbound", "/internal/messaging/inbound", asdict(message)
        )
        value = self._json(response, "pilot_inbound")
        if (
            not isinstance(value, dict)
            or not value.get("id")
            or not isinstance(value.get("status"), str)
        ):
            raise BackendClientError("pilot_inbound failed (schema)")

    def claim_pilot_outgoing(self) -> list[PilotOutgoing]:
        response = self._post("pilot_claim", "/internal/messaging/outgoing/claim", {})
        value = self._json(response, "pilot_claim")
        if not isinstance(value, list) or len(value) > 1:
            raise BackendClientError("pilot_claim failed (schema)")
        return [_outgoing(item) for item in value]

    @staticmethod
    def _path(identity: str, operation: str) -> str:
        return f"/internal/messaging/outgoing/{quote(identity, safe='')}/{operation}"

    def mark_sending(self, message: PilotOutgoing) -> PilotOutgoing:
        response = self._post(
            "pilot_sending",
            self._path(message.id, "sending"),
            {"lease_id": message.lease_id},
        )
        return _outgoing(self._json(response, "pilot_sending"))

    def acknowledge_pilot_receipt(self, receipt: ProviderReceipt) -> None:
        self._post(
            "pilot_accepted",
            self._path(receipt.message_id, "accepted"),
            {
                "lease_id": receipt.lease_id,
                "provider_message_id": receipt.provider_message_id,
                "provider_status": receipt.provider_status,
                "sent_text": receipt.sent_text,
            },
        )

    def fail_pilot_outgoing(
        self, message: PilotOutgoing, *, kind: str, retryable: bool
    ) -> None:
        self._post(
            "pilot_failed",
            self._path(message.id, "failed"),
            {
                "lease_id": message.lease_id,
                "kind": kind,
                "retryable": retryable,
            },
        )

    def reconcile_pilot_status(
        self, identity: str, provider_message_id: str, status: str
    ) -> None:
        self._post(
            "pilot_status",
            self._path(identity, "status"),
            {
                "provider_message_id": provider_message_id,
                "provider_status": status,
            },
        )
