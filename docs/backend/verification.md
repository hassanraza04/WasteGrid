# Dashboard contract completion: verification evidence

## Local backend demo and handoff: 2026-10-17

Verified the working tree on `main`, based on `f9f8f32`, with the repeatable live
verifier and handoff documentation. Supabase configuration is complete for
project `einjnvlhdogzdxafauyr`; the earlier statements about unavailable Supabase
credentials below describe historical checkpoints.

| Check | Result |
| --- | --- |
| Full backend workflow, Python 3.12 / disposable PostgreSQL 17 | 107 passed; zero failures, errors or skips |
| New verifier tests | 22 passed, including failed login, unreachable API, unexpected authorization, public-photo exposure, secret-free diagnostics, loopback validation and read-only database enforcement |
| Contract export, flake8, Black, isort and whitespace | Passed |
| Docker build and real HTTP smoke | Passed all 11 checks against disposable data and explicit cloud doubles |
| Local Uvicorn with live Supabase | Passed all 20 live checks, completed 2026-10-17 15:35:44 UTC |
| Preserved live fixture | Ten reports, six jobs, two crews, ten photos and five assignments; before/after application, account identity and Storage metadata fingerprints matched |

The API was left running on `http://127.0.0.1:8000`; `/health`, `/ready` and
`/docs` were checked over HTTP. Runtime availability depends on that local
process remaining active. Start/stop instructions and repeatable commands are
in [setup.md](setup.md#current-local-demo); the
[owner handoff and Swagger walkthrough](dashboard-handoff.md#local-swagger-walkthrough)
describe the demo without changing its fixtures.

Live checks used real Supabase password sign-ins for all three staff accounts,
verified protected roles and crew isolation, and downloaded authorized photos
while rejecting public access. Database reads confirmed all migration hashes,
RLS, client privilege restrictions and the schema's exclusion from the Data API.
The bucket remains private with the 8 MiB JPEG/PNG/WebP limit. The verifier did
not create accounts or change reports, jobs, assignments or Storage objects;
sign-ins created normal Auth sessions. State-changing workflows were exercised
only in disposable databases.

Reproduce from the repository root with the configured local API running:

```bash
export TEST_DATABASE_URL='postgresql://postgres:wastegrid-local-test@127.0.0.1:55432/wastegrid_test'
bash scripts/verify_backend.sh
uv run --extra backend python -m scripts.verify_live_backend
```

The latest live report is `.data/backend-live-verification.json` (Git-ignored).
JUnit evidence is `/tmp/wastegrid-backend-verification/pytest.xml`. The existing
`verification.json` is an older historical record, not this run's evidence.
The live command overwrites its latest local report with a timestamped result
on success or failure and returns nonzero for a failed check.

Source SHA-256 values for this acceptance:

- `scripts/verify_live_backend.py`: `99a07e7d551ab71d66d1cba552984d0c10cd0e6da64358631f679f232b04aa6c`
- `tests/backend/test_live_verifier.py`: `0818691a4c453470fd8f77f4b971368e2ac15e7b2b3b9d33031505bedabff4af`

Docker image: `sha256:14a47c357a86be923b57250138ca61df152485be5662b9bb0f33c57e823e8974`.
API v0.2, generated contracts and all six migration files are unchanged.
The worker is inactive; real Person 3 processing, Photon delivery, frontend/mobile
adapters and public hosting remain separate integration milestones. No real AI
or messaging delivery is claimed by this local backend acceptance.

## Integrated branch verification: 2026-10-17

Recorded at 12:00 UTC after merging `origin/main`
`60687a73453827efe7f8a54a02ba5f78ae246f66` into `omer/backend-foundation`.
Review checkpoint `fd2603e` and merge commit `b625a91` preserve published history.
The following results cover the actual merged branch with the accompanying CI
integration changes, rather than the earlier disposable compatibility copies.

| Check | Result |
| --- | --- |
| Python 3.12.3, full suite against PostgreSQL 17 | 85 passed; 0 failures/errors/skips |
| Python 3.13.15, full suite against PostgreSQL 17 | 85 passed; 0 failures/errors/skips |
| OpenAPI/schema/fixture export checks | Passed on Python 3.12 and 3.13 |
| Black, isort, flake8, messaging mypy | Passed; mypy checked 8 messaging source files |
| Python dependency audit | Passed with upstream's existing `PYSEC-2026-2275` exception; no new exclusions |
| Six migrations, populated upgrade and replay checks | Passed on disposable databases |
| Python 3.12 Docker build and HTTP smoke | Passed all 11 HTTP checks |
| Web, Node 22.23.3 | 24 tests passed; coverage and production build passed; audit found 0 vulnerabilities |
| Mobile, Node 22.23.3 | Typecheck, lint, and configured audit passed |

The mobile audit reported 20 high-severity dependency findings covered by its
existing two advisory exceptions (`GHSA-86w9-cpqp-85rv` and
`GHSA-vfj7-8cjw-p6xm`). The exceptions were preserved, not expanded.
Mobile, web, and messaging source matches the merged upstream revision.

The CI Python job now installs the backend extra and the unified dev group,
starts PostgreSQL 17 with disposable test credentials, and verifies generated
contracts. The local verification script also checks that the lockfile agrees
with the manifest. Both Python test reports confirm no skipped tests.

Docker image: `sha256:b3b7e1d475640a973de1b72db641c23456c38c76b81a6edd7ca7b15f2a914cbd`.
Local JUnit reports: `/tmp/wastegrid-backend-verification/pytest.xml` and
`/tmp/wastegrid-backend-verification/pytest313.xml`.
Hosted CI and review status are available on [PR #4](https://github.com/hassanraza04/WasteGrid/pull/4).
Live Supabase, Render, Person 3, Photon, and frontend acceptance remain separate
integration checks; the cloud calls in local backend tests use explicit doubles.
The earlier sections and `verification.json` below are historical evidence.

## Second PR review follow-up: 2026-10-17

Fixed blocked assignments now require current crew availability and equipment
when a plan is applied. A blocked crew route must also fit its current shift;
ongoing work retains the previous shortened-shift exception. Three regression
cases reject plans after availability, equipment, or shift capacity changes,
while the existing blocked-job resume and ongoing-work tests still pass.

The 413 OpenAPI description is now explicitly `Content Too Large`, so generated
contracts do not depend on the Python HTTP status phrase. The regenerated
`openapi.json` differs only in that description. `uv sync --locked --extra
backend` and the contract export check passed. The full
`scripts/verify_backend.sh` run passed **85 Python tests**, contract checks,
flake8, Black, isort, six disposable PostgreSQL migrations, Docker build, and
11 HTTP smoke checks. No tests were skipped. The four documentation headings
with em dashes were updated to plain punctuation.

At this checkpoint, the fetched `origin/main` was `430a0172323c938e6ea927681f5372fd7e4eac74`.
An isolated copy of that revision with the current backend files and a resolved
combined lockfile passed the contract check and **85 Python tests** against the
disposable PostgreSQL server. This compatibility copy did not change branch
history.
PR #4 then reported a conflict and requested changes. Shared changed paths since
the merge base are `.gitignore`, `README.md`, `pyproject.toml`, and `uv.lock`.
The branch update was subsequently authorized and completed as recorded above.

## First PR review follow-up: 2026-10-17

Hassan's requested privacy and credential-comparison fixes are implemented in
the working tree. Public report creation/lookup responses now omit `triage`;
organizer report routes and trusted Person 3 snapshots retain it. Completion
photo access uses constant-time resident token-hash comparison. The separate
automated review finding is also addressed: assigned blocked work remains fixed
through a new plan and can resume when the current plan and crew constraints
allow it. Focused tests cover both blocked entry states, cross-report photo
access, and denial of planner assignment for unassigned blocked work.

`scripts/verify_backend.sh` passed on the review working tree: **82 Python
tests**, contract export, flake8/Black/isort, six migrations, Docker build, and
11 HTTP smoke checks. A disposable copy combining this backend with latest
`origin/main` `430a0172323c938e6ea927681f5372fd7e4eac74` passed **82 tests** and
the generated contract check with a resolved combined lockfile. No live
Supabase, Render, Chalk, or Photon exchange is claimed.

At this checkpoint, the upstream CI workflow still needed integration:
its `uv sync --locked --group dev` omitted the optional `backend` extra,
and its Python job provided no `TEST_DATABASE_URL`. Replaying its commands in
the disposable combined copy failed during collection with missing `psycopg`.
Installing the backend extra and provisioning disposable PostgreSQL was required
for CI to test the backend. At that checkpoint, the review changes were
uncommitted and PR #4 conflicted with the advanced `main`.

## Earlier dashboard-contract evidence

Recorded 2026-10-17T03:43:06.641278+00:00. The approved incremental backend plan is
implemented. The code is ready for teammate adapter integration and review;
live deployment and end-to-end frontend/Photon acceptance remain external steps.

## Increment checkpoints

| Increment | Verified result before continuing |
| --- | --- |
| Baseline on main `f8b5703` | 68 Python tests passed |
| Identity and authorized tracking | 40 dashboard/workflow tests passed; contract exports checked |
| Customer update history | 45 backend tests passed; contract exports checked |
| Conversation history | 48 backend tests passed; contract exports checked |
| Final local suite, including demo history reset | **68 passed**, 49 backend + 19 existing; zero failures/errors/skips |
| Latest-main combined snapshot | **78 passed**, 49 backend + 29 upstream tests; zero failures/errors/skips |

No next increment started until the preceding increment passed. The identity
upgrade test exposed deferred foreign-key checks during backfill; migration
0004 now completes those checks before ALTER TABLE operations. A generated
acknowledgement response example was corrected to match its strict schema.

## Final checks

`scripts/verify_backend.sh` completed with exit code 0. It verified contract
exports, selected flake8 correctness/unused-name rules, Black, isort, whitespace,
Docker build and the real-Uvicorn HTTP smoke test.

All six SQL migrations applied to disposable PostgreSQL 17 databases. Tests also
upgrade a populated 0001–0003 schema, preserve original report data, backfill
unique references, leave unknown historical statuses null, and verify private
message storage. Original migrations 0001–0003 retain their previous hashes.

The tests prove title/address persistence without coordinates, required photos,
stable retry-safe references, UUID/reference authorization, organizer responses,
ordered/paginated safe updates, completion snapshots after rechecks, and immutable
reference/history records. Conversation tests cover duplicate input, changed
retries, crew/cross-report denial, hidden transport identifiers, failed/queued
send exclusion, stale leases, duplicate acknowledgements and atomic rollback of
message/task and message/delivery writes. Demo reset clears illustrative history.
Existing workflow, resource feasibility, private-photo and provider-retry tests
continue to pass.

Tested Docker image:

```text
sha256:fafb380f6d57421301303958139593e3cecd9b6429c2aceff47ab1a30d299915
```

Docker HTTP checks covered readiness, report persistence, resident authorization,
private photo signing, Supabase Auth HTTP verification, organizer token isolation,
durable tasks, title/address and reference lookup, customer update history,
idempotent inbound history and acknowledged outbound history. `PORT=18765` was
used. Auth/Storage were explicit local HTTP doubles; the acknowledgement exercise
did not send a real Photon message.

## Repository compatibility

Latest tested main: `fc3c7952d9c1b5a9edebf1be32a5034e1212f9c7`. It includes the Photon delivery
ledger and the subsequent mobile submodule pointer update. All patches other
than `.gitignore` applied directly to a plain temporary archive; the scratch
ignore file preserved both sets of rules. The working `.gitignore` also retains
`.data/` and environment exclusions. An actual Git update may still need conflict
resolution; the user-run instructions are in [merge.md](merge.md).

At this earlier checkpoint, working branch HEAD was
`a20a5a6c3ba030b523da0645be8124110d23893a` on
`omer/backend-foundation`, and the index was empty. No commits, pushes, rebases
or merges were performed during that verification. Teammate frontend, mobile,
and messaging implementation files were not changed. Frontend and mobile builds
were not run.

## Evidence and remaining acceptance

[verification.json](verification.json) contains individual test results, source
hashes, image identity and the check metadata. Temporary raw evidence is at
`/tmp/wastegrid-dashboard-verification.log`,
`/tmp/wastegrid-backend-verification/pytest.xml` and
`/tmp/wastegrid-dashboard-main-verification.xml`; these files may disappear after
cleanup. The JSON record preserves the relevant results. Three dependency
warnings and the existing uv development-dependency warning remain.

The proposed v0.2 contract and samples are ready in
[dashboard-handoff.md](dashboard-handoff.md). To complete live acceptance:

1. Configure Supabase, run migrations, seed illustrative data and provision
   organizer/crew Auth roles using [setup.md](setup.md).
2. Connect the dashboard's async API/Supabase adapters, required photo input and
   token-authorized tracking, retaining its existing UI routes.
3. Connect Person 3's provider and Person 4's existing ledger/adapter to the
   specified endpoints. Delivery acknowledgements now require `sent_text`.
4. Deploy/configure Render and share the actual dev HTTPS base URL. Verify real
   report creation, authorized tracking, organizer reads and messaging delivery.

No hosted URL, real Supabase verification, real provider output or live Photon
success is claimed by the local tests. Rerun verification after implementation
or upstream changes; these results apply to the recorded source hashes.
