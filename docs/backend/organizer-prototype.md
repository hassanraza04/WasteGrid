# Organiser prototype operations and supervised assessment demo

This guide covers the branded organiser console, read-only operational APIs,
road previews and the approved bounded assessment session. Deployment and live
acceptance are separate from local automated verification. Until a reviewed
revision is merged and deployed, keep the demo inactive, the general worker
stopped and every Photon/message poller stopped. Messaging pilot remains off.

## What each indicator establishes

- **Configuration:** the API has organiser routing enabled and an OSRM base URL.
  The startup doctor verifies the deployed revision, expected contracts and exact
  development origins. Neither configuration nor `/ready` proves that Chalk has
  successfully assessed a photo.
- **Worker heartbeat:** a local scoped worker holds the persisted ownership lease
  and renews it every 10 seconds. The console marks it stale/offline after 45
  seconds. The console does not start a worker or contain model credentials.
- **Observed assessment:** `last_success_at` records a valid image assessment
  committed to PostgreSQL. An invalid response or timeout spends its reserved
  attempt but does not establish provider success.
- **Crew availability:** a crew is available for work. Its separate GPS timestamp
  establishes location freshness; availability never establishes fresh GPS.
- **Road estimate:** the deterministic optimiser uses OSRM road durations. Map
  geometry comes from the OSRM Route service and is labelled separately from
  committed numerical estimates. A geometry failure does not revise estimates
  or turn connecting straight lines into road paths.

The console refreshes operational data every 15 seconds while foregrounded.
Real data is the default. Illustrative records require the labelled toggle.
Completed-in-24-hours counts distinct currently completed jobs with a completion
record in the last 24 hours; it is not a completion rate.

## Release and startup preflight

1. Review and merge the prototype changes. Use a **clean checkout of that exact
   merged commit** for both the deployed API and local worker. Keep the separate
   Expo Web native-map fix isolated until its own review is complete.
2. Apply migration `0015_assessment_demo.sql` through the normal migration runner
   using the ignored backend environment. This adds the approval record and task
   binding without admitting or processing any report. Existing illustrative
   reports and assignments remain unchanged. For example, from a shell where the
   backend variables are already configured:

   ```sh
   python -m scripts.migrate
   ```

   Do not print or commit database URLs, service keys, router keys or `.env` files.
   The migration runner verifies checksums and refuses drift; do not edit an
   already applied migration or reset approval/counter rows.
3. Deploy that reviewed merged revision to the existing Render service. Preserve
   `ORGANIZER_ROUTING_ENABLED=true`, `MESSAGING_PILOT_ENABLED=false`, the existing
   Supabase/Storage configuration and the configured OSRM base URL. General
   workers, messaging adapters and Photon pollers remain stopped on every team
   member's machine.
4. Verify public frontend variables and run the read-only doctor from the same
   checkout. Replace `MERGED_SHA` with the full 40-character deployed commit:

   ```sh
   python -m scripts.organizer_doctor \
     --env-file /home/omerh/WasteGrid/.env \
     --expected-revision MERGED_SHA
   ```

   `--offline` checks configuration only; it does not establish deployment
   readiness. The online doctor checks public API/Supabase settings, publishable
   key type, exact CORS origins, organiser routing, disabled messaging, OSRM
   configuration, migration-aware readiness, revision headers and organiser /
   routing contracts. It does not invoke AI or collect GPS.
5. Start the web development server from `web/` with the checked-in dependencies:

   ```sh
   npm ci
   npm run dev -- --host 127.0.0.1
   ```

   Vite uses port **5173** with `strictPort`. Resolve an occupied port instead of
   silently moving to a different origin. Use exactly the origin configured in
   CORS; `http://127.0.0.1:5173` and `http://localhost:5173` are distinct origins.
6. Sign in with a verified organiser account. Check Overview, Reports and Routing
   navigation repeatedly. `/admin`, `/admin/reports` and `/admin/dispatch` are
   absolute routes. Confirm that captions remain in evidence, list headings are
   neutral, held reports retain their holds and thumbnails require authentication.

## Approved assessment scope and hard limits

The only approved session freezes these existing report UUIDs by reference:

- `WG-19706F8BF5A2`
- `WG-D0820BDCA7E0`

Creation refuses activation unless both reports still have valid coordinates and
private photo metadata, remain pending and unlinked, and each has exactly one
unattempted pending assessment task with no existing triage work. A changed report
is not reset or replaced. `WG-8D724DBFF0D8` stays unchanged with its review hold;
`WG-8A03FEB19474` is excluded.

The same approval may admit **at most two newly submitted real reports** after
activation, for at most **four image attempts total**. New-report slots are
**project-wide**, because report/account associations currently live on devices.
Coordinate with the team before activation; the first eligible reports admitted
within the window use the slots, regardless of which resident account submitted
them. Illustrative, pre-activation, unlocated or already linked reports cannot
use a new slot.

Admission and fresh image processing end after **60 minutes**. One assessment can
be in flight at a time. Each attempt is durably charged before Storage/model
activity, using the explicit frozen route `xai/grok-4.3`. A timeout, malformed
response, uncertain failure or process interruption does not refund or replay an
image attempt. Valid observations feed the existing backend priority/review rules
and deterministic triage; the demo never calls a planning/follow-up model, leases
unrelated backlog, assigns crews or dispatches routes.

The approval's identity, report UUIDs, model, revision, window and limits are
immutable. Usage counters only increase. Creating another run cannot reset this
approval, even after stopping it. A changed scope or fresh budget requires a new
explicitly reviewed approval; it is not an operational retry.

## Create, run/resume, inspect and stop

Run these commands from the clean reviewed repository root using the backend
Python environment. The ignored root environment must have database and private
Supabase Storage access, Chalk router key/environment, explicit
`CHALK_MODEL=xai/grok-4.3`, organiser routing on and messaging pilot off.
`create` and `run` both verify the deployed revision/safety flags and local clean
checkout; do not bypass those checks. Creation verifies private bucket metadata
and the existing approved photos in Storage. No image is assessed by `create`.

1. Create once, immediately before the supervised session. **This starts the
   60-minute window.** Save the returned `run_id`:

   ```sh
   python -m scripts.assessment_demo --env-file /home/omerh/WasteGrid/.env create \
     --api-url https://wastegrid-api-dev.onrender.com \
     --expected-revision MERGED_SHA
   ```

2. Start the scoped worker in a supervised local terminal using that ID:

   ```sh
   python -m scripts.assessment_demo --env-file /home/omerh/WasteGrid/.env run \
     --api-url https://wastegrid-api-dev.onrender.com \
     --expected-revision MERGED_SHA \
     --run-id RUN_UUID
   ```

   Do not start `python -m api.worker`, a planning worker or a messaging process.
   The dashboard only observes this process. A second scoped process cannot take
   a live owner lease. During restart recovery, a still-live task lease may delay
   cleanup for up to five minutes; do not reset it or submit a replacement image.
   Interrupted inference terminalizes without replay once recoverable. After a
   restart, run the same command with the **same run UUID** and revision. `--once`
   processes at most one admissible task for supervised troubleshooting; it does
   not reset scope or counters.
3. Inspect status from another terminal without starting processing:

   ```sh
   python -m scripts.assessment_demo --env-file /home/omerh/WasteGrid/.env status
   ```

   Inspect `used_attempts`, `new_reports_admitted`, queue counts, heartbeat and
   `last_success_at` separately. Dashboard task failures expose sanitized codes,
   not provider exception bodies, credentials, signed URLs or resident text.
4. Stop fresh admission/assessment claims explicitly:

   ```sh
   python -m scripts.assessment_demo --env-file /home/omerh/WasteGrid/.env stop \
     --run-id RUN_UUID
   ```

   Stop/expiry allows an already claimed assessment to finish and permits
   interrupted-task cleanup and deterministic triage earned by successful images.
   Keep the scoped worker running long enough to drain that work, then confirm it
   exits with the approval closed. If the process was already stopped, resume the
   same run solely to drain; the stopped approval cannot admit or claim fresh
   images. Unattempted bound images remain pending and cannot be stolen by a
   general worker. Existing review holds survive both successful and failed
   assessments.

## Live end-to-end acceptance

The following is an acceptance checklist, **not evidence that the live steps have
already occurred**. Automated tests use fixtures/fake providers and establish
software behaviour only.

1. Confirm the exact deployed revision, migration 0015, disabled messaging,
   stopped general workers/pollers and the team's two new-report admission scope.
   Activate/run the approved session and observe a fresh worker heartbeat.
2. Inspect automatic assessment of the two frozen pending reports and submit no
   more than the two agreed new coordinate-bearing real reports. Observe real
   committed Chalk assessments and the persisted attempt counters. If a result
   needs review, demonstrate that state honestly; do not clear a hold to force a
   successful-job narrative.
3. Review evidence and backend explanations as organiser. Use the normal
   confirmation/version-checked action panel for an explicitly approved eligible
   report. Any job change follows existing server triage rules. Preserve the
   existing held report and the excluded report. Confirm an actual unassigned job
   exists before describing routing as available.
4. Agree on an isolated approved **real crew and job scope**, leaving existing
   illustrative assignments untouched. Sign the crew in on a device, grant GPS
   permission and obtain real fresh timestamped GPS. An availability checkbox or
   manually assumed location is insufficient. If no isolated approved crew is
   available, stop this part of acceptance until that scope is supplied.
5. In Routing, select the approved crew/job. Existing assignments of a selected
   crew are mandatory scope: inspect named missing jobs and use **Include required
   jobs** only after reviewing them. This explicitly widens selection within the
   25-job limit and invalidates an old preview. Do not include fixture assignments
   simply to make a test succeed.
6. Preview with defaults **120 minutes, 10 stops, return to start on, partial
   dispatch off**. Inspect ordered/fixed stops, return travel, equipment/GPS
   eligibility, omissions, objective estimates and changes from the current plan.
   Confirm a real road path or an honest geometry-unavailable state. OSM
   attribution remains visible; do not bulk prefetch/offline-download tiles.
7. Dispatch only after the final confirmation. If partial dispatch is explicitly
   enabled, separately acknowledge its exact omissions. Browser IndexedDB must
   durably save the account/environment-specific selection, command, scope,
   consent and attempt barrier before POST. Storage failure blocks submission.
   After refresh or an unknown response, inspect the original preview/receipt;
   never create a replacement command or widen scope automatically. A definite
   conflict requires refreshed operational state and a newly reviewed preview.
8. Verify the committed plan/actor/command receipt and printable committed crew
   route card. Distinguish estimated travel/service minutes from actual crew
   progress. Have the isolated crew start and complete its assigned job through
   the normal authenticated app flow, preserving completion evidence.
9. Check Resident B's login-required history and evidence on the same phone.
   Device-draft import is explicit; backend report tokens authorize individual
   reports and do not create server-side account ownership. Confirm persisted
   progress/completion and public-map state. Nearby open reports may keep an
   aggregated map marker visible after one report completes.
10. Stop/drain the session and verify no scoped/general worker or Photon poller
    remains running. Record final counters and remaining bound work; preserve the
    approval history. Messaging stays disabled throughout.

## Evidence record

Keep sanitized local test evidence separate from live evidence. For each live
step record timestamp, reviewed/deployed SHA, migration state, run/preview/plan or
public report reference, expected outcome and observed committed outcome. Do not
record private report tokens, staff passwords, API keys, signed photo URLs,
resident caption text or precise coordinates in logs, screenshots or PR comments.

Use explicit evidence labels:

- **Automated:** fixture-backed Python/web/mobile checks, contract generation,
  builds and responsive browser walkthroughs; no live provider implication.
- **Live configuration:** observed deployed revision, flags, contracts and
  migration checks; no successful-inference implication.
- **Live processing:** observed heartbeat, reserved counters and committed valid
  assessment/failure; include whether a hold prevented automatic job creation.
- **Live operations:** actual approved review/job, fresh crew GPS, road preview,
  matching committed dispatch receipt and crew/resident/public-map observations.

No messaging acceptance or recipient delivery is claimed by this milestone.
Provider availability, local worker ownership and completed operational outcomes
must each be demonstrated independently.
