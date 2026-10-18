"""Apply one explicit, bounded operator approval; never reset consumed attempts."""

import argparse
import json
from datetime import timedelta
from uuid import UUID

import httpx
from sqlalchemy import text
from sqlalchemy.orm import Session

from api.assessment_demo import DemoRefused, processing_status
from api.config import Settings
from api.db import make_engine, mutation_lock
from api.models import AssessmentDemoRun, now
from scripts.verify_assessment import require_deployed_api


def extend(engine, run_id, command_id, attempts, reports, revision, reason):
    if not (1 <= attempts <= 20 and 0 <= reports <= 20 and reason.strip()):
        raise DemoRefused("Approve 1–20 attempts, 0–20 reports and a reason")
    with Session(engine) as db:
        mutation_lock(db)
        previous = (
            db.execute(
                text(
                    "select * from wastegrid.assessment_demo_capacity_grants where id=:id"
                ),
                {"id": command_id},
            )
            .mappings()
            .one_or_none()
        )
        if previous:
            if not (
                previous["run_id"] == run_id
                and previous["max_attempts"] - previous["previous_max_attempts"]
                == attempts
                and previous["max_new_reports"] - previous["previous_max_new_reports"]
                == reports
                and previous["revision"] == revision
                and previous["reason"] == reason
            ):
                raise DemoRefused("This command ID belongs to a different approval")
            return processing_status(db)
        run = db.get(AssessmentDemoRun, run_id, with_for_update=True)
        if (
            run is None
            or run.status != "closed"
            or run.reason not in ("attempt_limit", "window_expired")
            or run.worker_owner
        ):
            raise DemoRefused(
                "Only a closed, drained original approval can receive capacity"
            )
        maximum, new_reports = (
            run.max_attempts + attempts,
            run.max_new_reports + reports,
        )
        if maximum > 100 or new_reports > 100:
            raise DemoRefused("Total approved capacity cannot exceed 100")
        at = now()
        expiry = at + timedelta(minutes=60)
        db.execute(
            text("""
            insert into wastegrid.assessment_demo_capacity_grants
                (id,run_id,approved_at,revision,reason,previous_max_attempts,max_attempts,
                 previous_max_new_reports,max_new_reports,previous_expires_at,expires_at)
            values (:id,:run,:at,:revision,:reason,:old_attempts,:attempts,:old_reports,:reports,:old_expiry,:expiry)
        """),
            dict(
                id=command_id,
                run=run.id,
                at=at,
                revision=revision,
                reason=reason,
                old_attempts=run.max_attempts,
                attempts=maximum,
                old_reports=run.max_new_reports,
                reports=new_reports,
                old_expiry=run.expires_at,
                expiry=expiry,
            ),
        )
        run.max_attempts, run.max_new_reports = maximum, new_reports
        run.current_window_started_at, run.expires_at = at, expiry
        run.revision, run.status, run.reason = revision, "active", None
        db.commit()
        return processing_status(db)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", required=True)
    parser.add_argument("--run-id", type=UUID, required=True)
    parser.add_argument("--command-id", type=UUID, required=True)
    parser.add_argument("--additional-attempts", type=int, required=True)
    parser.add_argument("--additional-reports", type=int, required=True)
    parser.add_argument("--reason", required=True)
    parser.add_argument("--api-url", required=True)
    parser.add_argument("--expected-revision", required=True)
    args = parser.parse_args()
    with httpx.Client(timeout=20) as client:
        require_deployed_api(
            args.api_url, args.expected_revision, client, allow_messaging_pilot=True
        )
    engine = make_engine(Settings(_env_file=args.env_file))
    if engine is None:
        raise SystemExit("DATABASE_URL is required")
    try:
        print(
            json.dumps(
                extend(
                    engine,
                    args.run_id,
                    args.command_id,
                    args.additional_attempts,
                    args.additional_reports,
                    args.expected_revision,
                    args.reason,
                ),
                default=str,
            )
        )
    finally:
        engine.dispose()


if __name__ == "__main__":
    main()
