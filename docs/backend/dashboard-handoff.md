# Dashboard and messaging handoff: proposed v0.2

The backend now supports the requested report identity, authorized tracking,
organizer reads, update history and conversation history. The routes below are
implemented and covered by PostgreSQL tests. Teammates still need to connect
their adapters; these payload shapes remain proposed until coordinated.

## Connection and authentication

- **Local API:** `http://localhost:8000` after the configuration and startup in
  [setup.md](setup.md). This is a local address, not a shared team deployment.
  **Shared dev API:** not provisioned; supply the actual HTTPS URL after hosting
  and Supabase setup. Interactive documentation is at `/docs`.
- **Organizer:** sign in with Supabase email/password, then send
  `Authorization: Bearer <user-access-JWT>`. A backend-provisioned organizer role
  is required. `/auth/me` confirms it. Never send service-role keys from a browser.
- **Resident:** save the report token returned by creation in device storage;
  send `Authorization: Bearer <report-access-token>` for tracking and history.
  Keep the token out of URLs, logs, analytics and organizer data.
- **Messaging adapter:** send `X-Integration-Key: <MESSAGING_API_KEY>` from the
  transport server. Browser clients must not receive this secret.

`WG-...` is a public identifier, not authorization. The existing
`/report/:reference` UI route can remain. On another device, a reference without
the resident token cannot reveal report details or transcripts. There is no
token-recovery flow in this MVP; show an access-required state rather than
falling back to anonymous lookup.
The creation and tracking responses omit the internal triage recommendation.
Use the organizer-only list/detail routes for `triage` and audit details; an
organizer calling a general `/reports` lookup still receives the public shape.

## Endpoint examples

All example URLs, IDs and credentials in the fixture files are illustrative.

| Operation | Endpoint and request | Sample response |
| --- | --- | --- |
| Create | `POST /reports`, multipart photo/title/address, optional coordinates/note | [201 report + token](fixtures/report-created.json) |
| Track by reference | `GET /reports/by-reference/WG-A1B2C3D4E5F6`, resident/staff bearer | [200 report](fixtures/report.json) |
| Read by UUID | `GET /reports/{id}`, resident/staff bearer | [200 report](fixtures/report.json) |
| Organizer list | `GET /organizer/reports?limit=50&offset=0`, organizer bearer | [200 organizer array with triage](fixtures/organizer-report-list.json) |
| Organizer detail | `GET /organizer/reports/{id}`, organizer bearer | [200 organizer report + audit events](fixtures/organizer-report-detail.json) |
| Update history | `GET /reports/{id}/updates?limit=50&offset=0`, resident/staff bearer | [200 page](fixtures/report-updates.json) |
| Conversation history | `GET /reports/{id}/messages?limit=50&offset=0`, resident/organizer bearer | [200 page](fixtures/report-messages.json) |
| Current staff identity | `GET /auth/me`, staff bearer | [200 role](fixtures/auth-me.json) |
| Bind opted-in conversation | `POST /internal/conversations/bind`, `{link_code, channel, external_id, opted_in:true}` | [200 conversation](fixtures/conversation.json) |
| Resolve existing conversation | `POST /internal/conversations/resolve`, `{channel:"imessage", external_id:"photon-space-id"}` | [200 conversation](fixtures/conversation.json) |
| Read messaging context | `GET /internal/conversations/{id}/snapshot` | [200 snapshot](fixtures/conversation-snapshot.json) |
| Accept inbound follow-up | `POST /internal/conversations/{id}/followup`, [request](fixtures/incoming-followup.json) | [202 task](fixtures/followup-task.json) |
| Claim outgoing messages | `POST /internal/outgoing-messages/claim`, `{limit:20}` | 200 array of [outgoing records](fixtures/outgoing-message.json) |
| Acknowledge successful send | `POST /internal/outgoing-messages/{id}/delivered`, [request](fixtures/delivery-ack.json) | [200 delivery status](fixtures/delivery-status.json) |

To obtain a link code before binding, the resident calls
`POST /reports/{id}/followup-link` with their bearer token; it returns
`{"link_code":"<one-time-code>","expires_at":"<UTC timestamp>"}`. It expires after
ten minutes. A conversation maps to one report; do not resolve by sender alone.
The existing resolver works after the adapter restarts.

Creation uses the existing multipart endpoint, with **photo required**:

```text
photo: JPEG/PNG/WebP file, at most 8 MiB
title: Overflowing bin
address: Illustrative park entrance, Gulshan-e-Iqbal, Karachi
latitude: optional; requires longitude too
longitude: optional; requires latitude too
note: optional additional description
```

Title/address are trimmed, bounded at 160/500 characters and optional for legacy
clients. The new dashboard should supply both. Coordinates remain null when
unknown; the address is still stored. For safe retries, generate and retain a
client UUID plus `wg_r_` followed by a base64url-encoded 32-byte random token.
Send multipart `client_report_id` and header `X-Report-Token` together. Retry the
same content and credentials; changed content returns 409. See [contracts.md](contracts.md).

History pages return `{items, limit, offset, total}`, oldest first by timestamp
then UUID. Limit is 1–100 (default 50); offset is nonnegative. Listing reports
returns an array, newest first, with limit 1–100 (default 100). Advance offset by
the requested limit; an empty page marks the end. Refresh from the beginning
when underlying data changes. Transcript data is fetched separately, not
embedded in organizer listings or model context.

401 requires authentication; 403 means an unauthorized role; 404 hides missing
or inaccessible reports; 409 requires resolving a version/content conflict;
422 rejects invalid input; 413/415 reject invalid photos. A typical conflict
response is [shown here](fixtures/error.json). Validation details contain
`loc`, `type`, `msg` and omit submitted input.

## Writing updates and message history

Report updates are generated by the backend's existing actions: clarification,
organizer triage decision, job changes, photo completion and recheck. Use their
`command_id` and `expected_version` contracts in [contracts.md](contracts.md).
Do not write arbitrary status values or audit-history rows from the dashboard.

The messaging `/followup` endpoint writes the inbound transcript and queues
Person 3 reasoning atomically. Use a stable provider message ID; identical
replays return the existing task and changed text returns 409. This endpoint is
asynchronous: a 202 response means accepted, not that reasoning has finished.

After successfully sending an outgoing record, acknowledge its lease with the
**exact `sent_text`** and optional provider message ID. This records outbound
history and delivery state atomically. Retry the same acknowledgement payload;
different text or provider ID conflicts. On send failure use `/failed` with
`lease_id` and `retry_after_seconds`; no outbound transcript entry is created.
An acknowledgement means the transport reported send success, not recipient
read confirmation. Incoming timestamps are server acceptance times; outgoing
timestamps are acknowledgement times.

Person 4's SQLite ledger remains the transport retry/checkpoint store. Persist
the backend outgoing UUID with its routing record and coordinate retries through
the backend lease endpoints. The current smoke-reply policy still needs replacing
with the real adapter. Existing transcript history starts at migration 0006;
earlier task/outbox rows are retained but not guessed into a transcript.

## Dashboard adapter changes

Keep the UI routes, and make repository operations asynchronous with loading,
authentication and error states. Add the required photo input and replace the
development organizer session with Supabase sign-in. Map:

| API | Dashboard |
| --- | --- |
| `id` | Persistent backend ID for related requests |
| `public_reference` | `reference` |
| `title`, `address` | Title and address, independently of coordinates |
| `location` | Nullable coordinate pair; never substitute `(0,0)` |
| `dashboard_status` | `status`: submitted / in-progress / resolved |
| `created_at`, `updated_at` | Creation and latest customer-update time |
| `latest_update` | `latestUpdate`, nullable for legacy rows without events |
| `/updates` page items | `updates`, mapping `created_at` to `createdAt` |
| `/messages` page items | `conversation`, mapping `created_at` to `createdAt` |

Keep detailed `state`, `display_status` and history snapshots for explanations.
Assigned/in_progress/blocked map to in-progress, completed to resolved, and other
states to submitted. Historical updates lacking snapshots have null status;
show their recorded text/time without inventing a past status.

The backend is ready for this adapter work. Live acceptance still requires
Supabase configuration, a reachable API, Person 3's provider and the Photon
adapter. [verification.md](verification.md) distinguishes tested code from
those remaining external integration steps.
