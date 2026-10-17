# Minimal waste assessment

New reports are saved with `assessment_status: pending` and enqueue one
`assessment` task in the existing database worker. Submission returns the existing
201 report response immediately; the latest result is available from the existing
resident and organizer report endpoints. No extra model service, queue, dashboard,
follow-up flow or planner is required.

The backend branch had an HTTP decision-provider interface but no implemented
image model client. `ChalkAssessmentClient` therefore uses the already installed
httpx dependency to call the configured Chalk Model Gateway once with the signed
photo URL and optional note. No provider credentials belong in the mobile/web app.
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
    "reason": "Waste is beside the path with no visible obstruction."
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
