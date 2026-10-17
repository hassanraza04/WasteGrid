# Photon Delivery Ledger Design

## Purpose

Make the existing Photon iMessage transport safe across process restarts without
waiting for the shared report database or reply-reasoning service. This is a
Person 4 transport component only.

## Alignment and boundaries

The build plan assigns incoming-message deduplication, outgoing retries, and
outgoing error handling to Person 4. Person 2 remains the owner of the shared
report, customer, and conversation records. Person 3 remains the owner of reply
reasoning.

The ledger is not a report database. It will not store reports, organizer
accounts, report actions, or mappings from people to reports. It only records
the delivery state needed to process a Photon message exactly once from the
transport's point of view.

## Chosen approach

Use Python's standard-library `sqlite3` module for a local delivery ledger.
The earlier echo agent held handled IDs only in memory. That loses deduplication
and retry information when the process restarts. A local SQLite file gives
restart safety with no new package and without claiming ownership of Person 2's
shared persistence layer.

The other options were rejected:

- In-memory state is useful only for a one-process smoke test and loses work on
  restart.
- Waiting for Person 2's database blocks independent Person 4 reliability work.

## Components

### `DeliveryLedger`

Create a SQLite-backed component in `api/messaging/delivery_ledger.py`. It owns
three small concerns:

- A single polling checkpoint timestamp.
- The IDs of valid inbound messages that have been accepted by this process.
- An outbound reply outbox with its state and retry metadata.

The database has these tables:

| Table | Required columns | Purpose |
| --- | --- | --- |
| `metadata` | `key`, `value` | Stores `poll_checkpoint` as an ISO-8601 UTC timestamp. |
| `inbound_messages` | `message_id`, `received_at` | Makes accepting an inbound Photon message idempotent. |
| `outbound_replies` | `message_id`, `agent_sender_id`, `space_id`, `text`, `state`, `attempt_count`, `next_attempt_at`, `last_error`, `created_at`, `sent_at` | Stores a reply and the Photon routing values needed to retry it after a restart. |

`message_id` is unique in both message tables. Database operations that accept a
message, create its outbox record, change retry state, or advance the checkpoint
must use SQLite transactions.

### Reply policy

Introduce a small `ReplyPolicy` protocol that takes an `InboundMessage` and
returns reply text. Keep a `SmokeTestReplyPolicy` that emits the existing safe
connection reply. Person 3 can later supply a policy backed by the reasoning
service without changing delivery logic.

### Polling coordinator

Replace the direct `EchoAgent.process()` call in the runner with a coordinator:

1. Read the persisted checkpoint. On a brand-new database, initialize it to the
   current UTC time before polling. This preserves the current behavior of not
   replying to historic messages when the service is first started.
2. Capture `poll_started_at` in UTC and request received iMessages since the
   checkpoint.
3. Extract valid inbound text messages. For each new message ID, persist the
   inbound receipt and its reply outbox row before any send attempt.
4. Advance the checkpoint to `poll_started_at` after all fetched messages have
   been durably inspected. Messages arriving during the poll are included in a
   later poll. Duplicate results are safe because the inbound ID is unique.
5. Send every outbox row that is due. Keep Photon’s existing stable idempotency
   key based on the inbound message ID.

If the process stops after Photon accepts a reply but before the ledger marks it
sent, the next attempt uses the same idempotency key. Photon therefore receives
an idempotent retry instead of a duplicate logical reply.

## Retry rules

- A successful Photon send changes the row to `sent` and records `sent_at`.
- Any exception while sending increments `attempt_count`, records a sanitized
  exception type as `last_error`, and schedules the next attempt.
- Retry delays are 5 seconds, 10 seconds, and 20 seconds.
- The maximum is three send attempts. A row that exhausts its third attempt is
  `failed` and is never sent automatically again.
- Every retry decision is logged with the message ID, state, and attempt count.
  Logs never include API keys or message body text.

## Configuration

Extend `PhotonConfig` with:

| Environment variable | Default | Meaning |
| --- | --- | --- |
| `PHOTON_DELIVERY_DB_PATH` | `.data/photon-delivery.db` | SQLite ledger location. |

The parent directory is created when the ledger opens. The database file is
local development and service state. It must be excluded from Git.

## Failure handling

- Failure to open or write the ledger stops that poll iteration before Photon is
  called. This prevents untracked sends.
- A Photon send error stays in the outbox and follows the retry rules.
- A malformed or unsupported Photon event is ignored as it is today and never
  produces a receipt or reply.
- This first slice supports one poller process against one SQLite file. Running
  several transport replicas requires a shared delivery store and is explicitly
  out of scope.

## Privacy and ownership

The outbox must keep reply text and Photon routing IDs long enough to send an
idempotent retry. It does not retain raw inbound message text. The database is a
local operational spool, not the long-term conversation history. The later
Person 2 integration owns durable conversation retention and report association.

## Testing

Unit tests will cover:

- First-start checkpoint behavior.
- Deduplication across separate ledger instances.
- Atomic inbox-to-outbox creation.
- A failed send becoming due after each fixed retry delay.
- The third failed send becoming terminal `failed`.
- A successful retry becoming `sent`.
- Checkpoint advancement without losing messages that arrive during a poll.
- The runner using persisted queued work after a simulated restart.

Existing Photon client tests remain unchanged. No live Photon message is sent as
part of this work.

## Out of scope

- Report lookup, report creation, and organizer dashboard data.
- Real organizer authentication.
- Person 3's LLM or reasoning implementation.
- Incoming webhook delivery, pagination changes, or multi-replica coordination.
- Automatic database retention cleanup.
