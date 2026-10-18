# WasteGrid backend

The backend is a FastAPI service with a separate durable-task worker. It owns
report persistence, private photos, authorization, review policy, route validation,
state transitions, audit history, and messaging delivery records. Supabase
provides PostgreSQL, Auth, and private Storage.

Start with [setup](setup.md) to run it, [contracts](contracts.md) to integrate a
client, or the [project README](../../README.md) for the full architecture.

## Runtime components

| Component | Responsibility |
| --- | --- |
| `api.main` | Resident and staff HTTP APIs, private photo access, reports, jobs, review, routing, and messaging contracts. |
| `api.worker` | Persisted assessment, triage, legacy planning, and follow-up tasks; runs separately from Uvicorn. |
| `api.assessment` / `api.decisions` | Validated photo assessment and deterministic priority/decision rules. |
| `api.routing` / `api.route_solver` / `api.road_times` | Road-time previews, resource-aware heuristic, stale-state checks, and explicit dispatch. |
| `api.messaging` | Separate Photon polling, transport coordination, and local delivery ledger. |
| `supabase/migrations` | Ordered, checksummed schema changes applied by `scripts.migrate`. |

The API/worker image excludes the Chalk and Photon SDKs; model requests use the
HTTP gateway. The Photon adapter runs with the repository's Python dependencies
in its own process. API imports do not deploy Chalk functions or start workers.

## Report and job lifecycle

1. Creation persists a photo and report and enqueues assessment. Client-generated
   report identity and a private token make upload retries safe.
2. A configured worker makes one assessment request through Chalk Model Gateway,
   validates the result, and calculates priority in Python. Assessment failures
   remain visible for organizer review rather than being silently retried.
3. Eligible assessments proceed to deterministic triage and job creation/linking.
   Missing information, hazards, and uncertain nearby reports stay behind review
   gates. Original photos/reports remain separate.
4. In organizer routing mode, organizers select work and crews, review a road-time
   preview, and approve dispatch. The server revalidates scope, resources, fixed
   work, locations, and expiry before applying assignments transactionally.
5. A crew starts only its own next permitted stop. Completion accepts an optional
   after-photo and records `verification: "crew_submitted"`. It does not perform
   independent inspection or photo analysis.
6. Residents read token-authorized history and available evidence. Linked
   conversations can request a recheck; organizer resolution is audited.

The older `/plans/generate` worker path applies plans and is not a read-only
preview. New organizer clients use `/routing/previews` and its separate dispatch
endpoint. See [routing](routing.md), [explicit scope](scoped-routing.md), and
[routing controls](routing-controls.md) for the execution rules.

## Authentication and private data

- Residents use random per-report bearer tokens. The database stores token hashes;
  a report reference alone grants no access.
- Organizer and crew accounts sign in through Supabase Auth. Protected database
  role records determine authorization; user-editable metadata does not.
- Photo access is authorized by the API and returns short-lived signed URLs.
  The Storage bucket stays private, and crews are restricted to their own work.
- Messaging and optional read-only decision tools use separate server integration
  keys. Conversation linking requires a short-lived one-time code and opt-in.
- Commands retain stable IDs and version checks for replay and conflict handling.
  Audits preserve state changes and the evidence actually supplied.

## Configuration and deployment

Use the root [environment example](../../.env.example) and [setup guide](setup.md).
Apply **all checked-in migrations** before starting a new revision; deployments
never migrate automatically. The repository currently contains migrations
`0001`–`0016`; an older acceptance record with fewer migrations describes that
historical checkpoint.

The default assessment-backed decisions require Chalk gateway configuration.
Explicit `INTEGRATION_FACTORY` or `PERSON3_BASE_URL` settings override the decision
provider. Organizer routing additionally needs its feature flag and an
OSRM-compatible driving-time service on the API/worker environment. There is no
straight-line fallback for organizer road-time previews.

[`render.dev.yaml`](../../render.dev.yaml) defines the API-only development
service; [`render.organizer.yaml`](../../render.organizer.yaml) defines the static
organizer site. The legacy [`render.yaml`](../../render.yaml) adds a general worker. Neither definition
activates every integration by itself. The configured shared origin is
[the development API](https://wastegrid-api-dev.onrender.com); verify its actual
revision, flags, and health rather than inferring them from local source.

The connected native app and web organizer dashboard now have API adapters.
Browser resident entry directs users to Android; legacy report URLs redirect there. See the [web README](../../web/README.md),
[mobile README](../../mobile/README.md), and [demo guide](../demo.md) for clients.

The [operator runbook](organizer-prototype.md) covers server-filtered operational
read models, worker indicators, and the approved four-attempt scoped assessment
session. Keep the general worker stopped for that shared demo. Migration 0016
adds audited reopening of the original expired/drained approval without resetting
its scope or usage. [Phone updates](phone-updates.md) describes the separate
resident Status reply and consented registered-phone copy.

## Contracts and verification

[OpenAPI](openapi.json), [JSON schemas](schemas/), and [fixtures](fixtures/) are
generated from Python models. Validate them with:

```bash
uv run --extra backend python -m scripts.export_contracts --check
```

[Setup](setup.md#5-reproducible-verification) documents disposable PostgreSQL tests
and the full Docker verification script. [Repository safety](../repository-safety.md)
records CI checks. [Verification history](verification.md) is dated evidence,
not a current deployment status page; external Auth, Storage, model, road, and
Photon acceptance must be established for the actual running revision.

## Detailed guides

- [Assessment](assessment.md): model request, priority rules, and review behavior.
- [Mobile API handoff](mobile-handoff.md) and [dashboard handoff](dashboard-handoff.md): endpoint examples and client contracts.
- [Mobile routing and completion](mobile-routing-completion.md): foreground GPS and durable staff operations.
- [Shared development API](shared-development-api.md): Render service runbook and recorded checks.
- [Photon adapter](photon-adapter.md) and [supervised pilot](photon-chalk-pilot.md): transport setup, fixed scope, budgets, and delivery recovery.
