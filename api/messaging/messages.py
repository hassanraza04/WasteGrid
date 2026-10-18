"""Small, provider-agnostic representations of inbound Photon messages."""

from dataclasses import dataclass
from datetime import datetime


@dataclass(frozen=True)
class InboundMessage:
    """The fields needed to reply safely to one inbound iMessage."""

    id: str
    agent_sender_id: str
    space_id: str
    text: str


@dataclass(frozen=True)
class PilotInboundMessage:
    """Provider identities needed for report-link and consent authorization."""

    project_id: str
    agent_sender_id: str
    external_id: str
    message_id: str
    text: str
    created_at: str
    peer_id: str
    space_kind: str


def _string_attribute(value: object, name: str) -> str | None:
    attribute = getattr(value, name, None)
    return attribute if isinstance(attribute, str) else None


def _object_attribute(value: object, name: str) -> object | None:
    attribute = getattr(value, name, None)
    return attribute if attribute is not None else None


def _unwrap_root_model(message: object) -> object:
    """Unwrap Photon generated root models until the concrete message is reached."""
    payload = message
    while True:
        nested = _object_attribute(payload, "root")
        if nested is None or nested is payload:
            return payload
        payload = nested


def extract_inbound_text(message: object) -> InboundMessage | None:
    """Return a replyable plain-text iMessage, or ``None`` for other event types."""
    payload = _unwrap_root_model(message)
    if _string_attribute(payload, "platform") != "imessage":
        return None
    if _string_attribute(payload, "status") != "received":
        return None

    content = _object_attribute(payload, "content")
    if content is None or _string_attribute(content, "type") != "text":
        return None
    text = _string_attribute(content, "text")
    if text is None or not text.strip():
        return None

    agent = _object_attribute(payload, "receivedBy")
    space = _object_attribute(payload, "space")
    message_id = _string_attribute(payload, "id")
    agent_sender_id = (
        _string_attribute(_unwrap_root_model(agent), "id")
        if agent is not None
        else None
    )
    space_id = (
        _string_attribute(_unwrap_root_model(space), "id")
        if space is not None
        else None
    )
    if not all((message_id, agent_sender_id, space_id)):
        return None

    return InboundMessage(
        id=message_id,
        agent_sender_id=agent_sender_id,
        space_id=space_id,
        text=text.strip(),
    )


def extract_pilot_inbound(
    message: object,
    *,
    project_id: str,
    agent_sender_id: str,
    chat_ids: tuple[str, ...],
) -> PilotInboundMessage | None:
    """Accept only the allowlisted direct chat received by this project's agent."""
    basic = extract_inbound_text(message)
    if basic is None or basic.agent_sender_id != agent_sender_id:
        return None
    payload = _unwrap_root_model(message)
    space = _unwrap_root_model(getattr(payload, "space", None))
    peer = _unwrap_root_model(getattr(payload, "sentBy", None))
    actual_project = _string_attribute(payload, "projectId")
    peer_id = _string_attribute(peer, "id")
    created_at = _string_attribute(payload, "createdAt")
    if (
        actual_project != project_id
        or basic.space_id not in chat_ids
        or _string_attribute(space, "kind") != "direct"
        or not peer_id
        or not created_at
    ):
        return None
    try:
        timestamp = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
        if timestamp.tzinfo is None or timestamp.utcoffset() is None:
            return None
    except ValueError:
        return None
    # Preserve the provider's exact text for the backend's immutable inbox hash.
    content = getattr(payload, "content", None)
    return PilotInboundMessage(
        actual_project,
        basic.agent_sender_id,
        basic.space_id,
        basic.id,
        getattr(content, "text"),
        created_at,
        peer_id,
        "direct",
    )
