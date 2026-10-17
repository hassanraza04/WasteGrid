# Repository safety checks

Run these commands before opening a pull request:

```bash
uv sync --locked --group dev
uv run black --check api tests
uv run isort --check-only api tests
uv run mypy --strict api/messaging
uv run pytest -q
uv run pip-audit --ignore-vuln PYSEC-2026-2275
(cd web && npm ci && npm audit --audit-level=high && npm run coverage && npm run build)
```

GitHub Actions runs the same checks on pull requests and pushes to `main`. It
has read-only repository permissions and does not receive project secrets. These
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

## Repository administrator checklist

1. Protect `main` and require the `Quality / Python quality` and
   `Quality / Web quality` checks before merge.
2. Enable Dependabot alerts and grouped dependency update pull requests.
3. Add the mobile repository URL to `.gitmodules`, or replace the `mobile`
   gitlink with a tracked directory.
4. Before a live demo, verify the deployed backend, Supabase, Person 3 provider,
   Photon transport, and dashboard together in staging.
