# WasteGrid

## Person 2 backend

The FastAPI backend, Supabase migrations, worker, proposed contracts, and setup
instructions are in [docs/backend](docs/backend/README.md). Start with
[setup](docs/backend/setup.md) and share the [contracts](docs/backend/contracts.md)
with the frontend, Chalk and Photon owners.

## Photon iMessage backend adapter

The agent polls Photon for new iMessages and submits them to the WasteGrid
backend. It sends replies that the backend has prepared. There is no local echo
fallback.

1. Create a local `.env` from `.env.example`.
2. Set `PHOTON_PROJECT_ID` and `PHOTON_API_KEY` with the values from Photon.
   Set `PHOTON_AGENT_SENDER_ID` to the Photon sender used for replies.
3. Set `WASTEGRID_BACKEND_URL` to the reachable WasteGrid backend URL and
   `WASTEGRID_MESSAGING_API_KEY` to its Person 4 integration key. The backend
   and all three backend mode settings must be ready before polling starts.
4. Start the agent:

   ```bash
   uv run --env-file .env python -m api.messaging.run_imessage_agent
   ```

5. Send a new iMessage to the Photon line after the process logs that it is polling.

The first run starts at the current time. Later runs resume from the saved poll
checkpoint. The agent ignores non-iMessage events and blank messages. The backend
owns follow-up retries, delivery retries, idempotency, and leases. SQLite stores the
Photon poll checkpoint plus immutable rendered text bound to each outgoing UUID in
backend mode. It defaults to
`.data/photon-delivery.db`; set
`PHOTON_DELIVERY_DB_PATH` to change the path. `.env` and the checkpoint database
are ignored by Git. Never commit `.env`.

## Connected resident and organiser flow

The native mobile app uploads photos, a caption and either GPS coordinates or a
manual address to FastAPI. The form omits fire/sharp-object questions; missing
answers remain unknown to the backend. It saves the report UUID, private token
and an immutable upload draft before submission. **My reports** recovers interrupted uploads and reads status
with that report's token. Checking status also displays paginated update history
and authorised report/cleanup photos. Temporary photo URLs stay in memory, refresh
on expiry and are never given backend authorization headers or stored in the image
disk cache. Definitively rejected uploads can be edited in the form
or discarded from My reports after checking that the server has not accepted them. Timeouts
and other uncertain outcomes retain their original identity and bytes.
Retaking a photo clears its location and requires a fresh lookup or a new manual
address. Draft metadata is published through a completed temporary file before
older revisions are removed. Interrupted saves retain the previous version;
unreadable records are isolated so intact history remains accessible. Their photos
and access keys are retained for recovery. Existing unversioned drafts remain readable.
Native credentials use Expo SecureStore; Expo web
report submission is not supported by this storage adapter.

The mobile app includes the new map, report, account, crew, dispatch and statistics
screens. Mobile sign-in uses Supabase Auth; staff roles and crew IDs come from
`/auth/me`, and verified accounts without a staff role are residents. Native sessions
use SecureStore, restore after restart with backend role verification, and refresh
while the app is in the foreground. Web sessions remain in memory. Report history
intentionally requires login and is filtered by account on this device;
it is not yet synced across devices. Anonymous reports remain supported, and a
signed-in user can explicitly import earlier anonymous drafts from their device.
New accounts must already be provisioned in Supabase; this milestone does not add
sign-up. Private report tokens remain the backend's report-access mechanism.

The web entry point is the live organiser dashboard at `/admin`. Sign-in uses
Supabase Auth and checks the backend `/auth/me` role before reading reports.
Sessions stay in memory and refresh while the page is open; reloading requires
sign-in again. Report photos are loaded through the authorised access endpoint.
The previous browser-local prototype remains in source for its existing tests,
but is not mounted by the application entry point.

Copy `mobile/.env.example` to `mobile/.env.local`, and `web/.env.example` to
`web/.env.local`. Supply the project's **publishable** Supabase key in both
configurations. No backend secret, staff password or resident token belongs in
these public settings. Restart development servers after configuration changes.

```bash
cd web
npm ci
npm run dev -- --host 127.0.0.1
```

Open **http://127.0.0.1:5173/admin** to match the command above. The shared backend
currently permits that origin (verified by a CORS preflight). Sign in with a provisioned
organiser account. **Refresh reports** reads the newest persisted records.

```bash
cd mobile
npm ci
npm start
```

Use a native development build or compatible Expo Go. Capture a photo, allow GPS,
enter a caption and submit. If GPS is denied, enter an address manually. Wait for backend confirmation;
a failed upload remains available under **My reports**. Keep this device's app
storage: the public reference cannot recover a lost resident token.

The mobile Dispatch and My route screens now use real staff API requests for
foreground crew GPS, route preview/dispatch, ordered starts and photo completion.
See [mobile routing and completion](docs/backend/mobile-routing-completion.md).
This change does not enable the assessment worker or Photon deployment.
New reports can remain assessment-pending while the worker is inactive. Do not
connect a preview button to the current `/plans/generate` endpoint: its worker
applies assignments immediately.

Run checks with Node 22.18 or newer (CI uses the current Node 22 release):

```bash
(cd web && npm run coverage && npm run build)
(cd mobile && npm test && npx tsc --noEmit && npm run lint && npm run audit:ci)
```

The integration includes Nikolas's UI branch and keeps resident uploads in
`mobile/src/services/reports.ts` and `report-client.ts`. Live dispatch uses all
eligible jobs and selected crews, following the backend's priority-aware road-time
objective. Unsupported city/shift/max-stop/return-to-start controls are absent from
the live flow. Crew completion requires a start and cleanup photo; there is no
ordinary crew undo action. Saved command IDs and evidence recover lost responses.
City statistics remain labelled demo previews. Public map pins require a separate
privacy-scoped feed. Nearby reports retain the existing 10 m review policy; no
automatic retention or deletion is added.

See [repository safety](docs/repository-safety.md) for backend checks and
[the mobile contract](docs/backend/mobile-handoff.md) for API details.
