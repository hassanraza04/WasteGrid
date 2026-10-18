# Repository safety checks

Run these commands before opening a pull request. First set `TEST_DATABASE_URL`
to a disposable localhost PostgreSQL server as described in
[backend setup](backend/setup.md). The tests create and remove isolated databases;
do not use a live project database. Use Node.js 22.22.2 or newer for both clients;
CI runs Node 22.

```bash
uv sync --locked --group dev --extra backend
uv run --extra backend black --check api scripts tests
uv run --extra backend isort --check-only api scripts tests
uv run --extra backend flake8 api/*.py scripts tests/backend --select=E9,F63,F7,F82,F401,F841
uv run --extra backend mypy --strict api/messaging
uv run --extra backend python -m scripts.export_contracts --check
uv run --extra backend pytest -q
uv run --extra backend pip-audit --ignore-vuln PYSEC-2026-2275
(cd web && npm ci && npm audit --audit-level=high && npm run coverage && npm run build)
(cd mobile && npm ci && npm test && npx tsc --noEmit && npm run lint && npm run audit:ci)
```

GitHub Actions runs the same checks on pull requests and pushes to `main`, with
Python 3.13 and a disposable PostgreSQL 17 service. It has read-only repository
permissions and uses only test credentials, with no project secrets. These
checks do not replace handling secrets through local environment files or the
deployment platform's secret store.

## Temporary dependency exception

- Advisory: `PYSEC-2026-2275`
- Package: `requests 2.32.5`
- Reason: `chalkpy[runtime]` currently requires `requests>=2.31,<2.33`, so the
  fixed release cannot resolve.
- Owner: `hassanraza04`
- Expires: `2026-11-17`
- Removal: remove the ignore flag and upgrade Chalk and `requests` as soon as a
  compatible Chalk release is available.

This exception applies only to the named advisory. Any other Python dependency
finding fails the quality check.

Mobile audit checks use the existing advisory allowlist in
[`mobile/audit-ci.jsonc`](../mobile/audit-ci.jsonc). Review that configuration when
updating Expo/Metro dependencies; the README check commands use the same policy as CI.

## Repository administrator checklist

1. Protect `main` and require the `Quality / Python quality` and
   `Quality / Web quality` checks, plus `Quality / Mobile connection checks`,
   before merge.
2. Enable Dependabot alerts and grouped dependency update pull requests.
3. Keep all three component lockfiles (`uv.lock`, `web/package-lock.json`, and
   `mobile/package-lock.json`) consistent with their manifests.
4. Before a live demo, verify the deployed backend, Supabase, Person 3 provider,
   Photon transport, and dashboard together in staging.
