"""Real-PostgreSQL acceptance tests for the bounded resident messaging API."""

import json
from datetime import timedelta
from hashlib import sha256
from secrets import token_urlsafe
from uuid import UUID, uuid4

import pytest
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from api.auth import digest
from api.models import (
    Conversation,
    ConversationMessage,
    LinkCode,
    MessagingInbound,
    MessagingOutgoing,
    MessagingPilot,
    MessagingThread,
    Report,
    Task,
    now,
)
from tests.backend.conftest import INTERNAL, auth, report

INBOUND = "/internal/messaging/inbound"
OUTGOING = "/internal/messaging/outgoing"


@pytest.fixture
def pilot(client, png):
    reports = [report(client, png, note=f"Private report {n}") for n in range(2)]
    settings = client.app.state.settings
    settings.messaging_pilot_enabled = True
    settings.messaging_pilot_id = uuid4()
    settings.messaging_pilot_report_ids = [
        UUID(item["report"]["id"]) for item in reports
    ]
    settings.messaging_pilot_chat_ids = ["private-pilot-chat"]
    settings.messaging_imessage_recipient = "pilot@example.test"
    settings.photon_project_id = "pilot-project"
    settings.photon_agent_sender_id = "pilot-agent"
    settings.organizer_routing_enabled = True
    return Pilot(client, reports)


class Pilot:
    def __init__(self, client, reports):
        self.client, self.reports, self.sequence = client, reports, 0

    def envelope(self, text, **changes):
        self.sequence += 1
        return {
            "project_id": "pilot-project",
            "agent_sender_id": "pilot-agent",
            "external_id": "private-pilot-chat",
            "message_id": f"provider-{self.sequence}",
            "peer_id": "resident-peer",
            "space_kind": "direct",
            "text": text,
            "created_at": now().isoformat(),
            **changes,
        }

    def send(self, text, **changes):
        body = self.envelope(text, **changes)
        response = self.client.post(INBOUND, headers=INTERNAL, json=body)
        assert response.status_code == 200, response.text
        return response.json()

    def code(self, index=0):
        created = self.reports[index]
        response = self.client.post(
            f"/reports/{created['report']['id']}/followup-link",
            headers=auth(created["access_token"]),
            json={},
        )
        assert response.status_code == 201, response.text
        return response.json()

    def link(self, index=0):
        code = self.code(index)
        self.send("LINK " + code["link_code"])
        return code

    def status(self, index=0, token=None):
        created = self.reports[index]
        return self.client.get(
            f"/reports/{created['report']['id']}/messaging-links",
            headers=auth(token or created["access_token"]),
        )


def claim(client):
    response = client.post(OUTGOING + "/claim", headers=INTERNAL, json={})
    assert response.status_code == 200, response.text
    return response.json()


def operation(client, message, name, **body):
    return client.post(
        f"{OUTGOING}/{message['id']}/{name}",
        headers=INTERNAL,
        json={"lease_id": message["lease_id"], **body},
    )


def isolated_outgoing(engine, pilot, *, text="Frozen report reply"):
    """Set aside onboarding replies to examine one transport outcome at a time."""
    with Session(engine) as db:
        for pending in db.scalars(select(MessagingOutgoing)):
            pending.status = "cancelled"
        conversation = db.scalar(select(Conversation))
        thread = db.get(MessagingThread, conversation.thread_id)
        message = MessagingOutgoing(
            thread_id=thread.id,
            conversation_id=conversation.id,
            kind="reply",
            text=text,
            external_id=thread.external_id,
            sender_id=thread.sender_id,
            consent_revision=thread.consent_revision,
        )
        db.add(message)
        db.commit()
        return message.id


def test_new_reports_require_coordinates_but_accepted_address_only_retries_recover(
    client, png, engine
):
    data = {"note": "Legacy report", "title": "Legacy title", "address": "A landmark"}
    upload = {"photo": ("photo.png", png, "image/png")}
    assert client.post("/reports", data=data, files=upload).status_code == 422
    for coords in (
        {"latitude": 24},
        {"longitude": 67},
        {"latitude": 91, "longitude": 67},
    ):
        assert (
            client.post("/reports", data={**data, **coords}, files=upload).status_code
            == 422
        )
    rid, token = uuid4(), "wg_r_" + token_urlsafe(32)
    response = client.post(
        "/reports",
        files=upload,
        headers={"X-Report-Token": token},
        data={
            **data,
            "latitude": 24.92,
            "longitude": 67.09,
            "client_report_id": str(rid),
        },
    )
    assert response.status_code == 201, response.text
    first = response.json()
    # Model a report accepted by the previous address-only contract. Replaying
    # that exact immutable submission must precede the new coordinate rule.
    old = {
        "photo": sha256(png).hexdigest(),
        "location": None,
        "note": data["note"],
        "title": data["title"],
        "address": data["address"],
    }
    with Session(engine) as db:
        row = db.get(Report, UUID(first["report"]["id"]))
        row.location, row.token_hash = None, digest(token)
        row.request_hash = digest(json.dumps(old, sort_keys=True))
        db.commit()
    replay = client.post(
        "/reports",
        data={**data, "client_report_id": str(rid)},
        files=upload,
        headers={"X-Report-Token": token},
    )
    assert replay.status_code == 201, replay.text
    assert replay.json()["report"]["id"] == str(rid)
    with Session(engine) as db:
        assert db.scalar(select(func.count()).select_from(Report)) == 1


def test_link_codes_are_private_expiring_and_binding_is_backend_confirmed(
    pilot, engine
):
    code = pilot.code()
    assert code["recipient"] == "pilot@example.test"
    assert code["channel"] == "imessage"
    assert pilot.status().json()["links"] == []
    assert pilot.status(token=pilot.reports[1]["access_token"]).status_code == 404
    pilot.send("LINK " + code["link_code"])
    status = pilot.status()
    assert status.status_code == 200
    assert status.json()["links"][0]["active"] is True
    assert set(status.json()["links"][0]) == {"id", "channel", "active", "paused"}
    assert (
        "private-pilot-chat" not in status.text and "resident-peer" not in status.text
    )
    with Session(engine) as db:
        inbound = db.scalar(select(MessagingInbound))
        assert code["link_code"] not in inbound.body
        assert inbound.body == "LINK [redacted]"
        assert db.scalar(select(func.count()).select_from(Conversation)) == 1
    expired = pilot.code(1)
    with Session(engine) as db:
        row = db.scalar(
            select(LinkCode).where(LinkCode.code_hash == digest(expired["link_code"]))
        )
        row.expires_at = now() - timedelta(seconds=1)
        db.commit()
    pilot.send("LINK " + expired["link_code"])
    assert pilot.status(1).json()["links"] == []


@pytest.mark.parametrize(
    "changes",
    [
        {"project_id": "other-project"},
        {"agent_sender_id": "other-agent"},
        {"external_id": "not-allowlisted"},
        {"space_kind": "group"},
        {"peer_id": "pilot-agent"},
    ],
)
def test_transport_scope_is_rejected_before_any_inbound_or_thread_is_saved(
    pilot, engine, changes
):
    response = pilot.client.post(
        INBOUND, headers=INTERNAL, json=pilot.envelope("HELP", **changes)
    )
    assert response.status_code == 403, response.text
    with Session(engine) as db:
        assert db.scalar(select(func.count()).select_from(MessagingInbound)) == 0
        assert db.scalar(select(func.count()).select_from(MessagingThread)) == 0


def test_integration_auth_timestamp_and_duplicate_payload_are_enforced(pilot, engine):
    body = pilot.envelope("HELP")
    assert pilot.client.post(INBOUND, json=body).status_code == 401
    malformed = {**body, "created_at": "2026-10-17T12:00:00"}
    assert (
        pilot.client.post(INBOUND, headers=INTERNAL, json=malformed).status_code == 422
    )
    first = pilot.client.post(INBOUND, headers=INTERNAL, json=body)
    duplicate = pilot.client.post(INBOUND, headers=INTERNAL, json=body)
    assert first.status_code == duplicate.status_code == 200
    assert first.json() == duplicate.json()
    changed = pilot.client.post(
        INBOUND, headers=INTERNAL, json={**body, "text": "STOP"}
    )
    assert changed.status_code == 409
    with Session(engine) as db:
        assert db.scalar(select(func.count()).select_from(MessagingInbound)) == 1
        assert db.scalar(select(func.count()).select_from(MessagingOutgoing)) == 1


def test_multiple_report_selection_resolves_one_pending_question_and_isolates_transcripts(
    pilot, engine
):
    pilot.link(0)
    pilot.link(1)
    with Session(engine) as db:
        thread = db.scalar(select(MessagingThread))
        thread.selected_link_id = thread.selection_expires_at = None
        db.commit()
    question = "Where is the cleanup crew?"
    ambiguous = pilot.send(question)
    assert ambiguous["status"] == "awaiting_selection"
    reference_a = pilot.reports[0]["report"]["public_reference"]
    selected = pilot.send(reference_a)
    assert selected["status"] == "queued"
    reference_b = pilot.reports[1]["report"]["public_reference"]
    second = pilot.send(reference_b + " More bags were left behind.")
    assert second["status"] == "queued"
    with Session(engine) as db:
        resolved = db.get(MessagingInbound, UUID(selected["id"]))
        assert resolved.body == question
        assert resolved.report_id == UUID(pilot.reports[0]["report"]["id"])
        assert db.get(MessagingInbound, UUID(ambiguous["id"])).status == "resolved"
        assert db.get(MessagingInbound, UUID(second["id"])).report_id == UUID(
            pilot.reports[1]["report"]["id"]
        )
        assert db.scalar(select(MessagingThread)).pending_text is None
    histories = []
    for created in pilot.reports:
        response = pilot.client.get(
            f"/reports/{created['report']['id']}/messages",
            headers=auth(created["access_token"]),
        )
        assert response.status_code == 200
        histories.append(response.text)
        assert (
            "private-pilot-chat" not in response.text
            and "resident-peer" not in response.text
        )
    assert question in histories[0] and "More bags" not in histories[0]
    assert "More bags" in histories[1] and question not in histories[1]


def test_unknown_reference_and_expired_pending_question_do_not_grant_access(
    pilot, engine, png
):
    pilot.link(0)
    pilot.link(1)
    outside = report(pilot.client, png, note="Outside private report")
    reference = outside["report"]["public_reference"]
    rejected = pilot.send(reference + " What is its status?")
    assert rejected["status"] == "awaiting_selection"
    with Session(engine) as db:
        assert (
            db.scalar(
                select(func.count())
                .select_from(Task)
                .where(Task.kind == "pilot_followup")
            )
            == 0
        )
        thread = db.scalar(select(MessagingThread))
        thread.selected_link_id = thread.selection_expires_at = None
        db.commit()
    pilot.send("An ambiguous older question")
    with Session(engine) as db:
        thread = db.scalar(select(MessagingThread))
        thread.pending_expires_at = now() - timedelta(seconds=1)
        db.commit()
    result = pilot.send(pilot.reports[0]["report"]["public_reference"])
    assert result["status"] == "processed"
    with Session(engine) as db:
        assert (
            db.scalar(
                select(func.count())
                .select_from(Task)
                .where(Task.kind == "pilot_followup")
            )
            == 0
        )


def test_stop_cancels_unsent_work_and_start_does_not_replay_it(pilot, engine):
    pilot.link()
    queued = pilot.send("What is the status?")
    claimed = claim(pilot.client)[0]
    pilot.send("STOP")
    assert pilot.status().json()["links"][0]["paused"] is True
    assert operation(pilot.client, claimed, "sending").status_code == 409
    stopped_input = pilot.send("Please update the location")
    assert stopped_input["status"] == "cancelled"
    with Session(engine) as db:
        assert db.get(MessagingInbound, UUID(queued["id"])).status == "cancelled"
        unsent = list(
            db.scalars(
                select(MessagingOutgoing).where(MessagingOutgoing.kind != "control")
            )
        )
        assert unsent and all(row.status == "cancelled" for row in unsent)
    pilot.send("START")
    assert pilot.status().json()["links"][0]["paused"] is False
    resumed = claim(pilot.client)
    assert len(resumed) == 1 and "resumed" in resumed[0]["text"].lower()


def test_unlink_is_report_authorized_and_a_used_code_cannot_reactivate_it(pilot):
    code = pilot.link()
    link = pilot.status().json()["links"][0]
    rid = pilot.reports[0]["report"]["id"]
    path = f"/reports/{rid}/messaging-links/{link['id']}/unlink"
    assert (
        pilot.client.post(
            path, headers=auth(pilot.reports[1]["access_token"]), json={}
        ).status_code
        == 404
    )
    assert (
        pilot.client.post(
            path, headers=auth(pilot.reports[0]["access_token"]), json={}
        ).status_code
        == 204
    )
    pilot.send("LINK " + code["link_code"])
    assert pilot.status().json()["links"][0]["active"] is False
    pilot.send("What is the status?")
    assert pilot.status().json()["links"][0]["active"] is False


def test_claiming_does_not_spend_budget_until_sending_and_duplicate_sending_is_rejected(
    pilot, engine
):
    pilot.link()
    identity = isolated_outgoing(engine, pilot)
    message = claim(pilot.client)[0]
    assert message["id"] == str(identity) and message["status"] == "leased"
    with Session(engine) as db:
        run = db.get(MessagingPilot, pilot.client.app.state.settings.messaging_pilot_id)
        assert (
            run.send_attempts == 0 and db.get(MessagingOutgoing, identity).attempts == 0
        )
    result = operation(pilot.client, message, "sending")
    assert result.status_code == 200 and result.json()["text"] == "Frozen report reply"
    assert operation(pilot.client, message, "sending").status_code == 409
    with Session(engine) as db:
        run = db.get(MessagingPilot, pilot.client.app.state.settings.messaging_pilot_id)
        assert (
            run.send_attempts == 1 and db.get(MessagingOutgoing, identity).attempts == 1
        )
    assert (
        operation(
            pilot.client, {**message, "lease_id": str(uuid4())}, "sending"
        ).status_code
        == 409
    )


def test_unknown_submission_is_not_retried_and_late_receipt_records_acceptance_separately_from_delivery(
    pilot, engine
):
    pilot.link()
    identity = isolated_outgoing(engine, pilot)
    message = claim(pilot.client)[0]
    assert operation(pilot.client, message, "sending").status_code == 200
    with Session(engine) as db:
        db.get(MessagingOutgoing, identity).leased_until = now() - timedelta(seconds=1)
        db.commit()
    assert claim(pilot.client) == []
    with Session(engine) as db:
        assert db.get(MessagingOutgoing, identity).status == "unknown"
    assert (
        operation(
            pilot.client, message, "failed", kind="rejected", retryable=True
        ).status_code
        == 409
    )
    assert claim(pilot.client) == []
    with Session(engine) as db:
        assert db.get(MessagingOutgoing, identity).status == "unknown"
    receipt = {
        "provider_message_id": "photon-real-id",
        "provider_status": "accepted",
        "sent_text": message["text"],
    }
    assert operation(pilot.client, message, "accepted", **receipt).status_code == 200
    assert operation(pilot.client, message, "accepted", **receipt).status_code == 200
    with Session(engine) as db:
        row = db.get(MessagingOutgoing, identity)
        assert row.accepted_at is not None and row.delivered_at is None
        # Photon accepted is terminal without proving recipient delivery.
        row.next_attempt_at = now() - timedelta(seconds=1)
        db.commit()
    assert claim(pilot.client) == []
    with Session(engine) as db:
        assert (
            db.scalar(
                select(func.count())
                .select_from(ConversationMessage)
                .where(ConversationMessage.pilot_outgoing_id == identity)
            )
            == 1
        )
    path = f"{OUTGOING}/{identity}/status"
    assert (
        pilot.client.post(
            path,
            headers=INTERNAL,
            json={"provider_message_id": "wrong", "provider_status": "delivered"},
        ).status_code
        == 409
    )
    delivered = pilot.client.post(
        path,
        headers=INTERNAL,
        json={"provider_message_id": "photon-real-id", "provider_status": "delivered"},
    )
    assert delivered.status_code == 200 and delivered.json()["status"] == "delivered"
    with Session(engine) as db:
        assert db.get(MessagingOutgoing, identity).delivered_at is not None


def test_definite_rejections_retry_at_most_three_times_with_frozen_destination_and_text(
    pilot, engine
):
    pilot.link()
    identity = isolated_outgoing(engine, pilot)
    payloads = []
    for attempt in range(1, 4):
        message = claim(pilot.client)[0]
        payloads.append((message["text"], message["external_id"], message["sender_id"]))
        assert operation(pilot.client, message, "sending").status_code == 200
        failed = operation(
            pilot.client, message, "failed", kind="rejected", retryable=True
        )
        assert failed.status_code == 200
        assert failed.json()["status"] == ("failed" if attempt == 3 else "pending")
        with Session(engine) as db:
            db.get(MessagingOutgoing, identity).next_attempt_at = now() - timedelta(
                seconds=1
            )
            db.commit()
    assert len(set(payloads)) == 1
    assert claim(pilot.client) == []
    with Session(engine) as db:
        assert db.get(MessagingOutgoing, identity).attempts == 3
        assert (
            db.get(
                MessagingPilot, pilot.client.app.state.settings.messaging_pilot_id
            ).send_attempts
            == 3
        )


def test_persisted_send_cap_and_pilot_scope_apply_before_leasing(pilot, engine):
    pilot.link()
    identity = isolated_outgoing(engine, pilot)
    with Session(engine) as db:
        run = db.get(MessagingPilot, pilot.client.app.state.settings.messaging_pilot_id)
        run.send_attempts = 30
        db.commit()
    assert claim(pilot.client) == []
    with Session(engine) as db:
        row = db.get(MessagingOutgoing, identity)
        assert row.status == "pending" and row.lease_id is None and row.attempts == 0
    settings = pilot.client.app.state.settings
    settings.messaging_pilot_chat_ids = ["changed-chat"]
    assert (
        pilot.client.post(OUTGOING + "/claim", headers=INTERNAL, json={}).status_code
        == 409
    )
    settings.messaging_pilot_chat_ids = ["private-pilot-chat"]
    assert claim(pilot.client) == []


def test_illustrative_report_messages_are_preserved_without_leasing(pilot, engine):
    pilot.link()
    identity = isolated_outgoing(engine, pilot)
    with Session(engine) as db:
        db.get(Report, UUID(pilot.reports[0]["report"]["id"])).illustrative = True
        db.commit()
    assert claim(pilot.client) == []
    with Session(engine) as db:
        row = db.get(MessagingOutgoing, identity)
        assert row.status == "pending" and row.lease_id is None


def test_unrelated_report_messages_are_preserved_without_claim_or_budget_use(
    pilot, engine, png
):
    pilot.link()
    isolated_outgoing(engine, pilot)
    outside = report(pilot.client, png, note="Not a pilot report")
    with Session(engine) as db:
        for pending in db.scalars(select(MessagingOutgoing)):
            pending.status = "cancelled"
        thread = db.scalar(select(MessagingThread))
        link = Conversation(
            report_id=UUID(outside["report"]["id"]),
            channel="imessage",
            external_id=thread.external_id,
            thread_id=thread.id,
        )
        db.add(link)
        db.flush()
        pending = MessagingOutgoing(
            thread_id=thread.id,
            conversation_id=link.id,
            kind="reply",
            text="Unrelated work must be retained",
            external_id=thread.external_id,
            sender_id=thread.sender_id,
            consent_revision=thread.consent_revision,
        )
        db.add(pending)
        db.commit()
        identity = pending.id
    assert claim(pilot.client) == []
    with Session(engine) as db:
        row = db.get(MessagingOutgoing, identity)
        assert row.status == "pending" and row.lease_id is None and row.attempts == 0
        assert (
            db.get(
                MessagingPilot, pilot.client.app.state.settings.messaging_pilot_id
            ).send_attempts
            == 0
        )


def test_receipt_rejects_text_mutation_and_a_lease_expired_before_sending_can_be_reclaimed(
    pilot, engine
):
    pilot.link()
    identity = isolated_outgoing(engine, pilot)
    original = claim(pilot.client)[0]
    with Session(engine) as db:
        db.get(MessagingOutgoing, identity).leased_until = now() - timedelta(seconds=1)
        db.commit()
    replacement = claim(pilot.client)[0]
    assert replacement["lease_id"] != original["lease_id"]
    assert operation(pilot.client, original, "sending").status_code == 409
    assert operation(pilot.client, replacement, "sending").status_code == 200
    conflict = operation(
        pilot.client,
        replacement,
        "accepted",
        provider_message_id="provider-id",
        provider_status="accepted",
        sent_text="Re-rendered text",
    )
    assert conflict.status_code == 409


def test_pilot_fails_closed_when_routing_or_configuration_is_disabled(pilot, engine):
    settings = pilot.client.app.state.settings
    for field, value in (
        ("organizer_routing_enabled", False),
        ("messaging_pilot_chat_ids", []),
        ("messaging_pilot_enabled", False),
    ):
        original = getattr(settings, field)
        setattr(settings, field, value)
        assert (
            pilot.client.post(
                INBOUND, headers=INTERNAL, json=pilot.envelope("HELP")
            ).status_code
            == 503
        )
        assert pilot.status().json()["enabled"] is False
        setattr(settings, field, original)
    with Session(engine) as db:
        assert db.scalar(select(func.count()).select_from(MessagingInbound)) == 0


def test_late_provider_receipt_after_unlink_still_records_the_real_delivery(
    pilot, engine
):
    pilot.link()
    identity = isolated_outgoing(engine, pilot)
    message = claim(pilot.client)[0]
    assert operation(pilot.client, message, "sending").status_code == 200
    link = pilot.status().json()["links"][0]
    created = pilot.reports[0]
    path = f"/reports/{created['report']['id']}/messaging-links/{link['id']}/unlink"
    assert (
        pilot.client.post(
            path, headers=auth(created["access_token"]), json={}
        ).status_code
        == 204
    )
    receipt = operation(
        pilot.client,
        message,
        "accepted",
        provider_message_id="real-after-unlink",
        provider_status="accepted",
        sent_text=message["text"],
    )
    assert receipt.status_code == 200, receipt.text
    with Session(engine) as db:
        row = db.get(MessagingOutgoing, identity)
        assert row.accepted_at is not None and row.delivered_at is None
    result = pilot.client.post(
        f"{OUTGOING}/{identity}/status",
        headers=INTERNAL,
        json={
            "provider_message_id": "real-after-unlink",
            "provider_status": "delivered",
        },
    )
    assert result.status_code == 200 and result.json()["status"] == "delivered"
    assert pilot.status().json()["links"][0]["active"] is False
    assert claim(pilot.client) == []


def test_future_provider_timestamp_and_peer_identity_change_are_rejected(pilot, engine):
    future = pilot.envelope("STOP", created_at=(now() + timedelta(hours=1)).isoformat())
    response = pilot.client.post(INBOUND, headers=INTERNAL, json=future)
    assert response.status_code == 422, response.text
    pilot.send("HELP")
    changed_peer = pilot.envelope("HELP", peer_id="different-resident")
    assert (
        pilot.client.post(INBOUND, headers=INTERNAL, json=changed_peer).status_code
        == 403
    )
    with Session(engine) as db:
        assert db.scalar(select(func.count()).select_from(MessagingInbound)) == 1


def test_late_stop_cannot_undo_a_more_recent_start(pilot):
    pilot.link()
    earlier = now() - timedelta(seconds=5)
    pilot.send("STOP", created_at=earlier.isoformat())
    pilot.send("START")
    stale = pilot.send("STOP", created_at=(earlier + timedelta(seconds=1)).isoformat())
    assert stale["status"] == "stale"
    assert pilot.status().json()["links"][0]["paused"] is False


def test_implicit_messages_do_not_renew_the_explicit_report_selection_window(
    pilot, engine
):
    pilot.link(0)
    pilot.link(1)
    reference = pilot.reports[0]["report"]["public_reference"]
    pilot.send(reference)
    with Session(engine) as db:
        thread = db.scalar(select(MessagingThread))
        expiry = now() + timedelta(seconds=30)
        thread.selection_expires_at = expiry
        db.commit()
    assert pilot.send("What is the current status?")["status"] == "queued"
    with Session(engine) as db:
        thread = db.scalar(select(MessagingThread))
        assert thread.selection_expires_at == expiry
        thread.selection_expires_at = now() - timedelta(seconds=1)
        db.commit()
    assert pilot.send("And when will someone come?")["status"] == "awaiting_selection"


@pytest.mark.parametrize("resume", ["start", "relink"])
def test_cancelled_followup_cannot_resume_after_start_or_relink(pilot, engine, resume):
    from api.followup_ai import FollowupIntent
    from api.pilot_worker import process_followup

    class Counter:
        calls = 0

        def interpret(self, text, context):
            self.calls += 1
            return FollowupIntent(kind="status")

    pilot.link()
    queued = pilot.send("Please process only while I am linked and opted in")
    if resume == "start":
        pilot.send("STOP")
        pilot.send("START")
    else:
        link = pilot.status().json()["links"][0]
        created = pilot.reports[0]
        path = f"/reports/{created['report']['id']}/messaging-links/{link['id']}/unlink"
        assert (
            pilot.client.post(
                path, headers=auth(created["access_token"]), json={}
            ).status_code
            == 204
        )
        pilot.link()  # A new code grants fresh consent, not permission to replay old input.
    counter = Counter()
    for _ in range(2):
        if not process_followup(engine, pilot.client.app.state.settings, counter):
            break
    assert counter.calls == 0
    with Session(engine) as db:
        assert db.get(MessagingInbound, UUID(queued["id"])).status == "cancelled"
        assert (
            db.get(
                MessagingPilot, pilot.client.app.state.settings.messaging_pilot_id
            ).followup_calls
            == 0
        )


def test_twenty_interleaved_messages_remain_bound_and_private_across_report_navigation(
    pilot, engine
):
    pilot.link(0)
    pilot.link(1)
    expected = {item["report"]["id"]: [] for item in pilot.reports}
    inbound_ids = {}
    for number in range(20):
        index = number % 2
        created = pilot.reports[index]
        text = f"{created['report']['public_reference']} Private report {index} message {number:02}"
        result = pilot.send(text)
        assert result["status"] == "queued"
        expected[created["report"]["id"]].append(text)
        inbound_ids[result["id"]] = created["report"]["id"]
    # Selecting another report never rewrites an already queued action's target.
    pilot.send(pilot.reports[0]["report"]["public_reference"])
    with Session(engine) as db:
        for identity, report_id in inbound_ids.items():
            assert db.get(MessagingInbound, UUID(identity)).report_id == UUID(report_id)
    for created in pilot.reports:
        collected = []
        for offset in (0, 7):
            response = pilot.client.get(
                f"/reports/{created['report']['id']}/messages?limit=7&offset={offset}",
                headers=auth(created["access_token"]),
            )
            assert response.status_code == 200
            assert response.json()["total"] == 10
            collected.extend(item["body"] for item in response.json()["items"])
            assert "private-pilot-chat" not in response.text
        assert collected == expected[created["report"]["id"]]


def test_new_status_supersedes_a_leased_but_not_submitted_status(pilot, engine):
    from api.models import Crew, Job
    from api.services import event

    pilot.link()
    with Session(engine) as db:
        for message in db.scalars(select(MessagingOutgoing)):
            message.status = "cancelled"
        row = db.get(Report, UUID(pilot.reports[0]["report"]["id"]))
        job = Job(
            status="assigned",
            assigned_crew_id=db.scalar(select(Crew.id)),
            location=row.location,
            category="mixed",
            required_equipment=[],
            estimated_service_minutes=5,
        )
        db.add(job)
        db.flush()
        row.job_id, row.state = job.id, "linked_to_job"
        event(db, "job.planned", job_id=job.id)
        db.commit()
        job_id = job.id
    original = claim(pilot.client)[0]
    assert "assigned" in original["text"]
    with Session(engine) as db:
        db.get(Job, job_id).status = "in_progress"
        event(db, "job.changed", job_id=job_id)
        db.commit()
    assert operation(pilot.client, original, "sending").status_code == 409
    current = claim(pilot.client)[0]
    assert "in progress" in current["text"]


def test_completion_coalesces_obsolete_pending_status_and_preserves_direct_replies_and_rechecks(
    pilot, engine
):
    from api.models import Crew, Job
    from api.pilot import queue_text
    from api.services import event

    pilot.link()
    with Session(engine) as db:
        for message in db.scalars(select(MessagingOutgoing)):
            message.status = "cancelled"
        row = db.get(Report, UUID(pilot.reports[0]["report"]["id"]))
        conversation = db.scalar(select(Conversation))
        thread = db.get(MessagingThread, conversation.thread_id)
        queue_text(
            db, thread, "Your direct question was answered", conversation=conversation
        )
        job = Job(
            status="in_progress",
            assigned_crew_id=db.scalar(select(Crew.id)),
            location=row.location,
            category="mixed",
            required_equipment=[],
            estimated_service_minutes=5,
        )
        db.add(job)
        db.flush()
        row.job_id, row.state = job.id, "linked_to_job"
        event(db, "job.changed", job_id=job.id)
        job.status = "completed"
        event(db, "job.completed", job_id=job.id)
        job.status = "recheck_requested"
        event(db, "job.recheck_requested", job_id=job.id)
        db.commit()
    with Session(engine) as db:
        pending = list(
            db.scalars(
                select(MessagingOutgoing).where(MessagingOutgoing.status == "pending")
            )
        )
        assert {row.kind for row in pending} == {"reply", "completion", "recheck"}
        assert any(
            "crew reported cleanup complete" in row.text.lower() for row in pending
        )
        assert not any("submitted a photo" in row.text.lower() for row in pending)


def test_enrolling_a_migrated_thread_does_not_lease_its_old_legacy_outbox(
    pilot, engine
):
    from api.models import Event, OutgoingMessage
    from tests.backend.conftest import bind

    settings = pilot.client.app.state.settings
    settings.messaging_pilot_enabled = False
    legacy = bind(pilot.client, pilot.reports[0], external="private-pilot-chat")
    conversation_id = UUID(legacy["id"])
    with Session(engine) as db:
        conversation = db.get(Conversation, conversation_id)
        # Reproduce migration13's backfilled transport record: the existing
        # conversation UUID survives and the transport identity is not enrolled yet.
        thread = MessagingThread(
            id=conversation_id, channel="imessage", external_id=conversation.external_id
        )
        db.add(thread)
        db.flush()
        conversation.thread_id = thread.id
        record = db.scalar(
            select(Event).where(Event.report_id == conversation.report_id)
        )
        old = OutgoingMessage(
            event_id=record.id,
            conversation_id=conversation.id,
            payload={
                "kind": "report.received",
                "report_id": str(conversation.report_id),
            },
        )
        db.add(old)
        db.commit()
        identity = old.id
    settings.messaging_pilot_enabled = True
    pilot.send("HELP")  # Enroll the backfilled direct thread in the bounded pilot.
    response = pilot.client.post(
        "/internal/outgoing-messages/claim", headers=INTERNAL, json={}
    )
    assert response.status_code == 200 and response.json() == []
    with Session(engine) as db:
        old = db.get(OutgoingMessage, identity)
        assert old.attempts == 0 and old.lease_id is None and old.leased_until is None
        assert old.delivered_at is None
        assert db.get(Conversation, conversation_id).id == conversation_id
        assert (
            db.get(MessagingThread, conversation_id).pilot_id
            == settings.messaging_pilot_id
        )
        assert db.get(MessagingPilot, settings.messaging_pilot_id).send_attempts == 0


def test_new_qualified_question_discards_an_older_ambiguous_action(pilot, engine):
    pilot.link(0)
    pilot.link(1)
    with Session(engine) as db:
        thread = db.scalar(select(MessagingThread))
        thread.selected_link_id = thread.selection_expires_at = None
        db.commit()
    old = pilot.send("Request a recheck because the dumped bags are still here")
    assert old["status"] == "awaiting_selection"
    fresh = pilot.send(
        pilot.reports[1]["report"]["public_reference"] + " What is the status?"
    )
    assert fresh["status"] == "queued"
    selected = pilot.send(pilot.reports[0]["report"]["public_reference"])
    assert selected["status"] == "processed"
    with Session(engine) as db:
        assert db.get(MessagingInbound, UUID(old["id"])).status == "cancelled"
        thread = db.scalar(select(MessagingThread))
        assert thread.pending_inbound_id is None and thread.pending_text is None
        tasks = list(db.scalars(select(Task).where(Task.kind == "pilot_followup")))
        assert len(tasks) == 1 and tasks[0].payload["inbound_id"] == fresh["id"]
        assert db.get(MessagingInbound, UUID(selected["id"])).report_id is None


def test_enrolled_report_links_reject_legacy_mutation_entry_points(pilot, engine):
    code = pilot.link()
    link = pilot.status().json()["links"][0]
    response = pilot.client.post(
        "/internal/conversations/bind",
        headers=INTERNAL,
        json={
            "link_code": code["link_code"],
            "channel": "imessage",
            "external_id": "private-pilot-chat",
            "opted_in": True,
        },
    )
    assert response.status_code == 409
    command = {"command_id": str(uuid4()), "expected_version": 1}
    for name, payload in (
        ("followup", {"message_id": "legacy-bypass", "text": "What is the status?"}),
        ("clarification", {**command, "note": "Bypass the durable inbox"}),
        ("recheck", {**command, "reason": "Bypass the durable inbox"}),
    ):
        response = pilot.client.post(
            f"/internal/conversations/{link['id']}/{name}",
            headers=INTERNAL,
            json=payload,
        )
        assert response.status_code == 409, response.text
    with Session(engine) as db:
        assert (
            db.scalar(
                select(func.count()).select_from(Task).where(Task.kind == "followup")
            )
            == 0
        )
        assert db.get(Report, UUID(pilot.reports[0]["report"]["id"])).version == 1
