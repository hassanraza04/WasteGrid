# Dashboard contract completion — verification evidence

## PR review follow-up — 2026-10-17

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

The new upstream CI workflow needs integration when the user updates this
branch: its `uv sync --locked --group dev` omits the optional `backend` extra,
and its Python job provides no `TEST_DATABASE_URL`. Replaying its commands in
the disposable combined copy failed during collection with missing `psycopg`.
Install the backend extra and provision disposable PostgreSQL for CI to test the
backend rather than skipping it. The review changes are uncommitted; PR #4 is
currently conflicting with the advanced `main` until the user updates it.

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

Working branch HEAD remains `a20a5a6c3ba030b523da0645be8124110d23893a` on
`omer/backend-foundation`; index is empty. No commits, pushes, rebases or merges
were performed. Teammate frontend/mobile/messaging implementation files were
not changed. Frontend/mobile builds were not run.

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
