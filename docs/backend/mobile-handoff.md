# WasteGrid mobile app integration handoff

**Recipient:** mobile app owner (Person 1)

**Backend contact:** Omer (Person 2)

**Prepared:** 17 October 2026

**Contract:** implemented API v0.2; coordinate contract changes with the backend owner.

This document contains the mobile integration requirements and shareable connection
details. Passwords and backend secrets are supplied separately. The mobile app is
the user interface. FastAPI's optional `/docs` page is only a developer tool for
trying requests; Swagger is not a mobile framework or a product requirement.

## 1. What is ready, and what is pending

| Item | Current status |
| --- | --- |
| Backend | FastAPI with Supabase PostgreSQL, Auth and private photo Storage |
| Local API | `http://127.0.0.1:8000`, on Omer's machine while its process is running |
| Shared API URL for your app | `https://wastegrid-api-dev.onrender.com` (verified API-only development service) |
| Supabase project URL | `https://einjnvlhdogzdxafauyr.supabase.co` |
| Supabase publishable key | **Pending handoff.** Needed for organizer/crew login, not resident submissions |
| Resident report submission, tracking and private photos | Implemented |
| Organizer/crew authorization | Implemented; demo accounts provisioned |
| AI triage and route planning | Integration pending; worker inactive, new work stays queued |
| Messaging transport | PR #9 adapter merged; separate Photon process not activated and live delivery not yet verified |
| Public hosting | Initial Render acceptance used `main` commit `7b77f8d`; 23 hosted checks also passed after the PR #6 database upgrade. The PR #6 API redeploy needs separate acceptance. Free instances can sleep when idle. |

The configured demo has **10 illustrative reports, 6 jobs, 2 crews, 10 photos and
5 assignments** (Crew A: 3; Crew B: 2). Images and decisions in that dataset are
synthetic examples, not evidence of real cleanup or AI execution. Preserve this
dataset during read-only exploration. Arrange disposable test data with Omer
before testing submission, completion or other state-changing actions.

Backend acceptance recorded on 17 October after PR review: 116 Python tests passed with zero skips,
contract/lint/format checks passed, Docker build and 11 HTTP smoke checks passed,
and 23 live Supabase checks passed, including effective Storage access checks for
both crews. Before/after application rows and Storage metadata matched; photo
bytes were not compared. These are
backend results; mobile end-to-end acceptance is still to be completed.

## 2. Connection settings and access

The backend owner follows the [shared API deployment runbook](shared-development-api.md).
The shared development API passed hosted acceptance on 17 October 2026. Use its
verified HTTPS URL for device integration; coordinate state-changing tests with
Omer so they do not alter the illustrative Supabase fixture unexpectedly.

Mobile configuration, for example in `mobile/.env.local`:

```dotenv
EXPO_PUBLIC_API_BASE_URL=https://wastegrid-api-dev.onrender.com
EXPO_PUBLIC_SUPABASE_URL=https://einjnvlhdogzdxafauyr.supabase.co
EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=REPLACE_WITH_PUBLISHABLE_KEY
```

The native resident adapter reads `EXPO_PUBLIC_API_BASE_URL`; mobile sign-in now
uses the two public Supabase settings. Staff roles come from `/auth/me`. API paths
below are relative to the base URL, with no extra `/api` prefix. Anonymous report
submission needs just the API base URL. The two
Supabase values are needed for account sign-in and the login-gated history screen.

Omer can retrieve the project's publishable key in Supabase **Project Settings →
API Keys**. Request the publishable key (`sb_publishable_…`), never the secret or
service-role key. Expo embeds `EXPO_PUBLIC_*` values in the app, so they must contain
only public configuration. Read them using static expressions such as
`process.env.EXPO_PUBLIC_API_BASE_URL` and reload after changes.
See [Expo environment variables](https://docs.expo.dev/guides/environment-variables/).

**Networking:** this machine's `127.0.0.1` is not accessible from your computer or
phone. On a phone, `localhost` refers to that phone. Use the shared HTTPS
deployment above. A temporary LAN connection requires
explicit server binding, firewall and WSL/network routing setup with Omer; replacing
the hostname alone does not expose this server. `0.0.0.0` is a server listening
address, not the URL to put in the app. For Expo's web preview, provide Omer the exact
browser origin so it can be allowed by backend CORS; native requests are not subject
to browser CORS enforcement.

Do not copy the backend `.env` into the mobile project. Database URLs/passwords,
Supabase secret/service-role keys, `AGENT_API_KEY`, `MESSAGING_API_KEY` and provider
keys are server-only. The app should not query the private `wastegrid` database
schema or upload directly to Supabase Storage.

## 3. Two distinct authentication flows

| User | Authentication | Mobile responsibility |
| --- | --- | --- |
| Resident report API | A private bearer token for each report; no Supabase account required by these endpoints | Securely retain the token and associate it with that report |
| Organizer or crew | Supabase Auth session JWT plus a backend-provisioned staff role | Sign in, refresh the session and call `/auth/me` |

Use `Authorization: Bearer <token>` when accessing an existing report. A resident
token starts with `wg_r_` and grants access only to its report and allowed photos.
A Supabase user JWT is a different credential; it does not replace a resident token
unless that user has an authorized staff role. The `access_token` returned when
creating a report is the resident token, not a Supabase session.

The public reference, for example `WG-0123456789AB`, is an identifier, **not an
access credential**. Knowing it alone must never display private report data.

### Approved mobile history policy

Omer approved login-required **My reports** as the intended app workflow on
17 October 2026. This app requirement is separate from the backend's per-report
authorization described above. Anonymous submission remains available without
sign-in. History is shown only after account sign-in and contains the reports
associated with that account's local device index. Anonymous device drafts can be
imported only through the user's explicit **Import this device's reports** action.
Signing in must not automatically claim drafts or reveal another account's local history.

Native account sessions are saved in protected device storage and restored after
restart, with roles reverified by the backend. Signing out clears the account
session. Web preview sessions remain in memory and end on page reload/closure.
Neither sign-in nor import creates server-side account ownership or replaces each
report's private token. Cross-device history and token recovery remain pending
backend capabilities, not features implied by login.

### Resident storage

Generate and save a report UUID and token before the first upload. Keep resident
tokens in protected device storage, such as Expo SecureStore, with one small entry
per report. Handle storage failures before submitting. Keep a local report index
containing IDs/references so the app can find the corresponding tokens. Minimize
cached location/photo data and never log tokens, authorization headers or signed
photo URLs. See [Expo SecureStore](https://docs.expo.dev/versions/v58.0.0/sdk/securestore/).

There is currently no resident account-based report list, cross-device sync or
token-recovery endpoint. A “My reports” screen must use the locally remembered
report IDs and fetch each report with its own token. If credentials are lost,
the reference alone cannot recover access; make that limitation clear in the UI.

## 4. Submit a resident report

**`POST /reports` → `201 Created`**, using `multipart/form-data`.
No Supabase login is required.

| Multipart field | Requirement |
| --- | --- |
| `photo` | Required binary image file; send actual bytes with filename and matching MIME type |
| `title` | Supply a meaningful title, trimmed, 1–160 characters; legacy omission defaults to `Cleanup report` |
| `address` | Optional human-readable address, trimmed, 1–500 characters if present; omit when blank |
| `latitude`, `longitude` | Required pair for new submissions: GPS or an explicitly confirmed map pin; ranges −90…90 and −180…180 |
| `landmark` | Optional, at most 300 characters; stored as part of a supplied coordinate location |
| `note` | Optional description, at most 2,000 characters |
| `client_report_id` | UUID generated once for this logical submission; use with `X-Report-Token` |

Address and coordinates are separate fields. A typed address adds context; new
reports require GPS coordinates or an explicitly confirmed map pin. Never invent
coordinates from prose or substitute `(0, 0)` for an unknown location. Successful
identical retries of previously accepted address-only reports remain valid. For an
older unsubmitted draft, resolve the original upload first; only a definite 404
permits correcting its capture and creating a fresh submission identity.

Photo limits: **8 MiB (8,388,608 bytes)**, JPEG/PNG/WebP, at most **25 million pixels**.
The server checks image bytes and MIME agreement. Convert unsupported camera formats
before saving the upload draft. A local `file://` URI is not a server-readable URL:
attach it as a React Native multipart file so its bytes are uploaded. Do not send
JSON containing only `photoUri` or base64 text. Let the networking library set the
multipart `Content-Type` boundary.

### Reliable submission and retry

1. Generate a UUID and 32 cryptographically random bytes. Encode the bytes as
   unpadded base64url (43 characters) and prefix with `wg_r_`. Do not use `Math.random`.
2. Persist the UUID, token, exact form values and a durable local copy of the final
   image. Send the UUID as `client_report_id` and token as the `X-Report-Token` header.
3. Upload once; disable duplicate taps and show a pending state.
4. On success, retain `report.id`, `report.public_reference` and `access_token`, then
   show confirmation/tracking. Do not navigate away as though saved before success.
5. On an ambiguous network failure, recover with `GET /reports/{client_report_id}`
   and the saved bearer token, or retry the identical upload. Reuse the same UUID,
   token, image bytes and form fields. Do not recompress or regenerate the location.

Both retry fields must be supplied together, otherwise the server returns `422`.
An identical accepted retry returns `201` and the existing report; changed content
under the same UUID returns `409`. Do not automatically create another UUID after a
timeout, since the original submission may already exist. A deliberately edited
submission needs explicit handling of the previous attempt's outcome.

Illustrative response shape (IDs below are examples; token is a placeholder):

```json
{
  "report": {
    "id": "d1e2f3a4-1111-4111-8111-111111111111",
    "public_reference": "WG-0123456789AB",
    "title": "Litter beside the bus stop",
    "address": "Example Street bus stop",
    "state": "received",
    "display_status": "received",
    "dashboard_status": "submitted",
    "location": null,
    "note": "Several bags beside the shelter.",
    "clarifications": [],
    "photo_id": "d1e2f3a4-2222-4222-8222-222222222222",
    "completion_photo_ids": [],
    "job_id": null,
    "version": 1,
    "illustrative": false,
    "created_at": "2026-10-17T15:00:00Z",
    "updated_at": "2026-10-17T15:00:00Z",
    "latest_update": null,
    "timeline": []
  },
  "access_token": "REDACTED_RESIDENT_TOKEN"
}
```

`latest_update` and `timeline` are populated when available; tolerate null/empty
values. Actual fixture records have `illustrative: true`; newly submitted reports
are not automatically marked illustrative. Creation queues assessment, but the worker
is currently inactive: do not display invented AI decisions or promise an automatic
status transition immediately after upload.

## 5. Track reports and display history

Send the report's resident bearer token on each request:

| Endpoint | Response and use |
| --- | --- |
| `GET /reports/{report_id}` | `ReportView`, the current report |
| `GET /reports/by-reference/{reference}` | Same view; still requires authorization. URL-encode the reference |
| `GET /reports/{report_id}/updates?limit=50&offset=0` | Paginated human-readable status history |
| `GET /reports/{report_id}/messages?limit=50&offset=0` | Paginated linked-conversation history, for resident/organizer only |

History responses have `{ "items": [], "limit": 50, "offset": 0, "total": 0 }`.
Both history endpoints accept `limit` 1–100 and nonnegative `offset`; defaults are
50 and 0. Results are oldest first, ordered by creation time and ID. Deduplicate
items by ID and reset pagination on refresh. No realtime subscription or push
notification contract is implemented; refresh on screen focus/manual refresh and
use bounded polling only while needed.

An update contains `id`, `kind`, `created_at`, `message`, `status`, `report_state`
and `job_status`. Render `message` as text. Historical status fields may be null;
do not backfill an old event with today's status. A conversation message contains
`id`, `created_at`, `direction` (`inbound` or `outbound`) and `body`. Outbound entries
represent acknowledged sends, not read receipts; queued/failed outgoing messages
are excluded. Empty history is valid while messaging is unconnected.

### Status and response mapping

| Field | Meaning / display guidance |
| --- | --- |
| `state` | `received`, `needs_info`, `needs_review` or `linked_to_job` |
| `display_status` | Detailed state: report state, or linked job status |
| `dashboard_status` | Coarse tab/badge: `submitted`, `in-progress` or `resolved` |
| `latest_update` | Latest customer-facing update or null |
| `timeline` | Event summaries (`id`, `kind`, `created_at`); use `/updates` for readable history |
| `clarifications` | Prior notes/locations with timestamps |
| `completion_photo_ids` | After-photo IDs; obtain authorized access as below |
| `job_id`, `location`, `address`, `note` | May be null; do not fabricate missing values |
| `version` | Server version; preserve for any supported versioned command |
| `illustrative` | Label synthetic demo content explicitly |

Assigned, in-progress and blocked jobs map to `in-progress`; completed jobs map to
`resolved`; other states map to `submitted`. Keep the detailed state visible where
it matters, especially missing information, review and blocked work. Completion is
**crew-submitted**, not independently verified. Use UTC timestamps from the API and
format locally. Report `updated_at` reflects report/customer updates, not every
conversation message. Resident responses intentionally omit internal triage data.

## 6. Display private photos

1. Call `GET /photos/{photo_id}/access` using the resident report token or authorized
   staff JWT.
2. Read `{ "url": "<temporary signed URL>", "expires_in": 300 }`.
3. Display/download that URL without attaching backend authorization headers.
4. Retain the photo ID, not the URL, as the durable identifier. Use `expires_in`
   rather than hardcoding the lifetime. Request a fresh URL when it expires.

The `report-photos` bucket is private. Public bucket links must fail. Never make the
bucket public to fix an image-loading issue. Signed URLs grant temporary access:
keep them out of logs and analytics. A failed image refresh should recheck access,
not endlessly retry. The same flow applies to completion photos.

## 7. Optional organizer and crew screens

Implement these only if they are in the agreed mobile scope; resident reporting
does not require staff sign-in.

Initialize a Supabase client with the project URL and publishable key. Use
`supabase.auth.signInWithPassword({ email, password })`, then send
`session.access_token` to FastAPI as a bearer JWT. Configure session persistence
and native foreground/background token refresh using the
[Supabase React Native guide](https://supabase.com/docs/guides/auth/quickstarts/react-native).
Choose appropriate protected storage for credentials; do not assume ordinary app
storage is encrypted.

After sign-in call `GET /auth/me`, which returns:

```json
{
  "user_id": "575ac039-3a8f-4795-bb40-f795c4d0c8d7",
  "role": "organizer",
  "crew_id": null
}
```

Backend-protected role records determine access. User-editable metadata and a
client-side role selector grant no permissions. A Supabase user without a provisioned
staff role receives `403`.

| Demo account | Role / expected access |
| --- | --- |
| `organizer@example.com` | Organizer; all 10 fixture reports and organizer routes |
| `crew-a@example.com` | Crew A; 3 fixture assignments |
| `crew-b@example.com` | Crew B; 2 fixture assignments |

Request only the required demo passwords privately from Omer. His ignored private
credential file is `.env.supabase-demo` at the repository root. It is not included
with this handoff and must not be committed, bundled into the app or attached to a
shared PR. Do not hardcode demo passwords in source.

| Endpoint | Staff behavior |
| --- | --- |
| `GET /organizer/reports?limit=50&offset=0` | Organizer only; returns an **array**, not the history pagination envelope; maximum page size 100 |
| `GET /organizer/reports/{report_id}` | Organizer only; `{report, events}`, including organizer triage context |
| `GET /jobs` | Array of jobs, maximum 100; crew sees only its own assignments, organizer sees all |
| `GET /jobs/{job_id}` | `{job, photo_ids, events}`; cross-crew access denied |
| `PATCH /jobs/{job_id}` | Versioned job command, subject to role/state/plan validation |
| `POST /jobs/{job_id}/completion` | Assigned crew only; multipart after-photo plus command fields |

For a crew start action, send JSON with `Content-Type: application/json`:

```json
{
  "command_id": "d1e2f3a4-3333-4333-8333-333333333333",
  "expected_version": 1,
  "status": "in_progress"
}
```

Use the fetched **job** version, not a report version. Generate a command UUID once
per intended action and reuse the identical command on retry. Starting/resuming
requires a valid current plan and eligible assignment. Organizer changes also
require a reason; consult the full contract before implementing organizer controls.

Completion sends multipart `photo`, `command_id`, `expected_version` and optional
`note` (maximum 2,000 characters). The job must already be `in_progress`. Photo rules
match report submission; the backend computes the photo hash. The response is the
updated `JobView`. Completion invalidates the plan, so later starts can require
replanning. With the worker inactive, do not assume this will happen automatically.
Crew accounts cannot read resident conversation history.

## 8. Messaging and follow-up boundary

If a resident explicitly opts into channel follow-up, call
`POST /reports/{report_id}/followup-link` with that report's resident token. A `201`
response contains `link_code` and `expires_at`. The code is single-use and expires
after ten minutes. Person 4 must supply the real channel destination/deep-link and
linking UX before this becomes a working mobile flow. Do not invent a messaging URL.

The mobile app must never call the `/internal/...` messaging integration routes or
contain the messaging integration key. Clarification/recheck conversation workflows
depend on the messaging adapter. There is currently no direct resident chat-send,
clarification or recheck endpoint for a mobile text box. History display alone does
not enable message delivery. Keep unavailable follow-up actions clearly labeled or
disabled until the transport is connected.

## 9. Errors and recovery

| Result | Mobile handling |
| --- | --- |
| Network failure / timeout | Keep the pending draft; recover/retry with persisted identifiers and identical content |
| `401` | Missing/invalid authentication. For staff, refresh once then request sign-in; for residents, check the saved report token |
| `403` | Role lacks access; do not retry with elevated permissions |
| `404` | Missing or inaccessible resource, including wrong resident token/cross-crew access; do not reveal whether another user's record exists |
| `409` | Changed retry content, stale version or state/plan conflict; refetch and reconcile instead of blindly overwriting |
| `413` | Image/request too large or image dimensions exceed the limit; prepare a compliant draft before a new submission |
| `415` | Unsupported, invalid or MIME-mismatched photo; fix the file and MIME metadata |
| `422` | Invalid fields, partial coordinate pair, blank title/address or missing retry pair; show actionable field errors |
| `503` | Backend/dependency temporarily unavailable; show a recoverable state with bounded retry |

Errors normally contain `detail`, which can be a string or an array of validation
issues. Handle both shapes and unexpected non-JSON/network failures. Do not show
raw credentials/request bodies in crash reporting. If editing a failed draft after
an uncertain upload, resolve the original submission first to avoid duplicates.

## 10. Changes needed in the current mobile app

The repository's `mobile/src/app/report.tsx` currently builds
`{ photoUri, caption, location }`, logs it and navigates back. Replace that placeholder
with the asynchronous flow above. The browser demo's local report shape is not the
backend wire contract.

| Current UI value | Backend mapping |
| --- | --- |
| `photoUri` | Actual multipart `photo` file; inspect/retain correct MIME, size and dimensions |
| `caption` | `note`; existing 280-character UI limit is within the backend limit |
| New title input or deliberate short summary | `title`, at most 160 characters; do not pass an unrestricted caption as title |
| `location.address` | `address`, omit if blank |
| `location.coords` | `latitude` and `longitude`, only when available |
| New persisted submission identity | `client_report_id` plus `X-Report-Token` |

Add a typed API adapter, protected report-token storage, durable pending drafts,
success/tracking views, authenticated photo loading, history pagination and clear
loading/error states. Remove the report-content console log. Use platform-compatible
cryptographic randomness and storage libraries. Staff authentication is an additional
adapter only if those screens are in scope.

## 11. Integration acceptance checklist

Use disposable test data for writes. Keep the shared illustrative fixture intact.

- [ ] Obtain a reachable base URL; check `/health` and `/ready` from the actual device.
- [ ] Submit a real multipart photo with title, note and GPS or manual address.
- [ ] Persist identity/token before upload; verify a repeated identical request creates one report.
- [ ] Recover after a simulated timeout and app restart without creating duplicates.
- [ ] Restore the intended account after restart, then show its local history and fetch each report with its saved report token.
- [ ] Verify anonymous submission, login-required history and explicit device-draft import without exposing another account's reports.
- [ ] Block native back/swipe during sign-in; verify logout during login leaves no restorable session.
- [ ] Confirm reference-only lookup and a different report's token cannot expose the report.
- [ ] Load authorized report/completion photos and renew an expired signed URL.
- [ ] Render null location, empty history, detailed states and illustrative labels correctly.
- [ ] Handle denied GPS permission, offline mode, oversize/invalid photos and server errors.
- [ ] If staff screens are included: verify `/auth/me`, organizer reports, Crew A/B assignment isolation and session refresh.
- [ ] Keep AI work visibly pending and messaging unavailable until the owners connect them.
- [ ] Confirm no backend secrets, resident tokens or signed URLs are in source/logs/analytics.

Optional developer walkthrough: readiness → Supabase organizer sign-in → `/auth/me`
→ organizer reports → crew sign-in and `/jobs` → authorized photo access. Use an HTTP
client, the app, or FastAPI `/docs`; none requires changing the mobile UI technology.
`/ready` checks backend readiness, not whether AI or Photon are connected.

## 12. Coordination and references

**Request from Omer:** the reachable API base URL; publishable key and relevant demo
passwords if staff screens are included; disposable write-test setup; exact web
origin allowlisting if applicable. A PR can review and distribute this handoff and
the backend verifier; it does not make the local API remotely reachable.

**Return to Omer:** confirmation of resident-only versus resident-and-staff scope,
target device/web environment, any contract mismatch, and the acceptance checklist
results. Report errors using endpoint, status and a sanitized description, without
tokens, passwords or private images.

**Coordinate with Person 3:** expected pending/needs-information presentation once
real triage/planning is connected. The backend owner handles provider credentials
and worker activation.

**Coordinate with Person 4:** opt-in wording, supported channel destination and
link-code/deep-link flow. Integration secrets and delivery acknowledgements remain
between the messaging adapter and backend.

Source contracts and further detail in the shared repository:

- [OpenAPI specification](https://github.com/hassanraza04/WasteGrid/blob/main/docs/backend/openapi.json)
- [Backend integration contracts](https://github.com/hassanraza04/WasteGrid/blob/main/docs/backend/contracts.md)
- [JSON schemas](https://github.com/hassanraza04/WasteGrid/tree/main/docs/backend/schemas)
- [Example payloads](https://github.com/hassanraza04/WasteGrid/tree/main/docs/backend/fixtures)
- [Backend setup](https://github.com/hassanraza04/WasteGrid/blob/main/docs/backend/setup.md)

This handoff and the accompanying verifier/documentation updates are delivered on
the milestone PR branch. Until that PR is merged, use its branch for those updates;
do not assume they are already available on `main`.


## Supervised iMessage pilot

See [pilot contracts and activation](photon-chalk-pilot.md). Report details expose
opt-in only when the report is in the configured pilot. `POST /reports/{id}/followup-link`
requires that report's bearer token and returns a ten-minute `link_code`,
`expires_at`, `recipient`, and `channel: imessage`. Explain consent before the
resident sends `LINK <code>` to the verified recipient. A composed message does
not establish a link. Poll `GET /reports/{id}/messaging-links` for backend-confirmed
active/paused links; its response never exposes transport identities. Unlink with
`POST /reports/{id}/messaging-links/{link_id}/unlink` and the same report token.
On devices without iMessage show the code/contact instructions and retain in-app
tracking. `GET /reports/{id}/messages` remains report-scoped, including when the
same private chat links several reports. Login-required device history and explicit
anonymous-draft import remain the approved app policy above.
