from dataclasses import dataclass

from api.messaging.messages import extract_inbound_text


@dataclass(frozen=True)
class Content:
    type: str
    text: str


@dataclass(frozen=True)
class User:
    id: str


@dataclass(frozen=True)
class Space:
    id: str


@dataclass(frozen=True)
class Message:
    id: str
    platform: str
    status: str
    content: Content
    sentBy: User
    receivedBy: User
    space: Space


@dataclass(frozen=True)
class WrappedMessage:
    root: object


def message(*, platform: str = "imessage", status: str = "received", text: str = "hello") -> Message:
    return Message(
        id="pho_msg_test",
        platform=platform,
        status=status,
        content=Content(type="text", text=text),
        sentBy=User(id="pho_usr_sender"),
        receivedBy=User(id="pho_usr_agent"),
        space=Space(id="pho_spc_test"),
    )


def test_extract_inbound_text_accepts_received_imessage_text() -> None:
    inbound = extract_inbound_text(message())

    assert inbound is not None
    assert inbound.id == "pho_msg_test"
    assert inbound.agent_sender_id == "pho_usr_agent"
    assert inbound.space_id == "pho_spc_test"
    assert inbound.text == "hello"


def test_extract_inbound_text_skips_sent_messages() -> None:
    assert extract_inbound_text(message(status="sent")) is None


def test_extract_inbound_text_skips_other_platforms() -> None:
    assert extract_inbound_text(message(platform="telegram")) is None


def test_extract_inbound_text_skips_blank_text() -> None:
    assert extract_inbound_text(message(text="  \n")) is None


def test_extract_inbound_text_skips_messages_without_an_agent_identity() -> None:
    inbound = message()
    object.__setattr__(inbound, "receivedBy", User(id=""))

    assert extract_inbound_text(inbound) is None


def test_extract_inbound_text_unwraps_generated_root_models() -> None:
    assert extract_inbound_text(WrappedMessage(WrappedMessage(message()))) is not None


def test_extract_inbound_text_unwraps_agent_and_space_root_models() -> None:
    inbound_message = message()
    object.__setattr__(inbound_message, "receivedBy", WrappedMessage(User(id="pho_usr_agent")))
    object.__setattr__(inbound_message, "space", WrappedMessage(Space(id="pho_spc_test")))

    inbound = extract_inbound_text(inbound_message)

    assert inbound is not None
    assert inbound.agent_sender_id == "pho_usr_agent"
    assert inbound.space_id == "pho_spc_test"


def test_extract_inbound_text_skips_messages_without_content() -> None:
    inbound = message()
    object.__setattr__(inbound, "content", None)

    assert extract_inbound_text(inbound) is None
