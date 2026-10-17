# Organiser routing and crew completion integration

Plan based on main `26f01b6` after PRs #12 and #13 merged.

## Goal and scope

Connect the existing mobile Dispatch and My route screens to the existing FastAPI
backend. A signed-in organiser selects real crews, computes and approves a route
preview, and dispatches it. Each crew sees its assigned jobs, starts its next stop,
captures cleanup evidence and submits completion. Residents can then retrieve the
completed status and cleanup photo through their existing report history.

Keep the implemented 10 m proximity-review policy. Do not add retention or deletion.
Reuse the current authentication, camera, file storage, schemas and API endpoints.
Do not introduce another optimiser, provider, queue service or dashboard.

## Contract decisions

- Use database job IDs as stop identities, not resident references or demo IDs.
  Resolve stop coordinates and labels from real jobs and associated report data
  available to the authenticated role. Crew callers cannot use organiser-only APIs.
- The routing scope is all eligible unassigned jobs plus eligible work assigned to
  selected crews. There is no city filter in the compute contract. Show this scope
  explicitly and replace the city-based planner presentation for live dispatch.
- Remove unsupported shift-hours, maximum-stop and return-to-start controls from
  live planning. The backend currently accepts only selected crew IDs and uses
  its configured collection time and priority-aware travel-time objective.
- Keep Compute and Dispatch separate. Computing never writes assignments.
- Preserve fixed work and unselected crews according to the backend. Surface
  exclusions, reassignments and non-dispatchable results before approval.
- The MVP backend supports at most five selected crews and 25 eligible scoped jobs.
- Replace the reversible cleaned toggle with assigned -> in_progress -> completed.
  Completion requires a photo. There is no general crew undo endpoint. Resident
  rechecks and audited organiser release continue through existing contracts.
- Display backend minutes and ETAs; do not invent kilometres or road geometry.
  Existing map directions links may guide crews to the next stop.

## 1. Shared authenticated staff client

- Add a small typed transport using the existing Supabase client and configuration.
  Expose a guarded way to obtain a current access token without persisting another
  copy. Resident report tokens remain separate from staff authentication.
- Validate the current account/role around async operations; cancel or ignore old
  responses after logout, account changes, screen changes and superseding requests.
- Add timeouts and controlled loading, empty and failure states. Distinguish denied
  access, stale/version conflicts, disabled routing and provider/data failures.
- Reuse existing API fields rather than creating parallel route/assignment schemas.

## 2. Real crews, jobs and foreground GPS

- Organiser reads GET /crews, GET /jobs and GET /plans/current for the fleet and
  assignment overview. Crew reads GET /jobs, which the backend scopes to itself.
- Use crew identity from the verified session. Remove demo-crew lookups from the
  live path, including the dependency that assumes a real UUID exists in demo data.
- On the crew screen, obtain a fresh foreground GPS observation and send
  POST /crews/me/location with its real recorded_at timestamp. Refresh periodically
  while the relevant screen is active (initially every 30 seconds), on foreground
  return, and through an explicit refresh action. Avoid overlapping observations.
- Stop location polling when backgrounded, unfocused or signed out. Show permission
  denial and stale location clearly; never substitute an organiser's GPS for a crew.
- Show freshness/availability to the organiser. The server remains authoritative
  about availability, location age, displacement and selection validity.
- Check whether historical completed jobs can crowd the GET /jobs 100-row cap.
  If necessary, add the smallest backward-compatible active-job filter/pagination
  and its regression test rather than silently omitting current work.

## 3. Compute, review and dispatch

- POST /routing/previews with {crew_ids}; retain the returned preview ID and full
  response. Join stops to jobs for map coordinates and display labels.
- Show ordered stops, priorities, travel/service/total time, fixed stops, changes
  of ownership/order, exclusions and unassigned reasons. Make missing coverage
  prominent. Disable dispatch unless dispatchable is true and the preview is fresh.
- Changing selection invalidates the local preview. Prevent duplicate submissions
  and ignore late compute responses. Recompute after stale-data conflicts.
- POST /routing/previews/{id}/dispatch with one stable command_id per approval.
  Keep the same identity for retries after an uncertain outcome; use GET of the
  preview to recover whether it was already dispatched. Do not silently dispatch
  a newly computed replacement plan without renewed organiser approval.
- Refresh crews, jobs and plan after confirmed dispatch. Preserve the backend's
  atomic ownership boundary; do not write assignments through legacy job PATCH.
- Show review-gated/blocked work with an explanation. Reuse existing audited review
  resolution when exposed; never clear review flags locally to make a preview pass.

## 4. Crew execution and completion evidence

- Fetch and display ordered assigned jobs and their server status/version. Poll
  while focused and refresh on focus, user request and successful mutations so a
  route dispatched on another device becomes visible without restarting the app.
- PATCH /jobs/{id} with status=in_progress, expected_version and command_id to
  start a stop. Retain command identity for uncertain retries; refresh on conflict.
  Let the backend enforce order, current ownership and review gates.
- Reuse the camera UI for a cleanup photo. Save durable bytes and immutable
  completion metadata scoped to the account/job before submission, following the
  existing resident draft storage patterns.
- POST /jobs/{id}/completion as multipart photo, command_id, expected_version and
  optional note. Do not call Chalk for completion images.
- Retry the same evidence and command after ambiguous failures; recover job state
  before reuploading. Keep failed evidence available and do not mark a job complete
  optimistically. Account changes must not expose or submit another crew's draft.
- After confirmation, update progress and route markers, refetch server state and
  expose the next stop. Retain a completed state without an unsupported undo action.

## 5. Resident confirmation and map boundary

- Verify existing My reports status refresh, update history and authorised cleanup
  photo access reflect job completion for every linked report.
- Update organiser/crew route markers from actual job status after refresh.
- The resident-wide map has no connected public job-list contract. Building that
  public map feed and its privacy policy is a separate follow-up; do not expose
  organiser report endpoints or resident credentials to implement public pins.

## 6. Verification and delivery

Focused tests should cover:

- Correct staff bearer credentials, role restrictions, logout/account changes and
  ignored late responses; no fallback to demo routes after network errors.
- Fresh crew observations, denied permission, stale location, foreground polling
  and cleanup; no overlap between in-flight refreshes.
- Selected crew IDs, preview-only computation, unsupported controls absent, fixed
  and unselected work, omissions, expired previews and stale dispatch conflicts.
- Duplicate taps and lost dispatch responses recover without another assignment.
- Backend-ordered starts, stale versions and reassigned/blocked/rechecked jobs.
- Required cleanup photo, durable evidence after restart, same-command retry after
  a lost response and account-isolated completion drafts.
- Server-confirmed completion refreshes route progress and resident status/photos.
- Active work remains visible when historical jobs exceed a response page.

Run mobile tests, TypeScript and lint; run affected backend tests and contract
checks for any backend adjustment. Keep generated exports in sync. Run required CI
checks before requesting review.

Live acceptance requires migration 0012, routing enabled on both API and worker,
a working OSRM driving Table endpoint, provisioned organiser/crew accounts, fresh
crew GPS and an active configured assessment worker. Perform state-changing demo
acceptance with coordinated test reports rather than resetting the shared fixture.

Acceptance sequence: resident submits report -> worker assesses/triages -> eligible
job exists -> crew publishes GPS -> organiser computes and dispatches -> assigned
crew starts -> submits cleanup photo -> resident refresh shows completion/evidence.
Also test a lost response and a resident recheck followed by organiser resolution.

## Suggested implementation order

1. Shared staff transport, real job/crew reads and GPS updates.
2. Organiser preview and atomic dispatch integration.
3. Crew start and durable photo completion integration.
4. Recovery/account-isolation tests, resident confirmation and live acceptance.

Keep commits independently reviewable. This plan does not change deployment or
credentials; live service activation remains a coordinated acceptance step.
