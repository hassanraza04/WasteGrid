"""One-report, non-pilot verification of the persisted Chalk assessment path."""

import argparse
from uuid import UUID

from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

from api.config import Settings
from api.db import make_engine
from api.decisions import AssessmentDecisionProvider
from api.integrations import ChalkAssessmentClient
from api.models import Photo, Report, Task
from api.schemas import Location
from api.storage import SupabaseCloud
from api.worker import process_one


def scoped_tasks(db: Session, report_id: UUID, kind: str) -> list[Task]:
    return list(
        db.scalars(
            select(Task).where(
                Task.kind == kind,
                Task.payload["report_id"].as_string() == str(report_id),
            )
        )
    )


def require_pending_task(db: Session, report_id: UUID, kind: str) -> None:
    tasks = scoped_tasks(db, report_id, kind)
    if len(tasks) != 1 or tasks[0].status != "pending" or tasks[0].attempts != 0:
        raise ValueError(f"Expected exactly one new pending {kind} task")


def unrelated_state(
    db: Session, report_id: UUID, known_task_ids: set[str] | None = None
) -> tuple:
    tasks = tuple(
        sorted(
            (
                str(task.id),
                task.status,
                task.attempts,
                str(task.lease_id),
                str(task.leased_until),
                str(task.next_attempt_at),
                task.last_error,
            )
            for task in db.scalars(select(Task))
            if known_task_ids is None or str(task.id) in known_task_ids
            if not (
                task.kind in ("assessment", "triage")
                and task.payload.get("report_id") == str(report_id)
            )
        )
    )
    demo = tuple(
        sorted(
            (
                str(report.id),
                report.assessment_status,
                report.state,
                report.version,
                str(report.job_id),
            )
            for report in db.scalars(
                select(Report).where(Report.illustrative.is_(True))
            )
        )
    )
    return tasks, demo


def verify(engine, settings: Settings, report_id: UUID) -> dict:
    if settings.messaging_pilot_enabled:
        raise ValueError("Messaging pilot must be disabled")
    if not settings.organizer_routing_enabled:
        raise ValueError(
            "Organizer routing must be enabled to preserve route ownership"
        )
    if not all(
        (
            settings.chalk_router_api_key,
            settings.chalk_env_id,
            settings.supabase_secret_key,
            settings.supabase_url,
        )
    ):
        raise ValueError("Chalk and private Storage configuration are required")
    if "chalk_model" not in settings.model_fields_set:
        raise ValueError("Set CHALK_MODEL explicitly for this verification")

    with Session(engine) as db:
        report = db.get(Report, report_id)
        if report is None or report.illustrative:
            raise ValueError("Choose an existing non-illustrative report")
        try:
            Location.model_validate(report.location)
        except ValidationError as exc:
            raise ValueError("Report needs valid coordinates") from exc
        if report.assessment_status != "pending" or report.job_id is not None:
            raise ValueError("Choose an unassessed report without a job")
        if db.get(Photo, report.photo_id) is None:
            raise ValueError("Report photo is missing")
        require_pending_task(db, report_id, "assessment")
        if scoped_tasks(db, report_id, "triage"):
            raise ValueError("Report already has triage work")
        before = unrelated_state(db, report_id)
        known_task_ids = {task[0] for task in before[0]}

    cloud = SupabaseCloud(settings)
    assessment = ChalkAssessmentClient(settings)
    provider = AssessmentDecisionProvider(settings.duplicate_radius_meters)
    try:
        worked = process_one(
            engine,
            provider,
            cloud,
            assessment,
            duplicate_radius_meters=settings.duplicate_radius_meters,
            organizer_routing=True,
            report_scope=report_id,
            scoped_kind="assessment",
        )
        if not worked:
            raise ValueError("Assessment task was no longer available")
        with Session(engine) as db:
            report = db.get(Report, report_id)
            assessment_task = scoped_tasks(db, report_id, "assessment")[0]
            if assessment_task.status != "succeeded":
                return {
                    "assessment_status": report.assessment_status,
                    "triage": "not_run",
                    "unrelated_unchanged": unrelated_state(
                        db, report_id, known_task_ids
                    )
                    == before,
                }
            eligible = (
                report.assessment_status == "assessed" and not report.needs_review
            )
            if eligible:
                require_pending_task(db, report_id, "triage")
        if eligible:
            worked = process_one(
                engine,
                provider,
                cloud,
                assessment,
                duplicate_radius_meters=settings.duplicate_radius_meters,
                organizer_routing=True,
                report_scope=report_id,
                scoped_kind="triage",
            )
            if not worked:
                raise ValueError("Triage task was no longer available")
        with Session(engine) as db:
            report = db.get(Report, report_id)
            triage = scoped_tasks(db, report_id, "triage")
            return {
                "assessment_status": report.assessment_status,
                "priority": report.priority,
                "needs_review": report.needs_review,
                "report_state": report.state,
                "job_created": report.job_id is not None,
                "triage": triage[0].status if triage else "not_queued",
                "unrelated_unchanged": unrelated_state(db, report_id, known_task_ids)
                == before,
            }
    finally:
        cloud.close()
        assessment.close()
        provider.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report-id", type=UUID, required=True)
    args = parser.parse_args()
    settings = Settings()
    if settings.database_url is None:
        raise SystemExit("DATABASE_URL is required")
    engine = make_engine(settings)
    try:
        result = verify(engine, settings, args.report_id)
    except ValueError as exc:
        print(f"Scoped verification refused: {exc}")
        raise SystemExit(1) from None
    except Exception:
        # Provider exceptions can include signed URLs or credentials.
        print(
            "Scoped verification failed; inspect sanitized task/report status through the API"
        )
        raise SystemExit(1) from None
    finally:
        engine.dispose()
    for key, value in result.items():
        print(f"{key}={value}")


if __name__ == "__main__":
    main()
