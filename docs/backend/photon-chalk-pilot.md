# Photon–Chalk supervised pilot

Implementation branch: `codex/photon-chalk-pilot`. Live activation is a separate,
reviewed step. Local fake-backed verification does not establish provider
acceptance or recipient delivery. The existing free Render API and Supabase
project remain the only hosted application services. Run one local worker and
one local Photon poller during a supervised session; stop both afterwards.
No new subscription, hosting plan, credits purchase or paid map service is needed.

## Contracts and data ownership

Migration 0012 supplies organiser routing; 0013 supplies persistent pilot counters,
transport threads, report-specific conversation links and the durable inbox/outbox.
0013 backfills existing links without changing their UUIDs or transcripts. Migration
0014 prevents the same approved scope from acquiring a second budget under a new
pilot ID. Legacy single-report endpoints remain available for non-enrolled
conversations; ambiguous legacy resolution returns 409. Enrolled mutations must
enter the new inbox.

New reports require photo bytes and valid coordinates from GPS or a confirmed map
pin. An address is supplementary context. An identical retry of an already accepted
address-only report still succeeds. The app resolves an older ambiguous upload
before permitting a corrected draft with a new submission identity.

The mobile history requirement is account sign-in with a local account-scoped
index and explicit import of anonymous device drafts. Backend report authorization
continues to use each report's private bearer token. A public reference selects
an already authorized report; it grants no access to another report.

Resident routes:

| Route | Behavior |
| --- | --- |
| `POST /reports/{id}/followup-link` | Report token; ten-minute code, expiry, verified recipient and `imessage` channel |
| `GET /reports/{id}/messaging-links` | Report token; `enabled`, recipient, links with `id/channel/active/paused`; no transport identities |
| `POST /reports/{id}/messaging-links/{link_id}/unlink` | Report token; deactivate only this report link, cancel its unsent work |
| `GET /reports/{id}/messages` | Existing report-isolated, paginated transcript |

Sending `LINK <code>` establishes consent only after backend acceptance. The app
must not treat opening the composer as a successful link. Without iMessage, show
the code and verified contact while retaining in-app tracking.

All internal routes use `X-Integration-Key`, with strict request schemas in
`api/pilot_schemas.py` and validated example fixtures under `fixtures/pilot-*`.

| Route under `/internal/messaging` | Contract |
| --- | --- |
| `POST /inbound` | `project_id, agent_sender_id, external_id, message_id, peer_id, space_kind, text, created_at` → envelope `id,status` |
| `POST /outgoing/claim` | `{}` → at most one frozen envelope; may return a known provider ID for status reconciliation |
| `POST /outgoing/{id}/sending` | `lease_id` → one submission authorization and persisted attempt charge; duplicate authorization returns 409 |
| `POST /outgoing/{id}/accepted` | Original lease, actual `provider_message_id`, provider status and exact `sent_text` |
| `POST /outgoing/{id}/failed` | Lease, `kind: rejected|unknown`, `retryable` |
| `POST /outgoing/{id}/status` | Matching provider ID and status; never infer delivery from acceptance |

Inbound deduplication is project/provider-message scoped and rejects changed
payloads. LINK codes are hashed and redacted from durable inbound text. Only the
configured agent/project in the allowlisted direct chat can link or reason.
STOP cancels queued reasoning and unsent messages immediately; an already submitted
message cannot be recalled. START resumes active links without replaying cancelled
notifications. Older controls cannot override a newer control.

One active report selects automatically. With several, an explicit reference or
selection in the preceding ten minutes is required. Implicit follow-up questions
do not extend that window. An ambiguous question is retained for ten minutes and
can be resolved once by a reference-only answer. Queued actions keep the selected
report even if the resident later selects another.

Chalk interprets only status, clarification, recheck or help/ambiguity. It receives
minimal context for the selected report. IDs, versions and command IDs come from
the backend. Explicit coordinate pairs must match resident text exactly. Resident
claims append to original evidence and can retain or raise review requirements.
A late image assessment cannot clear a concurrently raised hold. Interpretation
is persisted before applying changes; interrupted/invalid calls receive a no-action
fallback, without a second automatic model call. Replies describe committed outcomes.
The configured `xai/grok-4.3` route uses the existing
[Chalk Model Gateway](https://docs.chalk.ai/docs/model-gateway); no Function deployment.

The app's Leaflet/OpenStreetMap picker has attribution, normal cache behavior,
application identification on native, and no prefetch/offline download. Follow the
[OSM tile policy](https://operations.osmfoundation.org/policies/tiles/).

## Fixed scope and activation

Root `.env` is ignored. Both API and worker must have
`ORGANIZER_ROUTING_ENABLED=true`. Keep `MESSAGING_PILOT_ENABLED=false` until the
reviewed API is deployed, migrations are applied and preflight passes.

```dotenv
MESSAGING_PILOT_ENABLED=false
MESSAGING_PILOT_ID=GENERATE_ONE_UUID_ONCE
MESSAGING_PILOT_REPORT_IDS=["FIRST_NEW_REPORT_UUID","SECOND_NEW_REPORT_UUID"]
MESSAGING_PILOT_CHAT_IDS=["OWNED_DIRECT_PHOTON_SPACE_ID"]
MESSAGING_IMESSAGE_RECIPIENT=VERIFIED_BOT_PHONE_OR_APPLE_ID
CHALK_MODEL=xai/grok-4.3
ORGANIZER_ROUTING_ENABLED=true
PHOTON_DELIVERY_DB_PATH=.data/photon-pilot.db
```

Use the existing server/provider keys; never copy backend secrets into Expo or web.
The API `MESSAGING_API_KEY` and local poller's `WASTEGRID_MESSAGING_API_KEY` must match.
The pilot ID is stable across restarts, as are its report/chat/project/sender scope.
An enabled pilot requires exactly two distinct report UUIDs. Both persisted reports
must be real, have photo metadata, and contain finite latitude/longitude coordinates
within −90…90 and −180…180 before preflight reports readiness. Link-code issuance
during the pilot accepts only reports in this configured scope and fails closed
when pilot configuration is incomplete.
PostgreSQL caps remain at **2 image calls, 12 interpretation calls, 30 outbound
submission attempts**. A scope mismatch fails closed. The database permits one
budget per canonical project/sender/report/chat scope. Changing only the pilot ID
is rejected, and preflight continues to show the existing usage rather than a new
zero budget. Preserve the original pilot ID and counters across restarts.
If migration 0014 detects duplicate historical scopes, stop activation and
reconcile their history and combined usage under review; never discard usage or
zero counters to make migration pass.

1. Review and merge the implementation, then apply checked-in migrations with
   `uv run --env-file .env --extra backend python -m scripts.migrate`. Preserve the
   illustrative dataset; never run a demo reset against the shared project.
2. Deploy the reviewed commit to the existing Render service. Set organiser routing
   consistently on API and worker. Verify `/ready`, routing and messaging OpenAPI
   paths, `X-WasteGrid-Revision`, and the two feature headers against the actual
   deployment. A local commit hash is not evidence of deployment.
3. Submit exactly two new, real coordinate-bearing pilot reports through the app.
   Keep the worker stopped until their UUIDs are allowlisted. Add their IDs to the
   fixed pilot configuration on API and local worker. Exclude illustrative reports.
4. Change the flag to true on API and local processes. Run the read-only preflight:
   `uv run --env-file .env --extra backend python -m scripts.pilot_preflight --api-url https://wastegrid-api-dev.onrender.com --expected-revision REVIEWED_40_HEX_COMMIT`.
   Stop if revision, migrations, scope, either report's coordinates, or routing
   flags do not match.
5. Start exactly one worker and one poller in separate terminals:

   ```sh
   uv run --env-file .env --extra backend python -m api.worker
   uv run --env-file .env python -m api.messaging.run_imessage_agent
   ```

   The poller flag **must** be true: false selects the legacy adapter. Both processes
   are local and available only while running. Database pilot filters apply before
   leases/provider work; unrelated queued assessments, plans and messages remain.
6. Request each report's link code in the app and send LINK from the owned chat.
   Exercise reference selection, a status question, a permitted clarification,
   ambiguous selection and STOP/START. Check app link state and per-report history.
   Recheck is available only if an actual persisted job is completed; do not fabricate
   completion to claim wider dispatch/cleanup acceptance.
7. Stop local processes, retain the SQLite ledger and counters, and disable activation
   when the session ends. Restart with the same scope and ledger to verify recovery.

## Recovery and evidence

Polling reads every continuation page, including empty pages, with saved scan
bounds, a five-minute overlap and full activation-time reconciliation every fifteen
minutes. Photon SDK timeout is ten seconds with one SDK attempt. Definite rejection
can retry at most three total submissions; timeout/uncertain submission becomes
`unknown`, never an automatic resend. SQLite stores real provider receipts before
backend acknowledgements. A matching late receipt remains recordable after STOP,
unlink or lease expiry; it does not reauthorize sending. Known IDs are reconciled until a terminal Photon outcome. Photon’s terminal
`accepted` outcome remains separate from `delivered` and does not establish recipient
delivery.
Provider indexing has no finite bound, so this is not an exactly-once guarantee.

Use preflight counts to inspect operator-visible unknown/failed outbox records.
Never reset a sending/unknown row to pending merely because acknowledgement was lost.
Preserve the ledger and inspect the actual provider ID before manual reconciliation.

Record sanitized evidence with the deployed revision, migration checksums, pilot
counters, test commands/results and the two report references. Separate these claims:

- Fake-backed local/CI behavior.
- Real Chalk assessment and persisted interpretation.
- Photon accepted/dispatched a message with its real provider ID.
- Provider-confirmed delivery, and separately recipient-observed delivery.

Do not record tokens, link codes, private phone numbers, chat IDs, raw resident
messages or signed photo URLs in shareable evidence. Full planner/partial dispatch,
optional-photo cleanup, undo, public map and statistics acceptance remains a separate
integration track. Photon reports only states actually persisted by that track.
