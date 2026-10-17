"""Apply checked-in SQL migrations once, transactionally, with drift detection."""

from hashlib import sha256
from pathlib import Path

from sqlalchemy import text

from api.config import Settings
from api.db import make_engine

MIGRATIONS = Path(__file__).resolve().parents[1] / "supabase" / "migrations"


def migrate(engine):
    with engine.begin() as conn:
        conn.execute(text("select pg_advisory_xact_lock(47021926)"))
        conn.exec_driver_sql("create schema if not exists wastegrid")
        conn.exec_driver_sql("""
            create table if not exists wastegrid.schema_migrations (
                name text primary key, checksum text not null,
                applied_at timestamptz not null default now()
            )
        """)
        for path in sorted(MIGRATIONS.glob("*.sql")):
            sql = path.read_text()
            checksum = sha256(sql.encode()).hexdigest()
            previous = conn.scalar(
                text(
                    "select checksum from wastegrid.schema_migrations where name=:name"
                ),
                {"name": path.name},
            )
            if previous:
                if previous != checksum:
                    raise RuntimeError(
                        f"Previously applied migration changed: {path.name}"
                    )
                continue
            # No parameters: preserve PostgreSQL format('%I', ...) literally.
            conn.connection.driver_connection.execute(sql)
            conn.execute(
                text(
                    "insert into wastegrid.schema_migrations(name, checksum) values (:name, :checksum)"
                ),
                {"name": path.name, "checksum": checksum},
            )
            print(f"Applied {path.name}")


def main():
    engine = make_engine(Settings())
    if engine is None:
        raise SystemExit("Set DATABASE_URL in the backend environment")
    try:
        migrate(engine)
    finally:
        engine.dispose()


if __name__ == "__main__":
    main()
