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
- Update the locked Python dependency graph so `requests` is at least `2.33.0`.
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
uv run pip-audit
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

`requests` is upgraded through the UV lock resolution, then the dependency audit
must return no known findings. No dependency is upgraded by editing the lockfile
manually.

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
  `uv run pip-audit` pass on the branch.
- `npm ci`, `npm audit --audit-level=high`, `npm run coverage`, and
  `npm run build` pass in `web/`.
- The Python audit no longer reports the current `requests` advisory.
- The repository includes clear instructions for the remaining administrator
  safeguards.
