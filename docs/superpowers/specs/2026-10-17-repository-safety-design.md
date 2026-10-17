# Repository Safety Design

## Goal

Make every pull request prove that the current Python and web applications build,
pass their tests, meet the existing frontend coverage gate, and have no known
high-severity dependency findings.

## Scope

This change creates repository-owned safeguards that can run without production
credentials:

- Track GitHub Actions by removing the rule that ignores `.github`.
- Add one read-only GitHub Actions workflow for pull requests and pushes to
  `main`.
- Make Python developer tooling explicit and reproducible through the modern UV
  dependency-group format.
- Enforce Python formatting, import ordering, the current messaging type-check,
  Python tests, Python dependency auditing, frontend dependency auditing,
  frontend coverage, and the production frontend build.
- Audit Python dependencies, with one time-bounded and documented exception for
  an advisory that Chalk currently prevents us from resolving.
- Document the commands developers and repository administrators must run.

## Explicit Non-Goals

- Do not change application behavior, Photon credentials, or production data.
- Do not merge or modify Omer's backend pull request.
- Do not invent the missing mobile repository URL or alter the `mobile` gitlink.
- Do not attempt GitHub administrator actions. Branch protection and Dependabot
  remain documented manual setup steps.
- Do not add a hosted staging environment. That depends on the backend and
  Supabase integration work.

## CI Design

`.github/workflows/quality.yml` will use least-privilege `contents: read`
permissions, run on pull requests and pushes targeting `main`, and cancel an
older run for the same branch when a newer commit arrives.

The Python job will install the lockfile with the `dev` dependency group, then
run:

```text
uv run black --check api tests
uv run isort --check-only api tests
uv run mypy --strict api/messaging
uv run pytest -q
uv run pip-audit --ignore-vuln PYSEC-2026-2275
```

The web job will run from `web/` using the committed npm lockfile, then run:

```text
npm ci
npm audit --audit-level=high
npm run coverage
npm run build
```

The existing Vitest thresholds remain the frontend coverage policy. The Python
scope is deliberately limited to `api/messaging` because that is the current
production Python module with a passing strict check. Expanding type checking to
Omer's backend happens when that code is merged and its dependencies are part of
`main`.

## Dependency Design

The deprecated `tool.uv.dev-dependencies` table becomes a `dependency-groups`
`dev` group. `mypy` and `pip-audit` are explicit development tools, while the
unused Flake8 declaration is removed. The lockfile pins all resolved versions.

The lockfile pins all resolved versions and is never edited manually. Chalk's
current runtime dependency requires `requests>=2.31,<2.33`, so the fixed
`requests` release for `PYSEC-2026-2275` cannot resolve with the project today.
The audit therefore ignores exactly that advisory until **2026-11-17**. The
exception owner is `hassanraza04`; it must be removed as soon as Chalk supports
a compatible `requests` release. All other dependency advisories fail CI.

## Verification and Operations

The safety documentation will provide the same commands developers run locally,
state that CI cannot replace secret handling, and list the administrator tasks:

1. Protect `main` and require the quality workflow before merging.
2. Enable Dependabot alerts and grouped update pull requests.
3. Add the actual mobile repository URL to `.gitmodules`, or replace the gitlink
   with a normal tracked directory.
4. Run the backend, Photon, Person 3, and dashboard flow in staging before any
   live demo.

## Acceptance Criteria

- `.github/workflows/quality.yml` is tracked and runs both Python and web jobs.
- The workflow has read-only repository permissions and concurrency cancellation.
- `uv run black --check api tests`, `uv run isort --check-only api tests`,
  `uv run mypy --strict api/messaging`, `uv run pytest -q`, and
  `uv run pip-audit --ignore-vuln PYSEC-2026-2275` pass on the branch.
- `npm ci`, `npm audit --audit-level=high`, `npm run coverage`, and
  `npm run build` pass in `web/`.
- The repository documents the `PYSEC-2026-2275` exception, including its
  owner, expiry, and removal condition; no other audit finding is ignored.
- The repository includes clear instructions for the remaining administrator
  safeguards.
