"""Preflight reads migrations, scope, budgets and deployed revision without writes."""

import json
from uuid import uuid4

import httpx
import pytest
from pydantic import SecretStr, ValidationError
from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from api.config import Settings
from api.models import MessagingOutgoing, MessagingPilot, MessagingThread, Report
from scripts.pilot_preflight import _valid_coordinates, preflight
from tests.backend import test_pilot_assessment

assessment_pilot = test_pilot_assessment.assessment_pilot

REVISION = "a" * 40


def inspect(pilot, *, revision=REVISION, routing="true", enabled="true", **updates):
    settings = pilot.settings.model_copy(
        update={
            "database_url": SecretStr("postgresql://unused-test-connection"),
            "supabase_url": "https://test.invalid",
            "supabase_secret_key": SecretStr("private-supabase-key"),
            "messaging_api_key": SecretStr("private-messaging-key"),
            "chalk_router_api_key": SecretStr("private-chalk-key"),
            "chalk_env_id": "private-test-environment",
            "chalk_model": "xai/grok-4.3",
            **updates,
        }
    )
    requests = []

    def health(request):
        requests.append(request)
        assert request.url.path in ("/health", "/ready", "/openapi.json")
        assert "Authorization" not in request.headers
        if request.url.path == "/openapi.json":
            return httpx.Response(
                200,
                json={
                    "paths": {
                        "/routing/previews": {},
                        "/internal/messaging/inbound": {},
                    }
                },
            )
        return httpx.Response(
            200,
            json={"status": "ok"},
            headers={
                "X-WasteGrid-Revision": revision,
                "X-WasteGrid-Organizer-Routing": routing,
                "X-WasteGrid-Messaging-Pilot": enabled,
            },
        )

    return (
        preflight(
            pilot.engine,
            settings,
            api_url="https://api.test.invalid",
            expected_revision=REVISION,
            transport=httpx.MockTransport(health),
        ),
        requests,
    )


def test_preflight_is_sanitized_and_does_not_create_a_pilot(assessment_pilot):
    pilot = assessment_pilot
    result, requests = inspect(pilot)
    assert result["status"] == "ready"
    assert len(requests) == 3 and not result["provider_access_verified"]
    assert result["database"]["migrations_match"]
    assert result["database"]["pilot_persisted"] is False
    assert result["database"]["remaining"]["image_calls"] == 2
    encoded = json.dumps(result)
    for forbidden in (
        "private-",
        "test-peer",
        "test-pilot-chat",
        "test-project",
        "test-sender",
        "postgresql://",
        "Original immutable note",
    ):
        assert forbidden not in encoded
    with Session(pilot.engine) as db:
        assert db.scalar(select(func.count()).select_from(MessagingPilot)) == 0


@pytest.mark.parametrize(
    "changes",
    [
        {"revision": "b" * 40},
        {"revision": ""},
        {"routing": "false"},
        {"enabled": "false"},
    ],
)
def test_preflight_requires_deployed_revision_and_flags(assessment_pilot, changes):
    result, _ = inspect(assessment_pilot, **changes)
    assert result["status"] == "blocked"


def test_preflight_reads_existing_budget_without_reset(assessment_pilot):
    pilot = assessment_pilot
    with Session(pilot.engine) as db:
        db.add(
            MessagingPilot(
                id=pilot.settings.messaging_pilot_id,
                project_id=pilot.settings.photon_project_id,
                sender_id=pilot.settings.photon_agent_sender_id,
                report_ids=sorted(
                    str(value) for value in pilot.settings.messaging_pilot_report_ids
                ),
                chat_ids=pilot.settings.messaging_pilot_chat_ids,
                image_calls=2,
                followup_calls=7,
                send_attempts=9,
            )
        )
        db.commit()
    result, _ = inspect(pilot)
    assert result["status"] == "ready"
    assert result["database"]["usage"] == {
        "image_calls": 2,
        "followup_calls": 7,
        "send_attempts": 9,
    }
    assert result["database"]["remaining"]["image_calls"] == 0
    with Session(pilot.engine) as db:
        assert (
            db.get(MessagingPilot, pilot.settings.messaging_pilot_id).followup_calls
            == 7
        )


def test_preflight_rejects_migration_drift(assessment_pilot):
    pilot = assessment_pilot
    migration = "0013_messaging_pilot.sql"
    with Session(pilot.engine) as db:
        checksum = db.scalar(
            text("select checksum from wastegrid.schema_migrations where name=:name"),
            {"name": migration},
        )
        db.execute(
            text(
                "update wastegrid.schema_migrations "
                "set checksum=:checksum where name=:name"
            ),
            {"checksum": "b" * 64, "name": migration},
        )
        db.commit()
    try:
        result, _ = inspect(pilot)
        assert result["status"] == "blocked"
        assert result["database"]["changed_migrations"] == [migration]
    finally:
        with Session(pilot.engine) as db:
            db.execute(
                text(
                    "update wastegrid.schema_migrations "
                    "set checksum=:checksum where name=:name"
                ),
                {"checksum": checksum, "name": migration},
            )
            db.commit()


def test_preflight_blocks_unexpected_external_decision_provider(assessment_pilot):
    result, _ = inspect(
        assessment_pilot, person3_base_url="https://private-provider.invalid"
    )
    assert result["status"] == "blocked"
    assert not result["configuration"]["builtin_decisions_selected"]
    assert "private-provider" not in json.dumps(result)


def test_preflight_exposes_scoped_unknown_and_failed_counts_without_payloads(
    assessment_pilot,
):
    pilot = assessment_pilot
    with Session(pilot.engine) as db:
        db.add(
            MessagingPilot(
                id=pilot.settings.messaging_pilot_id,
                project_id=pilot.settings.photon_project_id,
                sender_id=pilot.settings.photon_agent_sender_id,
                report_ids=sorted(
                    str(value) for value in pilot.settings.messaging_pilot_report_ids
                ),
                chat_ids=pilot.settings.messaging_pilot_chat_ids,
            )
        )
        db.flush()
        for chat, statuses in (
            (
                "test-pilot-chat",
                [
                    ("unknown", "private-provider-id"),
                    ("unknown", None),
                    ("failed", None),
                ],
            ),
            ("unrelated-chat", [("unknown", None)]),
        ):
            thread = MessagingThread(
                pilot_id=pilot.settings.messaging_pilot_id,
                channel="imessage",
                external_id=chat,
                project_id=pilot.settings.photon_project_id,
                sender_id=pilot.settings.photon_agent_sender_id,
            )
            db.add(thread)
            db.flush()
            for status, provider_id in statuses:
                db.add(
                    MessagingOutgoing(
                        thread_id=thread.id,
                        kind="reply",
                        status=status,
                        text="private-message-body",
                        external_id=chat,
                        sender_id=thread.sender_id,
                        consent_revision=1,
                        provider_message_id=provider_id,
                        attempts=1,
                    )
                )
        db.commit()
    result, _ = inspect(pilot)
    outbox = result["database"]["outbox"]
    assert outbox["status_counts"] == {"unknown": 2, "failed": 1}
    assert outbox["unknown_with_provider_id"] == 1
    assert outbox["unknown_without_provider_id"] == 1
    assert len(outbox["operator_attention"]) == 3
    assert "private-" not in json.dumps(result)
    assert "test-pilot-chat" not in json.dumps(result)


@pytest.mark.parametrize("scope", ["empty", "single", "duplicate", "three"])
def test_enabled_settings_require_exactly_two_distinct_reports(scope):
    report_ids = [uuid4(), uuid4(), uuid4()]
    values = {
        "empty": [],
        "single": report_ids[:1],
        "duplicate": [report_ids[0], report_ids[0]],
        "three": report_ids,
    }
    with pytest.raises(ValidationError):
        Settings(
            _env_file=None,
            messaging_pilot_enabled=True,
            messaging_pilot_report_ids=values[scope],
        )


def test_disabled_settings_allow_unconfigured_pilot():
    assert not Settings(_env_file=None).messaging_pilot_enabled
    report_id = uuid4()
    settings = Settings(
        _env_file=None,
        messaging_pilot_report_ids=[report_id, report_id],
    )
    assert not settings.messaging_pilot_enabled
    configured = Settings(
        _env_file=None,
        messaging_pilot_enabled=True,
        messaging_pilot_report_ids=[uuid4(), uuid4()],
    )
    assert len(set(configured.messaging_pilot_report_ids)) == 2


@pytest.mark.parametrize("scope", ["empty", "single", "duplicate"])
def test_preflight_requires_two_distinct_reports_even_after_settings_copy(
    assessment_pilot, scope
):
    reports = assessment_pilot.settings.messaging_pilot_report_ids
    values = {
        "empty": [],
        "single": reports[:1],
        "duplicate": [reports[0], reports[0]],
    }
    result, _ = inspect(assessment_pilot, messaging_pilot_report_ids=values[scope])
    assert result["status"] == "blocked"
    assert not result["configuration"]["pilot_scope_configured"]
    assert not result["database"]["reports_present"]


@pytest.mark.parametrize("report_index", [0, 1])
@pytest.mark.parametrize(
    "location",
    [
        None,
        {},
        {"latitude": 24.92},
        {"longitude": 67.09},
        {"latitude": None, "longitude": 67.09},
        {"latitude": 24.92, "longitude": None},
        {"latitude": 91, "longitude": 67.09},
        {"latitude": -91, "longitude": 67.09},
        {"latitude": 24.92, "longitude": 181},
        {"latitude": 24.92, "longitude": -181},
        {"latitude": "NaN", "longitude": 67.09},
        {"latitude": 24.92, "longitude": "Infinity"},
    ],
)
def test_preflight_requires_valid_coordinates_on_each_report(
    assessment_pilot, report_index, location
):
    pilot = assessment_pilot
    report_id = pilot.report_ids[report_index]
    with Session(pilot.engine) as db:
        db.get(Report, report_id).location = location
        db.commit()
    result, _ = inspect(pilot)
    assert result["status"] == "blocked"
    reports = {report["id"]: report for report in result["database"]["reports"]}
    assert not reports[str(report_id)]["has_valid_coordinates"]
    assert reports[str(pilot.report_ids[1 - report_index])]["has_valid_coordinates"]
    assert not result["database"]["reports_present"]


@pytest.mark.parametrize(
    "location",
    [
        {"latitude": 0, "longitude": 0},
        {"latitude": -90, "longitude": -180},
        {"latitude": 90, "longitude": 180},
    ],
)
def test_preflight_accepts_valid_coordinate_boundaries(assessment_pilot, location):
    pilot = assessment_pilot
    with Session(pilot.engine) as db:
        for report_id in pilot.settings.messaging_pilot_report_ids:
            db.get(Report, report_id).location = location
        db.commit()
    result, _ = inspect(pilot)
    assert result["status"] == "ready"
    assert all(
        report["has_valid_coordinates"] for report in result["database"]["reports"]
    )
    assert "latitude" not in json.dumps(result)
    assert "longitude" not in json.dumps(result)


@pytest.mark.parametrize("coordinate", ["latitude", "longitude"])
@pytest.mark.parametrize("value", [float("nan"), float("inf"), float("-inf")])
def test_preflight_coordinate_validation_rejects_nonfinite_values(coordinate, value):
    location = {"latitude": 24.92, "longitude": 67.09, coordinate: value}
    assert not _valid_coordinates(location)


@pytest.mark.parametrize("report_index", [0, 1])
def test_preflight_requires_both_allowlisted_reports_to_exist(
    assessment_pilot, report_index
):
    report_ids = list(assessment_pilot.settings.messaging_pilot_report_ids)
    report_ids[report_index] = uuid4()
    result, _ = inspect(assessment_pilot, messaging_pilot_report_ids=report_ids)
    assert result["status"] == "blocked"
    assert result["configuration"]["pilot_scope_configured"]
    assert not result["database"]["reports_present"]


@pytest.mark.parametrize("changed_id", [False, True])
def test_preflight_reads_canonical_scope_budget_without_reset(
    assessment_pilot, changed_id
):
    pilot = assessment_pilot
    original_id = pilot.settings.messaging_pilot_id
    configured_id = uuid4() if changed_id else original_id
    with Session(pilot.engine) as db:
        db.add(
            MessagingPilot(
                id=original_id,
                project_id=pilot.settings.photon_project_id,
                sender_id=pilot.settings.photon_agent_sender_id,
                report_ids=sorted(
                    (str(value) for value in pilot.settings.messaging_pilot_report_ids),
                    reverse=True,
                ),
                chat_ids=pilot.settings.messaging_pilot_chat_ids,
                image_calls=2,
                followup_calls=7,
                send_attempts=9,
            )
        )
        db.flush()
        thread = MessagingThread(
            pilot_id=original_id,
            channel="imessage",
            external_id=pilot.settings.messaging_pilot_chat_ids[0],
            project_id=pilot.settings.photon_project_id,
            sender_id=pilot.settings.photon_agent_sender_id,
        )
        db.add(thread)
        db.flush()
        db.add(
            MessagingOutgoing(
                thread_id=thread.id,
                kind="reply",
                status="unknown",
                text="private-message-body",
                external_id=thread.external_id,
                sender_id=thread.sender_id,
                consent_revision=1,
                attempts=1,
            )
        )
        db.commit()
    result, _ = inspect(
        pilot,
        messaging_pilot_id=configured_id,
        messaging_pilot_report_ids=list(
            reversed(pilot.settings.messaging_pilot_report_ids)
        ),
    )
    assert result["status"] == ("blocked" if changed_id else "ready")
    assert result["database"]["scope_matches"] is not changed_id
    assert result["database"]["pilot_persisted"]
    assert result["database"]["usage"] == {
        "image_calls": 2,
        "followup_calls": 7,
        "send_attempts": 9,
    }
    assert result["database"]["remaining"]["image_calls"] == 0
    assert result["database"]["outbox"]["status_counts"] == {"unknown": 1}
    assert "private-message-body" not in json.dumps(result)
    with Session(pilot.engine) as db:
        assert db.scalar(select(func.count()).select_from(MessagingPilot)) == 1
        assert db.get(MessagingPilot, original_id).send_attempts == 9
        if changed_id:
            assert db.get(MessagingPilot, configured_id) is None
