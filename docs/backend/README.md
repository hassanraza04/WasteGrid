# WasteGrid backend: Person 2 handoff

This is the FastAPI/Postgres backend for the four-person build plan. All new
integration decisions are **proposed v0.2**, pending coordination with Persons
1, 3 and 4. Backend code owns authorization, persistence, feasibility validation,
state transitions and delivery records. Person 3 supplies Chalk photo assessment
and deterministic triage, heuristic planning and follow-up decisions; Person 4
owns Photon transport and delivery retries.

Start with [setup.md](setup.md), then share [contracts.md](contracts.md).
[openapi.json](openapi.json), [integration JSON schemas](schemas/) and
[example payloads](fixtures/) are generated from the Python models.
[verification.md](verification.md) records what has actually been tested.

The dashboard contract increment is implemented: title/address, public reference
lookup, latest updates and paginated update/conversation history. Share
[dashboard-handoff.md](dashboard-handoff.md) for endpoint examples and the exact
frontend/Photon adapter changes. The browser repository still needs asynchronous
calls and real authentication; a public reference alone grants no access.

## Implemented behavior

- Reports and private photos persist in Supabase. Residents use random report
  bearer tokens; the database stores hashes. Organizer/crew accounts use
  Supabase Auth; protected database role records determine permissions.
- Creation supports safe retries using a client UUID and a client-generated
  256-bit token. Repeating a command does not duplicate its state transition.
- New reports enqueue a one-call Chalk assessment, followed by deterministic
  backend priority calculation; see [assessment.md](assessment.md) for metadata,
  proximity review policy, configuration and API fields. Eligible results enqueue
  triage, which creates a job and queues planning. Nearby originals/photos remain
  separate with private review evidence. Audited organizer approvals can resolve
  settled review/failed results; pending results remain blocked. The worker
  obtains decisions through the Person 3 boundary and applies backend rules:
  missing location requests information, hazards and uncertain duplicates go
  to review, eligible ordinary reports create/link jobs.
- Plans must cover unfinished jobs exactly once, preserve locked/ongoing/blocked
  assigned work,
  respect equipment and shift budgets, and use at least the supplied travel
  estimates. Completed work continues consuming shift capacity after a recheck.
- Crew changes invalidate plans and release unlocked pending assignments. A
  crew can start only its own job in a current validated plan. Completed and
  ongoing work is preserved. Organizer holds, locks, reassignment and exception
  resolution are audited.
- Completion requires an after-photo. Completion is labeled crew-submitted,
  never independently verified. Residents can request a recheck through their
  linked conversation; organizers see its reason and completion evidence.
- Conversation links require a short-lived one-time code and explicit opt-in.
  Transport lookup survives adapter restarts. Outgoing messages have stable IDs,
  destinations, leases, acknowledgements and retry state.

## Integration status

No live Supabase, Render or Person 3 credentials were supplied. Provider calls
are tested using explicit doubles. With Chalk configured, the production worker
uses `api.decisions.AssessmentDecisionProvider` for triage, planning and follow-up
without extra model calls. External facades/factories can override it explicitly.
The route planner is a greedy heuristic over labeled travel estimates, not a
global optimum or live-road service. The separate legacy test provider remains
in `tests/backend/providers.py`, excluded from Docker.

The upstream `web/` application currently uses browser-local storage, three
presentation statuses and a development sign-in. Its owner must replace those
adapters with async API/Supabase clients. Preserve the backend's report/job
states; presentation labels can be mapped in the frontend. No frontend or
Photon implementation files were changed by this backend work.

The MVP models one current operating shift per crew. Create/reset a separate
demo dataset for a new demo shift. Multi-day scheduling and traffic routing are
outside this schema; travel inputs are explicitly illustrative estimates.
