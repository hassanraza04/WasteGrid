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
owns follow-up idempotency, delivery retries, and leases. SQLite stores only the
Photon poll checkpoint in backend mode. It defaults to
`.data/photon-delivery.db`; set
`PHOTON_DELIVERY_DB_PATH` to change the path. `.env` and the checkpoint database
are ignored by Git. Never commit `.env`.

## Dashboard foundation

The dashboard foundation provides public customer report flows and a separate,
development-only organizer route. It uses browser-local demo data until the report
API is ready.

```bash
cd web
npm install
npm run dev
```

Open the public customer view at the Vite URL. Open `/admin` for the organizer
view while running the development server. Production builds omit both organizer
routes. Its local sign-in is only a development adapter and is not production
authentication.

Run the frontend checks with:

```bash
cd web
npm run test
npm run typecheck
npm run build
```

Contributor quality checks and the remaining administrator safeguards are in
[repository safety](docs/repository-safety.md).
