# Shared development API deployment

**Owner:** Omer. **Activated:** 17 October 2026. **Status:** API-only Render
service live at **https://wastegrid-api-dev.onrender.com**. This document is
shareable; the environment and account credential files are private.

## Deployment scope

The live service was created as a Docker Web Service from the repository's
public Git URL, on the Free plan in Ohio. It uses the reviewed `main` branch,
manual deployments and `/ready` health checks. The equivalent API-only Blueprint
is [`render.dev.yaml`](../../render.dev.yaml) for a future recreation where
Blueprints are available. The older [`render.yaml`](../../render.yaml) also
defines a worker and is not the configuration for this milestone.
See [Render's Web Service guide](https://render.com/docs/web-services).

The API uses the existing Supabase project
`https://einjnvlhdogzdxafauyr.supabase.co` for PostgreSQL, Auth and private Storage.
No additional database or disk is needed. The Dockerfile already binds
`0.0.0.0:$PORT`; use its default command. API v0.2 and the six installed migration
checksums remain unchanged. Do not reseed the project.

The worker stays inactive. New submissions can be stored and tracked, but their
AI tasks remain queued. Existing plans and decisions are illustrative fixtures.
PR #9's Photon adapter is merged into the repository but is not running as part
of this API-only deployment; live messaging delivery remains unverified. Do not
describe either integration as working merely because `/ready` passes.

The Free plan sleeps after 15 idle minutes and can take about a minute to wake.
Clients should show a connecting/retry state; do not blindly repeat a report
submission whose response was lost. Render also imposes workspace usage and
outbound-traffic limits. This is a development service, not an always-on promise.
See [Render's Free service limits](https://render.com/docs/free).

## Private environment preparation

The local, ignored `.env.render-dev` is an owner-only export prepared for Render.
It contains only the seven variables below. It is excluded from Git and Docker
build context. It contains secrets: do not send it to frontend/mobile owners.
If credentials or CORS change, update its values from the sources below before
importing; it is a snapshot, not a synchronized file.

| Variable | Source and intended value |
| --- | --- |
| `DATABASE_URL` | Existing `.env` session pooler URL, port 5432, percent-encoded password and `sslmode=require`. Use the same Supabase project. |
| `SUPABASE_URL` | `https://einjnvlhdogzdxafauyr.supabase.co` |
| `SUPABASE_SECRET_KEY` | Existing backend secret from `.env`. Never a frontend setting. |
| `MESSAGING_API_KEY` | Existing `.env` key; only Hassan's server adapter receives it privately. |
| `AGENT_API_KEY` | Separate existing `.env` key for optional AI context reads. |
| `CORS_ORIGINS` | Initially `["http://localhost:5173","http://127.0.0.1:8000"]`, matching the local configuration. Confirm the actual dashboard browser origin with its owner before relying on browser integration. |
| `SUPABASE_PHOTO_BUCKET` | `report-photos` |

Do not import demo passwords, user JWTs, Photon credentials, or `PERSON3_*`/
`INTEGRATION_FACTORY` settings into this API service. Staff credentials remain
in `.env.supabase-demo`; users obtain fresh JWTs from Supabase Auth.

The CORS entries are **frontend browser origins**, not API URLs. Once a dashboard
or Expo web origin changes, add its exact scheme, hostname and port with no path.
Native mobile HTTP calls do not require CORS. Adding the API's own HTTPS URL to
this list does not grant a separately hosted frontend access.

## Create the service

The following steps reproduce the current service without enabling a worker:

1. Use a reviewed `main` commit. Do not push directly to `main`. The active
   deployment shows source commit `7b77f8d` (the PR #10 merge), which added no SQL
   migrations. Review and apply any later migrations separately before deploying
   newer code.
2. In Render, choose **Deploy a Web Service → Public Git Repository**, connect
   `https://github.com/hassanraza04/WasteGrid`, select `main`, Docker, Free, Ohio,
   and the name `wastegrid-api-dev`. Leave the root directory blank, use
   `./Dockerfile`, keep the Docker command blank, and set `/ready` as health path.
   Keep automatic deployment off. This public-URL source uses manual deploys.
3. Add the seven server environment variables from the owner-only export. Use
   **Environment → Add from .env** with the unquoted, ignored
   `.env.render-dev-paste`, or enter values individually without `KEY=` prefixes
   or outer quotes. Do not use a Render Secret File; the API reads environment
   variables. Review the parsed CORS value as a JSON array. See
   [Render environment setup](https://render.com/docs/configure-environment-variables).
4. Deploy and verify the actual HTTPS URL and source commit in Render. Do not
   activate `render.yaml` or PR #6 migrations as part of this API-only service.

For subsequent releases, inspect migration changes, apply approved additive
migrations from the owner's local environment if needed, then manually deploy
the reviewed commit. API startup does not run migrations. Retain the previous
working commit for an application rollback; application rollback does not undo
database migrations.

## Acceptance before sharing the URL

Before the first deployment, while the fixture is idle, run:

```bash
uv run --extra backend python -m scripts.verify_live_backend
```

This checks all six migration hashes and the preserved Supabase fixture through
the existing local API. It intentionally accepts loopback URLs only. Do not
change that restriction to run it against an arbitrary remote host.

Run these credential-free checks (the URL is public configuration):

```bash
API_BASE_URL=https://wastegrid-api-dev.onrender.com
curl --fail --show-error --max-time 120 "$API_BASE_URL/health"
curl --fail --show-error --max-time 120 "$API_BASE_URL/ready"
curl --fail --show-error --max-time 120 --output /dev/null "$API_BASE_URL/docs"
curl --silent --show-error --max-time 120 --output /dev/null \
  --write-out '%{http_code}\n' "$API_BASE_URL/organizer/reports"
curl --silent --show-error --max-time 120 --include --request OPTIONS \
  "$API_BASE_URL/organizer/reports" \
  --header 'Origin: http://127.0.0.1:8000' \
  --header 'Access-Control-Request-Method: GET' \
  --header 'Access-Control-Request-Headers: authorization'
```

Expect `{"status":"ok"}`, `{"status":"ready"}`, a successful docs response,
401 for the unauthenticated report listing, and a successful preflight with
`access-control-allow-origin: http://127.0.0.1:8000`. Repeat the preflight with
`https://unconfigured.invalid`; expect rejection and no allow-origin header.
Also test from the actual dashboard browser. `/ready` checks database/schema
access and configured cloud settings; it does not certify the cloud key or AI.

After `/health` responds (the Free service may take about a minute to wake), run
the committed hosted verifier from the repository root:

```bash
uv run --extra backend python -m scripts.verify_hosted_backend
```

This runs the same 23 read-only Supabase/API checks as the local verifier, but
its destination is fixed in source to `https://wastegrid-api-dev.onrender.com`.
It accepts no alternate URL or credential arguments, and HTTP clients do not
follow redirects. The local command's loopback restriction remains in place.
The owner must have the ignored backend `.env` and `.env.supabase-demo` files
with the existing Supabase configuration and all three demo staff accounts;
never share these files with frontend/mobile owners. The command prints only
check names/results and writes timestamped, secret-free JSON to
`.data/backend-hosted-render-verification.json`. A failed check or failure to
write evidence exits nonzero. Normal Auth sessions are its only live writes.
If the service times out while waking, wait for `/health` and rerun the command.

On the verified HTTPS service, follow the existing
[read-only staff walkthrough](dashboard-handoff.md#local-swagger-walkthrough),
substituting the hosted origin. `/docs` is optional developer tooling. Verify
organizer access, Crew A's three assignments, Crew B's two, cross-crew denial,
authorized photo downloads and denied public Storage downloads. Use fresh user
JWTs privately; save only pass/fail results, status codes, timestamp and commit
SHA. Do not save tokens, signed photo URLs or response bodies with personal data.

Rerun the local verifier after these read-only checks to confirm the ten reports,
six jobs, two crews, ten photos and five assignments remain intact. Coordinate
separate test data before teammates begin state-changing integration tests;
those tests will change counts and may queue AI work.

Hosted acceptance on 17 October 2026:

| Evidence | Result |
| --- | --- |
| Actual API HTTPS URL | `https://wastegrid-api-dev.onrender.com` |
| Render source commit | `7b77f8d` (`main`, PR #10 merge); service ID not recorded |
| UTC verification time | Initial: 2026-10-17 17:20:15 UTC; committed hosted verifier rerun: 17:45:25 UTC |
| Health, readiness, docs and unauthenticated denial | Passed in 23-check hosted verifier; OpenAPI identifies WasteGrid API v0.2.0 |
| Staff roles, crew isolation and private photos | Passed: organizer, both crews, cross-crew denial, authorized photo downloads, public/direct Storage denial |
| CORS preflight | Configured `http://127.0.0.1:8000` accepted (200 with matching allow-origin); unknown origin rejected (400 without allow-origin). Actual dashboard browser origin and browser test remain to confirm with Hassan. |
| Supabase fixture preservation | Passed: 10 reports, 6 jobs, 2 crews, 10 photos, 5 assignments; application rows and Storage metadata compared, not photo bytes |
| Worker / messaging | Inactive / unconnected |

The initial acceptance used an ignored owner-local wrapper around the shared
checks. The committed `scripts.verify_hosted_backend` command above now makes
that hosted procedure reproducible and writes the same evidence filename. The
JSON evidence stays local; share the pass/fail summary rather than credentials.
The curl checks reproduce public HTTP and CORS acceptance without credentials.

## Owner handoff after acceptance

| Recipient | Share and next action |
| --- | --- |
| Mobile owner | Verified HTTPS API URL and [mobile integration handoff](mobile-handoff.md). Resident flows need only the API URL; staff login also needs the Supabase URL, publishable key and appropriate private account credentials. Store resident tokens securely. |
| Hassan: dashboard | Same API URL, Supabase public configuration and organizer account privately. Confirm browser origin and CORS. Never embed integration/server keys in the dashboard. |
| Hassan: messaging server | API URL and existing messaging key privately. Use `X-Integration-Key` on messaging `/internal/...` routes and exact `sent_text` acknowledgements. Hosting alone does not start Photon. |
| Sherry: AI | API URL, [provider contracts](contracts.md) and optional separate agent key privately. Worker activation follows resolution of PR #6 review findings, migration review and an agreed queued-task policy. |

Never distribute `.env.render-dev`, `.env.render-dev-paste` or the backend `.env`
as a frontend configuration file.
