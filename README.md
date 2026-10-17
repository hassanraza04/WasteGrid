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

The native mobile app uploads photos, GPS coordinates and resident answers to
FastAPI. It saves the report UUID, private token and an immutable upload draft
before submission. **My reports** recovers interrupted uploads and reads status
with that report's token. Native credentials use Expo SecureStore; Expo web
report submission is not supported by this storage adapter.

The web entry point is the live organiser dashboard at `/admin`. Sign-in uses
Supabase Auth and checks the backend `/auth/me` role before reading reports.
Sessions stay in memory and refresh while the page is open; reloading requires
sign-in again. Report photos are loaded through the authorised access endpoint.
The previous browser-local prototype remains in source for its existing tests,
but is not mounted by the application entry point.

Copy `mobile/.env.example` to `mobile/.env.local`, and `web/.env.example` to
`web/.env.local`. Supply the project's **publishable** Supabase key in the web
configuration. No backend secret, staff password or resident token belongs in
these public settings. Restart development servers after configuration changes.

```bash
cd web
npm ci
npm run dev -- --host 127.0.0.1
```

Open **http://localhost:5173/admin**. The shared backend allows that browser
origin; `http://127.0.0.1:5173` is a different origin. Sign in with a provisioned
organiser account. **Refresh reports** reads the newest persisted records.

```bash
cd mobile
npm ci
npm start
```

Use a native development build or compatible Expo Go. Capture a photo, allow GPS,
answer the fire/sharp-object questions, and submit. Wait for backend confirmation;
a failed upload remains available under **My reports**. Keep this device's app
storage: the public reference cannot recover a lost resident token.

The first connection milestone does not enable the assessment worker, Photon,
crew completion screens, or the proposed routing preview/dispatch workflow.
New reports can remain assessment-pending while the worker is inactive. Do not
connect a preview button to the current `/plans/generate` endpoint: its worker
applies assignments immediately.

Run checks with Node 22.18 or newer (CI uses the current Node 22 release):

```bash
(cd web && npm run coverage && npm run build)
(cd mobile && npm test && npx tsc --noEmit && npm run lint && npm run audit:ci)
```

The integration is based on merged `main`. Nikolas's unmerged UI branch can reuse
`mobile/src/services/reports.ts` and `report-client.ts`; its placeholder login,
report arrays and route calculator still require separate integration.

See [repository safety](docs/repository-safety.md) for backend checks and
[the mobile contract](docs/backend/mobile-handoff.md) for API details.
