# Review and commit commands

The requested dashboard contract is implemented and tested. Review
`dashboard-handoff.md` and the evidence before committing. Latest checked main
is `fc3c7952d9c1b5a9edebf1be32a5034e1212f9c7`. A disposable combined snapshot
passed 78 Python tests; the working branch itself has not been rebased or merged.
Our working `.gitignore` now includes `.data/` and the environment exclusions;
preserve both sets of rules if Git reports an overlap when updating the branch.

No commits, staging, pushes, rebases or merges were performed by the agent during
completion. All backend work is in the working tree on `omer/backend-foundation`.
Remote references were fetched for inspection. The existing branch starts from
`a20a5a6`. Compatibility was checked in a disposable archive of the main revision
above, including the Photon ledger and mobile submodule pointer update. This does
not claim that frontend/mobile builds or live transport were tested.

Review the files and run the verification command in `setup.md`. The following
three commits divide runtime behavior, verification/deployment, and handoff docs.
The earlier foundation is also uncommitted, so the first commit necessarily
contains that foundation and the completed contract increments together. For
review, inspect migrations 0004, 0005 and 0006 and their tests as separate changes;
do not stage an incomplete subset of the shared Python models/routes.
Run these yourself from the repository root:

```bash
git switch omer/backend-foundation
git diff --check
git status --short

git add .chalkignore .env.example .gitignore pyproject.toml uv.lock \
  api/auth.py api/config.py api/db.py api/http_limits.py api/integrations.py \
  api/main.py api/models.py api/schemas.py api/services.py api/storage.py \
  api/worker.py api/workflows.py supabase/migrations \
  scripts/__init__.py scripts/migrate.py scripts/provision_staff.py scripts/seed_demo.py
git diff --cached --stat
git commit -m "feat(api): add validated workflows and dashboard persistence contracts"

git add Dockerfile .dockerignore render.yaml tests/backend \
  scripts/docker_smoke.py scripts/export_contracts.py scripts/verify_backend.sh \
  docs/backend/openapi.json docs/backend/schemas docs/backend/fixtures
git diff --cached --stat
git commit -m "test(api): verify tracking, history and Docker workflows"

git add README.md docs/backend/README.md docs/backend/setup.md \
  docs/backend/contracts.md docs/backend/verification.md docs/backend/verification.json \
  docs/backend/dashboard-handoff.md docs/backend/merge.md
git diff --cached --stat
git commit -m "docs(api): publish integration contracts and setup evidence"
```

Then refresh your branch against the latest main, and rerun checks if upstream
has changed. These commands are for **you** to execute:

```bash
git fetch origin
git rebase origin/main
export TEST_DATABASE_URL='postgresql://postgres:wastegrid-local-test@127.0.0.1:55432/wastegrid_test'
scripts/verify_backend.sh
git push -u origin omer/backend-foundation
```

If rebase stops on `.gitignore`, keep `.data/`, `.env`, `.env.*`,
`!.env.example`, `htmlcov/`, and upstream's `.idea/caches/`, remove conflict
markers, then run `git add .gitignore` and `git rebase --continue`. Inspect any
additional conflicts rather than overwriting teammate changes. The agent has
not executed these commands.

Open a PR targeting `main` after the checks pass. Suggested title:

> Add WasteGrid backend with authorized tracking and report/message history

Suggested description:

> Adds persistent reports/private photos, protected staff roles and resident
> tokens, validated triage/planning/follow-up integration, audited organizer and
> crew actions, durable task/outgoing-message queues, and illustrative Karachi
> seed data. Adds immutable public references, independent title/address fields,
> authorized reference lookup, customer update history, and atomic inbound/sent
> message history. Includes proposed typed contracts, generated OpenAPI/fixtures,
> Supabase/Render setup instructions, PostgreSQL regression tests and a Docker
> HTTP smoke check. Live Supabase, Person 3, Photon and frontend integration
> acceptance remains a deployment step; provider doubles are labeled in evidence.

The frontend owners still need to replace local-only adapters. Person 3 and
Person 4 should review the proposed contract shapes before connecting their
services. These are explicit integration steps, not missing backend credentials
to commit into this branch.
