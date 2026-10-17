"""Preflight reads migrations, scope, budgets and deployed revision without writes."""

import json

import httpx
import pytest
from pydantic import SecretStr
from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from api.models import MessagingOutgoing, MessagingPilot, MessagingThread
from scripts.pilot_preflight import preflight
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
