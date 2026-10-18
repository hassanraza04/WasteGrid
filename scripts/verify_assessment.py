"""One-report, non-pilot verification of the persisted Chalk assessment path."""

import argparse
import re
from urllib.parse import quote
from uuid import UUID

import httpx
from pydantic import ValidationError
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from api.config import Settings
from api.db import make_engine
from api.decisions import AssessmentDecisionProvider
from api.integrations import ChalkAssessmentClient
from api.models import Photo, Report, Task
from api.schemas import Location
from api.storage import SupabaseCloud
from api.worker import process_one


class VerificationRefused(ValueError):
    """A known preflight refusal with a safe operator-facing message."""


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
        raise VerificationRefused(f"Expected exactly one new pending {kind} task")


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


def require_deployed_api(
    api_url: str,
    expected_revision: str,
    client: httpx.Client,
    *,
    allow_messaging_pilot: bool = False,
) -> None:
    if not re.fullmatch(r"[0-9a-f]{40}", expected_revision):
        raise VerificationRefused(
            "Expected revision must be a full 40-character commit SHA"
        )
    try:
        base = httpx.URL(api_url)
    except httpx.InvalidURL as exc:
        raise VerificationRefused("API URL is invalid") from exc
    if (
        base.scheme != "https"
        or not base.host
        or base.userinfo
        or base.path not in ("", "/")
        or base.query
        or base.fragment
    ):
        raise VerificationRefused(
            "API URL must be an HTTPS origin without credentials or a path"
        )
    response = client.get(str(base).rstrip("/") + "/ready", follow_redirects=False)
    if response.status_code != 200 or response.json().get("status") != "ready":
        raise VerificationRefused("Deployed API is not ready")
    if (
        response.headers.get("X-WasteGrid-Revision") != expected_revision
        or response.headers.get("X-WasteGrid-Organizer-Routing") != "true"
        or response.headers.get("X-WasteGrid-Messaging-Pilot")
        not in (("true", "false") if allow_messaging_pilot else ("false",))
    ):
        raise VerificationRefused("Deployed revision or safety flags do not match")


def require_private_photo(db: Session, settings: Settings, object_path: str) -> None:
    present = db.scalar(
        text(
            "SELECT EXISTS (SELECT 1 FROM storage.objects "
            "WHERE bucket_id = :bucket AND name = :name)"
        ),
        {"bucket": settings.supabase_photo_bucket, "name": object_path},
    )
    if not present:
        raise VerificationRefused(
            "Report photo is not registered in the configured bucket"
        )


def require_private_bucket(cloud: SupabaseCloud, settings: Settings) -> None:
    bucket = quote(settings.supabase_photo_bucket, safe="")
    metadata = cloud.call("GET", "/storage/v1/bucket/" + bucket).json()
    if (
        metadata.get("id") != settings.supabase_photo_bucket
        or metadata.get("public") is not False
    ):
        raise VerificationRefused(
            "Configured report-photo bucket is not verified private"
        )


def verify(
    engine,
    settings: Settings,
    report_id: UUID,
    api_url: str,
    expected_revision: str,
    *,
    api_client: httpx.Client | None = None,
) -> dict:
    if settings.messaging_pilot_enabled:
        raise VerificationRefused("Messaging pilot must be disabled")
    if not settings.organizer_routing_enabled:
        raise VerificationRefused(
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
        raise VerificationRefused(
            "Chalk and private Storage configuration are required"
        )
    if "chalk_model" not in settings.model_fields_set:
        raise VerificationRefused("Set CHALK_MODEL explicitly for this verification")

    if api_client is None:
        with httpx.Client(timeout=20) as client:
            require_deployed_api(api_url, expected_revision, client)
    else:
        require_deployed_api(api_url, expected_revision, api_client)

    with Session(engine) as db:
        report = db.get(Report, report_id)
        if report is None or report.illustrative:
            raise VerificationRefused("Choose an existing non-illustrative report")
        try:
            Location.model_validate(report.location)
        except ValidationError as exc:
            raise VerificationRefused("Report needs valid coordinates") from exc
        if report.assessment_status != "pending" or report.job_id is not None:
            raise VerificationRefused("Choose an unassessed report without a job")
        photo = db.get(Photo, report.photo_id)
        if photo is None or photo.report_id != report_id:
            raise VerificationRefused("Report photo is missing")
        require_private_photo(db, settings, photo.object_path)
        require_pending_task(db, report_id, "assessment")
        if scoped_tasks(db, report_id, "triage"):
            raise VerificationRefused("Report already has triage work")
        before = unrelated_state(db, report_id)
        known_task_ids = {task[0] for task in before[0]}

    cloud = SupabaseCloud(settings)
    try:
        require_private_bucket(cloud, settings)
        assessment = ChalkAssessmentClient(settings)
        provider = AssessmentDecisionProvider(settings.duplicate_radius_meters)
        try:
            return run_scoped(
                engine,
                settings,
                report_id,
                cloud,
                assessment,
                provider,
                before,
                known_task_ids,
            )
        finally:
            assessment.close()
            provider.close()
    finally:
        cloud.close()


def run_scoped(
    engine, settings, report_id, cloud, assessment, provider, before, known_task_ids
):
    """Only this function can lease the selected report's work."""
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
        raise VerificationRefused("Assessment task was no longer available")
    with Session(engine) as db:
        report = db.get(Report, report_id)
        assessment_task = scoped_tasks(db, report_id, "assessment")[0]
        if assessment_task.status != "succeeded":
            return {
                "assessment_status": report.assessment_status,
                "triage": "not_run",
                "unrelated_unchanged": unrelated_state(db, report_id, known_task_ids)
                == before,
            }
        eligible = report.assessment_status == "assessed" and not report.needs_review
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
            raise VerificationRefused("Triage task was no longer available")
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


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report-id", type=UUID, required=True)
    parser.add_argument("--api-url", required=True)
    parser.add_argument("--expected-revision", required=True)
    args = parser.parse_args()
    settings = Settings()
    if settings.database_url is None:
        raise SystemExit("DATABASE_URL is required")
    engine = make_engine(settings)
    try:
        result = verify(
            engine, settings, args.report_id, args.api_url, args.expected_revision
        )
    except VerificationRefused as exc:
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
