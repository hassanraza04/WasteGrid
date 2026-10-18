"""Create, run/resume, inspect or stop the same bounded organiser demo approval.

Run from the repository root with ``python -m scripts.assessment_demo``. Creation
activates the 60-minute admission window. Status never starts a process. No image
or message is sent by create/status/stop; only the explicitly started scoped run
can invoke Chalk, and its persisted counter is reserved before each attempt.
"""

import argparse
import json
import logging
import subprocess
import threading
from hashlib import sha256
from pathlib import Path
from uuid import UUID, uuid4

import httpx
from sqlalchemy import text
from sqlalchemy.orm import Session

from api.assessment_demo import (
    HEARTBEAT_SECONDS,
    MODEL,
    DemoRefused,
    acquire_owner,
    create_run,
    finish_drain,
    heartbeat,
    processing_status,
    release_owner,
    stop_run,
)
from api.config import Settings
from api.db import make_engine, mutation_lock
from api.integrations import ChalkAssessmentClient
from api.models import AssessmentDemoRun, Photo
from api.storage import SupabaseCloud
from api.worker import process_one
from scripts.verify_assessment import (
    VerificationRefused,
    require_deployed_api,
    require_private_bucket,
    require_private_photo,
)

logger = logging.getLogger(__name__)
ROOT = Path(__file__).resolve().parents[1]


def require_configuration(settings: Settings, revision: str, api_url: str) -> None:
    if settings.messaging_pilot_enabled or not settings.organizer_routing_enabled:
        raise DemoRefused(
            "Organizer routing must be on and messaging pilot must be off"
        )
    if settings.chalk_model != MODEL or "chalk_model" not in settings.model_fields_set:
        raise DemoRefused("Explicit CHALK_MODEL=xai/grok-4.3 is required")
    if not all(
        (
            settings.chalk_router_api_key,
            settings.chalk_env_id,
            settings.supabase_url,
            settings.supabase_secret_key,
        )
    ):
        raise DemoRefused(
            "Chalk and private Supabase Storage configuration are required"
        )
    try:
        checkout = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=ROOT,
            capture_output=True,
            text=True,
            timeout=10,
            check=True,
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError) as exc:
        raise DemoRefused("Cannot verify the local worker revision") from exc
    if checkout != revision:
        raise DemoRefused(
            "Local worker checkout must match the verified deployed revision"
        )
    try:
        dirty = subprocess.run(
            ["git", "status", "--porcelain", "--untracked-files=normal"],
            cwd=ROOT,
            capture_output=True,
            text=True,
            timeout=10,
            check=True,
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError) as exc:
        raise DemoRefused("Cannot verify a clean worker checkout") from exc
    if dirty:
        raise DemoRefused("Run the reviewed code from a clean worker checkout")
    with httpx.Client(timeout=20) as client:
        try:
            require_deployed_api(api_url, revision, client)
        except VerificationRefused as exc:
            raise DemoRefused(str(exc)) from exc


def require_migrations(db: Session) -> None:
    applied = dict(
        db.execute(text("select name, checksum from wastegrid.schema_migrations")).all()
    )
    for path in (ROOT / "supabase" / "migrations").glob("*.sql"):
        if applied.get(path.name) != sha256(path.read_bytes()).hexdigest():
            raise DemoRefused(
                "Apply and verify the checked-in migrations before activation"
            )


def activate(engine, settings: Settings, revision: str, cloud) -> dict:
    require_private_bucket(cloud, settings)
    with Session(engine) as db:
        mutation_lock(db)
        require_migrations(db)
        run = create_run(db, revision)
        for report_id in run.report_ids:
            from api.models import Report

            report = db.get(Report, UUID(report_id))
            photo = db.get(Photo, report.photo_id)
            require_private_photo(db, settings, photo.object_path)
        db.commit()
        return processing_status(db)


def run_session(
    engine, settings: Settings, run_id: UUID, cloud, assessment, *, once: bool = False
) -> dict:
    """Only the original approval can run; restarts retain counters and bindings."""
    owner = uuid4()
    with Session(engine) as db:
        mutation_lock(db)
        require_migrations(db)
        run = acquire_owner(db, run_id, owner)
        if run.model != settings.chalk_model:
            raise DemoRefused("Worker model differs from the frozen demo approval")
        db.commit()
    stopped, lost = threading.Event(), threading.Event()

    def beat() -> None:
        while not stopped.wait(HEARTBEAT_SECONDS):
            try:
                with Session(engine) as db:
                    mutation_lock(db)
                    valid = heartbeat(db, run_id, owner)
                    db.commit()
                if not valid:
                    lost.set()
                    return
            except Exception:
                # No credentials, SQL parameters or provider errors in logs.
                logger.warning("Demo heartbeat unavailable; worker will stop claiming")
                lost.set()
                return

    thread = threading.Thread(
        target=beat, name="assessment-demo-heartbeat", daemon=True
    )
    thread.start()
    try:
        while not lost.is_set():
            worked = process_one(
                engine,
                None,
                cloud,
                assessment,
                duplicate_radius_meters=settings.duplicate_radius_meters,
                organizer_routing=True,
                demo_run_id=run_id,
                demo_owner=owner,
            )
            with Session(engine) as db:
                mutation_lock(db)
                run = db.get(AssessmentDemoRun, run_id, with_for_update=True)
                if run.worker_owner != owner:
                    lost.set()
                    break
                done = finish_drain(db, run)
                db.commit()
            if once or done:
                break
            if not worked:
                stopped.wait(2)
        if lost.is_set():
            raise DemoRefused(
                "Worker ownership or heartbeat was lost; restart the same run"
            )
    finally:
        stopped.set()
        thread.join(timeout=5)
        with Session(engine) as db:
            mutation_lock(db)
            release_owner(db, run_id, owner)
            db.commit()
    with Session(engine) as db:
        return processing_status(db)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--env-file", default=".env", help="Ignored backend environment file"
    )
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("create", "run"):
        sub = commands.add_parser(name)
        sub.add_argument("--api-url", required=True)
        sub.add_argument("--expected-revision", required=True)
        if name == "run":
            sub.add_argument("--run-id", type=UUID, required=True)
            sub.add_argument("--once", action="store_true")
    commands.add_parser("status")
    stop = commands.add_parser("stop")
    stop.add_argument("--run-id", type=UUID, required=True)
    args = parser.parse_args()
    settings = Settings(_env_file=args.env_file)
    engine = make_engine(settings)
    if engine is None:
        raise SystemExit("DATABASE_URL is required")
    cloud = assessment = None
    try:
        if args.command in ("create", "run"):
            require_configuration(settings, args.expected_revision, args.api_url)
            if args.command == "run":
                with Session(engine) as db:
                    run = db.get(AssessmentDemoRun, args.run_id)
                    if run is None or run.revision != args.expected_revision:
                        raise DemoRefused(
                            "Run must retain its original verified deployed revision"
                        )
            cloud = SupabaseCloud(settings)
            if args.command == "create":
                result = activate(engine, settings, args.expected_revision, cloud)
            else:
                assessment = ChalkAssessmentClient(settings)
                result = run_session(
                    engine, settings, args.run_id, cloud, assessment, once=args.once
                )
        else:
            with Session(engine) as db:
                if args.command == "stop":
                    mutation_lock(db)
                    stop_run(db, args.run_id)
                    db.commit()
                result = processing_status(db)
        print(json.dumps(result, default=str, sort_keys=True))
    except (DemoRefused, VerificationRefused) as exc:
        print(f"Assessment demo refused: {exc}")
        raise SystemExit(1) from None
    except KeyboardInterrupt:
        print("Worker stopped; resume the same run ID without resetting counters")
    except Exception:
        print("Assessment demo unavailable; inspect sanitized task/run status")
        raise SystemExit(1) from None
    finally:
        if assessment is not None:
            assessment.close()
        if cloud is not None:
            cloud.close()
        engine.dispose()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    main()
