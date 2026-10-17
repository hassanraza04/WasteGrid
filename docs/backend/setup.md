# Setup and deployment

## 1. Local configuration

From the repository root:

```bash
uv sync --extra backend
cp .env.example .env
```

Keep `.env` ignored. Existing Photon settings remain in the example. Configure:

| Variable | Value/source |
| --- | --- |
| `DATABASE_URL` | Supabase **Connect → Session pooler**, port 5432. Use the supplied `postgres.PROJECT_REF` user and host; URL-encode the database password; append `?sslmode=require`. Prefix may be `postgresql://` or `postgresql+psycopg://`. |
| `SUPABASE_URL` | Project URL, e.g. `https://PROJECT_REF.supabase.co`. |
| `SUPABASE_SECRET_KEY` | Backend-only secret API key (`sb_secret_…`) or legacy `service_role` key. |
| `SUPABASE_PHOTO_BUCKET` | Keep `report-photos`, matching the migration. |
| `MESSAGING_API_KEY` | A random 32-byte secret shared only with Person 4's server adapter. |
| `AGENT_API_KEY` | A different random secret for Person 3's optional read-only context tools. |
| `CORS_ORIGINS` | JSON array of exact dashboard origins, e.g. `["http://localhost:5173","https://your-dashboard.example"]`. |
| `CHALK_ROUTER_API_KEY` | Chalk Model Gateway key for the assessment worker, not an upstream provider key. |
| `CHALK_ENV_ID` | Chalk environment ID for the assessment worker. |
| `CHALK_MODEL` | Default `groq/qwen/qwen3.8-27b`; use the configured connection prefix. |
| `ASSESSMENT_TIMEOUT_SECONDS` | Default 30; one request and no automatic retries. |
| `DUPLICATE_RADIUS_METERS` | API proximity policy for unresolved reports; default 10 metres. |
| `PERSON3_BASE_URL` | Person 3 HTTP facade base URL, once available. |
| `PERSON3_API_KEY` | Optional bearer credential for that facade. |
| `INTEGRATION_FACTORY` | Alternative to HTTP: `package.module:create_provider`. Factory receives `Settings` and returns a `DecisionProvider`. Leave blank when using HTTP. |

Generate each integration secret independently:

```bash
python -c 'import secrets; print(secrets.token_urlsafe(32))'
```

Only Supabase's project URL and **publishable/anon key** go in the frontend's
public configuration. The database password and secret/service-role key stay
on the backend. Resident tokens belong in device secure storage, never URLs,
analytics, organizer listings or model context.

## 2. Supabase project

1. Create the project and record its database password, URL and server API key.
2. Enable email/password in Supabase Auth. Create the organizer and two crew
   demo users in the Auth dashboard; confirm their email addresses there for the
   demo. Save their Auth user UUIDs. Do not derive roles from user-editable metadata.
3. Run the migration runner against the project:

   ```bash
   uv run --extra backend python -m scripts.migrate
   ```

   It applies all SQL files in one transaction, uses a migration lock and checks
   checksums on subsequent runs. Do not mix this runner with independently
   applying the same SQL through another migration history. The schema is
   `wastegrid`, with client access revoked and RLS enabled. Keep it out of the
   Supabase exposed API schemas. Migration 0002 creates the private 8 MiB
   JPEG/PNG/WebP bucket. Do not add public Storage policies for this bucket.
   Existing installations also apply additive migrations 0004–0009 for report
   identity, event status snapshots and conversation history. Existing references
   are backfilled; unknown addresses/historical statuses stay null. No existing
   migration checksum changes are needed. Apply these before deploying API v0.2.
4. Populate the illustrative demo:

   ```bash
   uv run --extra backend python -m scripts.seed_demo
   ```

   The command prints the two crew UUIDs. It creates ten clearly illustrative
   reports in Gulshan-e-Iqbal, including missing information, duplicate/review,
   hazard and shift-capacity cases, plus a validated fixture plan. Its synthetic
   images and decisions are explicitly labeled; they are not real model results.
5. Provision the protected roles using the Auth UUIDs and printed crew UUIDs:

   ```bash
   uv run --extra backend python -m scripts.provision_staff --user-id ORGANIZER_AUTH_UUID --role organizer
   uv run --extra backend python -m scripts.provision_staff --user-id CREW_A_AUTH_UUID --role crew --crew-id CREW_A_UUID
   uv run --extra backend python -m scripts.provision_staff --user-id CREW_B_AUTH_UUID --role crew --crew-id CREW_B_UUID
   ```

6. Start the API:

   ```bash
   uv run --extra backend uvicorn api.main:app --host 0.0.0.0 --port 8000 --no-access-log
   ```

   `/health` is process liveness; `/ready` requires database/schema access and
   configured Supabase settings. It does not certify provider credentials.
   `/docs` is interactive OpenAPI. Authenticate staff with Supabase
   `signInWithPassword`; send the resulting **user access JWT** as `Bearer` to
   FastAPI. `/auth/me` verifies the session and returns the protected role.

## 3. Connect Persons 3 and 4

Share `contracts.md`, `openapi.json` and the fixture directory first. Configure
the Chalk gateway key/environment for assessments (or Person 3's facade/factory for legacy workflows), then start the worker:

```bash
uv run --extra backend python -m api.worker
```

The worker can also run a single task with `--once`. Its persisted task leases
recover after a crash. Legacy triage/planning/follow-up tasks retry up to five times, with bounded backoff;
organizers inspect `/tasks` and retry failed legacy tasks explicitly. Assessment tasks are attempted once and failures require review, with no repair or replay. No provider
configuration means the worker exits with a configuration message, preserving
the queue. API imports do not deploy Chalk functions.

Person 4 keeps the Photon service separate, uses `MESSAGING_API_KEY`, resolves
linked conversations, submits inbound messages and claims outgoing records.
Delivery retries and provider-side idempotency remain Person 4's responsibility.
The existing Photon echo agent is a smoke test, not the integrated adapter.
The upstream SQLite delivery ledger is also transport-only. API v0.2 requires
the actual `sent_text` on successful delivery acknowledgements; see
`dashboard-handoff.md` before connecting or updating the adapter.

## 4. Render

1. Create/connect the Git repository in Render once you have committed/pushed
   the reviewed changes. The prepared `render.yaml` defines the API Docker web
   service and worker. Choose the intended branch in Render.
2. Put the variables above in Render environment settings. Give the worker
   database/Storage/Person 3 settings; give the API database/Storage/integration
   keys/CORS settings. Do not include `.env` in a build.
3. Apply migrations from your local backend environment **before** the first
   service becomes healthy. Deployments intentionally do not run migrations at
   import/startup. Render uses `/ready` as its health path.
4. The Docker command binds `0.0.0.0` and Render's `$PORT` (local fallback 8000).
   The background worker uses `python -m api.worker`. All persistent state is in
   Supabase; a Render persistent disk is unnecessary.
5. Record the API HTTPS base URL and add the deployed dashboard origin to CORS.
   Give frontend owners that URL, the public Supabase configuration and their
   demo account credentials through your team's private channel.
6. Complete the live checks below before calling the **deployment** ready.

Local Docker build/run:

```bash
docker build -t wastegrid-api .
docker run --rm --env-file .env -e PORT=8000 -p 8000:8000 wastegrid-api
```

## 5. Reproducible verification

Use a disposable localhost PostgreSQL server. Tests create/drop their own
random database and stub only Supabase's `auth.users`/`storage.buckets` tables;
cloud HTTP services are doubled.
If `wastegrid-backend-test` is already running from verification, reuse it and
skip the `docker run` command below.

```bash
docker run --detach --rm --name wastegrid-backend-test \
  -e POSTGRES_PASSWORD=wastegrid-local-test -e POSTGRES_DB=wastegrid_test \
  -p 127.0.0.1:55432:5432 postgres:17-alpine
export TEST_DATABASE_URL='postgresql://postgres:wastegrid-local-test@127.0.0.1:55432/wastegrid_test'
uv run --extra backend pytest -q
uv run --extra backend python -m scripts.export_contracts --check
```

Without `TEST_DATABASE_URL`, PostgreSQL tests are explicitly skipped; a passing
Photon-only test run is not backend verification. For the complete check and
Docker smoke run, execute `scripts/verify_backend.sh` with the same exported
`TEST_DATABASE_URL`. It writes JUnit evidence to
`/tmp/wastegrid-backend-verification/pytest.xml` (override with `VERIFICATION_DIR`).

## 6. Live acceptance and reset

- Sign in as organizer and both crews. Verify one crew cannot access the other's
  job or evidence and that a user without a protected role is denied.
- Submit a real photo from the device, retrieve it using the resident token,
  and see the report in the organizer API/dashboard.
- Run real Person 3 triage and planning, inspect task/event evidence, and verify
  clarification, hazard review, duplicate handling and visible unassigned work.
- Use a real Photon exchange to bind a report, clarify it, request status and
  receive completion notification. Verify adapter restart/retry behavior.
- Disable a crew; verify no new start on invalid assignments and a feasible new
  plan. Complete a job with an after-photo, then request recheck.
- Verify Supabase denies public photo access while authorized signed URLs work.

For another demo, stop the worker/adapter, then run:

```bash
uv run --extra backend python -m scripts.seed_demo --reset-demo
```

Reset refuses databases containing non-illustrative reports/jobs. It preserves
Auth users and staff roles, recreates only a demo dataset, and removes the prior
fixture photos. Submit a fresh resident report for the live demonstration;
seeded reports deliberately do not publish resident tokens.

If a Storage operation or commit loses its acknowledgement, the backend avoids
deleting photos that have committed metadata. Failed cleanup logs only the
object path. Reconcile that path against `wastegrid.photos.object_path` before
removing an orphan through the Supabase dashboard.

References: [Supabase private buckets](https://supabase.com/docs/guides/storage/buckets/fundamentals),
[Supabase Auth user verification](https://supabase.com/docs/reference/python/auth-getuser),
[Render FastAPI deployment](https://render.com/docs/deploy-fastapi),
[Render Blueprint fields](https://render.com/docs/blueprint-spec), and
[Supabase secret-key headers](https://supabase.com/docs/guides/getting-started/api-keys).
