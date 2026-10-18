"""Verify PR review findings against persisted messaging behavior."""

from datetime import timedelta
from types import SimpleNamespace
from uuid import UUID

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from api.followup_ai import FollowupIntent
from api.models import (
    Conversation,
    Job,
    MessagingInbound,
    MessagingOutgoing,
    MessagingThread,
    Report,
    Task,
    now,
)
from api.pilot_worker import process_followup
from tests.backend import test_pilot_api

pilot = test_pilot_api.pilot


@pytest.mark.parametrize("channel", ["telegram", "whatsapp", "sms"])
def test_messaging_status_excludes_legacy_channels(pilot, engine, channel):
    pilot.link()
    imessage_link = pilot.status().json()["links"][0]
    with Session(engine) as db:
        thread = MessagingThread(channel=channel, external_id="legacy-chat")
        db.add(thread)
        db.flush()
        db.add(
            Conversation(
                report_id=UUID(pilot.reports[0]["report"]["id"]),
                channel=channel,
                external_id=thread.external_id,
                thread_id=thread.id,
            )
        )
        db.commit()

    response = pilot.status()
    assert response.status_code == 200, response.text
    assert response.json()["links"] == [imessage_link]


def test_late_inputs_cannot_move_the_thread_watermark_backwards(pilot, engine):
    pilot.link()
    latest = now() - timedelta(seconds=5)
    first = pilot.send("What is the status?", created_at=latest.isoformat())
    assert first["status"] == "queued"

    for seconds in (10, 5):
        stale = pilot.send(
            "Please check again.",
            created_at=(latest - timedelta(seconds=seconds)).isoformat(),
        )
        assert stale["status"] == "stale"
        with Session(engine) as db:
            assert db.scalar(select(MessagingThread)).last_input_at == latest
            tasks = db.scalars(select(Task).where(Task.kind == "pilot_followup")).all()
            assert len(tasks) == 1
            assert tasks[0].payload["inbound_id"] == first["id"]


@pytest.mark.parametrize(
    "job_status,held,review_flag,expected",
    [
        ("completed", False, None, "The crew reported cleanup complete."),
        ("blocked", True, None, "Cleanup is blocked and needs attention."),
        ("completed", False, "needs_review", "Your report needs organizer review."),
        (
            "completed",
            False,
            "organizer_review_required",
            "Your report needs organizer review.",
        ),
    ],
)
def test_status_followup_preserves_persisted_job_and_review_precedence(
    pilot, engine, seeded, job_status, held, review_flag, expected
):
    pilot.link()
    with Session(engine) as db:
        report = db.get(Report, UUID(pilot.reports[0]["report"]["id"]))
        job = Job(
            status=job_status,
            held=held,
            location=report.location,
            category="litter",
            required_equipment=[],
            estimated_service_minutes=10,
            assigned_crew_id=seeded["crew_a"],
        )
        db.add(job)
        db.flush()
        report.job_id = job.id
        report.state = "linked_to_job"
        if review_flag:
            setattr(report, review_flag, True)
        db.commit()

    queued = pilot.send("What is the current status?")
    model = SimpleNamespace(interpret=lambda *_: FollowupIntent(kind="status"))
    assert process_followup(engine, pilot.client.app.state.settings, model)

    with Session(engine) as db:
        inbound = db.get(MessagingInbound, UUID(queued["id"]))
        reply = db.scalar(
            select(MessagingOutgoing).where(MessagingOutgoing.kind == "reply")
        )
        assert inbound.status == "processed"
        reference = pilot.reports[0]["report"]["public_reference"]
        assert reply.text == f"{reference}: {expected}"
        assert (
            db.get(Job, db.get(Report, inbound.report_id).job_id).status == job_status
        )
