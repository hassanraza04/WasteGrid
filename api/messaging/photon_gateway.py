"""A narrow wrapper around the Photon Beta generated Python client."""

from dataclasses import dataclass
from datetime import UTC, datetime

from photon_api import Photon
from photon_api.generated import models
from photon_api.rpc_generated import (
    GetMessageInput,
    GetMessagePath,
    ListMessagesInput,
    ListMessagesPath,
    ListMessagesQuery,
    SendMessageHeader,
    SendMessageInput,
    SendMessagePath,
)

from api.messaging.config import PhotonConfig
from api.messaging.messages import InboundMessage


@dataclass(frozen=True)
class MessagePage:
    items: list[object]
    next_page_token: str | None = None


@dataclass(frozen=True)
class SubmissionReceipt:
    provider_message_id: str
    provider_status: str


def _receipt(value: object) -> SubmissionReceipt | None:
    payload = value
    while getattr(payload, "root", None) is not None:
        payload = payload.root
    identity, status = getattr(payload, "id", None), getattr(payload, "status", None)
    if (
        isinstance(identity, str)
        and identity
        and status in {"dispatched", "accepted", "delivered", "failed"}
    ):
        return SubmissionReceipt(identity, status)
    return None


class PhotonGateway:
    """Read fresh iMessages and request replies through the Photon API."""

    def __init__(self, config: PhotonConfig, client: Photon | None = None) -> None:
        self._config = config
        self._client = client or Photon(
            headers=lambda: {"Authorization": f"Bearer {config.api_key}"},
            timeout=10,
            max_attempts=1,
        )

    def list_message_page(
        self,
        since: datetime,
        before: datetime | None = None,
        page_token: str | None = None,
    ) -> MessagePage:
        """Read one bounded window; an empty page can still have a continuation."""
        query = dict(
            created_since=since.astimezone(UTC).isoformat().replace("+00:00", "Z"),
            direction=models.MessageDirection(root="received"),
            platform=models.Platform(root="imessage"),
            page_size=100,
            order=models.SortOrder(root="asc"),
            order_by=models.TimestampOrderBy(root="created_at"),
        )
        if before is not None:
            query["created_before"] = (
                before.astimezone(UTC).isoformat().replace("+00:00", "Z")
            )
        if page_token is not None:
            query["page_token"] = page_token
        page = self._client.projects.list_messages(
            ListMessagesInput(
                path=ListMessagesPath(id=self._config.project_id),
                query=ListMessagesQuery(**query),
            )
        )
        token = getattr(page, "nextPageToken", None)
        return MessagePage(
            list(page.items), token if isinstance(token, str) and token else None
        )

    def list_new_messages(self, since: datetime) -> list[object]:
        """List inbound iMessages that Photon received after ``since``."""
        items: list[object] = []
        token = None
        seen: set[str] = set()
        while True:
            page = self.list_message_page(since, page_token=token)
            items.extend(page.items)
            token = page.next_page_token
            if token is None:
                return items
            if token in seen:
                raise RuntimeError("Photon returned a repeated continuation token")
            seen.add(token)

    def send_reply(self, message: InboundMessage, text: str) -> None:
        """Request one plain-text iMessage reply with a stable idempotency key."""
        self.send_to_space(
            space_id=message.space_id,
            sender_id=message.agent_sender_id,
            text=text,
            idempotency_key=f"wastegrid-reply-{message.id}",
        )

    def send_to_space(
        self,
        *,
        space_id: str,
        sender_id: str,
        text: str,
        idempotency_key: str,
    ) -> SubmissionReceipt | None:
        """Send plain text to a Photon space from the given sender."""
        result = self._client.projects.send_message(
            SendMessageInput(
                body=models.SendMessageRequest(
                    content=models.SendTextContent(
                        type="text",
                        format="plain",
                        text=text,
                    ),
                    senderId=sender_id,
                    spaceId=space_id,
                ),
                path=SendMessagePath(id=self._config.project_id),
                headers=SendMessageHeader(idempotency_key=idempotency_key),
            )
        )
        return _receipt(result)

    def message_status(self, provider_message_id: str) -> SubmissionReceipt | None:
        return _receipt(
            self._client.projects.get_message(
                GetMessageInput(
                    path=GetMessagePath(
                        id=self._config.project_id, message_id=provider_message_id
                    )
                )
            )
        )

    def close(self) -> None:
        self._client.close()
