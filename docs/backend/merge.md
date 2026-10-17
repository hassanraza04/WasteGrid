# PR #4 review handoff

The backend branch `omer/backend-foundation` has an open PR. Hassan requested
three changes: synchronize the exported contract, keep triage out of resident
report responses, and use constant-time comparison for completion-photo access.
The separate automated review found that blocked jobs could not resume. The
working tree implements all four responses; [verification.md](verification.md)
records the checks. No review changes have been committed or pushed by the agent.

Latest inspected `origin/main`: `430a0172323c938e6ea927681f5372fd7e4eac74`.
It adds the mobile source and a CI workflow. PR #4 currently conflicts with
`main`; the user must update the branch before merge. A disposable combined
snapshot passed 82 Python tests and contract export checks.

## User-run steps

1. Review `git diff`, especially the public/organizer schema split,
   blocked-assignment rules, generated OpenAPI, and test cases. Run
   `git diff --check` and `scripts/verify_backend.sh` with a disposable
   localhost `TEST_DATABASE_URL` as described in [setup.md](setup.md).
2. Commit the reviewed working changes yourself. Suggested message:
   `fix(api): protect triage data and preserve blocked assignments`.
3. Run `git fetch origin`, then update the branch with `git merge origin/main`.
   This retains published branch history and avoids a force push. Resolve any
   overlap deliberately: keep the backend optional dependencies alongside
   main's dev dependency group, preserve the private environment-file and
   `.data/` ignore rules, retain main's mobile files and CI workflow, and
   regenerate `uv.lock` with `uv lock` after resolving `pyproject.toml`.
4. Update main's Python CI job to install `--extra backend` and provide a
   disposable PostgreSQL service plus `TEST_DATABASE_URL`. Without those, it
   either cannot import `psycopg` or skips backend database tests. Do this as
   part of the user-managed branch update; do not replace teammate CI wholesale.
5. Rerun the full verification and generated-contract check on the updated
   branch, inspect GitHub CI/review, then push the branch yourself. Share the
   updated PR with Hassan for review.

Live Supabase, Render, Person 3, Photon, dashboard, and mobile acceptance remain
separate deployment/integration checks.
