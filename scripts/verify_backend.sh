#!/usr/bin/env bash
set -euo pipefail
: "${TEST_DATABASE_URL:?Set TEST_DATABASE_URL to the disposable localhost PostgreSQL server}"
uv sync --locked --extra backend --group dev
verification_dir="${VERIFICATION_DIR:-/tmp/wastegrid-backend-verification}"
mkdir -p "$verification_dir"
uv run --extra backend pytest -q --junitxml="$verification_dir/pytest.xml"
uv run --extra backend python -m scripts.export_contracts --check
backend_files=(api/assessment.py api/duplicates.py api/auth.py api/config.py api/db.py api/http_limits.py api/integrations.py api/main.py api/models.py api/schemas.py api/services.py api/storage.py api/worker.py api/workflows.py scripts tests/backend tests/test_assessment.py)
uv run --extra backend flake8 "${backend_files[@]}" --select=E9,F63,F7,F82,F401,F841
uv run --extra backend black --check "${backend_files[@]}"
uv run --extra backend isort --profile black --check-only "${backend_files[@]}"
git diff --check
docker build -t wastegrid-api:verify .
uv run --extra backend python -m scripts.docker_smoke --image wastegrid-api:verify --postgres-container "${TEST_POSTGRES_CONTAINER:-wastegrid-backend-test}"
