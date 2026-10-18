# Dashboard and messaging handoff: proposed v0.2

## Local demo status

Supabase migrations, Auth roles, private Storage and the illustrative dataset
are configured. The backend runs locally at `http://127.0.0.1:8000` after the
[startup command](setup.md#current-local-demo). Its Supabase project URL is
`https://einjnvlhdogzdxafauyr.supabase.co`. The shared development API is
`https://wastegrid-api-dev.onrender.com`. The browser dashboard runs at
`http://127.0.0.1:5173`, which is configured as an allowed CORS origin.

The [shared development API runbook](shared-development-api.md) defines the
API-only Render deployment. The worker and Photon adapter remain inactive until
their owners coordinate a safe, explicit integration test.

Run `uv run --extra backend python -m scripts.verify_live_backend` for live
authentication/read/privacy checks. It checks the ten reports, six jobs,
two crews, ten photo records and five assignments, compares application rows and
Storage metadata before/after (not image bytes), and saves secret-free evidence
under `.data/`. Full write workflows are tested against disposable local
PostgreSQL. Synthetic images and decisions remain illustrative fixtures.

## Hassan's local connection handoff: 2026-10-17

- The ignored, owner-only `.env.hassan-handoff` file contains the existing
  `MESSAGING_API_KEY`, organizer email/password, a fresh organizer access JWT and
  its expiry, plus public connection settings. Share that file only through the
  private channel; it is not part of this PR. The JWT expires, while email/password
  can obtain a new session. A browser Supabase login client additionally needs the
  project's publishable key; the short-lived JWT can be used directly meanwhile.
- The messaging adapter sends `X-Integration-Key` to the documented messaging
  `/internal/...` routes. Agent context routes instead use `X-Agent-Key`.
  Never bundle the messaging key or a hardcoded organizer password into a browser
  build. The organizer JWT is sent as `Authorization: Bearer <JWT>`.
- Organizer access to `/organizer/reports`, `/crews` and `/plans/current` was
  verified. The hosted Render API allows the supplied dashboard browser origin,
  `http://127.0.0.1:5173`. `localhost` and `127.0.0.1` are different origins;
  configure each additional dashboard origin explicitly.
- The configured messaging key passed authentication on a read-only lookup;
  missing/wrong keys were rejected. This does not demonstrate Photon delivery.
- The API still binds only to this machine's loopback address. Hassan needs his
  own configured backend or a shared reachable deployment. The dashboard now
  uses the shared HTTPS API through `VITE_API_BASE_URL`; CORS does not expose a
  local server to other machines.

## Owner checklist

| Owner | Inputs and next action |
| --- | --- |
| Frontend/mobile | The organizer dashboard uses `VITE_API_BASE_URL`, `VITE_SUPABASE_URL`, and `VITE_SUPABASE_PUBLISHABLE_KEY` to sign in with Supabase, verify `/auth/me`, and load `/organizer/reports`. Only the publishable key belongs in browser configuration. Customer creation and tracking remain browser-local demo flows until their separate integration work is complete. |
| Person 3 | Implement HTTP `POST /triage`, `/plan`, `/followup` with the generated schemas and fixtures, or provide the documented Python factory. Supply `PERSON3_BASE_URL` and any `PERSON3_API_KEY` privately to the backend owner. Optional snapshot tools use the separate `AGENT_API_KEY` in `X-Agent-Key`. Configure and start the worker only after the provider is ready; inspect `/tasks` and retry failed tasks explicitly. |
| Person 4 | Obtain `MESSAGING_API_KEY` privately for server-side `X-Integration-Key`. Implement opt-in linking, conversation resolution after restart, stable inbound message IDs, outgoing leases/retries, and delivery acknowledgements with the exact `sent_text`. The Photon echo agent must be replaced by this adapter before claiming integrated delivery. |

The common contract is [contracts.md](contracts.md); the generated
[OpenAPI](openapi.json), [schemas](schemas/) and [fixtures](fixtures/) are the
implementation reference. Provider recommendations pass through backend
validation and must not write the database directly. Messaging delivery uses
the existing transport ledger plus backend outgoing IDs for deduplication.
Coordinate v0.2 with the other owners before claiming their adapters are ready.

The private `.env.supabase-demo` file contains the three account passwords and
IDs. Give teammates only the accounts they need through a private channel.
Database, Storage secret, agent and messaging keys are server credentials; they
do not belong in browser/mobile configuration or shared example payloads.

## Local Swagger walkthrough

1. Start the API with the command in [setup.md](setup.md#current-local-demo),
   then open `http://127.0.0.1:8000/docs`. Execute `GET /health` and `GET /ready`.
2. Obtain a user access JWT for the organizer. The local Python snippet below
   reads the saved demo credentials and prints only that short-lived user token
   for copying into Swagger. Run it privately; omit its output from recordings,
   logs and shared handoffs. The automated verifier never prints tokens.

   ```bash
   uv run --extra backend python - <<'PY'
   from dotenv import dotenv_values
   from api.config import Settings
   from api.storage import SupabaseCloud

   values = dotenv_values('.env.supabase-demo', interpolate=False)
   label = 'ORGANIZER'  # Change to CREW_A or CREW_B for the crew walkthrough.
   cloud = SupabaseCloud(Settings())
   try:
       result = cloud.call('POST', '/auth/v1/token?grant_type=password', json={
           'email': values[f'DEMO_{label}_EMAIL'],
           'password': values[f'DEMO_{label}_PASSWORD'],
       }).json()
       print(result['access_token'])
   finally:
       cloud.close()
   PY
   ```

3. Click **Authorize**, use **ReportOrStaffBearer**, and paste the JWT value
   without adding `Bearer`. Execute `GET /auth/me`; expect `organizer`.
4. Execute `GET /organizer/reports`; expect ten illustrative reports. Use a
   returned report UUID with `GET /organizer/reports/{report_id}` to inspect its
   stored decision and audit history. `GET /plans/current` shows the fixture plan.
5. Repeat the snippet with `CREW_A`, replace the Swagger authorization, and
   confirm `/auth/me` returns that crew. `GET /jobs` returns three assignments;
   Crew B returns two. A crew receives 403 on organizer listings and 404 for the
   other crew's job UUID. `GET /jobs/{job_id}` provides accessible photo UUIDs.
6. Use an accessible photo UUID with `GET /photos/{photo_id}/access`. Open the
   returned signed URL within 300 seconds; it shows a labeled synthetic image.
   Other crews cannot obtain that URL. The automated verifier also confirms
   that the public Storage URL fails.
7. Log out of Swagger's authorization when finished. Keep this walkthrough to
   GET operations. New report submission and lifecycle mutations belong to the
   later integrated demo; the current fixtures have no published resident tokens.

The backend now supports the requested report identity, authorized tracking,
organizer reads, update history and conversation history. The routes below are
implemented and covered by PostgreSQL tests. Teammates still need to connect
their adapters; these payload shapes remain proposed until coordinated.

## Connection and authentication

- **Local API:** `http://localhost:8000` after the configuration and startup in
  [setup.md](setup.md). This is a local address, not a shared team deployment.
  **Shared dev API:** `https://wastegrid-api-dev.onrender.com`. Interactive
  documentation is at `/docs`. The shared API permits the dashboard origin
  `http://127.0.0.1:5173`; the browser smoke test remains the final connection
  check.
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

New link codes require an enabled, fully configured supervised pilot and an
allowlisted report. The resident calls `POST /reports/{id}/followup-link` with
their bearer token; the response contains a ten-minute `link_code`, `expires_at`,
verified `recipient`, and `channel: imessage`. Disabled/incomplete pilot
configuration returns `503`, an out-of-scope report returns `403`, and a persisted
scope conflict returns `409`. Pilot enrollment uses the durable messaging inbox
described in [the pilot contract](photon-chalk-pilot.md). The legacy integration
routes above retain existing conversation handling after adapter restarts.

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
