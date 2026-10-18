# Hackathon finish: one report through cleanup

Use one real report from submission through resident-visible completion, one
isolated crew, the organiser browser and one phone. This checklist adds crew
preparation to [the organiser prototype runbook](organizer-prototype.md); it does
not activate an assessment session or establish live acceptance by itself.

## Public organizer deployment

1. Merge and push the reviewed revision before creating or updating services.
   The existing API service is manually managed. `render.dev.yaml` is its
   reproducible API-only configuration, not an automatically synced Blueprint.
   Apply its routing-enabled, messaging-disabled and OSRM values to the existing
   service while preserving private environment values. Apply migration 0015 and
   deploy the exact API revision using the [prototype runbook](organizer-prototype.md).
   Blueprint adoption/sync requires a deliberate separate step; do not select the
   legacy `render.yaml`.
2. Create `wastegrid-organizer` as a separate Render static site on the same
   repository's `main` branch. With the MCP creation tool, which does not expose
   a root directory, use build `cd web && npm ci && npm run build` and publish
   path `web/dist`. Set `NODE_VERSION=22`, `SKIP_INSTALL_DEPS=true` and the three
   public values `VITE_API_BASE_URL`, `VITE_SUPABASE_URL` and
   `VITE_SUPABASE_PUBLISHABLE_KEY` from the reviewed client configuration. These
   enter the browser bundle; never supply database, service-role, API-agent or
   Chalk credentials. Keep automatic deploys off.

   The MCP tool does not expose redirect/rewrite rules. In the static site's
   Render Dashboard, add **Rewrite** from `/*` to `/index.html` before checking
   direct browser routes.

   Alternatively, deliberately create a separate Blueprint with **Blueprint Path
   `render.organizer.yaml`** after it is merged. It declares only the static site,
   with root `web`, build `npm ci && npm run build`, publish `dist`, Node 22,
   automatic deploys off and the SPA rewrite already included. It is a reproducible
   alternative to manual creation; do not create a second site for the same demo.
3. Copy the actual HTTPS site origin from Render (scheme and host, no trailing
   slash). Add that exact origin to the API's `CORS_ORIGINS` JSON array while
   preserving existing local origins, then deploy the API with the new settings.
   Set the same `DASHBOARD_ORIGIN` and `CORS_ORIGINS` in the doctor's local env
   file. For Blueprint users, `sync: false` prompts only during initial creation;
   update existing service values in Render's Environment settings. Vite
   configuration changes require a fresh static-site build.
4. From the clean checkout of the deployed API revision, run:

   ```sh
   python -m scripts.organizer_doctor \
     --env-file /home/omerh/WasteGrid/.env \
     --expected-revision FULL_DEPLOYED_API_COMMIT_SHA
   ```

   Open the public site's `/admin` route, sign in as the organizer, and reload
   `/admin/reports/REPORT_ID` directly to check the SPA rewrite. Confirm the
   expected report and crew appear. This publishes the UI and checks API/CORS;
   the assessment window still starts only with the explicitly approved session
   commands below.

The Blueprint paths follow Render's [monorepo root-directory rules](https://render.com/docs/monorepo-support)
and [static-site rewrite rules](https://render.com/docs/redirects-rewrites).
Both files were validated against Render's public JSON schema. The Render CLI
was unavailable for platform validation; when available, run
`render blueprints validate render.dev.yaml` and
`render blueprints validate render.organizer.yaml` before syncing.

## Before starting the assessment window

1. Merge/review and deploy the intended API revision, apply migration 0015, and run
   the organiser doctor from a clean checkout of that same revision. Keep
   `ORGANIZER_ROUTING_ENABLED=true` and `MESSAGING_PILOT_ENABLED=false`. Leave
   general workers and all Photon pollers stopped. Use the prototype runbook's
   exact commands and retain the deployed revision in the evidence record.
2. Designate an existing Supabase Auth account for the demo crew. A separate
   provisioned account is needed if the candidate already has an organiser or
   another crew role. The command below does not create Auth users or change
   passwords. Store credentials in the normal private handoff, not this document.
3. Obtain explicit initial coordinates for the demo crew's starting point. They
   satisfy the stored location schema only; they are never treated as a fresh
   device location. From the reviewed repository root and backend Python
   environment, substitute the real UUID and coordinates:

   ```sh
   python -m scripts.provision_demo_crew \
     --env-file /home/omerh/WasteGrid/.env \
     --user-id CREW_AUTH_USER_UUID --latitude LATITUDE --longitude LONGITUDE --check
   ```

   `would_create` means the read-only check passed. Repeat the same command
   without `--check` to create **Hackathon Demo Crew**, its staff-role link and
   ownership audit record atomically. Default equipment is gloves, trash bags and
   a broom; its shift is 120 minutes. Supply `--equipment` with actual available
   catalog items if the chosen cleanup needs more, and retain that same equipment
   argument on later checks. Do not claim equipment merely to bypass routing.

   The stable crew UUID prevents duplicate creation. Repeating preparation while
   the crew is unused reports `ready` and changes nothing, including any device
   GPS already received. Existing staff roles, unexpected crew configuration,
   ownership mismatches and current or historical assignments are refused; this
   tool never resets a completed demonstration or alters the illustrative fleet.
   After creation, `--latitude` and `--longitude` may be omitted for checks.
4. Sign in as the crew once on the phone and verify `/auth/me` resolves that crew.
   Confirm the normal location permission flow works. Sign out, then sign in as
   the resident who will submit the report. Keep app storage intact during every
   account switch; report history belongs to that account on this device.
5. Prepare the organiser browser, the phone, a real ordinary-cleanup photo and a
   short screen recording. If the selected spot has an unresolved report within
   10 metres, expect duplicate review; do not invent another location. Finish
   setup before consuming the one-time assessment window.

## One-phone demonstration

1. Create and run the approved assessment session using the prototype runbook.
   The unchanged limit is four image attempts total: the two frozen pending
   reports and at most two new real reports across the entire project, within
   60 minutes. Coordinate submissions with teammates. Creation starts the clock;
   failures consume attempts. Do not create another run to reset the budget.
2. As the resident, submit one report with the real photo, caption and GPS or a
   confirmed map pin. A typed address alone is insufficient. Save its public
   reference and observe backend confirmation. Keep the same report for every
   remaining step; do not resubmit it to escape a review state.
3. In the organiser browser, observe a committed assessment. If required, inspect
   the photo and explanation and make the normal review decision. For an ordinary
   cleanup, supply a category, real equipment, service estimate, sufficient
   evidence and a reason. Resolve any duplicate/missing-information concern
   honestly. A pending assessment cannot be approved. A settled failed/review
   result can be manually reviewed. Confirm the resulting report has a linked
   job **and a priority** before proceeding; approval alone does not fill a null
   priority. Leave unrelated held reports and fixture assignments untouched.
4. On the same phone, sign out of the resident account and sign in as the
   designated demo crew. Refresh its actual GPS using the crew flow. Keep that
   screen foregrounded. The normal location/preview freshness window is two
   minutes, so refresh GPS immediately before preview/dispatch as needed.
5. In the organiser browser, select only this report's job and **Hackathon Demo
   Crew**. Preview the road route, inspect its stops/estimates, and confirm the
   dispatch. Use the committed receipt and crew route card as the result.
   Uncertain responses must be recovered with the original command; do not submit
   a replacement dispatch. Do not select illustrative jobs to resolve a scope
   error.
6. Refresh the crew route on the phone, start the assigned stop, perform the
   demonstration cleanup and confirm completion. A cleanup photo is optional;
   attach one when available. Completion is crew-submitted, not independently
   verified.
7. Sign out of the crew account and back into the same resident account on the
   same phone. Open the original report in **My reports** and refresh its status
   and timeline. Verify completion and evidence; reopen Explore to check the
   public feed. Nearby unresolved reports can legitimately keep a shared marker
   visible.
8. Stop and drain the approved assessment run as documented. Record the final
   counters, the report reference, deployed revision, preview/plan receipt and
   observed resident outcome. Keep credentials, private report tokens, signed
   photo links and precise coordinates out of shared evidence.

A successful rehearsal means the same real report has a committed assessment,
review/job, dispatch, crew completion and resident-visible outcome. A green health
endpoint, a fixture route or a passed automated test is not evidence of that live
journey. Preserve the recording as a fallback for connectivity/provider failure.

## Explicit additional recording capacity

The default approval remains four image attempts and two new reports. A user may
explicitly authorize additional capacity; this requires migration 0017 and an
append-only capacity grant. Never reset counters, delete the original run, or
edit an already applied migration. The existing API and scoped worker already
read the persisted limits, so this database extension does not require an API
redeploy.

For an exhausted or expired, closed, drained run, use the deployed revision and
a fresh command UUID. Retain that UUID for retries: repeating the same command
is idempotent, and changing its approved scope is rejected.

```sh
python -m scripts.extend_assessment_demo \
  --env-file /home/omerh/WasteGrid/.env \
  --api-url https://wastegrid-api-dev.onrender.com \
  --expected-revision DEPLOYED_SHA --run-id ORIGINAL_RUN_UUID \
  --command-id NEW_APPROVAL_UUID \
  --additional-attempts 5 --additional-reports 5 \
  --reason "User approved five additional recording attempts"
```

Each grant permits 1–20 additional attempts and 0–20 additional reports, with
lifetime limits capped at 100 each. It opens one new hour, preserves all consumed
attempts and admitted reports, and records the old and new limits, expiry,
revision and reason. The database refuses increases without a matching audit
record, changes to original report scope/model/identity, counter decrements,
active-worker overlap, and edits or deletion of grant history. Resume the same
scoped worker using its existing command and the deployed revision recorded by
the grant. Failed reports are retained and do not automatically retry; newly
submitted eligible reports can use the extra admission slots.
