# Routing limits and partial dispatch

This extends the existing scoped preview/dispatch API. Basic clients may use
`{crew_ids, job_ids}` because the constraint fields are optional. Both the web
workspace and mobile Dispatch screen expose the controls described below.
No database migration, new credential, paid service, worker or messaging process
is required. This document describes the implemented code contract, not deployed
or device acceptance.

## Preview contract

```json
POST /routing/previews
{
  "crew_ids": ["30000000-0000-4000-8000-000000000001"],
  "job_ids": ["20000000-0000-4000-8000-000000000001"],
  "constraints": {
    "max_duration_minutes": 120,
    "max_stops_per_crew": 10,
    "return_to_start": true,
    "allow_partial": false
  }
}
```

`max_duration_minutes` is a positive finite number up to 480, or null to use each
crew's configured budget alone. `max_stops_per_crew` is an integer from 1 to 25.
The two flags are booleans. Omitted constraints default to null, 25, false and
false respectively. Unknown fields are rejected. The existing 5-crew/25-job
scope bounds remain unchanged. The mobile controls start at two hours, ten stops,
return enabled and partial dispatch disabled.

The response echoes the canonical constraints in `settings.constraints`, with
`settings.routing_contract_version: 2`. Clients offering these controls must
verify that echo and the exact requested crew/job scope. A deployment that does
not support them must show a contract error; never remove controls or `job_ids`
to make a failed request succeed. Changing controls invalidates the proposal.

Every job requires the selected crew to have its `required_equipment`.
The route duration must fit both the requested time limit and the crew's
`shift_minutes`, using whichever is smaller. This is a **remaining route budget
from the observed crew GPS position**, not a record of elapsed time across an
operating shift. There is no shift start/end ledger in this schema. Completion
history from previous days is not charged again. A new shift/session ledger
would be needed to enforce a total working-day limit reliably.

When `return_to_start` is true, the directional road leg from the final job back
to that crew's frozen starting GPS position counts toward travel, duration,
latest finish and the combined objective. It does not change the final stop's
completion time. The response adds `return_travel_minutes` and
`returns_to_start` to each route. Empty routes have zero return travel. An
unknown return leg cannot be treated as a zero-cost road connection.

The fixed prefix, including ongoing collection and work through the last locked
stop, remains immutable. Equipment, budget or road conflicts in that prefix
block dispatch and require organiser resolution. Existing assignments cannot
be omitted to make a partial proposal feasible.

## Incomplete proposals

Full coverage remains the default requirement. `allow_partial: true` permits
review of a nonempty feasible subset when the selected scope does not all fit.
The solver first preserves existing assigned work, then prefers greater served
priority weight (high/medium/routine = 3/2/1), then more jobs, then the existing
weighted completion/finish/travel objective. It is a bounded heuristic, not a
proof of a global optimum.

For explicit scope, routed stops and `unassigned` must partition the requested
jobs exactly once. Omitted work stays unassigned; it is not implicitly approved,
released from another crew or added to another route. Reasons identify a proven
equipment mismatch, stop-capacity limit, service-duration limit or missing road
connection where possible. `search_incomplete` is conservative: route order,
capacity, connectivity or the search budget may have prevented insertion without
proving global infeasibility. Provider failure remains non-dispatchable.

Partial dispatch requires an additional explicit acknowledgement:

```json
POST /routing/previews/40000000-0000-4000-8000-000000000001/dispatch
{
  "command_id": "50000000-0000-4000-8000-000000000001",
  "accept_partial": true
}
```

For an incomplete proposal, this acknowledgement is accepted only when it was
computed with `allow_partial: true`.
Complete proposals use the existing command-only body. The mobile confirmation
lists the omitted work and freezes the partial acknowledgement with the preview
and command ID before sending. Recovery retains that same intent. An uncertain
response never permits a new command, expanded scope or changed acknowledgement.
A definite 409 requires current-state refresh and a new preview/approval.

Dispatch rechecks the complete frozen scope, resources, fixed prefix, GPS,
expiry and all route metrics under the mutation lock. Changes to required
gear or crew capacity invalidate the preview even if a version was not advanced.
Old undispatched previews require recomputation under the new contract;
successfully dispatched commands retain their idempotent recovery behavior.
Outside assignments retain their source plan and execution terms.

New organiser assignments persist their resource rules. Starting a stop checks
current equipment and remaining frozen route costs, including any return leg,
against the current budget. It cannot use another crew's completion as permission
to bypass those checks. Releasing or reassigning an unfinished stop requires a fresh preview before
starting another stop: the old incoming/return travel estimates no longer describe
the remaining route. Completing an earlier stop normally is allowed. Historical
organiser and preserved legacy assignments keep their established execution rules
until explicitly recomputed.

## Verification and rollout

Automated tests use synthetic matrices and a disposable local PostgreSQL database.
They must cover directional returns, resource limits, fixed work, priority-aware
partial selection, explicit acceptance, stale resources, immutable retries,
account changes and dispatch recovery. Native exports verify bundling, not GPS
or live provider/device behavior.

After review and merge, deploy current main and publish the matching app. Check
`/ready`, `X-WasteGrid-Revision`, organiser routing enabled, messaging pilot off,
and the new OpenAPI properties before exercising controls. Keep the general
worker and all messaging pollers stopped. Use only an agreed separate test job
and crew with real phone GPS; preserve `WG-8D724DBFF0D8` and its review hold.
First review a preview, then approve that exact proposal before dispatch.
Record the selected scope, omissions, saved plan, ordered crew execution and
resident history separately from local test evidence.

Both implemented clients supply and validate these controls against this
contract. Web also persists reviewed scope and dispatch intent in IndexedDB.
General crew undo is a separate workflow and is not implemented.
