# Photon Delivery Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Photon polling restart-safe with a SQLite checkpoint, inbox, and reply outbox.

**Architecture:** `DeliveryLedger` persists transport state only. `DeliveryCoordinator` records a reply before sending it and later retries it with Photon’s existing idempotency key. `ReplyPolicy` supplies text and is the future Person 3 integration boundary.

**Tech Stack:** Python 3.11+, standard-library `sqlite3`, pytest, and the existing Photon client.

## Global Constraints

- Do not persist reports, customers, organizers, report associations, or LLM output other than the queued reply text required for retry.
- Add no dependency. Use UTC-aware datetimes and ISO-8601 storage.
- Log only message IDs, state, and attempt counts. Never log bodies or secrets.
- Default `PHOTON_DELIVERY_DB_PATH` to `.data/photon-delivery.db` and ignore `.data/`.
- Retry after 5 seconds and 10 seconds. Mark the third failure as terminal `failed`.

## Files

- `.gitignore`: exclude `.data/`.
- `api/messaging/config.py`: add `delivery_db_path: Path`.
- `api/messaging/delivery_ledger.py`: create local SQLite persistence.
- `api/messaging/reply_policy.py`: create `ReplyPolicy` and `SmokeTestReplyPolicy`.
- `api/messaging/delivery_coordinator.py`: create queueing and retry orchestration.
- `api/messaging/run_imessage_agent.py`: wire durable polling.
- `tests/messaging/test_delivery_ledger.py`: persistence and state transitions.
- `tests/messaging/test_reply_policy.py`: current smoke-reply compatibility.
- `tests/messaging/test_delivery_coordinator.py`: queue and retry behavior.
- `tests/messaging/test_config.py`, `tests/messaging/test_run_imessage_agent.py`, and `README.md`: configuration, restart behavior, and documentation.

## Interfaces

```python
@dataclass(frozen=True)
class OutboundReply:
    message: InboundMessage
    text: str
    attempt_count: int

class DeliveryLedger:
    def checkpoint_or_initialize(self, now: datetime) -> datetime: ...
    def enqueue_reply(self, message: InboundMessage, text: str, now: datetime) -> bool: ...
    def advance_checkpoint(self, checkpoint: datetime) -> None: ...
    def due_replies(self, now: datetime) -> list[OutboundReply]: ...
    def mark_sent(self, message_id: str, now: datetime) -> None: ...
    def mark_send_failed(self, message_id: str, now: datetime, error: Exception) -> str: ...

class ReplyPolicy(Protocol):
    def reply_for(self, message: InboundMessage) -> str: ...
```

### Task 1: Configuration

**Files:** `.gitignore`, `api/messaging/config.py`, `tests/messaging/test_config.py`, `README.md`.

- [ ] Write failing tests that assert `load_photon_config()` returns `Path(".data/photon-delivery.db")` by default and respects `PHOTON_DELIVERY_DB_PATH=/tmp/ledger.db`.
- [ ] Run `uv run pytest tests/messaging/test_config.py -q`; expect failure because `delivery_db_path` is absent.
- [ ] Add `delivery_db_path: Path` to `PhotonConfig` and parse `Path(environ.get("PHOTON_DELIVERY_DB_PATH", ".data/photon-delivery.db")).expanduser()`. Update every direct `PhotonConfig(...)` fixture in `tests/messaging/test_photon_gateway.py` and `tests/messaging/test_run_imessage_agent.py` to pass `Path(".data/test-delivery.db")`.
- [ ] Add `.data/` to `.gitignore`. Document it as a local retry spool, not the shared report database.
- [ ] Run `uv run pytest tests/messaging/test_config.py -q`; expect pass.
- [ ] Commit with `git add .gitignore README.md api/messaging/config.py tests/messaging/test_config.py && git commit -m "Configure Photon delivery ledger"`.

### Task 2: SQLite delivery ledger

**Files:** Create `api/messaging/delivery_ledger.py` and `tests/messaging/test_delivery_ledger.py`.

- [ ] Write failing tests for persisted checkpoint across two instances, duplicate message rejection across two instances, a due `OutboundReply`, `mark_sent()` removing a due row, checkpoint advancement, and retry at 5 seconds then 10 seconds followed by terminal failure on attempt three.
- [ ] Run `uv run pytest tests/messaging/test_delivery_ledger.py -q`; expect module-import failure.
- [ ] Create `metadata(key, value)`, `inbound_messages(message_id, received_at)`, and `outbound_replies(message_id, agent_sender_id, space_id, text, state, attempt_count, next_attempt_at, last_error, created_at, sent_at)`. Make `message_id` unique in both message tables.
- [ ] Implement `enqueue_reply()` as one SQLite transaction: `INSERT OR IGNORE` the inbound ID, then insert the pending outbox row only if it was new. Rebuild `InboundMessage` from due rows.
- [ ] Implement `mark_send_failed()` by storing `type(error).__name__`. Schedule attempts one and two at 5 and 10 seconds. Set state to `failed` on attempt three.
- [ ] Run `uv run pytest tests/messaging/test_delivery_ledger.py -q`; expect pass.
- [ ] Commit with `git add api/messaging/delivery_ledger.py tests/messaging/test_delivery_ledger.py && git commit -m "Persist Photon delivery state"`.

### Task 3: Reply policy and coordinator

**Files:** Create `api/messaging/reply_policy.py`, `api/messaging/delivery_coordinator.py`, `tests/messaging/test_reply_policy.py`, and `tests/messaging/test_delivery_coordinator.py`. Remove `api/messaging/echo_agent.py` and its test after equivalent coverage exists.

- [ ] Write failing test that `SmokeTestReplyPolicy.reply_for(inbound(text="Oak Street"))` returns `Photon Spectrum is connected. You said: Oak Street`.
- [ ] Write failing coordinator tests with a fake gateway: duplicate input queues once, the first dispatch sends once, a timeout creates a due retry at 5 seconds, and the retry uses the same message ID and text.
- [ ] Run `uv run pytest tests/messaging/test_reply_policy.py tests/messaging/test_delivery_coordinator.py -q`; expect module-import failure.
- [ ] Define `ReplyPolicy.reply_for(message) -> str` and a smoke policy that preserves the existing echo text.
- [ ] Define a sender protocol exposing `send_reply(message, text)`. Implement `queue_messages()` to call `ledger.enqueue_reply(message, policy.reply_for(message), now)`. Implement `dispatch_due_replies()` to call the sender, then `mark_sent()` or `mark_send_failed()`.
- [ ] Run `uv run pytest tests/messaging/test_reply_policy.py tests/messaging/test_delivery_coordinator.py -q`; expect pass.
- [ ] Commit with `git add api/messaging/reply_policy.py api/messaging/delivery_coordinator.py tests/messaging/test_reply_policy.py tests/messaging/test_delivery_coordinator.py && git rm api/messaging/echo_agent.py tests/messaging/test_echo_agent.py && git commit -m "Queue Photon replies through delivery ledger"`.

### Task 4: Durable poll runner

**Files:** Modify `api/messaging/run_imessage_agent.py` and `tests/messaging/test_run_imessage_agent.py`.

- [ ] Write failing tests that a new `run_once(gateway, coordinator, poll_started_at)` reads the saved checkpoint, sends a due retry before fetching, queues valid inbound messages, advances the checkpoint only after a successful fetch, and does not advance it when fetch raises.
- [ ] Run `uv run pytest tests/messaging/test_run_imessage_agent.py -q`; expect signature and behavior failures.
- [ ] In `run_once()`, get `checkpoint = coordinator.checkpoint_or_initialize(poll_started_at)`, dispatch existing due replies, fetch Photon messages since checkpoint, extract valid inputs, queue them, advance the checkpoint to `poll_started_at`, then dispatch newly queued replies.
- [ ] In `run_forever()`, construct `DeliveryLedger(config.delivery_db_path)`, `SmokeTestReplyPolicy()`, and `DeliveryCoordinator`. Capture `datetime.now(UTC)` immediately before every poll. Keep the outer exception and interrupt handling.
- [ ] Run `uv run pytest tests/messaging/test_run_imessage_agent.py -q`; expect pass.
- [ ] Commit with `git add api/messaging/run_imessage_agent.py tests/messaging/test_run_imessage_agent.py && git commit -m "Resume Photon polling from delivery ledger"`.

### Task 5: Verification

**Files:** Change only if verification exposes a real defect.

- [ ] Run `uv run pytest -q && uv run mypy --strict api/messaging && git diff --check`.
- [ ] Confirm no table or module owns report data, the policy has no database or Photon dependency, and every retry calls existing `PhotonGateway.send_reply()` with its message-derived idempotency key.
- [ ] If verification exposes a defect, return to the task that owns its file, add a focused failing test, and make a separate corrective commit after that test passes.
