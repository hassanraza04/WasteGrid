# Waste assessment and Person 3 decisions

## Processing flow

`POST /reports` retains the photo, location, optional note and resident yes/no
answers, returns 201 with `assessment_status: pending`, and queues one assessment
task. The existing worker makes one Qwen-through-Groq request via Chalk Model
Gateway. It validates the result, calculates priority in Python, and persists it.
An eligible assessment queues the existing triage task in the same transaction.
Triage creates a job; existing plan invalidation queues planning. Review and failed
reports remain visible without an automatically assigned ordinary cleanup job.

A Chalk-only worker now loads `AssessmentDecisionProvider` and processes
assessment, triage, plan and followup tasks. Explicit `INTEGRATION_FACTORY` or
`PERSON3_BASE_URL` settings still take precedence for the decision methods.
No additional queue, tool loop, frontend, or provider service is needed.

## Setup and seed refresh

Configure these server-side variables alongside the existing database/Supabase
credentials; never put gateway or provider credentials in the frontend:

```text
CHALK_ROUTER_API_KEY=<Chalk gateway key>
CHALK_ENV_ID=<Chalk environment ID>
CHALK_MODEL=groq/qwen/qwen3.8-27b
CHALK_ROUTER_BASE_URL=https://api.chalk.ai/v1/router
ASSESSMENT_TIMEOUT_SECONDS=30
DUPLICATE_RADIUS_METERS=10
```

Apply migrations 0007–0011, then start the existing worker alongside FastAPI:

```sh
uv run --extra backend python -m scripts.migrate
uv run --extra backend python -m scripts.seed_demo
uv run --extra backend python -m api.worker
```

`seed_demo` is for an isolated demo database and refuses databases containing real
reports/jobs. Rerunning it refreshes known illustrative rows that have pending,
missing assessments from older seeds, without resetting their jobs or photos.
The stored assessments are explicitly synthetic, not live AI outputs. An optional
`--reset-demo` rebuilds the demo fixtures; it is unnecessary for assessment refresh.
This code does not migrate or reseed a hosted database automatically.

## Capture contract and returned assessment

`POST /reports` is multipart: `photo`, `latitude`, `longitude`, optional `note`,
`resident_fire`, and `resident_sharp_objects`. Boolean answers use true/false;
omitted answers mean unknown. The current backend still permits legacy reports
without GPS and can request location information; mandatory capture/GPS enforcement
is a separate app/API contract change. No frontend code changed here.

Report endpoints expose these additive fields:

```json
{
  "assessment_status": "assessed",
  "priority": "routine",
  "needs_review": false,
  "priority_reason": "No visible obstruction or identified special handling concern.",
  "resident_answers": {"fire": false, "sharp_objects": false},
  "assessment": {
    "description": "Mixed bags and rubble",
    "size": "medium",
    "obstruction": "none_visible",
    "obstruction_level": "none",
    "forces_people_into_traffic": "no",
    "special_handling": "none_identified",
    "reason": "Waste is beside the path with no visible obstruction.",
    "visible_fire": "no",
    "visible_sharp_objects": "no",
    "confidence": 0.8,
    "resident_context_agreement": "consistent",
    "comparison_reason": "Resident answers agree with visible conditions."
  }
}
```

The prompt makes the photo primary evidence and resident context an unverified
reference. Negative answers cannot clear visible hazards. Positive hazard claims
unsupported by the photo, contradictions, unclear special handling and insufficient
evidence require review. Confidence is self-reported, not calibrated accuracy or a
priority input. One context-bearing call does not prove independence from context.
Coordinates do not establish nearby buildings, weather or hidden hazards.

High means complete entrance obstruction or access obstruction forcing people into
traffic. Medium covers other partial/complete access or drain obstructions. Routine
requires usable no-obstruction evidence with no identified special handling concern.
Otherwise priority is null. Supported high/medium priority is retained when review
is also required. Size never raises priority. These are demo rules, not an official
municipal risk standard.

Timeout, provider error or malformed output retains the report/photo with failed
status, null priority and review required. No model repair or automatic assessment
retry is performed. Expired assessment leases fail without replay; the generic
retry endpoint still refuses assessment tasks. Organizers can resolve those reports
through an audited decision rather than rerunning the model.

## Proximity review and organizer decisions

Reports within the configured radius (default 10 metres) are possible duplicates,
not proven duplicates. Both original reports/photos are retained and assessed. The
new report is marked for review with a private `report.possible_duplicate` event
containing the candidate and evidence report IDs. The worker preserves that review
after assessment and does not enqueue ordinary triage for it. Resident APIs expose
no other report's identifier or private audit details. Retry-safe replay of the same
submission still returns its original report without another photo/task.

Completed jobs, recheck-requested jobs and illustrative seed reports do not trigger
proximity review. `DUPLICATE_RADIUS_METERS=0` disables it for a demo. No reports are
rejected or merged based only on proximity. Coordinate changes through either the
internal clarification endpoint or worker follow-up apply the same authoritative
proximity rule as submission, using the configured radius and excluding the
report itself. Nearby evidence and the review flag persist in the clarification
transaction, and no ordinary triage is queued while review remains unresolved.
Idempotent replay does not add another clarification or duplicate-evidence event.

Automatic creation/linking requires a completed eligible assessment, with evidence
and resident answers revalidated in Python. An authenticated organizer can use the
existing `POST /organizer/reports/{id}/decision` to approve a settled review/failed
report for `create_job` or `link_job`. The decision must still supply sufficient
evidence, location, equipment/time for creation, or a confirmed open candidate with
its ID in `evidence_report_ids` for linking. `hazard: true` and `next_action: review`
still explicitly request review; approving ordinary cleanup requires clearing those
recommendations and explaining the decision in `decision_summary`.

Only this authorized endpoint enables the exception. Agents/residents cannot clear
review by setting fields. Successful approval clears `needs_review` and records the
organizer actor, reason, prior assessment status/review and resulting job ID in the
existing `report.triaged` audit. Raw model evidence and assessment status remain as
the historical model outcome. Pending assessments cannot be overridden. An organizer decision requesting review
sets a separate persisted `organizer_review_required` hold. Model completion,
automated triage, and resident clarification cannot clear this hold or enqueue
automatic assignment. Only a successful audited organizer create/link approval
clears it. Migration 0010 conservatively preserves existing unresolved review
states as holds. Command
idempotency and version checks still apply. Approved linked reports can serve as
future duplicate targets based on that organizer audit.

## Built-in decision methods

- `triage_report`: reuses the validated saved assessment, never calls a model again,
  and sends uncertain nearby reports to review. General waste gets gloves/bags;
  large size also requests a pickup truck. Size sets illustrative service estimates
  of 10/20/40/30 minutes for small/medium/large/unknown, never risk priority.
- `generate_plan`: greedily chooses the shortest next travel leg across eligible
  crews. It uses the supplied matrix, equipment, availability and shift budget,
  preserves fixed/ongoing work and completed time, and covers each job once. Existing
  backend validators approve or reject every proposal. This is a heuristic, not a
  globally optimal or live-road route; the matrix label remains explicit.
- `handle_followup`: replies from stored report/job status. Explicit `/clarify ...`
  adds information before job linking, and `/recheck ...` requests a recheck after
  completion. Free text otherwise returns status/help without changing state. These
  are deterministic commands, not unrestricted natural-language reasoning. Existing
  bind, followup, outgoing claim and acknowledgement APIs remain unchanged.

## Verification

Focused tests exercise the real gateway HTTP boundary with MockTransport, priority
rules, failure retention, duplicate evidence, and a Chalk-only worker advancing
assessment → triage → job → plan → followup without a second model call.
PostgreSQL tests additionally verify migrations, organizer authorization/overrides,
planning constraints, seed refresh and the real bind → followup → outgoing claim
loop with fake external services. Live Chalk/Groq requests, hosted Supabase changes,
and actual Photon delivery require deployment credentials and are not inferred
from CI success.

## Local photo check without a database

Put the Chalk gateway key, environment ID, and exact Grok model ID/route into an
ignored backend `.env`. Use the connection prefix from Chalk, not a guessed prefix:

```text
CHALK_ROUTER_API_KEY=<Chalk gateway key, not the xAI provider key>
CHALK_ENV_ID=<environment ID>
CHALK_MODEL=<exact discovered model ID or published route for Grok 4.3>
CHALK_REASONING_EFFORT=none
```

`CHALK_REASONING_EFFORT` is optional and omitted from requests by default. Grok 4.3
supports `none` for lower latency; remove this setting for models that do not
support it. The xAI key stays on the provider connection inside Chalk.

From the repository root, run:

```sh
uv run --extra backend python -m scripts.check_chalk_assessment /path/to/trash.jpg
```

Optional flags: `--model`, `--note`, paired `--latitude`/`--longitude`, and
`--fire yes|no`/`--sharp-objects yes|no`. The check requires an explicitly selected
model so it cannot silently test the default Qwen connection instead of Grok.
It sends one local JPG/PNG as a base64 data URL through `ChalkAssessmentClient`,
validates the real assessment contract, and prints elapsed seconds, assessment,
and deterministic priority. It creates no report or database rows. No request is
sent if credentials or the photo are missing/invalid. Credentials and upstream
error bodies are never printed. Exit codes: 0 success, 1 gateway/output failure,
2 missing configuration/invalid local inputs.

## Live model evidence

On 2026-10-17 the user ran the local checker against their desktop `trash.png`
with `xai/grok-4.3` through Chalk. It returned validated assessment JSON in 3.253
seconds, describing a large mixed-waste pile. Obstruction and traffic displacement
were unknown, so Python returned null priority and review required, as intended.
This is one user-reported live photo request, not a latency benchmark or independent
accuracy check. It did not create a database report or verify hosted worker flows.
No API key or source photo is stored in this evidence.

## Upgrade recovery and absent Chalk configuration

Migration 0011 queues an assessment for each pre-existing unlinked pending report
with matching photo metadata and no prior assessment task. Existing assessment
attempts are never replayed. Existing linked jobs are not retrospectively assessed
or changed. Organizer holds survive the backfill and any subsequent model result.
Unlinked pending reports with missing photo metadata or only terminal old tasks
move to `needs_review` with a durable hold so an audited organizer decision can
resolve them instead of returning a permanent pending-assessment conflict.
The migration ledger and task dedupe key make reruns idempotent.

An external-only decision worker may still process triage, plan and followup tasks,
but an unattempted assessment is not claimable until the Chalk client is configured.
It retains pending status, zero attempts and no lease. Adding credentials and
restarting the worker makes that same task available without a manual retry.
Startup warns when assessments are disabled. Already-attempted interrupted work
still terminalizes without another model call, preserving the one-call guarantee.
Actual provider errors and malformed outputs remain failures requiring review;
missing local configuration is not treated as a provider attempt.
