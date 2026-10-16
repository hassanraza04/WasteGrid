# Photon Beta iMessage Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local Python process that receives fresh Photon Beta iMessage texts and sends a safe exact echo reply.

**Architecture:** The adapter stays inside the existing Python repository. A small domain layer filters Photon messages and prevents duplicate replies in a process. A Photon gateway wraps the generated Beta client and owns authentication plus request construction. A command module polls from its startup timestamp.

**Tech Stack:** Python 3.11+, `photonhq-api`, pytest, official Photon Beta API.

## Global Constraints

- Use Photon Beta only: `photonhq-api`, a `pho_prj_` project ID, and Bearer API-key authentication.
- Read `PHOTON_PROJECT_ID` and `PHOTON_API_KEY` only from the environment.
- Never log API keys or full contact handles.
- Reply only to iMessage messages whose status is `received` and whose text is non-empty.
- Derive the outbound idempotency key from the inbound Photon message ID.
- Keep the first slice independent of FastAPI, Chalk follow-up logic, and report persistence.

---

### Task 1: Configuration and message filtering

**Files:**
- Create: `api/__init__.py`
- Create: `api/messaging/__init__.py`
- Create: `api/messaging/config.py`
- Create: `api/messaging/messages.py`
- Test: `tests/messaging/test_config.py`
- Test: `tests/messaging/test_messages.py`

**Interfaces:**
- Produces `PhotonConfig`, `ConfigurationError`, `load_photon_config`, `InboundMessage`, and `extract_inbound_text`.
- Consumed by the gateway and agent tasks.

- [ ] **Step 1: Write failing configuration and filtering tests**

```python
def test_load_photon_config_requires_both_variables() -> None:
    with pytest.raises(ConfigurationError):
        load_photon_config({})

def test_extract_inbound_text_accepts_received_imessage_text() -> None:
    assert extract_inbound_text(message).text == "hello"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/messaging/test_config.py tests/messaging/test_messages.py -v`

Expected: import failure because the modules do not exist.

- [ ] **Step 3: Implement the minimal immutable configuration and filtering models**

Use dataclasses. Treat unknown, sent, non-iMessage, non-text, and whitespace-only inputs as `None`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/messaging/test_config.py tests/messaging/test_messages.py -v`

Expected: all tests pass.

### Task 2: Photon gateway and echo policy

**Files:**
- Create: `api/messaging/photon_gateway.py`
- Create: `api/messaging/echo_agent.py`
- Test: `tests/messaging/test_photon_gateway.py`
- Test: `tests/messaging/test_echo_agent.py`

**Interfaces:**
- Consumes `PhotonConfig` and `InboundMessage` from Task 1.
- Produces `PhotonGateway.list_new_messages(since)` and `PhotonGateway.send_reply(message, text)`.
- Produces `EchoAgent.process(messages)`.

- [ ] **Step 1: Write failing gateway and agent tests**

```python
def test_gateway_lists_received_imessage_messages_since_startup() -> None:
    gateway.list_new_messages(started_at)
    assert captured_query == {"platform": "imessage", "direction": "received"}

def test_echo_agent_replies_once_per_message() -> None:
    assert agent.process([message, message]) == [message.id]
    assert gateway.sent == [(message.id, "Photon Spectrum is connected. You said: hello")]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/messaging/test_photon_gateway.py tests/messaging/test_echo_agent.py -v`

Expected: import failure because the gateway and agent do not exist.

- [ ] **Step 3: Implement the Photon Beta client wrapper and exact echo policy**

Build generated `ListMessagesInput` requests with `platform="imessage"`, `direction="received"`, and UTC `created_since`. Build `SendMessageInput` with a plain text content payload, the inbound `receivedBy.id` agent sender and `space_id`, and a stable idempotency key. Do not set `parentMessageId`, because shared iMessage spaces reject threaded replies. Store handled IDs in the agent instance.

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/messaging/test_photon_gateway.py tests/messaging/test_echo_agent.py -v`

Expected: all tests pass.

### Task 3: Runnable polling command and local safety configuration

**Files:**
- Create: `api/messaging/run_imessage_agent.py`
- Create: `.env.example`
- Modify: `.gitignore`
- Test: `tests/messaging/test_run_imessage_agent.py`

**Interfaces:**
- Consumes `load_photon_config`, `PhotonGateway`, and `EchoAgent`.
- Produces `run_forever()` and a `python -m api.messaging.run_imessage_agent` entry point.

- [ ] **Step 1: Write a failing poll-loop test**

```python
def test_run_once_processes_only_messages_after_startup() -> None:
    run_once(gateway, agent, started_at)
    assert gateway.requested_since == started_at
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/messaging/test_run_imessage_agent.py -v`

Expected: import failure because the command does not exist.

- [ ] **Step 3: Implement one safe polling iteration and the command loop**

The command records startup time before polling, invokes `run_once`, sleeps for the configured interval, and exits cleanly on `KeyboardInterrupt`. `.env.example` contains only variable names and `.gitignore` ignores `.env`.

- [ ] **Step 4: Run tests and static checks**

Run: `uv run pytest tests/messaging -v --cov=api.messaging --cov-report=term-missing`

Run: `uv run mypy --strict api/messaging`

Expected: zero test failures and zero type errors.

### Task 4: Validate the live Photon connection

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes the runnable module and the user-managed local `.env`.
- Produces a concise setup and test command in the README.

- [ ] **Step 1: Document the exact local configuration and start command**

Document `PHOTON_PROJECT_ID`, `PHOTON_API_KEY`, `uv run python -m api.messaging.run_imessage_agent`, and the echo reply the user should expect. Do not write keys or phone numbers.

- [ ] **Step 2: Run a credential-presence check without printing credentials**

Run a Python process that loads configuration and prints only that both fields are configured.

- [ ] **Step 3: Start the agent after the user places their ignored `.env` file in the worktree**

Run: `uv run python -m api.messaging.run_imessage_agent`

Expected: startup log confirms it is polling Photon without credentials appearing.

- [ ] **Step 4: Ask the user to send one new iMessage**

Expected reply: `Photon Spectrum is connected. You said: <message>`.

## Self-review

- The plan stays within Photon Beta and does not use the stable Spectrum CLI.
- Each source module has direct unit tests before implementation.
- The first slice excludes report linking, Chalk calls, and dashboard work until shared contracts exist.
- No placeholder configuration values, credentials, or contact handles are committed.
