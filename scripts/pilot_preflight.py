"""Read-only pilot readiness checks; never activate workers or contact providers."""

import argparse
import json
import re
from hashlib import sha256
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from pydantic import ValidationError
from sqlalchemy import func, or_, select, text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from api.config import Settings
from api.db import make_engine
from api.models import (
    Conversation,
    MessagingOutgoing,
    MessagingPilot,
    MessagingThread,
    Photo,
    Report,
    Task,
)
from api.pilot import enabled, matching_run, scope_matches
from api.schemas import Location

MIGRATIONS = Path(__file__).resolve().parents[1] / "supabase" / "migrations"
LIMITS = {"image_calls": 2, "followup_calls": 12, "send_attempts": 30}
REVISION = re.compile(r"^[0-9a-f]{40}$")


def _safe_url(value):
    try:
        parsed = urlsplit(value)
        return (
            parsed.scheme in ("http", "https")
            and bool(parsed.hostname)
            and parsed.username is None
            and parsed.password is None
            and not parsed.query
            and not parsed.fragment
            and not any(character.isspace() for character in value)
        )
    except ValueError:
        return False


def _valid_coordinates(location):
    try:
        Location.model_validate(location, strict=True)
    except ValidationError:
        return False
    return True


def _database(engine, settings):
    result = {"reachable": False, "migrations_match": False}
    if engine is None:
        return result
    try:
        with Session(engine) as db:
            # Enforce the promise at the database boundary, including future edits.
            db.execute(text("SET TRANSACTION READ ONLY"))
            result["reachable"] = True
            if not db.scalar(text("select to_regclass('wastegrid.schema_migrations')")):
                result["missing_migrations"] = [
                    path.name for path in sorted(MIGRATIONS.glob("*.sql"))
                ]
                return result
            applied = dict(
                db.execute(
                    text("select name, checksum from wastegrid.schema_migrations")
                ).all()
            )
            expected = {
                path.name: sha256(path.read_bytes()).hexdigest()
                for path in MIGRATIONS.glob("*.sql")
            }
            result["missing_migrations"] = sorted(set(expected) - set(applied))
            result["changed_migrations"] = sorted(
                name
                for name in expected
                if name in applied and expected[name] != applied[name]
            )
            result["migrations_match"] = (
                not result["missing_migrations"] and not result["changed_migrations"]
            )
            if not result["migrations_match"]:
                return result
            reports = list(
                db.scalars(
                    select(Report).where(
                        Report.id.in_(settings.messaging_pilot_report_ids)
                    )
                )
            )
            result["reports"] = [
                {
                    "id": str(report.id),
                    "illustrative": report.illustrative,
                    "assessment_status": report.assessment_status,
                    "has_photo_metadata": db.get(Photo, report.photo_id) is not None,
                    "has_valid_coordinates": _valid_coordinates(report.location),
                    "has_job": report.job_id is not None,
                }
                for report in sorted(reports, key=lambda report: str(report.id))
            ]
            result["reports_present"] = (
                len(reports) == len(set(settings.messaging_pilot_report_ids)) == 2
                and len(settings.messaging_pilot_report_ids) == 2
                and all(
                    not report["illustrative"]
                    and report["has_photo_metadata"]
                    and report["has_valid_coordinates"]
                    for report in result["reports"]
                )
            )
            scope = (
                Task.payload["report_id"]
                .as_string()
                .in_([str(value) for value in settings.messaging_pilot_report_ids])
            )
            result["task_counts"] = {}
            other = or_(~scope, Task.payload["report_id"].as_string().is_(None))
            for label, condition in (("allowlisted_reports", scope), ("other", other)):
                result["task_counts"][label] = [
                    {"kind": kind, "status": status, "count": count}
                    for kind, status, count in db.execute(
                        select(Task.kind, Task.status, func.count())
                        .where(condition)
                        .group_by(Task.kind, Task.status)
                        .order_by(Task.kind, Task.status)
                    )
                ]
            run = (
                db.get(MessagingPilot, settings.messaging_pilot_id)
                if settings.messaging_pilot_id
                else None
            )
            if run is None:
                run = matching_run(db, settings)
            result["pilot_persisted"] = run is not None
            result["scope_matches"] = run is None or (
                run.id == settings.messaging_pilot_id and scope_matches(run, settings)
            )
            result["usage"] = {
                name: getattr(run, name) if run else 0 for name in LIMITS
            }
            result["remaining"] = {
                name: maximum - result["usage"][name]
                for name, maximum in LIMITS.items()
            }
            result["budgets_valid"] = all(
                0 <= result["usage"][name] <= maximum
                for name, maximum in LIMITS.items()
            )
            outgoing = list(
                db.scalars(
                    select(MessagingOutgoing)
                    .join(
                        MessagingThread,
                        MessagingThread.id == MessagingOutgoing.thread_id,
                    )
                    .outerjoin(
                        Conversation,
                        Conversation.id == MessagingOutgoing.conversation_id,
                    )
                    .where(
                        MessagingThread.pilot_id
                        == (run.id if run else settings.messaging_pilot_id),
                        MessagingThread.external_id.in_(
                            settings.messaging_pilot_chat_ids
                        ),
                        MessagingThread.project_id == settings.photon_project_id,
                        MessagingThread.sender_id == settings.photon_agent_sender_id,
                        or_(
                            MessagingOutgoing.conversation_id.is_(None),
                            Conversation.report_id.in_(
                                settings.messaging_pilot_report_ids
                            ),
                        ),
                    )
                )
            )
            status_counts = {}
            for message in outgoing:
                status_counts[message.status] = status_counts.get(message.status, 0) + 1
            result["outbox"] = {
                "status_counts": status_counts,
                "unknown_with_provider_id": sum(
                    message.status == "unknown" and bool(message.provider_message_id)
                    for message in outgoing
                ),
                "unknown_without_provider_id": sum(
                    message.status == "unknown" and not message.provider_message_id
                    for message in outgoing
                ),
                "operator_attention": [
                    {
                        "id": str(message.id),
                        "status": message.status,
                        "attempts": message.attempts,
                        "has_provider_message_id": bool(message.provider_message_id),
                    }
                    for message in outgoing
                    if message.status in ("unknown", "failed")
                ],
            }
    except SQLAlchemyError:
        result["read_error"] = "database_unavailable_or_schema_incomplete"
        result["migrations_match"] = False
    return result


def preflight(engine, settings, *, api_url, expected_revision, transport=None):
    """Return sanitized evidence from configuration, read-only SQL and public health."""
    configuration = {
        "pilot_scope_configured": enabled(settings),
        "database_configured": settings.database_url is not None,
        "supabase_configured": bool(
            settings.supabase_url and settings.supabase_secret_key
        ),
        "messaging_key_configured": bool(settings.messaging_api_key),
        "chalk_configured": bool(
            settings.chalk_router_api_key and settings.chalk_env_id
        ),
        "expected_model_configured": settings.chalk_model == "xai/grok-4.3",
        "builtin_decisions_selected": not settings.integration_factory
        and not settings.person3_base_url,
    }
    result = {
        "configuration": configuration,
        "pilot_id": (
            str(settings.messaging_pilot_id) if settings.messaging_pilot_id else None
        ),
        "report_ids": sorted(
            str(value) for value in settings.messaging_pilot_report_ids
        ),
        "chat_count": len(settings.messaging_pilot_chat_ids),
        "limits": LIMITS,
        "database": _database(engine, settings),
        "api": {"revision_matches": False, "pilot_flags_enabled": False},
        "provider_access_verified": False,
    }
    if (
        _safe_url(api_url)
        and isinstance(expected_revision, str)
        and REVISION.fullmatch(expected_revision)
    ):
        try:
            with httpx.Client(
                timeout=15, follow_redirects=False, transport=transport
            ) as client:
                response = client.get(api_url.rstrip("/") + "/health")
                response.raise_for_status()
                readiness = client.get(api_url.rstrip("/") + "/ready")
                readiness.raise_for_status()
                specification = client.get(api_url.rstrip("/") + "/openapi.json")
                specification.raise_for_status()
            actual = response.headers.get("X-WasteGrid-Revision", "")
            result["api"] = {
                "revision": actual if REVISION.fullmatch(actual) else None,
                "revision_matches": (
                    actual == expected_revision
                    and readiness.headers.get("X-WasteGrid-Revision")
                    == expected_revision
                ),
                "ready": True,
                "required_paths_present": {
                    "/routing/previews",
                    "/internal/messaging/inbound",
                }
                <= set(specification.json().get("paths", {})),
                "pilot_flags_enabled": (
                    response.headers.get("X-WasteGrid-Organizer-Routing") == "true"
                    and response.headers.get("X-WasteGrid-Messaging-Pilot") == "true"
                    and readiness.headers.get("X-WasteGrid-Organizer-Routing") == "true"
                    and readiness.headers.get("X-WasteGrid-Messaging-Pilot") == "true"
                ),
            }
        except (httpx.HTTPError, ValueError):
            result["api"]["read_error"] = "health_or_readiness_unavailable"
    database = result["database"]
    result["status"] = (
        "ready"
        if (
            all(configuration.values())
            and database.get("migrations_match")
            and database.get("reports_present")
            and database.get("scope_matches")
            and database.get("budgets_valid")
            and result["api"]["revision_matches"]
            and result["api"]["pilot_flags_enabled"]
            and result["api"].get("required_paths_present")
        )
        else "blocked"
    )
    return result


class _Parser(argparse.ArgumentParser):
    def error(self, message):
        super().error("Invalid preflight arguments; see --help.")


def main(argv=None):
    parser = _Parser(description=__doc__)
    parser.add_argument("--api-url", required=True, help="WasteGrid API origin to read")
    parser.add_argument(
        "--expected-revision", required=True, help="Expected full Git commit SHA"
    )
    arguments = parser.parse_args(argv)
    engine = None
    try:
        settings = Settings()
        engine = make_engine(settings)
        result = preflight(
            engine,
            settings,
            api_url=arguments.api_url,
            expected_revision=arguments.expected_revision,
        )
    except (SQLAlchemyError, ValueError):
        result = {
            "status": "blocked",
            "error": "invalid_configuration_or_database_unavailable",
        }
    finally:
        if engine is not None:
            engine.dispose()
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0 if result["status"] == "ready" else 1


if __name__ == "__main__":
    raise SystemExit(main())
