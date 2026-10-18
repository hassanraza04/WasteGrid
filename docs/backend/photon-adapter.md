# Photon iMessage adapter

The adapter polls Photon for iMessages, submits inbound events to the WasteGrid
backend, and sends backend-prepared replies. Backend persistence owns the report
and conversation state; SQLite stores transport checkpoints and delivery identity.
There is no local echo fallback.

## Choose the mode

- **Supervised pilot:** `MESSAGING_PILOT_ENABLED=true` selects the bounded
  Photon–Chalk flow. Follow the [pilot runbook](photon-chalk-pilot.md), including
  deployed revision, migrations, exact scope, counters, and preflight.
- **Legacy backend adapter:** leaving the pilot flag false selects the earlier
  backend conversation/delivery flow. It still requires a configured reachable
  backend and explicit report linking/opt-in.

Do not use the legacy launch command to bypass the pilot's activation checks.

## Configure the legacy adapter

From the repository root, create `.env` from [the example](../../.env.example)
if it does not exist, then set:

| Variable | Purpose |
| --- | --- |
| `PHOTON_PROJECT_ID` / `PHOTON_API_KEY` | Server-side Photon project credentials. |
| `PHOTON_AGENT_SENDER_ID` | Photon sender used for replies. |
| `WASTEGRID_BACKEND_URL` | Reachable backend origin. |
| `WASTEGRID_MESSAGING_API_KEY` | Must match the API's `MESSAGING_API_KEY`. |
| `PHOTON_POLL_INTERVAL_SECONDS` | Poll interval; example default is 2 seconds. |
| `WASTEGRID_TIMEOUT_SECONDS` | Backend request timeout; example default is 10 seconds. |
| `PHOTON_DELIVERY_DB_PATH` | Durable local ledger; default `.data/photon-delivery.db`. |

Start only after backend URL, integration key, and sender configuration are ready:

```bash
uv sync --locked
uv run --env-file .env python -m api.messaging.run_imessage_agent
```

Send a new iMessage to the Photon line after the process logs that it is polling.
The first run starts at the current time; later runs resume from the saved
checkpoint. Non-iMessage events and blank messages are ignored.

## Delivery and recovery

Backend records provide stable outgoing IDs, destinations, leases, acknowledgements,
and retry state. In legacy backend mode, SQLite also binds immutable rendered
text to each outgoing UUID. Successful backend acknowledgements include the
actual `sent_text`; see [dashboard handoff](dashboard-handoff.md).

Preserve the ledger when restarting. Provider acceptance alone does not prove
recipient delivery. The pilot has additional rules for uncertain sends and late
receipts; follow its runbook rather than resetting unknown records or replaying
messages manually.

The local `.env` and `.data/` files are Git-ignored. Provider credentials and the
messaging integration key belong only in server/adapter environments.
