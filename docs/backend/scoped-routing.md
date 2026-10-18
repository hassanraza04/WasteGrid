# Explicit job scope for organiser routing

Organisers can preview and dispatch a reviewed set of jobs without adding every
eligible unassigned job to the calculation. This extends the existing routing
endpoints; it does not require a database migration or activate any worker.

## Contract

```json
POST /routing/previews
{
  "crew_ids": ["30000000-0000-4000-8000-000000000001"],
  "job_ids": ["20000000-0000-4000-8000-000000000001"]
}
```

The example UUIDs are illustrative. Supply 1–5 distinct crew IDs and 1–25 distinct
job IDs. The response includes the canonical, sorted `job_ids`, together with the
existing preview, routes, exclusions, metrics and expiry. Omitted or null
`job_ids` retains the legacy all-eligible calculation; an explicit empty list is
invalid. Clients using explicit scope must never retry by omitting that field.

An explicit selection fails before road-provider calls when a job is missing,
completed, held, awaiting assessment/priority review, or assigned to an
unselected crew. A selected crew with **any unfinished assigned work outside the
selected jobs** also fails. Include its complete existing work or select an idle
crew. This prevents a small test from silently changing earlier assignments or
cutting a locked/ongoing route prefix.

Existing GPS freshness, crew availability, maximum displacement, provider
validation and fixed-prefix rules continue to apply. Job selection does not
approve a held report or waive any organiser/assessment requirement.

## Preview and dispatch

Computing a preview persists a proposal and does not change job assignments.
Changing the selected crews, jobs or routing controls invalidates the client-side proposal. Check
that returned `job_ids` match the requested set before offering dispatch. A
server without this contract must produce a visible deployment/contract error,
not an expanded-scope fallback.

Dispatch remains a separate confirmation:

```json
POST /routing/previews/40000000-0000-4000-8000-000000000001/dispatch
{"command_id":"50000000-0000-4000-8000-000000000001"}
```

The server revalidates the **stored** job scope under its mutation lock. Missing,
newly ineligible or changed scoped work requires a fresh preview. A new outside
assignment on a selected crew also blocks dispatch. Unrelated unassigned work
neither enters the routes nor invalidates an explicit preview.

Only proposed jobs receive assignment/version/planning-event changes. Existing
outside assignments retain their order, travel/service values and execution
provenance in the global current-plan snapshot. Outside unassigned work is
labelled `outside_scope`; its business row is unchanged. An uncertain dispatch
retry must reuse the same preview ID and command ID. A definite HTTP 409 ends
retries for the old preview: the app clears the proposal, retains the selected
crews/jobs, reads current routing state and requires a new computation and
confirmation. A durable conflict marker also prevents stale callbacks or a
restarted app from recovering that old command. If reconciliation cannot reach
the server, keep the saved conflict and offer **Refresh routing state** instead
of **Recover dispatch**. A conflict can mean another command already dispatched
the preview, so inspect the current plan rather than claiming no dispatch exists.

Before sending a dispatch, the app publishes a durable attempt barrier. A failed
barrier write prevents the POST. If saving the response classification fails or
the app stops mid-attempt, the barrier survives restart and only permits checking
the existing preview for an accepted plan. An unconfirmed result remains pending;
it cannot be resent, discarded or replaced by a new computation. Ordinary
network/5xx recovery retains the original preview/command IDs after its retryable
state is durably saved. A known conflict can be reconciled once storage works.

For an already terminal conflict, a missing old preview (HTTP 404) can be retired
after the current plan refresh succeeds. Other preview errors and any failed
current-plan refresh preserve the blocked action. A missing preview does not
establish success or resolve an unclassified dispatch attempt.

Optional time/stop limits, equipment checks, return-to-start and explicitly
acknowledged partial dispatch are defined in [routing-controls.md](routing-controls.md).
Omitting those request fields preserves the existing full-coverage contract.

## Supervised acceptance

1. Merge the reviewed change, deploy its API revision, and publish the matching
   mobile build. Check `/ready`, `X-WasteGrid-Revision`, organiser routing enabled,
   messaging pilot disabled, and `ComputeRoutes.job_ids` in `/openapi.json`.
2. Agree a separate approved test job and an idle test crew, or an explicitly
   reviewed complete existing crew scope. Preserve earlier fixtures and report
   holds. Use a real timestamped location update from the crew phone.
3. Compute a preview only. Check the exact scope, road estimates, exclusions,
   stop order, expiry and OpenStreetMap attribution. Record sanitized evidence.
4. Agree the displayed proposal before dispatch; then verify the assigned job,
   ordered crew start, persisted cleanup evidence and authorised resident history.
   Verify unrelated rows/assignments remain unchanged.

The general worker and messaging poller are unnecessary for routing an already
approved job. Assessment of any new report remains a separately scoped operation.
No live acceptance is established by disposable database tests or provider-only
matrix checks.

## Client support

Both the web organizer workspace and native mobile Dispatch screen send explicit
crew/job selections and expose the optional duration, stop, return, and
partial-dispatch controls. Web additionally saves its dispatch journal in
account/environment-specific IndexedDB and shows separately fetched road geometry.
Each client requires the matching deployed API contract; source implementation
alone does not establish deployed or device acceptance.
