# WasteGrid demo walkthrough

This guide covers the connected native app, organizer dashboard, and backend.
The browser landing directs residents and crews to Android; legacy report URLs
redirect there. Use the native app to demonstrate a report appearing in the API.
For the current supervised single-phone sequence and bounded assessment session,
follow the [one-phone finish checklist](backend/hackathon-finish.md) and
[organizer operations runbook](backend/organizer-prototype.md).

## Before starting

1. Configure the clients using the [root quick start](../README.md#getting-started).
   Use the same API and Supabase project in both clients.
2. Obtain a provisioned organizer account and crew accounts privately. Confirm
   `/auth/me` returns their protected roles and the correct crew IDs.
3. Confirm the deployed API revision and migrations support the app. Routing
   needs `ORGANIZER_ROUTING_ENABLED=true`, a working OSRM-compatible service,
   and fresh locations from the selected crews.
4. Decide whether to demonstrate new-report assessment or already approved work.
   Shared-demo assessment uses the approved scoped worker and preserved four-attempt
   budget. Keep general workers stopped. Existing eligible jobs can be routed
   without starting a general worker or Photon poller.

New uploads may remain pending while the worker is stopped. Review/failed reports
cannot be made routable by hiding their flags. Use approved test records and
preserve other people's reports, assignments, and messaging work.

## Connected walkthrough

| Step | Action | Expected result |
| --- | --- | --- |
| 1. Resident report | Capture a photo, add a caption, and confirm GPS or a map pin. If GPS is unavailable, select and confirm the location on the map. An optional address adds context. Submit and wait for server confirmation. | The app retains a private token and report reference. An uncertain upload remains available in **My reports**. |
| 2. Organizer review | Sign in at `/admin`, refresh reports, and inspect the new report and authorized photo. | Assessment state and review requirements are visible. Eligible assessed reports can become jobs; older address-only reports need location clarification before routing. |
| 3. Crew location | Sign in on the crew devices and open **My route** in the foreground. | Fresh, crew-owned locations become available to the planner. |
| 4. Route preview | In mobile **Dispatch** or web **Routing dispatch**, select the intended jobs and crews and compute a preview. Include every unfinished assignment of each selected crew. | Ordered stops, estimates, exclusions, and reassignments are available for review; assignments have not changed. |
| 5. Approval | Review the exact proposal and confirm dispatch before it expires. Mobile partial dispatch additionally requires acknowledging omitted work. | The backend saves the approved assignments. Recover a lost response using the saved command. |
| 6. Collection | On each crew device, start its next stop. Take a cleanup photo or choose completion without a photo and confirm. | Completion persists as crew-submitted; only photos actually supplied appear as evidence. |
| 7. Resident update | Refresh the original report in **My reports** on the resident's device. | The linked job state, history, and any authorized cleanup photos are shown. |

If a preview expires or receives a definite conflict, refresh the current state,
compute a new preview, and review it again. Keep original command IDs for uncertain
outcomes; do not create a second dispatch or completion to hide a timeout.

## Recording the Worcester and Karachi demos

The staged crew-location controls below require the separately prepared local
mobile demo changes. The main app uses foreground GPS; an environment flag alone
does not add those controls. Use these staged steps only with the matching build.

Use the existing native app, hosted API, Supabase Auth, private photo bucket and
organizer dashboard for both walkthroughs. Demo login credentials stay in the
ignored `.env.supabase-demo`; roles come from the backend's protected staff table.

| Walkthrough | Crew accounts in Dispatch | Credential prefixes |
| --- | --- | --- |
| Worcester video | Hackathon Demo Crew; Hackathon Demo Crew B | `DEMO_CREW_HACKATHON`; `DEMO_CREW_HACKATHON_B` |
| Karachi in person | Illustrative Crew A; Illustrative Crew B | `DEMO_CREW_A`; `DEMO_CREW_B` |

Use `DEMO_ORGANIZER` for the organizer login. Each prefix has `_EMAIL` and
`_PASSWORD` values in the private credentials file.

For the Worcester video, capture cleanup photos in the mobile app and use
**Adjust map pin** to confirm each actual location. Each report keeps its photo
and saved coordinates together. The two crew accounts use live foreground GPS.
New uploads follow the existing assessment and organizer-review process; do not
fabricate assessments or clear review flags to make routing succeed.

For an in-person Karachi walkthrough from Worcester, keep the report pins in
Karachi and open **My route → Demo crew location** on each crew's device. Choose
**Karachi crew position**, tap a different staged starting position for each
crew, and confirm the pin. This uses the normal authenticated location endpoint
and refreshes that explicit demo position while the screen is active. It pauses
device GPS so a Worcester fix cannot overwrite a Karachi start. **Use live GPS**
restores normal observation. The control is available in development; a preview
build can opt in with `EXPO_PUBLIC_DEMO_LOCATIONS=true`.

The organizer selects the intended crews and jobs in **Dispatch**, computes and
reviews both routes, then approves dispatch. Each crew starts its next stop in
**My route**, submits completion with an optional cleanup photo, and the resident
checks the update in **My reports**. Keep example Karachi photos clearly labeled
as illustrative, with explicitly staged pins.

Routing requires every unfinished job of each selected crew to be included.
Use idle crews for Worcester recording so older Karachi assignments do not enter
the route. Preserve unrelated reports, assignments and Photon work; do not run a
global seed/reset against the shared Supabase database.

## Optional messaging demonstration

For the app composer, follow [phone updates](backend/phone-updates.md): **Status**
returns a reply and authorizes a copy to the configured registered phone. It uses
the existing bounded messaging runner, not an assessment/follow-up model worker.
For linked conversation behavior, use the
[Photon–Chalk pilot runbook](backend/photon-chalk-pilot.md) for preflight,
fixed report/chat scope, opt-in, linking, budgets, and shutdown. Starting the app
or dashboard does not activate messaging. Keep the existing delivery ledger and
pilot counters across restarts.

Record provider acceptance, provider-confirmed delivery, and recipient-observed
delivery separately. Keep private tokens, link codes, signed photo URLs, phone
numbers, account passwords, and raw private conversations out of recordings.

## What the demo establishes

Distinguish real uploads and provider results from labeled synthetic fixtures
and staged crew locations. Mobile statistics remain illustrative and hidden
from live navigation. Mobile lines show stop order; the web map separately labels
road geometry or its absence. Completion is the crew's report of its work.
Automated test results and older [verification records](backend/verification.md)
do not establish live device or provider acceptance for a new deployment.
