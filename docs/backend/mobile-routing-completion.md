# Mobile routing and cleanup completion

The mobile Dispatch and My route tabs now call the merged routing and job APIs.
They reuse verified Supabase sessions, with no second JWT store. Resident report
tokens remain separate. Staff responses are ignored after account changes, and
focused screens poll every 15 seconds only while foregrounded.

## Organiser

Dispatch loads real crews and active jobs. Select at most five crews, then Compute
routes. This creates a read-only preview across all eligible unassigned jobs and
eligible selected-crew work. The existing backend limit is 25 eligible scoped jobs.
The live screen has no city, hours, max-stop or return-to-start controls.

Review per-crew time, ordered stops and priorities, fixed work, reassignments,
excluded jobs and unassigned reasons. Maps show the stop sequence, not road
geometry. Only a complete, unexpired dispatchable preview can be approved.
Approval saves a command ID before POST /routing/previews/{id}/dispatch. Recover a
lost response with the saved action; do not create a replacement command blindly.
An unresolved saved dispatch blocks another calculation. Definitively rejected
actions can be discarded after verifying the server has not applied them.

Rechecked jobs expose an audit-reason field and the existing narrow organiser
release to unassigned. Review/handling gates are never bypassed locally.

## Crew

My route uses the verified crew ID and GET /jobs?active_only=true with pagination.
There are no demo crew IDs on the live path. Remaining jobs appear in server order;
completed stops disappear without deleting their database records.

The focused crew tab requests foreground GPS and sends fresh observed coordinates
and timestamps to POST /crews/me/location, initially and every 30 seconds. It
retries on foreground return and offers Refresh GPS. Backgrounded/unfocused or
signed-out screens stop publishing. Denied or unavailable location remains visible;
the organiser cannot publish its own location as another crew's position.

Start stop sends a version-checked job PATCH with a durable command ID. Take cleanup
photo opens the existing camera. Review and submit copies evidence into durable
app storage before multipart POST /jobs/{id}/completion. No model examines these
photos. Retakes are possible before submission; uncertain submissions keep their
original bytes, version and command ID. Completion is never optimistic and cannot
be undone through a crew toggle.

Recovery checks job audit events for the exact command ID and event kind. A
different actor's completed status is not proof our photo was accepted. Evidence
and pending commands survive app restart and are isolated by account, crew and
API environment. Temporary-file publication protects saved metadata from
interrupted writes. Definitive validation/conflict responses retain a rejected
action for recovery or explicit discard after a server audit check.

Confirmed completion refreshes remaining stops and progress. Residents refresh
their existing report to see completion, status history and authorised cleanup
photos. All linked reports reflect the job state. No public report-map endpoint,
impact analytics or retention policy is introduced.

## Additive backend query

GET /jobs now accepts active_only (default false), limit (1..100, default 100) and
offset (nonnegative, default 0). Old callers keep their existing behavior. Filtering
occurs before pagination and retains crew ownership restrictions, so historical
completed records cannot hide current work. The native staff client reads all
active pages and reports an explicit error if a 10,000-job safety bound is exceeded.

## Configuration and acceptance

Mobile uses existing EXPO_PUBLIC_API_BASE_URL, EXPO_PUBLIC_SUPABASE_URL and
EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY. No new mobile credentials are needed.
The foreground location permission description is configured in app.json;
standalone builds must be rebuilt to incorporate native configuration changes.

Backend deployment needs migration 0012, ORGANIZER_ROUTING_ENABLED=true on API
and worker, and a working ROUTING_OSRM_BASE_URL, as described in routing.md. Fresh
crew GPS and provisioned staff accounts are required. Coordinate these inputs with
the backend owner. Chalk worker and Photon activation belong to their respective
owners; this integration does not change their code, configuration or credentials.

Run mobile tests, TypeScript and lint, native bundle exports, backend contract and
Python checks, and PostgreSQL CI. External Auth/Storage/road calls in automated
tests are controlled substitutes; these checks are not live provider acceptance.

On real devices verify: resident upload -> assessment and job -> crew GPS ->
organiser preview/dispatch -> assigned crew start -> cleanup photo -> resident
completion evidence. Exercise an interrupted upload, a lost dispatch response,
logout/account switching, denied GPS and recheck release. Coordinate new test
records and preserve the shared illustrative fixture.
