# Photon Backend Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route Photon follow-ups and replies through the proposed WasteGrid backend while it owns message idempotency, leases, and delivery acknowledgements.

**Architecture:** A narrow synchronous `httpx` client implements four documented internal endpoints. A backend coordinator translates Photon input to backend follow-ups and claimed backend replies to Photon sends. SQLite remains only as a poll checkpoint, not a reply/retry queue.

**Tech Stack:** Python 3.13, `httpx`, pytest, Photon Beta API, SQLite checkpoint.

## Global Constraints

- Require `WASTEGRID_BACKEND_URL`, `WASTEGRID_MESSAGING_API_KEY`, and `PHOTON_AGENT_SENDER_ID` before polling starts. No local echo fallback.
- The backend URL must be an absolute `http` or `https` URL with no credentials, query, or fragment.
- Send Person 4 backend messaging requests with `X-Integration-Key: <messaging key>` and bounded timeouts. Photon API requests separately use `Authorization: Bearer <Photon API key>`.
- Do not log credentials, message text, response bodies, or signed URLs.
- The backend owns outgoing retries, leases, and delivery state. `DeliveryLedger` stores only the polling checkpoint in backend mode.
- Preserve the Photon gateway as the only Photon SDK boundary and use fake transports only in tests.

---

### Task 1: Make backend-mode configuration mandatory

**Files:**
- Modify: `pyproject.toml:7-13`
- Modify: `uv.lock`
- Modify: `api/messaging/config.py:1-57`
- Modify: `tests/messaging/test_config.py`

**Interfaces:**
- Produces `BackendConfig(base_url: str, messaging_api_key: str, agent_sender_id: str, timeout_seconds: float)`.
- Extends `PhotonConfig` with `backend: BackendConfig`.

- [ ] **Step 1: Write failing tests**

```python
def test_load_photon_config_requires_backend_credentials() -> None:
    with pytest.raises(ConfigurationError, match="WASTEGRID_BACKEND_URL"):
        load_photon_config({"PHOTON_PROJECT_ID": "pho_prj_test", "PHOTON_API_KEY": "pho_sk_test"})


def test_load_photon_config_rejects_unsafe_backend_url() -> None:
    with pytest.raises(ConfigurationError, match="WASTEGRID_BACKEND_URL"):
        load_photon_config({
            "PHOTON_PROJECT_ID": "pho_prj_test", "PHOTON_API_KEY": "pho_sk_test",
            "WASTEGRID_BACKEND_URL": "https://key@example.test/api?secret=yes",
            "WASTEGRID_MESSAGING_API_KEY": "backend-key",
            "PHOTON_AGENT_SENDER_ID": "pho_usr_agent",
        })
```

- [ ] **Step 2: Verify red**

Run: `uv run pytest -q tests/messaging/test_config.py`

Expected: FAIL because backend configuration is currently absent.

- [ ] **Step 3: Add minimal configuration**

Add `"httpx>=0.28,<1"` to `[project].dependencies` and run `uv lock`. Add:

```python
@dataclass(frozen=True)
class BackendConfig:
    base_url: str
    messaging_api_key: str
    agent_sender_id: str
    timeout_seconds: float
```

Use `urllib.parse.urlsplit` to validate the required backend URL. Read the two other required strings and a positive `WASTEGRID_TIMEOUT_SECONDS` defaulting to `10`. Return the new config in `PhotonConfig`.

- [ ] **Step 4: Verify green**

Run: `uv run pytest -q tests/messaging/test_config.py`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add pyproject.toml uv.lock api/messaging/config.py tests/messaging/test_config.py
git commit -m "feat: require Photon backend configuration"
```

### Task 2: Build a narrow WasteGrid HTTP client

**Files:**
- Create: `api/messaging/backend_client.py`
- Create: `tests/messaging/test_backend_client.py`

**Interfaces:**
- Consumes `BackendConfig`.
- Produces `WasteGridBackendClient` with `resolve_conversation`, `submit_followup`, `claim_outgoing`, and `acknowledge_delivery` methods.

- [ ] **Step 1: Write failing HTTP-boundary tests**

```python
def test_submit_followup_preserves_photon_message_id() -> None:
    client, requests = client_with_recording_transport()
    client.submit_followup(conversation_id="11111111-1111-1111-1111-111111111111", message_id="pho_msg_1", text="Please send an update")
    request = requests[-1]
    assert request.headers["X-Integration-Key"] == "backend-key"
    assert request.url.path.endswith("/followup")
    assert json.loads(request.content) == {"message_id": "pho_msg_1", "text": "Please send an update"}


def test_resolve_conversation_returns_none_for_an_unlinked_sender() -> None:
    client = client_returning(404, {"detail": "Conversation not linked"})
    assert client.resolve_conversation(channel="imessage", external_id="pho_spc_1") is None
```

- [ ] **Step 2: Verify red**

Run: `uv run pytest -q tests/messaging/test_backend_client.py`

Expected: FAIL because `backend_client` does not exist.

- [ ] **Step 3: Implement only the documented contract**

Create frozen `Conversation(id, channel, external_id)` and `ClaimedOutgoingMessage(id, lease_id, channel, external_id, text)` dataclasses. Implement these exact operations:

```python
def resolve_conversation(self, *, channel: str, external_id: str) -> Conversation | None: ...
def submit_followup(self, *, conversation_id: str, message_id: str, text: str) -> None: ...
def claim_outgoing(self, *, limit: int) -> list[ClaimedOutgoingMessage]: ...
def acknowledge_delivery(self, *, message_id: str, lease_id: str,
                         provider_message_id: str | None, sent_text: str) -> None: ...
```

Use one private `httpx.Client` request helper. Map only a 404 resolve result to `None`; all malformed or other failed responses raise a sanitized `BackendClientError` that retains operation/status, never response text. Parse only contract fields and `payload.reply_text`.

- [ ] **Step 4: Verify green**

Run: `uv run pytest -q tests/messaging/test_backend_client.py`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add api/messaging/backend_client.py tests/messaging/test_backend_client.py
git commit -m "feat: add WasteGrid messaging client"
```

### Task 3: Expose an explicit Photon route sender

**Files:**
- Modify: `api/messaging/photon_gateway.py:35-54`
- Modify: `tests/messaging/test_photon_gateway.py`

**Interfaces:**
- Produces:

```python
def send_to_space(self, *, space_id: str, sender_id: str, text: str, idempotency_key: str) -> None: ...
```

- [ ] **Step 1: Write the failing Photon route test**

```python
def test_send_to_space_uses_backend_message_idempotency_key() -> None:
    gateway, client = gateway_with_fake_client()
    gateway.send_to_space(space_id="pho_spc_1", sender_id="pho_usr_agent", text="Your report is in review.", idempotency_key="wastegrid-outgoing-123")
    assert client.projects.sent.headers.idempotency_key == "wastegrid-outgoing-123"
    assert client.projects.sent.body.senderId == "pho_usr_agent"
    assert client.projects.sent.body.spaceId == "pho_spc_1"
```

- [ ] **Step 2: Verify red**

Run: `uv run pytest -q tests/messaging/test_photon_gateway.py`

Expected: FAIL because `send_to_space` does not exist.

- [ ] **Step 3: Implement the route method**

Implement `send_to_space` with the current generated Photon request classes. Keep `send_reply` as a compatibility wrapper that passes the inbound message's route plus `wastegrid-reply-<message id>`.

- [ ] **Step 4: Verify green and commit**

Run: `uv run pytest -q tests/messaging/test_photon_gateway.py`

Expected: PASS.

```bash
git add api/messaging/photon_gateway.py tests/messaging/test_photon_gateway.py
git commit -m "feat: route Photon replies by space"
```

### Task 4: Make the backend coordinator own delivery flow

**Files:**
- Create: `api/messaging/backend_coordinator.py`
- Create: `tests/messaging/test_backend_coordinator.py`
- Modify: `api/messaging/run_imessage_agent.py:1-67`
- Modify: `tests/messaging/test_run_imessage_agent.py`

**Interfaces:**
- Consumes `WasteGridBackendClient`, `PhotonGateway.send_to_space`, and `InboundMessage`.
- Produces `BackendMessagingCoordinator.submit_inbound(message) -> bool` and `dispatch_claimed(limit: int = 20) -> list[str]`.

- [ ] **Step 1: Write failing coordinator tests**

```python
def test_unlinked_sender_is_skipped_without_followup(caplog) -> None:
    backend = FakeBackend(conversation=None)
    coordinator = BackendMessagingCoordinator(backend, FakePhoton(), "pho_usr_agent")
    assert coordinator.submit_inbound(inbound("pho_msg_1")) is False
    assert backend.followups == []
    assert "pho_msg_1" in caplog.text
    assert "resident text" not in caplog.text


def test_failed_photon_send_does_not_acknowledge_backend_lease() -> None:
    backend = FakeBackend(outgoing=[claimed_reply()])
    coordinator = BackendMessagingCoordinator(backend, FakePhoton(fail_send=True), "pho_usr_agent")
    assert coordinator.dispatch_claimed() == []
    assert backend.acknowledgements == []
```

- [ ] **Step 2: Verify red**

Run: `uv run pytest -q tests/messaging/test_backend_coordinator.py`

Expected: FAIL because `BackendMessagingCoordinator` does not exist.

- [ ] **Step 3: Implement backend-owned flow**

`submit_inbound` resolves `channel="imessage"`, `external_id=message.space_id`, then sends the unchanged Photon message ID and text only when linked. `dispatch_claimed` skips non-iMessage and blank-text claims. For eligible claims it calls:

```python
sender.send_to_space(
    space_id=claim.external_id,
    sender_id=self._agent_sender_id,
    text=claim.text,
    idempotency_key=claim.id,
)
backend.acknowledge_delivery(
    message_id=claim.id,
    lease_id=claim.lease_id,
    provider_message_id=None,
    sent_text=claim.text,
)
```

Photon currently returns no provider message ID. The backend accepts
`provider_message_id=None`; do not substitute a Photon idempotency key for it.

Catch only operational errors, logging class/name and stable message IDs. Never acknowledge after a Photon send error.

- [ ] **Step 4: Replace the production echo path**

Change `run_once` to accept `BackendMessagingCoordinator`. Keep `DeliveryLedger` only for `checkpoint_or_initialize` and `advance_checkpoint`. Call `dispatch_claimed()` before Photon fetch, submit all extracted inbound messages, advance the checkpoint after successful fetch processing, then call `dispatch_claimed()` again. In `run_forever`, build `WasteGridBackendClient(config.backend)` and the coordinator; remove `SmokeTestReplyPolicy` and local reply queue usage.

- [ ] **Step 5: Verify green and commit**

Run:

```bash
uv run pytest -q tests/messaging/test_backend_coordinator.py tests/messaging/test_run_imessage_agent.py
```

Expected: PASS, including no delivery acknowledgement after a send failure.

```bash
git add api/messaging/backend_coordinator.py api/messaging/run_imessage_agent.py \
  tests/messaging/test_backend_coordinator.py tests/messaging/test_run_imessage_agent.py
git commit -m "feat: route Photon delivery through backend"
```

### Task 5: Document backend mode and complete verification

**Files:**
- Modify: `.env.example`
- Modify: `README.md:3-26`
- Modify: `tests/messaging/test_config.py`

**Interfaces:**
- Documents the required runtime settings, backend retry ownership, and absence of a local echo fallback.

- [ ] **Step 1: Write the failing documentation assertion**

```python
def test_env_example_lists_required_backend_mode_settings() -> None:
    example = Path(".env.example").read_text()
    assert "WASTEGRID_BACKEND_URL=" in example
    assert "WASTEGRID_MESSAGING_API_KEY=" in example
    assert "PHOTON_AGENT_SENDER_ID=" in example
```

- [ ] **Step 2: Verify red**

Run: `uv run pytest -q tests/messaging/test_config.py`

Expected: FAIL until backend-mode settings are documented.

- [ ] **Step 3: Update documentation**

Add the three setting names to `.env.example`. Update README setup to state that the agent requires a reachable WasteGrid backend before polling, the backend owns follow-up/delivery retries, and SQLite stores only the polling checkpoint in this mode.

- [ ] **Step 4: Run full verification**

Run:

```bash
uv run black --check api tests
uv run isort --check-only api tests
uv run mypy --strict api/messaging
uv run pytest -q
uv run pip-audit --ignore-vuln PYSEC-2026-2275
```

Expected: all commands pass and only the documented Python audit exception is ignored.

- [ ] **Step 5: Commit**

```bash
git add .env.example README.md tests/messaging/test_config.py
git commit -m "docs: explain Photon backend mode"
```
