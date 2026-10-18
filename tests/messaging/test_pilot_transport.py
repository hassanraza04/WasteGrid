"""Pilot isolation, crash recovery and real SDK request-contract regressions."""

import json
from dataclasses import asdict, replace
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import httpx
import pytest
from photon_api import Photon
from photon_api.errors import ApiError
from photon_api.generated import models

from api.messaging.backend_client import BackendClientError
from api.messaging.config import (
    BackendConfig,
    ConfigurationError,
    PhotonConfig,
    load_photon_config,
)
from api.messaging.messages import PilotInboundMessage, extract_pilot_inbound
from api.messaging.photon_gateway import MessagePage, PhotonGateway, SubmissionReceipt
from api.messaging.pilot_backend_client import PilotBackendClient, PilotOutgoing
from api.messaging.pilot_coordinator import PilotCoordinator
from api.messaging.pilot_ledger import PilotLedger
from api.messaging.pilot_runner import run_pilot_once

NOW = datetime(2026, 10, 17, 20, tzinfo=UTC)


def configuration(tmp_path):
    return PhotonConfig(
        "project-1",
        "secret",
        BackendConfig("https://api.test", "integration", "agent-1", 10),
        2,
        tmp_path / "pilot.db",
        True,
        ("space-1",),
    )


def outgoing(**changes):
    return replace(
        PilotOutgoing(
            "out-1",
            "lease-1",
            "thread-1",
            "imessage",
            "space-1",
            "agent-1",
            "WG-AAA: Your report is received.",
            None,
            "claimed",
            1,
        ),
        **changes,
    )


def raw_message(identity="message-1", **changes):
    values = dict(
        id=identity,
        platform="imessage",
        status="received",
        projectId="project-1",
        receivedBy=SimpleNamespace(id="agent-1"),
        sentBy=SimpleNamespace(id="resident-1"),
        space=SimpleNamespace(id="space-1", kind="direct"),
        createdAt=NOW.isoformat(),
        content=SimpleNamespace(type="text", text="  status?  "),
    )
    values.update(changes)
    return SimpleNamespace(**values)


class Backend:
    def __init__(self):
        self.message = outgoing()
        self.state = "claimed"
        self.inbound, self.acknowledgements, self.failures, self.statuses = (
            [],
            [],
            [],
            [],
        )
        self.fail_ack = False
        self.fail_inbound = False

    def submit_pilot_inbound(self, message):
        if self.fail_inbound:
            raise BackendClientError("unavailable", status_code=503)
        self.inbound.append(message)

    def claim_pilot_outgoing(self):
        return [self.message] if self.state == "claimed" else []

    def mark_sending(self, message):
        if self.state != "claimed":
            raise BackendClientError("lease changed", status_code=409)
        self.state = "sending"
        return self.message

    def acknowledge_pilot_receipt(self, receipt):
        self.acknowledgements.append(receipt)
        if self.fail_ack:
            raise BackendClientError("unavailable", status_code=503)
        self.state = "submitted"

    def fail_pilot_outgoing(self, message, *, kind, retryable):
        self.failures.append((message.id, kind, retryable))
        self.state = kind

    def reconcile_pilot_status(self, *values):
        self.statuses.append(values)


class Gateway:
    def __init__(self):
        self.sent, self.pages, self.reads = [], [MessagePage([])], []
        self.error = None

    def send_to_space(self, **kwargs):
        self.sent.append(kwargs)
        if self.error:
            raise self.error
        return SubmissionReceipt("provider-1", "dispatched")

    def message_status(self, identity):
        return SubmissionReceipt(identity, "delivered")

    def list_message_page(self, since, before, token):
        self.reads.append((since, before, token))
        return self.pages.pop(0)


def test_pilot_inbound_requires_exact_project_agent_direct_allowlisted_space(tmp_path):
    config = configuration(tmp_path)

    def extract(raw):
        return extract_pilot_inbound(
            raw,
            project_id=config.project_id,
            agent_sender_id=config.backend.agent_sender_id,
            chat_ids=config.pilot_chat_ids,
        )

    result = extract(raw_message())
    assert result.peer_id == "resident-1" and result.text == "  status?  "
    for message in (
        raw_message(projectId="other-project"),
        raw_message(receivedBy=SimpleNamespace(id="other-agent")),
        raw_message(space=SimpleNamespace(id="space-2", kind="direct")),
        raw_message(space=SimpleNamespace(id="space-1", kind="group")),
        raw_message(createdAt="2026-10-17T20:00:00"),
        raw_message(createdAt="bad"),
        raw_message(sentBy=SimpleNamespace(id="")),
    ):
        assert extract(message) is None


def test_success_saves_actual_provider_receipt_before_backend_ack(tmp_path):
    config, backend, gateway = configuration(tmp_path), Backend(), Gateway()
    ledger = PilotLedger(config.delivery_db_path)
    coordinator = PilotCoordinator(backend, gateway, ledger, config)
    assert coordinator.dispatch_claimed() == ["out-1"]
    receipt = ledger.receipts()[0]
    assert receipt.acknowledged and receipt.provider_message_id == "provider-1"
    assert receipt.provider_status == "dispatched"
    assert receipt.sent_text == backend.message.text
    assert gateway.sent[0]["idempotency_key"] == "out-1"
    assert backend.acknowledgements[0].acknowledged is False


def test_lost_ack_recovers_after_process_restart_without_resending(tmp_path):
    config, backend, first = configuration(tmp_path), Backend(), Gateway()
    backend.fail_ack = True
    PilotCoordinator(
        backend, first, PilotLedger(config.delivery_db_path), config
    ).dispatch_claimed()
    assert len(first.sent) == 1
    backend.fail_ack, backend.state = False, "unknown"
    restarted = Gateway()
    ledger = PilotLedger(config.delivery_db_path)
    PilotCoordinator(backend, restarted, ledger, config).dispatch_claimed()
    assert restarted.sent == []
    assert backend.state == "submitted" and ledger.receipts()[0].acknowledged
    assert {item.lease_id for item in backend.acknowledgements} == {"lease-1"}


def test_uncertain_network_submission_is_unknown_and_never_resent(tmp_path, caplog):
    config, backend, gateway = configuration(tmp_path), Backend(), Gateway()
    gateway.error = TimeoutError("private body https://signed.test/?secret=secret")
    coordinator = PilotCoordinator(
        backend, gateway, PilotLedger(config.delivery_db_path), config
    )
    assert coordinator.dispatch_claimed() == []
    assert backend.failures == [("out-1", "unknown", False)]
    assert coordinator.dispatch_claimed() == [] and len(gateway.sent) == 1
    assert not backend.acknowledgements
    assert "private body" not in caplog.text and "signed.test" not in caplog.text


@pytest.mark.parametrize(
    ("status", "kind", "retryable"),
    [
        (429, "rejected", True),
        (422, "rejected", False),
        (408, "unknown", False),
        (503, "unknown", False),
    ],
)
def test_provider_definite_rejection_is_separate_from_unknown(
    tmp_path, status, kind, retryable
):
    config, backend, gateway = configuration(tmp_path), Backend(), Gateway()
    gateway.error = ApiError(
        "redacted",
        status=status,
        headers={},
        body=None,
        raw_body="",
        operation_id="sendMessage",
        request_id=None,
    )
    PilotCoordinator(
        backend, gateway, PilotLedger(config.delivery_db_path), config
    ).dispatch_claimed()
    assert backend.failures == [("out-1", kind, retryable)]


def test_consent_failure_blocks_provider_contact(tmp_path):
    config, backend, gateway = configuration(tmp_path), Backend(), Gateway()

    def revoked(message):
        raise BackendClientError("consent changed", status_code=409)

    backend.mark_sending = revoked
    assert (
        PilotCoordinator(
            backend, gateway, PilotLedger(config.delivery_db_path), config
        ).dispatch_claimed()
        == []
    )
    assert gateway.sent == []


@pytest.mark.parametrize(
    "changes", [{"external_id": "other-chat"}, {"sender_id": "other-agent"}]
)
def test_destination_allowlist_is_checked_before_provider_contact(tmp_path, changes):
    config, backend, gateway = configuration(tmp_path), Backend(), Gateway()
    backend.message = outgoing(**changes)
    PilotCoordinator(
        backend, gateway, PilotLedger(config.delivery_db_path), config
    ).dispatch_claimed()
    assert gateway.sent == [] and backend.failures == [("out-1", "rejected", False)]


def test_status_updates_do_not_repeat_provider_submission(tmp_path):
    config, backend, gateway = configuration(tmp_path), Backend(), Gateway()
    ledger = PilotLedger(config.delivery_db_path)
    coordinator = PilotCoordinator(backend, gateway, ledger, config)
    coordinator.dispatch_claimed()
    coordinator.reconcile(NOW)
    coordinator.reconcile(NOW + timedelta(seconds=1))
    assert backend.statuses == [("out-1", "provider-1", "delivered")]
    assert len(gateway.sent) == 1 and ledger.receipts()[0].latest_status == "delivered"


@pytest.mark.parametrize("initial_status", ["dispatched", "accepted"])
def test_terminal_acceptance_stops_status_polling_without_claiming_delivery(
    tmp_path, initial_status
):
    config, backend, gateway = configuration(tmp_path), Backend(), Gateway()
    ledger = PilotLedger(config.delivery_db_path)
    original_send, status_reads = gateway.send_to_space, []

    def submit(**values):
        receipt = original_send(**values)
        return replace(receipt, provider_status=initial_status)

    def status(identity):
        status_reads.append(identity)
        return SubmissionReceipt(identity, "accepted")

    gateway.send_to_space, gateway.message_status = submit, status
    coordinator = PilotCoordinator(backend, gateway, ledger, config)
    coordinator.dispatch_claimed()
    coordinator.reconcile(NOW)
    restarted = PilotCoordinator(
        backend, gateway, PilotLedger(config.delivery_db_path), config
    )
    restarted.reconcile(NOW + timedelta(minutes=5))
    # Even a stale backend reconciliation claim cannot restart terminal polling.
    backend.state = "claimed"
    backend.message = outgoing(
        provider_message_id="provider-1", status="submitted", lease_id=None
    )
    restarted.dispatch_claimed()
    assert status_reads == (["provider-1"] if initial_status == "dispatched" else [])
    receipt = ledger.receipts()[0]
    assert receipt.latest_status == "accepted" and receipt.acknowledged
    assert receipt.latest_status != "delivered"
    assert not any(value[-1] == "delivered" for value in backend.statuses)
    assert len(gateway.sent) == 1


def test_backend_provider_identity_is_reconciled_even_without_local_receipt(tmp_path):
    config, backend, gateway = configuration(tmp_path), Backend(), Gateway()
    backend.message = outgoing(
        provider_message_id="existing-provider-id", status="submitted", lease_id=None
    )
    PilotCoordinator(
        backend, gateway, PilotLedger(config.delivery_db_path), config
    ).dispatch_claimed()
    assert gateway.sent == []
    assert backend.statuses == [("out-1", "existing-provider-id", "delivered")]


def test_http_claim_accepts_no_lease_only_for_an_existing_provider_submission(tmp_path):
    config = configuration(tmp_path)
    payload = asdict(
        outgoing(
            provider_message_id="known-provider", lease_id=None, status="submitted"
        )
    )
    client = PilotBackendClient(
        config.backend,
        transport=httpx.MockTransport(
            lambda request: httpx.Response(200, json=[payload])
        ),
    )
    assert client.claim_pilot_outgoing()[0].provider_message_id == "known-provider"
    payload["provider_message_id"] = None
    with pytest.raises(BackendClientError, match="schema"):
        client.claim_pilot_outgoing()


def test_all_pages_including_empty_continuation_are_processed_before_sends(tmp_path):
    config, backend, gateway = configuration(tmp_path), Backend(), Gateway()
    gateway.pages = [
        MessagePage([raw_message(str(i)) for i in range(100)], "page-2"),
        MessagePage([], "page-3"),
        MessagePage([raw_message("message-101")]),
    ]

    def submit(message):
        assert gateway.sent == []
        backend.inbound.append(message)

    backend.submit_pilot_inbound = submit
    accepted = run_pilot_once(
        gateway,
        PilotCoordinator(
            backend, gateway, PilotLedger(config.delivery_db_path), config
        ),
        PilotLedger(config.delivery_db_path),
        config,
        NOW,
    )
    assert len(accepted) == 101
    assert [item[2] for item in gateway.reads] == [None, "page-2", "page-3"]
    assert len(gateway.sent) == 1


def test_failed_page_restarts_from_durable_cursor_with_same_window(tmp_path):
    config, backend, gateway = configuration(tmp_path), Backend(), Gateway()
    ledger = PilotLedger(config.delivery_db_path)
    window = ledger.scan_window(NOW)
    ledger.page_processed(window, "page-2")
    gateway.pages = [MessagePage([raw_message()])]
    backend.fail_inbound = True
    with pytest.raises(BackendClientError):
        run_pilot_once(
            gateway,
            PilotCoordinator(backend, gateway, ledger, config),
            ledger,
            config,
            NOW + timedelta(minutes=2),
        )
    restored = PilotLedger(config.delivery_db_path).scan_window(
        NOW + timedelta(minutes=3)
    )
    assert restored.page_token == "page-2" and restored.before == NOW
    assert restored.since == NOW


def test_overlap_and_periodic_reconciliation_return_to_activation(tmp_path):
    ledger = PilotLedger(tmp_path / "pilot.db")
    start = ledger.scan_window(NOW)
    ledger.page_processed(start, None)
    ten = ledger.scan_window(NOW + timedelta(minutes=10))
    assert ten.since == NOW and not ten.reconciliation
    ledger.page_processed(ten, None)
    eleven = ledger.scan_window(NOW + timedelta(minutes=11))
    assert eleven.since == NOW + timedelta(minutes=5)
    ledger.page_processed(eleven, None)
    full = PilotLedger(ledger.path).scan_window(NOW + timedelta(minutes=16))
    assert full.reconciliation and full.since == NOW


def test_pilot_backend_http_contract_preserves_integration_header_and_receipt(tmp_path):
    requests = []

    def transport(request):
        requests.append(
            (
                request.url.path,
                request.headers["X-Integration-Key"],
                json.loads(request.content),
            )
        )
        if request.url.path.endswith("/claim"):
            return httpx.Response(200, json=[asdict(outgoing())])
        if request.url.path.endswith("/sending"):
            return httpx.Response(200, json=asdict(outgoing(status="sending")))
        return httpx.Response(200, json={"id": "inbox-1", "status": "queued"})

    config = configuration(tmp_path)
    client = PilotBackendClient(
        config.backend, transport=httpx.MockTransport(transport)
    )
    message = PilotInboundMessage(
        "project-1",
        "agent-1",
        "space-1",
        "provider-in",
        "status?",
        NOW.isoformat(),
        "peer-1",
        "direct",
    )
    client.submit_pilot_inbound(message)
    item = client.claim_pilot_outgoing()[0]
    assert client.mark_sending(item).status == "sending"
    ledger = PilotLedger(config.delivery_db_path)
    ledger.record_receipt(
        item.id, item.lease_id, "provider-out", "dispatched", item.text
    )
    client.acknowledge_pilot_receipt(ledger.receipts()[0])
    client.fail_pilot_outgoing(item, kind="unknown", retryable=False)
    client.reconcile_pilot_status(item.id, "provider-out", "delivered")
    assert all(key == "integration" for _, key, _ in requests)
    assert requests[0][2] == asdict(message)
    assert requests[3][2] == {
        "lease_id": "lease-1",
        "provider_message_id": "provider-out",
        "provider_status": "dispatched",
        "sent_text": item.text,
    }


def test_sdk_paging_contract_carries_window_and_real_submission_identity(tmp_path):
    pages = [
        SimpleNamespace(items=list(range(100)), nextPageToken="second"),
        SimpleNamespace(items=[], nextPageToken="third"),
        SimpleNamespace(items=[100]),
    ]
    inputs = []

    def listing(request):
        inputs.append(request)
        return pages.pop(0)

    client = SimpleNamespace(
        projects=SimpleNamespace(
            list_messages=listing,
            send_message=lambda request: SimpleNamespace(
                root=SimpleNamespace(
                    root=SimpleNamespace(id="real-id", status="dispatched")
                )
            ),
            get_message=lambda request: SimpleNamespace(
                root=SimpleNamespace(id=request.path.message_id, status="delivered")
            ),
        )
    )
    gateway = PhotonGateway(configuration(tmp_path), client=client)
    assert len(gateway.list_new_messages(NOW)) == 101
    assert [getattr(item.query, "page_token") for item in inputs[1:]] == [
        "second",
        "third",
    ]
    receipt = gateway.send_to_space(
        space_id="space-1", sender_id="agent-1", text="reply", idempotency_key="out-1"
    )
    assert receipt == SubmissionReceipt("real-id", "dispatched")
    assert gateway.message_status("real-id") == SubmissionReceipt(
        "real-id", "delivered"
    )


def test_pilot_configuration_is_closed_by_default_and_bounds_chat_allowlist():
    env = dict(
        PHOTON_PROJECT_ID="project",
        PHOTON_API_KEY="secret",
        WASTEGRID_BACKEND_URL="https://api.test",
        WASTEGRID_MESSAGING_API_KEY="integration",
        PHOTON_AGENT_SENDER_ID="agent",
    )
    assert not load_photon_config(env).pilot_enabled
    enabled = dict(
        env, MESSAGING_PILOT_ENABLED="true", MESSAGING_PILOT_CHAT_IDS='["space-1"]'
    )
    assert load_photon_config(enabled).pilot_chat_ids == ("space-1",)
    for chats in ('["first","second"]', "[1]", "{}", "bad"):
        with pytest.raises(ConfigurationError, match="MESSAGING_PILOT_CHAT_IDS"):
            load_photon_config(dict(enabled, MESSAGING_PILOT_CHAT_IDS=chats))


def test_receipt_payload_is_immutable(tmp_path):
    ledger = PilotLedger(tmp_path / "pilot.db")
    ledger.record_receipt("out", "lease", "provider", "dispatched", "Original")
    with pytest.raises(ValueError, match="changed"):
        ledger.record_receipt("out", "lease", "provider", "dispatched", "Changed")
    assert ledger.receipts()[0].sent_text == "Original"


def test_expired_page_token_restarts_same_window_not_a_new_checkpoint(tmp_path):
    config, backend, gateway = configuration(tmp_path), Backend(), Gateway()
    ledger = PilotLedger(config.delivery_db_path)
    window = ledger.scan_window(NOW)
    ledger.page_processed(window, "expired")

    def expired(since, before, token):
        raise ApiError(
            "redacted",
            status=410,
            headers={},
            body=None,
            raw_body="",
            operation_id="listMessages",
            request_id=None,
        )

    gateway.list_message_page = expired
    with pytest.raises(ApiError):
        run_pilot_once(
            gateway,
            PilotCoordinator(backend, gateway, ledger, config),
            ledger,
            config,
            NOW + timedelta(minutes=4),
        )
    retry = ledger.scan_window(NOW + timedelta(minutes=5))
    assert (
        retry.page_token is None
        and retry.since == window.since
        and retry.before == window.before
    )
    assert not gateway.sent


def test_pilot_disabled_or_empty_allowlist_never_contacts_provider(tmp_path):
    config, backend, gateway = configuration(tmp_path), Backend(), Gateway()
    ledger = PilotLedger(config.delivery_db_path)
    for blocked in (
        replace(config, pilot_enabled=False),
        replace(config, pilot_chat_ids=()),
    ):
        assert (
            run_pilot_once(
                gateway,
                PilotCoordinator(backend, gateway, ledger, blocked),
                ledger,
                blocked,
                NOW,
            )
            == []
        )
    assert not gateway.reads and not gateway.sent


def test_sdk_automatic_send_retries_are_disabled(tmp_path, monkeypatch):
    from api.messaging import photon_gateway

    options = []
    monkeypatch.setattr(
        photon_gateway, "Photon", lambda **kwargs: options.append(kwargs) or object()
    )
    PhotonGateway(configuration(tmp_path))
    assert options[0]["timeout"] == 10 and options[0]["max_attempts"] == 1


def test_state_file_cannot_reuse_receipts_for_another_provider_project(tmp_path):
    config = configuration(tmp_path)
    PilotCoordinator(Backend(), Gateway(), PilotLedger(config.delivery_db_path), config)
    with pytest.raises(ValueError, match="different project"):
        PilotCoordinator(
            Backend(),
            Gateway(),
            PilotLedger(config.delivery_db_path),
            replace(config, project_id="another-project"),
        )


def sdk_message_payload(status="received"):
    """Use complete wire payloads, validated by the installed generated SDK."""
    stamp = NOW.isoformat().replace("+00:00", "Z")

    def user(identity, kind, handle):
        return {
            "id": identity,
            "platform": "imessage",
            "projectId": "project-1",
            "kind": kind,
            "handle": handle,
            "metadata": {},
            "details": {},
        }

    agent = user("agent-1", "agent", "+15555550124")
    peer = user("resident-1", "human", "+15555550123")
    timestamps = {status + "At": stamp}
    if status != "received":
        timestamps["dispatchedAt"] = stamp
    payload = {
        "id": "sdk-inbound" if status == "received" else "sdk-outbound",
        "platform": "imessage",
        "projectId": "project-1",
        "status": status,
        "metadata": {},
        "createdAt": stamp,
        "updatedAt": stamp,
        "timestamps": timestamps,
        "content": {"type": "text", "format": "plain", "text": "  Keep exact text.\n"},
        "sentBy": peer if status == "received" else agent,
        "receivedBy": agent,
        "space": {
            "id": "space-1",
            "platform": "imessage",
            "projectId": "project-1",
            "kind": "direct",
            "metadata": {},
            "details": {},
            "participantIds": ["agent-1", "resident-1"],
        },
    }
    if status == "accepted":
        payload["acceptance"] = {
            "code": "delivery_confirmation_unavailable",
            "message": "Recipient delivery confirmation is unavailable.",
        }
    elif status == "failed":
        payload["failure"] = {
            "code": "message_delivery_failed",
            "message": "Provider reported delivery failure.",
        }
    return payload


def test_installed_sdk_decodes_received_root_models_and_private_peer_identity(tmp_path):
    config = configuration(tmp_path)
    wire = sdk_message_payload()
    with httpx.Client(
        transport=httpx.MockTransport(
            lambda request: httpx.Response(200, json={"items": [wire]})
        )
    ) as http:
        with Photon(client=http, timeout=10, max_attempts=1) as sdk:
            page = PhotonGateway(config, client=sdk).list_message_page(NOW)
    event = page.items[0]
    assert isinstance(event, models.PlatformMessage)
    assert isinstance(event.root, models.Message)
    concrete = event.root.root
    assert isinstance(concrete, models.ReceivedImessageMessage)
    assert isinstance(concrete.receivedBy, models.UserSnapshot)
    assert isinstance(concrete.space, models.SpaceSnapshot)
    inbound = extract_pilot_inbound(
        event,
        project_id=config.project_id,
        agent_sender_id=config.backend.agent_sender_id,
        chat_ids=config.pilot_chat_ids,
    )
    assert inbound == PilotInboundMessage(
        "project-1",
        "agent-1",
        "space-1",
        "sdk-inbound",
        wire["content"]["text"],
        wire["createdAt"],
        "resident-1",
        "direct",
    )
    # Generated User and PlatformUser add two more real root wrappers.
    agent = models.PlatformUser.model_validate(
        {
            **wire["receivedBy"],
            "createdAt": wire["createdAt"],
            "updatedAt": wire["updatedAt"],
        }
    )
    assert isinstance(agent.root, models.User)
    concrete.receivedBy = agent
    assert (
        extract_pilot_inbound(
            event,
            project_id=config.project_id,
            agent_sender_id=config.backend.agent_sender_id,
            chat_ids=config.pilot_chat_ids,
        )
        == inbound
    )
    concrete.space.root.kind = "group"
    assert (
        extract_pilot_inbound(
            event,
            project_id=config.project_id,
            agent_sender_id=config.backend.agent_sender_id,
            chat_ids=config.pilot_chat_ids,
        )
        is None
    )


@pytest.mark.parametrize("status", ["dispatched", "accepted", "delivered", "failed"])
def test_installed_sdk_send_and_status_root_models_preserve_provider_receipt(
    tmp_path, status
):
    observed = []
    wire = sdk_message_payload(status)

    def transport(request):
        observed.append(request)
        return httpx.Response(202 if request.method == "POST" else 200, json=wire)

    with httpx.Client(transport=httpx.MockTransport(transport)) as http:
        with Photon(client=http, timeout=10, max_attempts=1) as sdk:
            gateway = PhotonGateway(configuration(tmp_path), client=sdk)
            receipt = gateway.send_to_space(
                space_id="space-1",
                sender_id="agent-1",
                text=wire["content"]["text"],
                idempotency_key="immutable-outgoing-uuid",
            )
            assert receipt == SubmissionReceipt("sdk-outbound", status)
            assert gateway.message_status("sdk-outbound") == receipt
    assert observed[0].headers["Idempotency-Key"] == "immutable-outgoing-uuid"
    assert json.loads(observed[0].content)["content"]["text"] == wire["content"]["text"]
    assert observed[1].url.path.endswith("/messages/sdk-outbound")
