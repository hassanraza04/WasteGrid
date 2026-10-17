# Organiser routing integration

This opt-in backend mode uses the existing Chalk assessment and Python priority
rules. High/medium/routine priorities have routing weights 3/2/1. Unknown priority,
unapproved assessment and suspected-handling review remain outside automatic
assignment. If several approved reports link to one job, use the highest priority
and schedule that job once. The API keeps `routine`; the UI may label it Low.

## Enable and configure

Apply migrations through `0012_organizer_routing.sql`. Set on **both API and worker**:

```dotenv
ORGANIZER_ROUTING_ENABLED=true
```

On the API, configure an OSRM-compatible driving Table server:

```dotenv
ROUTING_OSRM_BASE_URL=https://YOUR_OSRM_SERVER
ROUTING_PROVIDER_TIMEOUT_SECONDS=10
ROUTING_SERVICE_MINUTES=5
ROUTING_LOCATION_MAX_AGE_SECONDS=120
ROUTING_PREVIEW_MAX_AGE_SECONDS=120
ROUTING_MAX_DISPLACEMENT_METERS=100
ROUTING_WAIT_WEIGHT=1
ROUTING_FINISH_WEIGHT=1
ROUTING_TRAVEL_WEIGHT=0.25
ROUTING_IMPROVEMENT_BUDGET=10000
ROUTING_SOLVER_TIMEOUT_SECONDS=5
```

No new AI key is needed. OSRM itself does not require an API key; any hosted
service access policy must be configured with that service. A real road server URL
and fresh crew observations are required for live acceptance. No provider/server
is deployed by this change. OSRM protocol reference:
https://project-osrm.org/docs/v5.24.0/api/#table-service

The mode defaults off for coordinated deployment. In organiser mode, legacy
`POST /plans/generate` returns a conflict directing clients to previews. Workers
consume invalidation tasks without generating/dispatching automatic plans.
Existing automatic decision providers remain available for legacy deployments.
Once an organiser plan is dispatched, legacy `apply_plan` cannot overwrite it,
even if a worker was accidentally started without the flag. Enable the flag on
both services before using the new UI.

## API sequence

If an assessment leaves priority unknown, an organiser can submit
`POST /organizer/reports/{report_id}/priority` with `command_id`,
`expected_version`, `priority` (`high`, `medium` or `routine`) and an audit `reason`.
This updates the effective priority, preserves the AI assessment and never clears
review/handling gates. Pending assessments cannot be overridden. Resolve review
through the existing organiser decision before dispatch. This also supports older
manually approved jobs that still have null priority. Crew/resident callers cannot
set priority. Replay of the same command is idempotent.

1. Each authenticated crew sends `POST /crews/me/location`:

   ```json
   {
     "location": {"latitude": 24.923, "longitude": 67.092},
     "recorded_at": "2026-10-17T19:00:00Z"
   }
   ```

   Use the actual current observation timestamp, not the example. Future, stale
   or out-of-order observations are rejected. A crew can update only itself.
   `GET /crews` exposes the timestamp/revision to organisers. GPS does not clear
   assignments or increment the crew business version. A manual depot edit clears
   live-location timestamps and requires a new observation.

2. Organiser sends `POST /routing/previews`:

   ```json
   {"crew_ids": ["SELECTED_CREW_UUID", "ANOTHER_CREW_UUID"]}
   ```

   Response contains `id`, `computed_at`, `expires_at`, `matrix_id`, `travel_label`,
   `settings`, `routes`, `metrics`, `unassigned`, `exclusions`, `reassignments`,
   `termination_reason`, `dispatchable` and nullable `plan_id`.

   Each route contains `crew_id`, `duration_minutes`, `travel_minutes`, and ordered
   `stops`. Each stop contains `job_id`, `position`, `priority`, `travel_minutes`,
   `service_minutes`, `completion_minutes`, `fixed`, and `service_estimate_source`.
   `metrics` includes weighted wait, latest finish, total travel and combined score.
   A provider failure creates a non-dispatchable diagnostic preview with
   `travel_data_unavailable`; it does not change assignments.

3. Organiser reads `GET /routing/previews/{id}` if needed, reviews omissions and
   reassignment differences, then sends `POST /routing/previews/{id}/dispatch`:

   ```json
   {"command_id": "FRESH_DISPATCH_UUID"}
   ```

   Response: `{"preview_id": "...", "plan_id": "..."}`. Replay the same command
   for the same organiser/preview to recover a lost success response. Different
   commands for an already dispatched preview conflict. Dispatch revalidates and
   writes in one database transaction; stale or competing previews return 409.

4. Crews use existing `GET /jobs` for ordered, crew-scoped assignments. Start the
   next stop using the existing job PATCH command, which records collection start
   time. In organiser plans, starting respects route order and current approved
   assignment; legacy equipment and shift budgets are not applied. Ownership edits
   through the legacy job PATCH are rejected in organiser mode; use dispatch.
   Editing legacy equipment/shift values does not clear organiser assignments. Completing work
   uses existing `POST /jobs/{id}/completion` with the required cleanup photo.
   No AI analysis of completion evidence is performed.

All routing read/compute/dispatch endpoints require an organiser account. The
location endpoint requires a crew account. Residents retain private report tokens.

## Solver and scope

Road times are directional, in minutes; OSRM seconds are converted without
straight-line fallback. Explicit null durations represent missing road routes.
Provider errors/malformed tables are unknown data, not proof of unreachable roads.
The matrix is requested once and frozen with the preview. Maximum 25 scoped
unfinished jobs plus five selected crew origins (30 matrix locations).

Scope is all eligible unassigned jobs plus eligible jobs owned by selected crews.
Unselected assignments remain unchanged. Current collection and the prefix through
the last organiser-locked job are fixed; a lock represents an en-route commitment
in this MVP. Assigned-but-unstarted unlocked work can move among selected crews.
An ineligible assigned selected job prevents dispatch until resolved; it is never
silently unassigned. No area filtering or partial dispatch is implemented.

Remaining service is `max(1, service_minutes - elapsed_since_start)` for ongoing
work, or a labelled full-service fallback when no start time exists. Incoming
travel already completed is zero. No historical shift time is carried forward.

Construction evaluates permitted insertions across all remaining jobs and selected
crews with fixed denominators; improvement uses relocations and swaps including
within-route reordering. Every changed directed edge and downstream completion
time is recomputed. Full coverage outranks partial cost. An iteration budget gives
repeatability; the operational time cutoff is explicitly reported and does not
promise identical results. This heuristic does not guarantee global optimality.

Dispatch stores a regular active Plan and Assignment records for existing crew APIs,
including preserved unselected assignments. Its business revision is separate from
matrix identity and GPS revision. Fresh GPS within 100 metres does not automatically
invalidate business state; old locations, displacement or expired previews do.
New eligible jobs, status/priority changes, assignment changes and resource business
versions invalidate the preview. No road provider call happens under dispatch locks.

The 10-metre intake hard-block change and mandatory resident GPS enforcement remain
separate work. Existing PR #6 intake behaviour is unchanged.
