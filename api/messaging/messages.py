"""Small, provider-agnostic representations of inbound Photon messages."""

from dataclasses import dataclass


@dataclass(frozen=True)
class InboundMessage:
    """The fields needed to reply safely to one inbound iMessage."""

    id: str
    agent_sender_id: str
    space_id: str
    text: str


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
        _string_attribute(_unwrap_root_model(agent), "id") if agent is not None else None
    )
    space_id = _string_attribute(_unwrap_root_model(space), "id") if space is not None else None
    if not all((message_id, agent_sender_id, space_id)):
        return None

    return InboundMessage(
        id=message_id,
        agent_sender_id=agent_sender_id,
        space_id=space_id,
        text=text.strip(),
    )
