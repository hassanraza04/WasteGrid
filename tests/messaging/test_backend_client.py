"""HTTP contract tests for the narrow WasteGrid messaging client."""

import json
from dataclasses import FrozenInstanceError

import httpx
import pytest

from api.messaging.backend_client import (
    BackendClientError,
    ClaimedOutgoingMessage,
    Conversation,
    WasteGridBackendClient,
)
from api.messaging.config import BackendConfig


def backend_config() -> BackendConfig:
    return BackendConfig(
        base_url="https://backend.example.test/api",
        messaging_api_key="private-key",
        agent_sender_id="agent-1",
        timeout_seconds=3.5,
    )


def client_for(handler) -> WasteGridBackendClient:
    def check_auth(request: httpx.Request) -> httpx.Response:
        assert request.headers["x-integration-key"] == "private-key"
        assert "authorization" not in request.headers
        return handler(request)

    return WasteGridBackendClient(
        backend_config(), transport=httpx.MockTransport(check_auth)
    )


def test_resolve_conversation_uses_integration_key_and_required_fields() -> None:
    def respond(request: httpx.Request) -> httpx.Response:
        assert request.method == "POST"
        assert request.url.path == "/api/internal/conversations/resolve"
        assert request.headers["x-integration-key"] == "private-key"
        assert json.loads(request.content) == {
            "channel": "imessage",
            "external_id": "pho-user-1",
        }
        assert request.extensions["timeout"]["read"] == 3.5
        return httpx.Response(
            200,
            json={
                "id": "conversation-1",
                "channel": "imessage",
                "external_id": "pho-user-1",
                "report_id": "unused",
            },
        )

    result = client_for(respond).resolve_conversation("imessage", "pho-user-1")

    assert result == Conversation("conversation-1", "imessage", "pho-user-1")
    with pytest.raises(FrozenInstanceError):
        result.id = "changed"


def test_resolve_conversation_returns_none_only_for_404() -> None:
    client = client_for(lambda request: httpx.Response(404, text="private body"))
    assert client.resolve_conversation("imessage", "unknown") is None


def test_submit_followup_posts_message_without_parsing_unused_response() -> None:
    def respond(request: httpx.Request) -> httpx.Response:
        assert request.method == "POST"
        assert request.url.path == "/api/internal/conversations/conversation-1/followup"
        assert json.loads(request.content) == {
            "message_id": "pho-message-1",
            "text": "private followup",
        }
        return httpx.Response(202, text="not JSON")

    assert (
        client_for(respond).submit_followup(
            "conversation-1", "pho-message-1", "private followup"
        )
        is None
    )


def test_claim_outgoing_reads_only_required_nested_fields() -> None:
    def respond(request: httpx.Request) -> httpx.Response:
        assert request.method == "POST"
        assert request.url.path == "/api/internal/outgoing-messages/claim"
        assert json.loads(request.content) == {"limit": 5}
        return httpx.Response(
            200,
            json=[
                {
                    "id": "outgoing-1",
                    "lease_id": "lease-1",
                    "conversation": {
                        "channel": "imessage",
                        "external_id": "pho-user-1",
                        "report_id": "unused",
                    },
                    "payload": {"reply_text": "Send this", "unused": "ignored"},
                    "attempts": 1,
                }
            ],
        )

    result = client_for(respond).claim_outgoing(5)

    assert result == [
        ClaimedOutgoingMessage(
            "outgoing-1", "lease-1", "imessage", "pho-user-1", "Send this"
        )
    ]
    with pytest.raises(FrozenInstanceError):
        result[0].text = "changed"


def test_acknowledge_delivery_posts_exact_contract_fields() -> None:
    def respond(request: httpx.Request) -> httpx.Response:
        assert request.method == "POST"
        assert (
            request.url.path == "/api/internal/outgoing-messages/outgoing-1/delivered"
        )
        assert json.loads(request.content) == {
            "lease_id": "lease-1",
            "provider_message_id": None,
            "sent_text": "private reply",
        }
        return httpx.Response(200, text="not JSON")

    assert (
        client_for(respond).acknowledge_delivery(
            "outgoing-1", "lease-1", None, "private reply"
        )
        is None
    )


@pytest.mark.parametrize("operation", ["followup", "claim", "delivered"])
def test_non_resolve_404_is_sanitized_error(operation: str) -> None:
    client = client_for(lambda request: httpx.Response(404, text="private reply"))

    with pytest.raises(BackendClientError) as caught:
        if operation == "followup":
            client.submit_followup("conversation-1", "message-1", "private reply")
        elif operation == "claim":
            client.claim_outgoing(1)
        else:
            client.acknowledge_delivery("outgoing-1", "lease-1", None, "private reply")

    assert "404" in str(caught.value)
    assert "private reply" not in str(caught.value)
    assert caught.value.__cause__ is None
    assert caught.value.__context__ is None


@pytest.mark.parametrize(
    "body",
    [
        "not JSON",
        "{}",
        '{"id":"conversation-1","channel":"imessage","external_id":42}',
    ],
)
def test_resolve_rejects_invalid_response_without_exposing_body(body: str) -> None:
    client = client_for(lambda request: httpx.Response(200, text=body + " private-key"))

    with pytest.raises(BackendClientError) as caught:
        client.resolve_conversation("imessage", "pho-user-1")

    assert "resolve_conversation" in str(caught.value)
    assert "private-key" not in str(caught.value)
    assert body not in str(caught.value)
    assert caught.value.__cause__ is None
    assert caught.value.__context__ is None


@pytest.mark.parametrize(
    "response",
    [
        {},
        [
            {
                "id": "outgoing-1",
                "lease_id": None,
                "conversation": {"channel": "imessage", "external_id": "pho-user-1"},
                "payload": {"reply_text": "private reply"},
            }
        ],
    ],
)
def test_claim_rejects_invalid_schema_without_exposing_body(response) -> None:
    client = client_for(lambda request: httpx.Response(200, json=response))

    with pytest.raises(BackendClientError) as caught:
        client.claim_outgoing(1)

    assert "claim_outgoing" in str(caught.value)
    assert "private reply" not in str(caught.value)
    assert caught.value.__cause__ is None
    assert caught.value.__context__ is None


def test_network_failure_does_not_expose_url_or_secret() -> None:
    def fail(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError(
            "private-key private reply https://secret.example/path", request=request
        )

    with pytest.raises(BackendClientError) as caught:
        client_for(fail).claim_outgoing(1)

    assert "claim_outgoing" in str(caught.value)
    assert "private-key" not in str(caught.value)
    assert "private reply" not in str(caught.value)
    assert "secret.example" not in str(caught.value)
    assert caught.value.__cause__ is None
    assert caught.value.__context__ is None
