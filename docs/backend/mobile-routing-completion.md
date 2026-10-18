# Mobile routing and cleanup completion

The mobile Dispatch and My route tabs now call the merged routing and job APIs.
They reuse verified Supabase sessions, with no second JWT store. Resident report
tokens remain separate. Staff responses are ignored after account changes, and
focused screens poll every 15 seconds only while foregrounded.

## Organiser

Dispatch loads real crews and active jobs. Select at most five crews and 1–25
jobs, then Compute routes. This creates a read-only preview of that explicit
scope. Include every unfinished assignment of a selected crew. See
[scoped routing](scoped-routing.md) for eligibility and conflict recovery. The
live screen adds hours, maximum stops, return-to-start and explicit partial
dispatch controls; see [routing-controls.md](routing-controls.md). City filtering
remains outside this flow.

Review per-crew time, ordered stops and priorities, fixed work, reassignments,
excluded jobs and unassigned reasons. Maps show the stop sequence, not road
geometry. Only an unexpired dispatchable preview can be approved. An incomplete proposal
requires partial mode and a separate acknowledgement of omitted work.
Approval saves a command ID before POST /routing/previews/{id}/dispatch. Recover a
lost response with the saved action; do not create a replacement command blindly.
An unresolved saved dispatch blocks another calculation. A definite dispatch 409
retires that preview and requires current-state refresh, a new computation and
renewed approval. Interrupted outcome storage permits only read-only checks;
it cannot authorize another dispatch. See the scoped-routing recovery contract.

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

Start stop sends a version-checked job PATCH with a durable command ID. The crew
can choose Take cleanup photo or Mark cleanup complete. The latter opens Confirm
completion without a photo and requires another explicit confirmation before the
action is saved and sent. Review states whether an image will be submitted. The
photo path retains the existing camera, retake and durable image-copy flow before
multipart POST /jobs/{id}/completion. No model examines these photos. Completion is never optimistic and cannot be undone through a crew
toggle.

The backend accepts the same command and version fields without a `photo`. With
no photo, it creates no photo record or Storage object; the completion audit
records `photo_id: null` and retains `verification: "crew_submitted"`. Both choices
are the crew's reported completion, not an independent inspection. When a photo
is supplied, existing size, format and private-access rules still apply. Keep
photo presence and bytes, note, version and command ID unchanged on retry;
changing them under the same command conflicts. A saved photo-free action cannot
silently acquire a photo during recovery, and a saved photo action cannot lose
its evidence when retried.

Recovery checks job audit events for the exact command ID and event kind. A
different actor's completed status is not proof our completion command was
accepted. Evidence and pending commands survive app restart and are isolated by
account, crew and API environment. Temporary-file publication protects saved
metadata from interrupted writes. Definitive validation/conflict responses retain a rejected
action for recovery or explicit discard after a server audit check.

The staff-only GET /jobs/{id} audit events now include nullable command_id for this
correlation. Public resident timelines remain redacted and expose no command IDs.

Confirmed completion refreshes remaining stops and progress. Residents refresh
their existing report to see crew-reported completion, status history and any
authorised cleanup photos that were actually submitted. An empty
`completion_photo_ids` list is valid for a completed job. Existing photo IDs remain
available as historical evidence; their presence does not establish that a later
completion included another photo. All linked reports reflect the job state. No
public report-map endpoint, impact analytics or retention policy is introduced.

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

Backend contract checks must additionally cover completion without a photo,
unchanged-command recovery, changed photo presence returning a conflict, and
resident history that does not claim a photo was submitted. Rehearse both the
photo and explicitly confirmed photo-free choices on actual devices before
claiming live acceptance. These checks do not activate the general worker or
messaging pilot.

### Review follow-up

Dispatch reads `/plans/current` with each fleet refresh, including after approval or pending-action recovery. The saved plan lists all assignments, including preserved work for unselected crews; current active job statuses identify ongoing and locked stops. Preview stops show individual travel and service durations alongside cumulative completion time.

GPS uses a cancellable one-fix location watch. After 15 seconds without a fix, it removes the subscription and releases the guard so manual, scheduled and foreground refreshes can retry. Success, provider errors, backgrounding and blur also remove the watch; late callbacks are ignored.
