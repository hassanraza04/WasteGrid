# Minimal waste assessment

New reports are saved with `assessment_status: pending` and enqueue one
`assessment` task in the existing database worker. Submission returns the existing
201 report response immediately; the latest result is available from the existing
resident and organizer report endpoints. No extra model service, queue, dashboard,
follow-up flow or planner is required.

The backend branch had an HTTP decision-provider interface but no implemented
image model client. `ChalkAssessmentClient` therefore uses the already installed
httpx dependency to call the configured Chalk Model Gateway once with the signed
photo URL, coordinates, optional note, and resident hazard answers. No provider credentials belong in the mobile/web app.
The legacy decision-provider interface remains available for existing workflows.

## Setup

Apply the new migration using the existing migration command:

```sh
uv run --extra backend python -m scripts.migrate
```

Configure server environment variables:

```text
CHALK_ROUTER_API_KEY=<gateway key, not the Groq provider key>
CHALK_ENV_ID=<Chalk environment ID>
CHALK_MODEL=groq/qwen/qwen3.8-27b
CHALK_ROUTER_BASE_URL=https://api.chalk.ai/v1/router
ASSESSMENT_TIMEOUT_SECONDS=30
DUPLICATE_RADIUS_METERS=10
```

Run the existing worker alongside FastAPI:

```sh
uv run --extra backend python -m api.worker
```

With only Chalk configured, the worker processes assessment tasks. Configure the
existing Person 3 decision provider separately to process legacy planning or
follow-up tasks. New submissions no longer enqueue the legacy triage/job-creation
pipeline. Assessment itself does not create cleanup jobs.

## Added report fields (example fragment)

```json
{
  "assessment_status": "assessed",
  "priority": "routine",
  "needs_review": false,
  "priority_reason": "No visible obstruction or identified special handling concern.",
  "assessment": {
    "description": "Mixed bags and rubble",
    "size": "large",
    "obstruction": "none_visible",
    "obstruction_level": "none",
    "forces_people_into_traffic": "no",
    "special_handling": "none_identified",
    "reason": "Waste is beside the path with no visible obstruction.",
    "visible_fire": "no",
    "visible_sharp_objects": "no",
    "confidence": 0.8,
    "resident_context_agreement": "not_provided",
    "comparison_reason": "No resident claims were provided."
  }
}
```

These are hackathon demo rules, not an official municipal risk standard. Backend
rules generate `priority_reason`; the model does not choose priority. Size is
stored only as an approximate workload signal. Unknown size alone does not raise
priority. Routine requires affirmative, consistent no-obstruction evidence, no
traffic displacement, and `none_identified` special handling. Unknown special
handling requires review even when a high/medium obstruction priority is supported.
Suspected special handling keeps any supported high/medium priority and prohibits
ordinary job creation through the legacy automatic triage boundary.

Timeout, provider error, missing credentials at processing time or invalid JSON
sets `assessment_status: failed`, `priority: null`, `needs_review: true`. The report
and photo remain available. There is no output repair or automatic retry. Expired
assessment leases fail without replaying the request, and the generic task retry
endpoint rejects assessment replays. A worker process crash can leave pending
status visible until the lease expires and the worker next runs.

Verification: `pytest -q tests/test_assessment.py` checks the rule cases, one-call
HTTP boundary, real local SQLite transaction persistence, expired leases and
POST/GET report API flow with a fake provider. Existing backend integration tests
require a disposable local PostgreSQL server; those retain explicit legacy triage
fixture setup for their planning/messaging checks. No live Chalk/Groq request or
Supabase migration was executed in this workspace.

## Clarified capture and metadata flow

`POST /reports` remains multipart. In addition to `photo`, `latitude`, `longitude`
and optional `note`, it now accepts optional `resident_fire` and
`resident_sharp_objects` boolean form fields (`true` / `false`). Omitted answers
are unknown, not false. They are stored separately as `resident_answers` and
exposed by report APIs. A valid report can still be retained without GPS, for
example after permission denial; no location deduplication is possible then.
The frontend owner controls camera capture and location permission prompts;
no frontend files changed in this PR.

Before creating a report row or storing its photo, the backend checks unresolved
reports within `DUPLICATE_RADIUS_METERS` (default 10; 0 disables the policy).
It uses a database latitude-band filter and exact haversine distance. The
existing PostgreSQL transaction lock serializes check-and-create with other
mutations. Completed jobs are excluded, while reports without jobs, pending
reports and review cases are unresolved. There is no time cutoff. This is a
proximity rule, not proof of identical waste: different piles within the radius
or noisy GPS can be rejected, and a new hazard at an existing report's location
will also be rejected. The policy does not merge new evidence into older reports.

A nearby match returns HTTP 409 before photo Storage upload, new report/task
creation or a new model call:

```json
{"detail": "Trash already reported at this location."}
```

It also sets `X-WasteGrid-Error: trash_already_reported`. No existing report ID,
resident access token, exact existing coordinates or private photo is disclosed.
The frontend can use the response to display a popup later. The backend still
receives the request's photo bytes; it prevents durable storage, not transfer
from the phone. Retry-safe replay of the same report ID/token is checked first
and returns the original report rather than a false duplicate error.

For accepted reports the one Chalk request contains the signed photo URL and a
JSON context with `location`, `resident_note`, and `resident_answers`. The model
is instructed to assess the image first, keep resident claims separate, and then
return `visible_fire`, `visible_sharp_objects`, `confidence` (0-1),
`resident_context_agreement` and `comparison_reason` alongside the original
assessment fields. New gateway responses require all these fields. Older stored
assessments remain readable with unknown/null defaults. Coordinates alone do
not establish surrounding risks; the model performs no geocoding or DB lookup.

Confidence is self-reported, not calibrated accuracy or a safety probability.
It is stored for inspection and is never used to calculate priority or approve
assignment. A single call with resident context cannot guarantee mathematical
independence from that context; the system prompt establishes the evidence
policy rather than proving independence. Model quality on this policy still
needs evaluation with real representative images.

A visible fire or sharp-object flag requires review even if the model incorrectly
returns `special_handling: none_identified`. A resident's negative answer cannot
clear an observed hazard. A positive resident hazard claim unsupported by the
photo remains an unverified claim and requires review; it is not copied into
visual observations. Explicit model-reported contradictions also require review.
Supported high/medium priority is preserved; routine becomes null when there is
an unresolved contradiction/positive hazard claim. Other priority rules remain
ordinary Python.

Deploy migrations 0007 and 0008 before these API/worker changes. The Render worker
blueprint now lists Chalk credentials, model, base URL and timeout. Secrets must
still be configured in the target environment. PR integration is not live service
verification: this branch is still draft/unmerged and no live credentials or
Supabase migration were exercised here.
