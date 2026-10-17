# Shared development API deployment

**Owner:** Omer. **Prepared:** 17 October 2026. **Status:** configuration prepared;
Render service and shared HTTPS URL still pending. This document is shareable;
the environment and account credential files are private.

## Deployment scope

Use [`render.dev.yaml`](../../render.dev.yaml) for one Docker web service named
`wastegrid-api-dev`, on the Free plan in Ohio. It uses the reviewed `main` branch,
manual deployments and `/ready` health checks. Select this filename explicitly
when creating a Blueprint. The older [`render.yaml`](../../render.yaml) also
defines a worker and is not the configuration for this milestone.
See [Render's Blueprint reference](https://render.com/docs/blueprint-spec).

The API uses the existing Supabase project
`https://einjnvlhdogzdxafauyr.supabase.co` for PostgreSQL, Auth and private Storage.
No additional database or disk is needed. The Dockerfile already binds
`0.0.0.0:$PORT`; use its default command. API v0.2 and the six installed migration
checksums remain unchanged. Do not reseed the project.

The worker stays inactive. New submissions can be stored and tracked, but their
AI tasks remain queued. Existing plans and decisions are illustrative fixtures.
Messaging delivery remains unconnected. Do not describe either integration as
working merely because `/ready` passes.

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
| `CORS_ORIGINS` | Initially `["http://localhost:5173","http://127.0.0.1:8000"]`, matching the current local configuration and supplied dashboard origin. |
| `SUPABASE_PHOTO_BUCKET` | `report-photos` |

Do not import demo passwords, user JWTs, Photon credentials, or `PERSON3_*`/
`INTEGRATION_FACTORY` settings into this API service. Staff credentials remain
in `.env.supabase-demo`; users obtain fresh JWTs from Supabase Auth.

The CORS entries are **frontend browser origins**, not API URLs. Once a dashboard
or Expo web origin changes, add its exact scheme, hostname and port with no path.
Native mobile HTTP calls do not require CORS. Adding the API's own HTTPS URL to
this list does not grant a separately hosted frontend access.

## Create the service

1. Commit and push this preparation branch for review, then merge through the
   repository's normal review process. Do not push directly to `main`.
2. In Render, connect the GitHub account/repository, create a Blueprint from
   `main`, and select **`render.dev.yaml`**. Confirm the preview contains one
   Free web service and no worker/database.
3. Fill the prompted environment values from the private export. For individual
   fields, use the actual value without dotenv wrapper quotes. Existing services
   also support **Environment → Add from .env**. Review the parsed CORS value as
   a JSON array. See [Render environment setup](https://render.com/docs/configure-environment-variables).
4. Before creation/deployment, check which `main` commit Render will build. The
   reviewed starting point is `b3dec0a`; this preparation adds no SQL migrations.
   If other PRs have since added migrations, review and apply those separately
   before deploying that newer code. Do not apply PR #6 migrations as part of
   this preparation.
5. Deploy, copy the **actual HTTPS URL** from Render, and record it with the
   deployed commit SHA. Keep automatic deployment off. A placeholder or service
   name is not proof that a URL exists or is reachable.

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

After deployment, set `API_BASE_URL` to the actual Render HTTPS origin in a local
terminal (it is public configuration), then run these credential-free checks:

```bash
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

Record hosted acceptance here before announcing readiness:

| Evidence | Result |
| --- | --- |
| Actual API HTTPS URL | Pending |
| Render service ID and deployed commit SHA | Pending |
| UTC verification time | Pending |
| Health, readiness, docs and unauthenticated denial | Pending |
| Staff roles, crew isolation and private photos | Pending |
| Actual browser CORS check | Pending |
| Supabase fixture preservation | Pending hosted checks |
| Worker / messaging | Inactive / unconnected |

## Owner handoff after acceptance

| Recipient | Share and next action |
| --- | --- |
| Mobile owner | Verified HTTPS API URL and [mobile integration handoff](mobile-handoff.md). Resident flows need only the API URL; staff login also needs the Supabase URL, publishable key and appropriate private account credentials. Store resident tokens securely. |
| Hassan: dashboard | Same API URL, Supabase public configuration and organizer account privately. Confirm browser origin and CORS. Never embed integration/server keys in the dashboard. |
| Hassan: messaging server | API URL and existing messaging key privately. Use `X-Integration-Key` on messaging `/internal/...` routes and exact `sent_text` acknowledgements. Hosting alone does not start Photon. |
| Sherry: AI | API URL, [provider contracts](contracts.md) and optional separate agent key privately. Worker activation follows provider review, migration review and an agreed queued-task policy. PR #6 is still awaiting permission to review. |

Update the shared URL in this record, the mobile handoff and dashboard handoff
only after acceptance. Never distribute `.env.render-dev` or the backend `.env`
as a frontend configuration file.
