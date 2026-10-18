"""App requests use the existing verified chat and durable bounded outbox."""

from datetime import timedelta
from uuid import UUID, uuid4

import pytest
from pydantic import ValidationError
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from api.config import Settings
from api.models import (
    Conversation,
    ConversationMessage,
    LinkCode,
    MessagingInbound,
    MessagingOutgoing,
    MessagingPilot,
    MessagingThread,
    OutgoingMessage,
    Report,
    Task,
    now,
)
from api.services import event
from tests.backend import test_pilot_api
from tests.backend.conftest import auth

pilot = test_pilot_api.pilot


@pytest.fixture
def phone(pilot):
    settings = pilot.client.app.state.settings
    settings.messaging_pilot_peer_id = "resident-peer"
    settings.messaging_pilot_phone_label = "Registered phone ending 1234"
    return pilot


def path(phone, index=0):
    return f"/reports/{phone.reports[index]['report']['id']}/phone-updates"


def post(phone, command_id=None, index=0, **changes):
    return phone.client.post(
        path(phone, index),
        headers=auth(phone.reports[index]["access_token"]),
        json={
            "command_id": str(command_id or uuid4()),
            "message": "Status",
            "consent": True,
            **changes,
        },
    )


def get(phone, index=0):
    return phone.client.get(
        path(phone, index), headers=auth(phone.reports[index]["access_token"])
    )


def test_read_is_private_side_effect_free_and_disabled_until_phone_is_configured(
    pilot, engine
):
    response = get(pilot)
    assert response.json() == {
        "enabled": False,
        "phone_label": None,
        "latest_request": None,
    }
    assert pilot.client.get(path(pilot)).status_code == 401
    assert (
        pilot.client.get(
            path(pilot), headers=auth(pilot.reports[1]["access_token"])
        ).status_code
        == 404
    )
    assert post(pilot).status_code == 503
    with Session(engine) as db:
        assert db.scalar(select(func.count()).select_from(MessagingPilot)) == 0
        assert db.scalar(select(func.count()).select_from(MessagingThread)) == 0


def test_status_creates_fixed_phone_snapshot_without_model_or_link_code(phone, engine):
    assert get(phone).json() == {
        "enabled": True,
        "phone_label": "Registered phone ending 1234",
        "latest_request": None,
    }
    command = uuid4()
    result = post(phone, command, message=" \n sTaTuS\t")
    assert result.status_code == 200, result.text
    assert set(result.json()) == {"id", "status", "message", "created_at"}
    assert result.json()["id"] == str(command)
    assert result.json()["status"] == "queued"
    assert "received" in result.json()["message"]
    assert get(phone).json()["latest_request"] == result.json()
    assert (
        "resident-peer" not in result.text and "private-pilot-chat" not in result.text
    )
    with Session(engine) as db:
        row = db.get(MessagingOutgoing, command)
        assert row.kind == "phone_status" and row.status == "pending"
        assert (
            row.external_id == "private-pilot-chat" and row.sender_id == "pilot-agent"
        )
        assert row.text == result.json()["message"]
        assert db.scalar(select(Conversation)).active is False
        assert db.scalar(select(MessagingThread)).peer_id == "resident-peer"
        run = db.scalar(select(MessagingPilot))
        assert run.image_calls == run.followup_calls == run.send_attempts == 0
        for model in (LinkCode, MessagingInbound, ConversationMessage):
            assert db.scalar(select(func.count()).select_from(model)) == 0
        assert (
            db.scalar(
                select(func.count())
                .select_from(Task)
                .where(Task.kind == "pilot_followup")
            )
            == 0
        )


@pytest.mark.parametrize(
    "changes",
    [
        {"message": "Where is the crew?"},
        {"message": "Status please"},
        {"message": "Sta tus"},
        {"message": "STOP"},
        {"consent": False},
        {"consent": "true"},
        {"recipient": "+15555551234"},
    ],
)
def test_unsupported_input_has_no_effect_or_ai(phone, engine, changes):
    assert post(phone, **changes).status_code == 422
    with Session(engine) as db:
        assert db.scalar(select(func.count()).select_from(MessagingPilot)) == 0
        assert db.scalar(select(func.count()).select_from(MessagingOutgoing)) == 0
        assert db.scalar(select(func.count()).select_from(Conversation)) == 0


def test_replay_preserves_snapshot_and_never_requeues_an_uncertain_send(phone, engine):
    command = uuid4()
    first = post(phone, command).json()
    with Session(engine) as db:
        db.get(Report, UUID(phone.reports[0]["report"]["id"])).state = "needs_review"
        row = db.get(MessagingOutgoing, command)
        row.status, row.attempts = "unknown", 1
        db.scalar(select(MessagingPilot)).send_attempts = 1
        db.commit()
    repeat = post(phone, command)
    assert repeat.status_code == 200
    assert repeat.json() == {**first, "status": "uncertain"}
    assert post(phone).status_code == 409
    phone.client.app.state.settings.messaging_pilot_enabled = False
    assert post(phone, command).json() == repeat.json()
    assert get(phone).json()["latest_request"] == repeat.json()
    with Session(engine) as db:
        assert db.scalar(select(func.count()).select_from(MessagingOutgoing)) == 1
        assert db.scalar(select(MessagingPilot)).send_attempts == 1


def test_command_id_cannot_switch_reports(phone, engine):
    command = uuid4()
    assert post(phone, command).status_code == 200
    assert post(phone, command, index=1).status_code == 409
    with Session(engine) as db:
        assert db.scalar(select(func.count()).select_from(Conversation)) == 1
        assert db.scalar(select(func.count()).select_from(MessagingOutgoing)) == 1


def test_stop_cancels_request_and_app_consent_cannot_resume_phone(phone, engine):
    command = uuid4()
    assert post(phone, command).status_code == 200
    phone.send("STOP")
    status = get(phone).json()
    assert status["enabled"] is False
    assert status["latest_request"]["status"] == "cancelled"
    assert post(phone).status_code == 409
    assert post(phone, command).json()["status"] == "cancelled"
    with Session(engine) as db:
        assert db.scalar(select(MessagingThread)).paused
        assert db.get(MessagingOutgoing, command).status == "cancelled"
    # START remains a phone-side control, then an explicit app request is allowed.
    phone.send("START")
    assert post(phone).status_code == 200


@pytest.mark.parametrize(
    "field,value",
    [
        ("peer_id", "unexpected-peer"),
        ("project_id", "other-project"),
        ("sender_id", "other-sender"),
        ("pilot_id", None),
    ],
)
def test_existing_chat_identity_must_match_trusted_configuration(
    phone, engine, field, value
):
    phone.send("HELP")
    with Session(engine) as db:
        setattr(db.scalar(select(MessagingThread)), field, value)
        db.commit()
    assert get(phone).json()["enabled"] is False
    assert post(phone).status_code == 409
    with Session(engine) as db:
        assert db.scalar(select(func.count()).select_from(Conversation)) == 0


def test_phone_scope_and_send_budget_cannot_be_reset(phone, engine):
    command = uuid4()
    assert post(phone, command).status_code == 200
    settings = phone.client.app.state.settings
    original = settings.messaging_pilot_id
    settings.messaging_pilot_id = uuid4()
    assert get(phone).json()["enabled"] is False
    assert post(phone, index=1).status_code == 409
    settings.messaging_pilot_id = original
    with Session(engine) as db:
        db.scalar(select(MessagingPilot)).send_attempts = 30
        db.commit()
    assert get(phone).json()["enabled"] is False
    assert post(phone, index=1).status_code == 429
    assert test_pilot_api.claim(phone.client) == []


def test_disabled_or_outside_pilot_reports_cannot_request_phone_updates(phone, engine):
    settings = phone.client.app.state.settings
    settings.messaging_pilot_report_ids[0] = uuid4()
    assert get(phone).json()["enabled"] is False
    assert post(phone).status_code == 503
    with Session(engine) as db:
        assert db.scalar(select(func.count()).select_from(MessagingOutgoing)) == 0


def test_receipts_distinguish_sending_acceptance_delivery_and_uncertainty(
    phone, engine
):
    command = uuid4()
    assert post(phone, command).status_code == 200
    claimed = test_pilot_api.claim(phone.client)[0]
    assert test_pilot_api.operation(phone.client, claimed, "sending").status_code == 200
    assert get(phone).json()["latest_request"]["status"] == "sending"
    with Session(engine) as db:
        db.get(MessagingOutgoing, command).leased_until = now() - timedelta(seconds=1)
        db.commit()
    assert get(phone).json()["latest_request"]["status"] == "uncertain"
    receipt = {
        "provider_message_id": "provider-phone-update",
        "provider_status": "accepted",
        "sent_text": claimed["text"],
    }
    assert (
        test_pilot_api.operation(
            phone.client, claimed, "accepted", **receipt
        ).status_code
        == 200
    )
    assert get(phone).json()["latest_request"]["status"] == "submitted"
    assert (
        test_pilot_api.operation(
            phone.client,
            claimed,
            "accepted",
            **{**receipt, "provider_status": "delivered"},
        ).status_code
        == 200
    )
    assert get(phone).json()["latest_request"]["status"] == "delivered"
    assert post(phone, command).json()["status"] == "delivered"
    with Session(engine) as db:
        assert db.scalar(select(MessagingPilot)).send_attempts == 1
        assert db.scalar(select(func.count()).select_from(ConversationMessage)) == 1


def test_changed_trusted_peer_prevents_outbox_claim(phone):
    assert post(phone).status_code == 200
    phone.client.app.state.settings.messaging_pilot_peer_id = "different-peer"
    assert test_pilot_api.claim(phone.client) == []


@pytest.mark.parametrize(
    "label", ["+15555551234", "person@example.test", "Registered phone ending 12345"]
)
def test_config_phone_label_cannot_publish_unmasked_contact(label):
    with pytest.raises(ValidationError):
        Settings(_env_file=None, messaging_pilot_phone_label=label)


def test_one_phone_snapshot_does_not_subscribe_to_later_report_or_job_events(
    phone, engine
):
    command = uuid4()
    assert post(phone, command).status_code == 200
    with Session(engine) as db:
        rid = UUID(phone.reports[0]["report"]["id"])
        db.get(Report, rid).state = "needs_review"
        event(db, "report.assessed", report_id=rid)
        event(db, "job.changed", report_id=rid)
        event(db, "job.completed", report_id=rid)
        db.commit()
        assert db.scalar(select(func.count()).select_from(MessagingOutgoing)) == 1
        assert db.scalar(select(func.count()).select_from(OutgoingMessage)) == 0
        assert db.scalar(select(Conversation)).active is False
    claimed = test_pilot_api.claim(phone.client)
    assert len(claimed) == 1 and claimed[0]["id"] == str(command)
    assert (
        test_pilot_api.operation(phone.client, claimed[0], "sending").status_code == 200
    )


@pytest.mark.parametrize("active", [False, True])
def test_phone_snapshot_preserves_existing_subscription_state(phone, engine, active):
    phone.link()
    with Session(engine) as db:
        db.scalar(select(Conversation)).active = active
        db.commit()
    assert post(phone).status_code == 200
    with Session(engine) as db:
        assert db.scalar(select(Conversation)).active is active


def test_trusted_phone_hi_directs_to_in_app_status_without_link_or_ai(phone, engine):
    phone.send("Hi")
    with Session(engine) as db:
        outgoing = db.scalar(select(MessagingOutgoing))
        assert "Report updates" in outgoing.text and "type Status" in outgoing.text
        assert "LINK" not in outgoing.text and "iMessage" not in outgoing.text
        assert db.scalar(select(func.count()).select_from(Conversation)) == 0
        assert (
            db.scalar(
                select(func.count())
                .select_from(Task)
                .where(Task.kind == "pilot_followup")
            )
            == 0
        )
        run = db.scalar(select(MessagingPilot))
        assert run.image_calls == run.followup_calls == run.send_attempts == 0
