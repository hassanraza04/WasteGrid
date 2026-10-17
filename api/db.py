from collections.abc import Generator

from fastapi import HTTPException, Request
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session

from api.config import Settings


def make_engine(settings: Settings):
    if settings.database_url is None:
        return None
    url = settings.database_url.get_secret_value()
    if url.startswith("postgresql://"):
        url = url.replace("postgresql://", "postgresql+psycopg://", 1)
    return create_engine(url, pool_pre_ping=True, hide_parameters=True)


def get_db(request: Request) -> Generator[Session, None, None]:
    if request.app.state.engine is None:
        raise HTTPException(503, "Database is not configured")
    with Session(request.app.state.engine) as session:
        if request.method not in ("GET", "HEAD", "OPTIONS"):
            mutation_lock(session)
        yield session


def mutation_lock(session: Session):
    """Serialize short MVP writes and planner application, never provider calls."""
    session.execute(text("select pg_advisory_xact_lock(47021927)"))
