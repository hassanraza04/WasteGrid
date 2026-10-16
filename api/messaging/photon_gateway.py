"""A narrow wrapper around the Photon Beta generated Python client."""

from datetime import UTC, datetime

from photon_api import Photon
from photon_api.generated import models
from photon_api.rpc_generated import (
    ListMessagesInput,
    ListMessagesPath,
    ListMessagesQuery,
    SendMessageHeader,
    SendMessageInput,
    SendMessagePath,
)

from api.messaging.config import PhotonConfig
from api.messaging.messages import InboundMessage


class PhotonGateway:
    """Read fresh iMessages and request replies through the Photon API."""

    def __init__(self, config: PhotonConfig, client: Photon | None = None) -> None:
        self._config = config
        self._client = client or Photon(
            headers=lambda: {"Authorization": f"Bearer {config.api_key}"}
        )

    def list_new_messages(self, since: datetime) -> list[object]:
        """List inbound iMessages that Photon received after ``since``."""
        timestamp = since.astimezone(UTC).isoformat().replace("+00:00", "Z")
        page = self._client.projects.list_messages(
            ListMessagesInput(
                path=ListMessagesPath(id=self._config.project_id),
                query=ListMessagesQuery(
                    created_since=timestamp,
                    direction=models.MessageDirection(root="received"),
                    platform=models.Platform(root="imessage"),
                    page_size=100,
                ),
            )
        )
        return list(page.items)

    def send_reply(self, message: InboundMessage, text: str) -> None:
        """Request one plain-text iMessage reply with a stable idempotency key."""
        self._client.projects.send_message(
            SendMessageInput(
                body=models.SendMessageRequest(
                    content=models.SendTextContent(
                        type="text",
                        format="plain",
                        text=text,
                    ),
                    senderId=message.agent_sender_id,
                    spaceId=message.space_id,
                ),
                path=SendMessagePath(id=self._config.project_id),
                headers=SendMessageHeader(
                    idempotency_key=f"wastegrid-reply-{message.id}"
                ),
            )
        )
