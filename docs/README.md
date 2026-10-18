# WasteGrid documentation

Start with the [project README](../README.md) for the product overview,
architecture, and quick start. This index groups the supporting documentation by
the work you want to do.

## Run or demonstrate the project

| Guide | Purpose |
| --- | --- |
| [Demo walkthrough](demo.md) | Connected resident, organizer, and crew flow; Worcester and Karachi demonstrations. |
| [One-phone finish](backend/hackathon-finish.md) | Supervised Android resident/crew account switching and browser organizer sequence. |
| [Organizer operations](backend/organizer-prototype.md) | Read models, doctor checks, road maps, durable dispatch, and bounded assessment. |
| [Web app](../web/README.md) | Browser configuration, organizer routes, and Android entry boundary. |
| [Mobile app](../mobile/README.md) | Native setup, roles, report recovery, and staff actions. |
| [Backend setup](backend/setup.md) | Supabase, migrations, staff provisioning, API, worker, and disposable tests. |
| [Shared development API](backend/shared-development-api.md) | Render deployment and its recorded acceptance. |

## Understand or integrate the backend

| Guide | Purpose |
| --- | --- |
| [Backend overview](backend/README.md) | Responsibilities, processing, authentication, and runtime components. |
| [Contracts](backend/contracts.md) | API behavior, credentials, idempotent commands, and integration boundaries. |
| [OpenAPI](backend/openapi.json), [schemas](backend/schemas/), [fixtures](backend/fixtures/) | Generated contract and example payloads; check with `scripts.export_contracts --check`. |
| [Mobile handoff](backend/mobile-handoff.md) | Resident upload, tracking, and staff API contract details. |
| [Dashboard handoff](backend/dashboard-handoff.md) | Report history, authorized photos, and organizer integration details. |
| [Assessment](backend/assessment.md) | Structured photo analysis, deterministic priority, and review policy. |
| [Routing](backend/routing.md) | Road matrices, previews, dispatch, and preserved assignments. |
| [Explicit routing scope](backend/scoped-routing.md) | Selected crews/jobs, conflicts, and recovery. |
| [Routing controls](backend/routing-controls.md) | Equipment, remaining route budgets, stop limits, return legs, and partial dispatch. |
| [Mobile routing and completion](backend/mobile-routing-completion.md) | Foreground GPS, durable commands, and optional-photo completion. |
| [Phone updates](backend/phone-updates.md) | In-app Status replies and the explicitly authorized registered-phone copy. |
| [Photon adapter](backend/photon-adapter.md) | Transport configuration, legacy mode, and local ledger. |
| [Photon–Chalk pilot](backend/photon-chalk-pilot.md) | Supervised activation, fixed scope, budgets, and delivery evidence. |
| [Routing algorithm](../routing_algo.md) | Detailed algorithm and objective explanation. |

## Validate changes

[Repository safety](repository-safety.md) records the CI checks and dependency
audit exceptions. [Backend setup](backend/setup.md#5-reproducible-verification)
explains the disposable PostgreSQL test environment and Docker smoke checks.

[Verification history](backend/verification.md) contains dated results. Its test
counts, fixture sizes, migration ranges, and runtime observations describe the
recorded revision; they are not evidence of the current checkout or deployment.
Run checks again for a new revision and validate each external integration separately.

## Design and implementation history

[`superpowers/`](superpowers/) and [`plans/`](plans/) retain research, design
notes, and implementation plans. The [merge handoff](backend/merge.md) also
records an earlier integration checkpoint. These documents can refer to earlier
owners, issues, unimplemented steps, or superseded assumptions.

For current setup and behavior, use the root/component READMEs and the specific
runbooks above. When an older handoff and generated contract differ, inspect
the current API models and regenerate the contract before changing a client.
Deployment status must be checked against the actual running revision and flags.
