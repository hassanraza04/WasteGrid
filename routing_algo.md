# WasteGrid routing algorithm — review draft

Status: implementation specification for `codex/priority-aware-routing`, based on
main after PR #6 merged. The backend implements the preview/dispatch and heuristic
flow described below as an opt-in mode. Defaults remain demo assumptions to
validate. See [backend setup and API sequence](docs/backend/routing.md).

## 1. Goal and optimisation objective

Assign every eligible cleanup job to exactly one selected crew, using each crew's
latest location as its starting point.

Optimise a combination of:

1. Priority-weighted time until collection, so urgent jobs tend to be collected
   earlier without automatically skipping nearby lower-priority jobs.
2. Latest estimated crew finishing time, to avoid leaving one crew overloaded.
3. Total road travel time, to avoid excessive detours.

This replaces the earlier finishing-time-first objective. Full coverage and unique
assignment remain hard requirements; priority changes scheduling, not coverage.

### Priority-aware scoring

For job `i`, let `C_i` be the estimated remaining minutes from the planning
snapshot until its collection is complete, including preceding travel and
remaining collection work on its crew's route.
Let `w_i` be its priority weight.

Proposed initial weights for testing: high = 3, medium = 2, low = 1. These are
finite trade-offs, not a rule that every high-priority stop must precede every
low-priority stop. The existing API value `routine` maps to low for routing;
no API enum rename is required. Organisers can set an audited effective priority
through `POST /organizer/reports/{report_id}/priority`; this preserves model
observations, cannot override pending assessments and never clears review gates.

Evaluate complete candidate plans using:

- `weighted_wait = sum(w_i * C_i) / sum(w_i)`
- `latest_finish = max(crew_route_duration)`
- `travel_per_job = total_travel_minutes / number_of_jobs`
- `score = alpha * weighted_wait + beta * latest_finish + gamma * travel_per_job`

Lower scores are better. All three terms use minutes. Positive coefficients
`alpha`, `beta` and `gamma` are configurable. Proposed starting values are
`alpha = 1`, `beta = 1`, `gamma = 0.25`, to be tested rather than described as
calibrated. Empty plans return zero metrics without division. Compare complete
plans over the same scoped job set. Score ties use latest finish, total travel,
then a stable canonical sequence of crew/job IDs.

A complete feasible plan always outranks a partial plan, regardless of score.
Priority weights and score coefficients do not guarantee equal workloads or
minimum possible finishing time: the score explicitly trades these objectives.
Freeze all settings with the preview so its result is reproducible.

Do not maximise the sum of collected priority weights: when every job is
collected, that sum is constant. Put priority on the job's waiting-time cost,
not on the road edge or an artificially increased road travel time.

Ten nearby low-priority stops collectively contribute to waiting cost. The solver
can collect some on the way to a high-priority job when the combined benefit
outweighs the delay. It need not collect all ten first or always visit the high
job first. Use the objective to compare those alternatives.

Use road travel time rather than straight-line distance. Balance estimated route
duration, not the number of stops. Six nearby stops may take less time than three
widely separated stops. Do not describe this as a fairness guarantee.

This is a practical heuristic for the hackathon MVP, not a guarantee of the
mathematically optimal solution. Estimates are planning estimates, not promised
arrival times.

## 2. Roles and workflow

### Resident

- Opens the camera and grants location permission so the app captures coordinates
  automatically. The resident does not type coordinates.
- Takes a photo and answers the yes/no questions used by the assessment flow.
- Submits the report, which is assessed through the existing Chalk workflow.
- Can see the original report, collection status and eventual cleanup photo.

Location capture is required in the intended app flow. Permission prompts and
permission persistence depend on the device/browser; the app cannot guarantee a
"forever" permission option.

### Organiser

1. Views reported trash and crew locations on the map.
2. Selects the available crews to include.
3. Presses **Compute routes**.
4. Reviews each crew's ordered stops, estimated travel time, total estimated
   duration and any jobs that could not be routed, with reasons.
5. Presses **Dispatch** to publish the assignments to crews.

Computing is a preview. It does not immediately replace published assignments.

### Crew

- Views its dispatched route and assigned cleanup jobs in stop order.
- Collects the trash and uploads an after-cleanup photo.
- Marks the job cleared; the backend saves the photo and completion status.
- No AI analysis of the cleanup photo is required.

The resident-facing report shows both the original resident evidence and the crew
completion evidence. The active trash pin disappears only after completion,
not when a route is computed or dispatched. Report history remains available.

## 3. Inputs

For each selected crew:

- Crew identifier and availability.
- Latest location and the time that location was recorded.
- Existing dispatched assignments and any collection already in progress.

For each eligible job:

- Job/report identifiers and coordinates.
- Current collection and review status.
- Backend-approved priority: high, medium or routine (low in routing).

For the calculation:

- A road travel-time matrix between crew starting locations and cleanup stops.
- One configurable, equal collection-time estimate for every new stop. Proposed
  starting value: five minutes. This affects assignment and routing decisions,
  not just display; validate it with demo scenarios.
- Fixed-prefix ownership/ordering, remaining-service estimates and their source.
- Job, crew, assignment and scope versions; travel snapshot ID; settings; timestamp.

Do not use AI waste-size estimates to vary collection time in this version.

## 4. Eligibility and assignment rules

- Include all eligible open jobs in the chosen planning scope.
- Exclude completed jobs and reports still awaiting assessment or review.
- Suspected hazards require organiser approval before ordinary dispatch.
- Each eligible job appears in at most one crew route. Successful full coverage
  means every eligible job appears exactly once.
- Never silently omit a job. Return each unassigned job with a specific travel,
  eligibility or search outcome; do not call every omission unreachable.
- A crew must have a usable starting location. Missing or stale crew locations
  must be shown to the organiser rather than treated as current coordinates.
- Preserve a collection already in progress during recalculation.
- Do not change published assignments until the organiser dispatches the preview.

"No overlap" means no duplicate collection assignments. Crews may use the same
roads where that is efficient; geographic separation is not a hard constraint.

Priority affects assignment and stop order through weighted waiting time.
Assessment and review gates still determine whether a job is eligible. Never
silently treat an unknown/null priority as low; resolve it through organiser
review before including the job in automatic routing.

### Assignment ownership and recalculation

The MVP has one global operational scope: all eligible unassigned jobs, plus
eligible unfinished jobs assigned to selected crews. Geographic-area selection is
out of scope. Every assignment belonging to an unselected crew is outside the
mutable scope: preserve its owner, order and status without assigning it again.
Unselected crews' routes do not contribute to this preview's score. Preserve
stored service/travel durations and per-assignment execution rules as well as
owner/order. A global organiser plan must not impose a new priority requirement
on an unselected, previously validated legacy assignment.

For each selected crew, preserve a fixed prefix:

- A job being collected stays first and with its current crew.
- A next stop explicitly marked as committed/en route also stays with that crew,
  after any current collection. Do not infer travelling state from GPS alone.
- Explicitly locked assignments retain ownership and relative order. Freeze the
  existing prefix through the last locked stop, including intervening stops.
- All other eligible assigned-but-not-started jobs may move between selected
  crews and may be reordered. Display old and proposed owners/orders in preview.
- Insert new/movable work only after the fixed prefix. If a held, blocked,
  review-required or otherwise ineligible job occurs in a fixed prefix, return a
  planning conflict; require organiser resolution rather than dispatch through it.

The current API has no explicit en-route commitment contract. The routing PR must
add a small explicit representation for that commitment or omit en-route UI until
it exists; an organiser lock can serve as the MVP commitment. Do not invent a new
status based on an assumption about the current backend.

Changes outside scope must never be cleared by a scoped dispatch. Coverage and
revision validation must use exactly the same scope as the solver and writes.

### Assessment versus priority policy — recommendation for review

Keep the existing one-call Chalk photo assessment and deterministic Python
priority calculation. Chalk interprets visible evidence and compares resident
claims; Python applies the explicit triage policy. This recommendation does not
add another model call or change the assessment contract.

Reasons: the same validated observations get the same policy outcome, boundary
cases can be regression-tested, and routing consumes an explainable, stable
priority. Asking the model for an additional priority label would not replace the
need to enforce review and dispatch rules in the backend.

| Evidence | Proposed handling |
| --- | --- |
| Visible fire, suspected chemical leak or similar special handling | Urgent organiser review; exclude from ordinary automatic dispatch |
| Complete entrance obstruction, or obstruction forcing people into traffic | High |
| Other identified partial/complete road, walkway, drain or entrance obstruction | Medium |
| Sufficient evidence of no obstruction and no identified special handling | Low (`routine` in the existing API) |
| Unclear, conflicting or insufficient evidence | Unknown/null priority; review required |

Large size alone does not increase urgency. Keep the equal collection-time
estimate in this routing version. A model confidence value does not establish
that an uncertain job is safe or override a review gate.

A supported high/medium obstruction priority may coexist with special-handling
review. The review gate takes precedence over automatic dispatch; the model must
not resolve it simply by emitting a high priority. The hazard label is a review
signal, not an instruction to send an ordinary crew to a fire or chemical leak.

## 5. Remaining duration and location contract

All estimates start at the planning snapshot, not the beginning of a shift.
Completed travel and completed jobs contribute zero remaining time. Do not reuse
historical completed-work minutes as a routing cost or shift budget.

For a crew currently collecting, keep the current job first with zero incoming
travel. Proposed remaining-service rule:

- With a recorded collection-start time, use `max(1 minute, S - elapsed_minutes)`,
  where `S` is the fixed collection-time setting.
- Without a reliable start time, use `S` remaining minutes and label that fallback.
- This is an estimate, not automatic completion. A crew still has to submit its
  cleanup photo and completion command.

After the current job, calculate travel from that job's coordinates. For an idle
or travelling crew, calculate remaining travel from its latest reported location,
including travel to any committed first stop; do not count the journey already
travelled. Subsequent stops each use `S` service minutes.

Routes end at the last collection. Depot returns and unloading are excluded.
Use remaining workload even if a crew is already busy; do not assume all crews
are idle at dispatch.

The crew location contract needs coordinates, `recorded_at`, server `received_at`
and a location revision. Proposed configurable defaults: location age at most
120 seconds at compute/dispatch, preview lifetime at most 120 seconds, and a
maximum 100-metre displacement from the snapshot before requiring recomputation.
These are demo defaults to validate, not GPS accuracy guarantees. Reject future
or invalid timestamps. New GPS observations alone do not change the business-state
revision; check age and displacement separately at dispatch. Existing
`start_location` without a timestamp is not evidence of a live location.

## 6. Construction, improvement and incomplete travel data

### Deterministic construction

1. Snapshot the scope, selected crews, fixed prefixes, priority and settings.
2. Fetch a directional driving-time matrix. Proposed MVP mode: driving for every
   crew, with no claim of live traffic unless the provider supports it.
3. Initialise fixed prefixes and their remaining durations.
4. Evaluate every remaining job at every permitted insertion position in every
   selected crew route, rejecting insertions with unusable directed edges.
5. For construction only, choose the insertion with the smallest increase in
   unnormalised `sum(w_i * C_i)` weighted by `alpha / total_scope_weight`, plus
   `beta * latest_finish` and `gamma * travel / total_scope_job_count` changes.
   Include all affected downstream completion times. Denominators remain fixed
   to the full scope, rather than changing with the inserted subset.
6. Break ties by job UUID, crew UUID and insertion position, ascending. Insert and
   repeat. This is a greedy construction choice, not a complete-plan quality claim.
7. Attempt construction for every job before spending the local-improvement budget.
   If construction cannot cover all jobs, try bounded relocations/reordering to
   make space in the road connectivity before returning an incomplete preview.
8. Improve complete plans with single-stop relocations, swaps and within-route
   reordering, without changing fixed prefixes. Evaluate the full score and only
   accept strict improvements. Use a fixed neighbourhood enumeration order.
9. Recalculate every changed directed edge and downstream completion time.
   Segment reversal must not assume symmetric travel times.
10. Validate coverage, eligibility and ownership independently of the solver.

Proposed limits: at most 25 scoped stops, five selected crews and 10,000 candidate
move evaluations after construction, with a separate five-second solver safety
limit. Reject larger requests explicitly instead of truncating jobs. Provider
requests have their own timeout and must respect provider element/batch limits;
verify these limits when choosing the provider.

Deterministic tests use the iteration budget and a frozen matrix, not elapsed
wall time. Production may stop earlier at the safety limit and must report
`time_limit_reached`; identical inputs under different time cutoffs are not
promised identical results. Construction interrupted by a time limit is incomplete.

### Travel and search outcomes

Store each matrix element as usable duration, explicit no-road-route result, or
unknown/provider error. Never replace unknown edges with zero or silently fall
back to straight-line time.

| Outcome | Meaning and handling |
| --- | --- |
| `no_usable_route_found` | Known road connectivity plus search did not produce a route for this job. Try other orders/crews before reporting it; this is not proof of global infeasibility. |
| `travel_data_unavailable` | Timeout, rate limit, malformed response or unresolved element error. Retry/recompute; do not label the road unreachable. |
| `search_incomplete` | Search/time budget ended without coverage or insertion could not be resolved within the heuristic budget. Do not claim no feasible plan exists. |

A missing edge between two stops does not make either stop unreachable: another
order or crew may work. Keep provider failure distinct from an explicit no-route
response. For this MVP, unresolved required matrix elements make the preview
non-dispatchable; known no-route elements can be avoided by a complete valid plan.

Partial previews are diagnostic only and **cannot be dispatched**. List every
omitted job prominently with its reason. A complete plan found before an
improvement cutoff can be dispatched if all normal validations pass. The API
returns coverage, stop estimates, travel/finish/wait metrics, settings, solver
termination reason, matrix identity and any reassignment summary.

## 7. Preview persistence, dispatch and completion integrity

Persist the preview's selected crew IDs, exact scoped job IDs, fixed prefixes,
business-state versions, location snapshot, road-matrix ID/content hash and
provider/mode metadata, collection-time setting, weights/coefficients, timestamp,
expiry, result and termination reason. Compute does not publish assignments.

Separate two freshness checks:

- **Business state:** job eligibility/status/priority, crew availability, assignment
  ownership/order/locks, and scope membership. Changes invalidate the preview.
  Newly eligible jobs entering the global scope also require recomputation.
- **Travel/location snapshot:** use frozen matrix estimates to validate the preview;
  do not rebuild its hash from a fresh provider response. Check snapshot expiry
  and current location age/displacement separately. If stale, ask for recompute.

Dispatch must be one atomic database transaction using the existing mutation
serialisation mechanism plus appropriate locking. Inside it, re-read and validate
scope membership, job/crew/assignment versions, fixed work, eligibility, availability
and location usability, then write only scoped assignments and activate the plan.
Do not check versions in one transaction and write in another. Do not call the
travel provider while holding assignment locks.

Two competing dispatches cannot both overwrite the same assignments. Use an
idempotency command ID so replay of a successful dispatch returns its original
result. A competing stale preview returns a conflict. Preserve all assignments
outside scope. A worker-generated plan must not bypass organiser dispatch;
background recalculation may produce or invalidate previews only in this mode.

Completion retains the existing authenticated assigned-crew flow: require a
cleanup photo, save evidence and status atomically, make replay idempotent, and
expose the result to the resident. Remove the active pin after backend confirmation.
No additional AI call is made for completion evidence.

## 8. Ten-metre duplicate policy — separate intake change

This change is not part of the routing PR and must not block it. The router
consumes eligible cleanup jobs from the existing intake/assessment flow.

Intended product rule for a subsequent intake change:

- Block a new report within 10 metres of an existing unresolved report.
- Allow a new report at that location after the earlier report is closed by the
  crew through the completion flow.
- Enforce the check authoritatively in the backend, including concurrent
  submissions. A preliminary app check alone is insufficient.
- Recheck proximity if coordinates are subsequently changed.

**Difference from PR #6:** that PR retains nearby submissions and sends uncertain
duplicates to review instead of rejecting them. The intended hard-block policy
requires an explicit backend change; it is not already implemented by PR #6.

The radius is a proximity heuristic, not proof that two photographs show the same
pile. Under the intended rule, a distinct pile within 10 metres can also be
blocked. Existing duplicate reports should not break routing: route cleanup jobs
once rather than treating each linked report as another collection stop.

## 9. Scope exclusions

- Truck capacity, vehicle size and unloading trips.
- Equipment matching and variable workload estimates based on waste size.
- Shift limits and crew-specific service speeds.
- Hard priority deadlines or emergency response routing (weighted waiting time
  is included).
- Geographic-area selection or partial-plan dispatch.
- Continuous automatic rerouting as crews move.
- AI analysis of cleanup photos.
- A guarantee of globally optimal routes.

Existing planning currently considers equipment and shifts. The new PR must
explicitly align the active planning path with this simplified scope, rather than
only removing those inputs from the UI. In particular, align `generate_plan`,
`build_planning_input`, `apply_plan`, schemas, plan invalidation/worker processing
and organiser endpoints. Current validation covers every unfinished job and hashes
travel data with business state; it cannot be reused unchanged for scoped previews.
Retain assessment/review gates and backend assignment authority.

Add the minimal location timestamp/revision and collection-start/commitment
contracts needed by this specification. Do not substitute legacy shift usage or
variable service estimates for the new remaining-duration model.

## 10. Acceptance checks

- Multiple crews and jobs: every eligible job assigned once, no duplicates.
- Nearby versus scattered stops: account for duration rather than stop count.
- Equal-duration alternatives: collecting a high-priority job earlier reduces
  weighted waiting cost.
- Ten nearby low-priority jobs and one high-priority job: compare alternative stop
  orders by the configured score, keep all stops, and avoid unconditional
  high-first or low-first sorting.
- Moving a stop between crews: include the resulting delays to every downstream
  stop when recomputing score.
- Unknown priority: excluded pending review, not silently mapped to low.
- Review-gated hazards: remain outside ordinary automatic dispatch regardless of
  any priority weight.
- Identical snapshots and iteration budgets: reproducible plan and termination.
- Wall-clock cutoff: explicitly labelled, without a reproducibility guarantee.
- One crew: produce an ordered route covering all reachable eligible jobs.
- More crews than jobs: permit empty crew routes without duplicate assignments.
- No eligible jobs: return an empty plan clearly.
- No selected crews or unusable crew locations: return an actionable validation
  response; do not invent starting locations.
- Directional matrix: reversing/reordering updates every changed directed edge.
- One missing edge: try another order/crew without declaring both jobs unreachable.
- Provider timeout/element error versus explicit no-route response: distinct outcomes.
- Search budget exhausted: distinguish from unavailable roads; no silent omission.
- Incomplete previews: cannot dispatch; complete coverage outranks lower partial cost.
- Completed/review-pending jobs: excluded from ordinary automatic assignment.
- Compute alone: no changes to published crew assignments or map-pin completion.
- Concurrent dispatch or changed job state: prevent conflicting assignments.
- Unselected crews: assignments and route order unchanged after dispatch.
- Selected crews: movable jobs can be reassigned; preview shows differences.
- Ongoing, committed and locked prefixes: ownership/order preserved.
- Ongoing collection: remaining service only, no previously consumed travel/time.
- Missing collection-start time: explicit full-service fallback label.
- Stale/missing GPS, expired preview and excessive displacement: reject dispatch.
- Fresh GPS within tolerance: no false business-revision conflict solely from GPS.
- Fresh provider estimates: cannot silently mutate a saved preview's matrix.
- Two simultaneous dispatches: one succeeds; conflicting preview is rejected.
- Dispatch replay: returns the prior result without duplicate assignments.
- New eligible job after compute: scope-change conflict, recompute required.
- Small enumerated instances: compare heuristic score to exhaustive optimum, record
  its quality gap and validate constraints; do not assert all heuristics are optimal.
- Completion without a photo or by another crew: rejected.
- Successful completion: evidence retained, resident status updated and active
  pin removed. Reporting eligibility after closure belongs to the intake change.
- Separate intake PR: test the 10-metre hard-block policy and reopening after
  completion independently; these tests are not routing-PR acceptance criteria.

## 11. Review defaults and remaining integration choice

Proposed defaults to review before implementation:

| Setting | Proposed MVP value |
| --- | --- |
| Priority weights: high / medium / routine | 3 / 2 / 1 |
| Score coefficients: waiting / latest finish / travel per job | 1 / 1 / 0.25 |
| Service time for each new stop | 5 minutes |
| Ongoing service with start time | `max(1 minute, 5 minutes - elapsed)` |
| Ongoing service without start time | 5 minutes, labelled fallback |
| Maximum crew-location age / preview age | 120 seconds / 120 seconds |
| Maximum displacement before recompute | 100 metres |
| Maximum scoped stops / selected crews | 25 / 5 |
| Improvement budget / solver safety limit | 10,000 move evaluations / 5 seconds |
| Travel mode | Driving |
| Scope | All eligible unassigned jobs + selected crews' eligible jobs |
| Partial dispatch | Disabled |

The initial adapter uses OSRM's directional driving Table API via a configured
server URL, with a 10-second request timeout. One matrix request covers at most 30
locations; choose a server that supports that size and its usage policy. The solver
is ordinary Python, without an extra optimisation dependency. Freeze the input
matrix and settings in each preview; validate service-time and score assumptions
using small examples and the demo geography.

The recommendation is to keep Python priority rules behind Chalk observations.
Automatic classification rules are unchanged. An authenticated organiser can make
an explicit, audited priority decision with a reason; review/handling approval is
still a separate gate.

The branch implements backend routing with these starting defaults. Frontend
integration, live road-service configuration and live crew GPS observations are
still required; no hosted deployment is changed here.

### Dispatch persistence clarification

Save the exact preview service duration for each selected stop, including
fractional remaining service for ongoing collection. For unselected assignments,
carry forward saved durations and execution provenance. The current-plan API
exposes per-job `execution_rules` (`mode`, `source_plan_id`); the plan header's
mode does not change the policy of preserved legacy jobs. Legacy work retains its
original validated-plan checks until explicitly selected for organiser routing.

### Ownership, flag and invalidation boundaries

When organiser routing is enabled, legacy job PATCH rejects `assigned_crew_id`,
`status: "unassigned"` and `held: true` rather than clearing ownership outside
dispatch. Marking a crew unavailable also retains its assignments and pauses
execution. The new priority and GPS writes are disabled with the routing flag;
read-only historical previews remain available to authorised organisers.

The business revision covers eligible routing work and all selected crews'
assigned work that can affect execution guards. Excluded unassigned diagnostics
are outside the hash until they become eligible. Changes within an exclusion do
not force recomputation; promotion into the solver scope does.

Load reports, fallback approval events and preserved assignment provenance in
batches. Filter unrelated jobs in SQL and avoid per-job history lookups under the
mutation lock. The stop cap is 25 eligible jobs; query-count regressions include
many unselected assignments and multiple manually approved reports.
