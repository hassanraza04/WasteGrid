from api.messaging.messages import InboundMessage
from api.messaging.reply_policy import SmokeTestReplyPolicy


def test_smoke_policy_preserves_connection_reply() -> None:
    message = InboundMessage("pho_msg_1", "pho_agent", "pho_space", "Oak Street")

    assert SmokeTestReplyPolicy().reply_for(message) == (
        "Photon Spectrum is connected. You said: Oak Street"
    )
