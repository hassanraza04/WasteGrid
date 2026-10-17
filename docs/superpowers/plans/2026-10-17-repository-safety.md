# Repository Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make pull requests automatically verify the current Python and web code quality, dependency safety, test coverage, and production build.

**Architecture:** A single GitHub Actions workflow contains separate Python and web jobs so each ecosystem installs only its locked dependencies. Local commands mirror CI, while a concise repository-safety document records the safeguards that need GitHub administrator access.

**Tech Stack:** GitHub Actions, UV, pytest, Black, isort, mypy, pip-audit, npm, Vitest, Vite.

## Global Constraints

- Do not modify application behavior, Photon credentials, production data, Omer's pull request, or the mobile gitlink.
- Use the committed `uv.lock` and `web/package-lock.json`; never hand-edit either lockfile.
- Target Python 3.13 because `pyproject.toml` supports Python `>=3.11,<3.15` and current verification runs under 3.13.
- The workflow must have only `contents: read` repository permission.
- Keep the Python strict type check limited to `api/messaging`.
- Do not add external CI secrets or send project secrets to any workflow.

---

### Task 1: Make Python quality tools reproducible and resolve the advisory

**Files:**
- Modify: `pyproject.toml:14-25`
- Modify: `uv.lock`

**Interfaces:**
- Consumes: the existing project dependencies and lockfile.
- Produces: a `dev` dependency group that supplies all Python quality commands.

- [ ] **Step 1: Demonstrate the dependency-audit failure**

Run:

```bash
uv run --with pip-audit pip-audit
```

Expected: FAIL or nonzero result that identifies `requests 2.32.5` and its available `2.33.0` fix.

- [ ] **Step 2: Replace deprecated UV development dependencies**

Replace the existing `[tool.uv]` block with:

```toml
[dependency-groups]
dev = [
  "pytest>=7.0",
  "pytest-cov>=4.0",
  "black>=23.0",
  "isort>=5.0",
  "ipython>=8.37.0",
  "jupyter>=1.1.1",
  "ipykernel>=6.29.5",
  "mypy>=1.13,<2",
  "pip-audit>=2.9,<3",
]
```

This removes unused Flake8 and makes mypy and pip-audit explicit reproducible tools.

- [ ] **Step 3: Upgrade only the vulnerable resolved package**

Run:

```bash
uv lock --upgrade-package requests
uv sync --locked --group dev
```

Expected: `uv.lock` resolves `requests` to `2.33.0` or newer without editing the lockfile manually.

- [ ] **Step 4: Verify the green dependency and typing state**

Run:

```bash
uv run pip-audit
uv run mypy --strict api/messaging
```

Expected: `No known vulnerabilities found` and `Success: no issues found`.

- [ ] **Step 5: Commit the reproducible Python toolchain**

```bash
git add pyproject.toml uv.lock
git commit -m "build: add reproducible Python quality tools"
```

### Task 2: Establish a clean Python formatting baseline

**Files:**
- Modify only files reported by Black or isort under `api/` and `tests/`

**Interfaces:**
- Consumes: the Black and isort commands made reproducible in Task 1.
- Produces: source and tests that pass non-mutating formatting checks.

- [ ] **Step 1: Demonstrate the current formatting failures**

Run:

```bash
uv run black --check api tests
uv run isort --check-only api tests
```

Expected: FAIL because the current messaging files need Black formatting and import ordering.

- [ ] **Step 2: Apply only mechanical formatting**

Run:

```bash
uv run black api tests
uv run isort api tests
```

Do not change behavior or tests beyond formatter and import-order output.

- [ ] **Step 3: Verify formatting and Python behavior**

Run:

```bash
uv run black --check api tests
uv run isort --check-only api tests
uv run pytest -q
```

Expected: all commands pass and the current 29 Python tests remain green.

- [ ] **Step 4: Commit the formatting baseline**

```bash
git add api tests
git commit -m "style: align Python formatting checks"
```

### Task 3: Add least-privilege quality automation

**Files:**
- Modify: `.gitignore:24`
- Create: `.github/workflows/quality.yml`

**Interfaces:**
- Consumes: Task 1's UV `dev` dependency group and Task 2's clean formatting baseline.
- Produces: a tracked GitHub workflow that validates Python and web quality independently.

- [ ] **Step 1: Remove the rule that hides GitHub workflows**

Delete the `.github` line from `.gitignore`. Leave all other ignore rules unchanged.

- [ ] **Step 2: Create the quality workflow**

Create `.github/workflows/quality.yml` with this content:

```yaml
name: Quality

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

concurrency:
  group: quality-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  python:
    name: Python quality
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: astral-sh/setup-uv@v5
      - uses: actions/setup-python@v5
        with:
          python-version: "3.13"
      - run: uv sync --locked --group dev
      - run: uv run black --check api tests
      - run: uv run isort --check-only api tests
      - run: uv run mypy --strict api/messaging
      - run: uv run pytest -q
      - run: uv run pip-audit

  web:
    name: Web quality
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: web
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "22"
          cache: npm
          cache-dependency-path: web/package-lock.json
      - run: npm ci
      - run: npm audit --audit-level=high
      - run: npm run coverage
      - run: npm run build
```

- [ ] **Step 3: Validate the workflow's tracked state and supporting commands**

Run:

```bash
git check-ignore -v .github/workflows/quality.yml
git diff --check
uv run pytest -q
(cd web && npm run coverage && npm run build)
```

Expected: `git check-ignore` prints no matching ignore rule; the remaining commands pass. GitHub Actions executes the workflow after the branch is pushed.

- [ ] **Step 4: Commit the workflow**

```bash
git add .gitignore .github/workflows/quality.yml
git commit -m "ci: verify Python and web quality"
```

### Task 4: Document local and administrator safeguards

**Files:**
- Create: `docs/repository-safety.md`
- Modify: `README.md:1-7`

**Interfaces:**
- Consumes: the exact commands enforced by Task 3.
- Produces: a discoverable operational checklist for contributors and repository administrators.

- [ ] **Step 1: Write the safety document**

Create `docs/repository-safety.md` with:

````markdown
# Repository safety checks

Run these commands before opening a pull request:

```bash
uv sync --locked --group dev
uv run black --check api tests
uv run isort --check-only api tests
uv run mypy --strict api/messaging
uv run pytest -q
uv run pip-audit
(cd web && npm ci && npm audit --audit-level=high && npm run coverage && npm run build)
```

GitHub Actions runs the same checks on pull requests and pushes to `main`.
It has read-only repository permissions and does not receive project secrets.

## Repository administrator checklist

1. Protect `main` and require the `Quality / Python quality` and `Quality / Web quality` checks before merge.
2. Enable Dependabot alerts and grouped dependency update pull requests.
3. Add the mobile repository URL to `.gitmodules`, or replace the `mobile` gitlink with a tracked directory.
4. Before a live demo, verify the deployed backend, Supabase, Person 3 provider, Photon transport, and dashboard together in staging.
````

- [ ] **Step 2: Link the document from the README**

Add this sentence after the existing backend paragraph:

```markdown
Contributor quality checks and the remaining administrator safeguards are in
[repository safety](docs/repository-safety.md).
```

- [ ] **Step 3: Verify the documented commands**

Run:

```bash
uv sync --locked --group dev
uv run black --check api tests
uv run isort --check-only api tests
uv run mypy --strict api/messaging
uv run pytest -q
uv run pip-audit
(cd web && npm ci && npm audit --audit-level=high && npm run coverage && npm run build)
git diff --check
```

Expected: all commands pass with no known vulnerabilities, formatting drift, type errors, test failures, or whitespace errors.

- [ ] **Step 4: Commit the operating guide**

```bash
git add README.md docs/repository-safety.md
git commit -m "docs: add repository safety checklist"
```

### Task 5: Final pull-request readiness verification

**Files:**
- Verify: all files changed in Tasks 1 through 4

**Interfaces:**
- Consumes: the complete safety branch.
- Produces: evidence suitable for a pull request description.

- [ ] **Step 1: Confirm the branch contains only intended changes**

Run:

```bash
git status --short
git diff origin/main...HEAD --stat
git diff --check origin/main...HEAD
```

Expected: a clean working tree and only safety workflow, tooling, formatting, documentation, and lockfile changes.

- [ ] **Step 2: Run the full local gate once more**

Run:

```bash
uv sync --locked --group dev
uv run black --check api tests
uv run isort --check-only api tests
uv run mypy --strict api/messaging
uv run pytest -q
uv run pip-audit
(cd web && npm ci && npm audit --audit-level=high && npm run coverage && npm run build)
```

Expected: every command passes. Record the Python test count, frontend test count, coverage result, and audit outcome for the pull request description.

- [ ] **Step 3: Request review and open the pull request**

Use a title such as:

```text
Add repository quality and dependency safety gates
```

Describe the workflow, `requests` resolution, formatting baseline, and the administrator follow-ups that remain outside the repository.
