"""Narrow HTTP client for the WasteGrid messaging contract."""

from dataclasses import dataclass
from typing import Any
from urllib.parse import quote

import httpx

from api.messaging.config import BackendConfig


class BackendClientError(RuntimeError):
    """A backend failure with no response content or request secrets."""


@dataclass(frozen=True)
class Conversation:
    id: str
    channel: str
    external_id: str


@dataclass(frozen=True)
class ClaimedOutgoingMessage:
    id: str
    lease_id: str
    channel: str
    external_id: str
    text: str


def _required_text(value: Any) -> str | None:
    return value if isinstance(value, str) and bool(value) else None


class WasteGridBackendClient:
    """Expose only the operations needed by the Photon messaging adapter."""

    def __init__(
        self, config: BackendConfig, *, transport: httpx.BaseTransport | None = None
    ) -> None:
        self._config = config
        self._transport = transport

    def _post(
        self,
        operation: str,
        path: str,
        payload: dict[str, object],
        *,
        missing_ok: bool = False,
    ) -> httpx.Response | None:
        failed = False
        try:
            with httpx.Client(
                base_url=self._config.base_url,
                timeout=self._config.timeout_seconds,
                transport=self._transport,
                headers={"X-Integration-Key": self._config.messaging_api_key},
            ) as client:
                response = client.post(path, json=payload)
        except (httpx.HTTPError, ValueError):
            failed = True
        if failed:
            raise BackendClientError(f"{operation} failed (network)")
        if response.status_code == 404 and missing_ok:
            return None
        if not 200 <= response.status_code < 300:
            raise BackendClientError(
                f"{operation} failed (status {response.status_code})"
            )
        return response

    @staticmethod
    def _json(response: httpx.Response, operation: str) -> Any:
        invalid = False
        try:
            result = response.json()
        except ValueError:
            invalid = True
        if invalid:
            raise BackendClientError(f"{operation} failed (json)")
        return result

    def resolve_conversation(
        self, channel: str, external_id: str
    ) -> Conversation | None:
        operation = "resolve_conversation"
        response = self._post(
            operation,
            "/internal/conversations/resolve",
            {"channel": channel, "external_id": external_id},
            missing_ok=True,
        )
        if response is None:
            return None
        data = self._json(response, operation)
        if not isinstance(data, dict):
            raise BackendClientError(f"{operation} failed (schema)")
        identity = _required_text(data.get("id"))
        resolved_channel = _required_text(data.get("channel"))
        resolved_external_id = _required_text(data.get("external_id"))
        if identity is None or resolved_channel is None or resolved_external_id is None:
            raise BackendClientError(f"{operation} failed (schema)")
        return Conversation(identity, resolved_channel, resolved_external_id)

    def submit_followup(self, conversation_id: str, message_id: str, text: str) -> None:
        self._post(
            "submit_followup",
            f"/internal/conversations/{quote(str(conversation_id), safe='')}/followup",
            {"message_id": message_id, "text": text},
        )

    def claim_outgoing(self, limit: int) -> list[ClaimedOutgoingMessage]:
        operation = "claim_outgoing"
        response = self._post(
            operation, "/internal/outgoing-messages/claim", {"limit": limit}
        )
        data = self._json(response, operation)
        if not isinstance(data, list):
            raise BackendClientError(f"{operation} failed (schema)")
        messages: list[ClaimedOutgoingMessage] = []
        for item in data:
            if not isinstance(item, dict):
                raise BackendClientError(f"{operation} failed (schema)")
            conversation = item.get("conversation")
            payload = item.get("payload")
            if not isinstance(conversation, dict) or not isinstance(payload, dict):
                raise BackendClientError(f"{operation} failed (schema)")
            fields = (
                _required_text(item.get("id")),
                _required_text(item.get("lease_id")),
                _required_text(conversation.get("channel")),
                _required_text(conversation.get("external_id")),
                _required_text(payload.get("reply_text")),
            )
            if any(field is None for field in fields):
                raise BackendClientError(f"{operation} failed (schema)")
            messages.append(ClaimedOutgoingMessage(*fields))
        return messages

    def acknowledge_delivery(
        self,
        message_id: str,
        lease_id: str,
        provider_message_id: str | None,
        sent_text: str,
    ) -> None:
        self._post(
            "acknowledge_delivery",
            f"/internal/outgoing-messages/{quote(str(message_id), safe='')}/delivered",
            {
                "lease_id": lease_id,
                "provider_message_id": provider_message_id,
                "sent_text": sent_text,
            },
        )
