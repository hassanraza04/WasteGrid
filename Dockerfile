FROM python:3.12-slim AS build
COPY --from=ghcr.io/astral-sh/uv:0.12.3 /uv /usr/local/bin/uv
WORKDIR /app
COPY pyproject.toml uv.lock ./
# Backend extra only: retain Chalk/Photon in the repo, exclude them from the API image.
RUN uv export --frozen --extra backend --no-dev --no-hashes --no-emit-project \
    --prune chalkcompute --prune chalkpy --prune photonhq-api > /tmp/api-requirements.txt \
    && uv venv /opt/venv \
    && uv pip install --python /opt/venv/bin/python -r /tmp/api-requirements.txt

FROM python:3.12-slim
WORKDIR /app
COPY --from=build /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH" PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
COPY api ./api
COPY scripts ./scripts
COPY supabase/migrations ./supabase/migrations
RUN useradd --create-home app
USER app
CMD ["sh", "-c", "exec uvicorn api.main:app --host 0.0.0.0 --port ${PORT:-8000} --no-access-log"]
