"""Real PostgreSQL follow-up ordering, consent, limits and replay boundaries."""

from datetime import timedelta
from types import SimpleNamespace
from uuid import uuid4, uuid5

import httpx
import pytest
from sqlalchemy import select
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session

import api.pilot_worker as worker
from api.config import Settings
from api.followup_ai import FollowupIntent
from api.models import (
    Conversation,
    Crew,
    Event,
    Job,
    MessagingInbound,
    MessagingOutgoing,
    MessagingPilot,
    MessagingThread,
    Photo,
    Report,
    Task,
    now,
)


@pytest.fixture
def pilot_setup(engine):
    report_ids, thread_id, conversation_ids = (
        [uuid4(), uuid4()],
        uuid4(),
        [uuid4(), uuid4()],
    )
    settings = Settings(
        _env_file=None,
        messaging_pilot_enabled=True,
        messaging_pilot_id=uuid4(),
        messaging_pilot_report_ids=report_ids,
        messaging_pilot_chat_ids=["pilot-chat"],
        messaging_imessage_recipient="test-peer",
        photon_project_id="test-project",
        photon_agent_sender_id="test-agent",
        organizer_routing_enabled=True,
        duplicate_radius_meters=0,
    )
    with Session(engine) as db:
        db.add(
            MessagingPilot(
                id=settings.messaging_pilot_id,
                project_id=settings.photon_project_id,
                sender_id=settings.photon_agent_sender_id,
                report_ids=sorted(str(value) for value in report_ids),
                chat_ids=settings.messaging_pilot_chat_ids,
            )
        )
        db.add_all(
            [
                Report(
                    id=report_id,
                    photo_id=uuid4(),
                    token_hash="a" * 64,
                    note="Original immutable note",
                    location={"latitude": 24.92, "longitude": 67.09},
                    illustrative=False,
                )
                for report_id in report_ids
            ]
        )
        db.flush()
        db.add_all(
            [
                Photo(
                    id=db.get(Report, report_id).photo_id,
                    report_id=report_id,
                    object_path=f"pilot-test/{report_id}",
                    content_type="image/png",
                    size_bytes=100,
                )
                for report_id in report_ids
            ]
        )
        db.add(
            MessagingThread(
                id=thread_id,
                pilot_id=settings.messaging_pilot_id,
                channel="imessage",
                external_id="pilot-chat",
                project_id=settings.photon_project_id,
                sender_id=settings.photon_agent_sender_id,
                peer_id=settings.messaging_imessage_recipient,
            )
        )
        db.flush()
        db.add_all(
            [
                Conversation(
                    id=conversation_id,
                    report_id=report_id,
                    thread_id=thread_id,
                    channel="imessage",
                    external_id="pilot-chat",
                    active=True,
                )
                for report_id, conversation_id in zip(report_ids, conversation_ids)
            ]
        )
        db.commit()
    return SimpleNamespace(
        engine=engine,
        settings=settings,
        report_ids=report_ids,
        thread_id=thread_id,
        conversation_ids=conversation_ids,
    )


def inbound(pilot, text, *, report_index=0, **changes):
    with Session(pilot.engine) as db:
        value = MessagingInbound(
            id=uuid4(),
            thread_id=pilot.thread_id,
            project_id=pilot.settings.photon_project_id,
            provider_message_id=uuid4().hex,
            payload_hash="test-payload-hash",
            body=text,
            provider_created_at=now(),
            received_at=now(),
            conversation_id=pilot.conversation_ids[report_index],
            report_id=pilot.report_ids[report_index],
            consent_revision=1,
            status="queued",
        )
        for key, change in changes.items():
            setattr(value, key, change)
        db.add(value)
        task = Task(
            kind="pilot_followup",
            dedupe_key=f"pilot-test:{value.id}",
            payload={
                "inbound_id": str(value.id),
                "conversation_id": str(value.conversation_id),
                "thread_id": str(value.thread_id),
                "report_id": str(value.report_id),
            },
        )
        db.add(task)
        db.commit()
        return value.id, task.id


def client(raw, callback=None):
    calls = []

    def interpret(text, context):
        calls.append((text, context))
        if callback:
            callback()
        if isinstance(raw, Exception):
            raise raw
        return FollowupIntent.model_validate(raw)

    return SimpleNamespace(interpret=interpret), calls


def outputs(db):
    return list(
        db.scalars(select(MessagingOutgoing).order_by(MessagingOutgoing.created_at))
    )


def test_status_is_scoped_frozen_and_has_no_mutation(pilot_setup):
    pilot = pilot_setup
    message_id, task_id = inbound(pilot, "How is my report doing?")
    model, calls = client({"kind": "status"})
    assert worker.process_followup(pilot.engine, pilot.settings, model)
    assert not worker.process_followup(pilot.engine, pilot.settings, model)
    assert len(calls) == 1
    with Session(pilot.engine) as db:
        report = db.get(Report, pilot.report_ids[0])
        message = db.get(MessagingInbound, message_id)
        assert report.version == 1 and not report.clarifications
        assert message.status == "processed" and message.model_attempted
        assert message.interpretation["report_version"] == 1
        assert db.get(Task, task_id).status == "succeeded"
        assert (
            db.get(MessagingPilot, pilot.settings.messaging_pilot_id).followup_calls
            == 1
        )
        assert (
            outputs(db)[0].text
            == f"{report.public_reference}: Your report has been received."
        )
        assert outputs(db)[0].conversation_id == pilot.conversation_ids[0]
        assert calls[0][1]["report"]["public_reference"] == report.public_reference
        assert "note" not in calls[0][1]["report"]


def test_claim_appends_unverified_evidence_and_preserves_original_assessment(
    pilot_setup,
):
    pilot = pilot_setup
    evidence = {"description": "Original visual evidence"}
    with Session(pilot.engine) as db:
        report = db.get(Report, pilot.report_ids[0])
        report.assessment, report.assessment_status = evidence, "assessed"
        report.priority = "high"
        report.organizer_review_required = True
        db.commit()
    message_id, _ = inbound(pilot, "There are broken bottles near the entrance.")
    model, calls = client(
        {"kind": "clarification", "note": "broken bottles near the entrance"}
    )
    assert worker.process_followup(pilot.engine, pilot.settings, model)
    with Session(pilot.engine) as db:
        report = db.get(Report, pilot.report_ids[0])
        assert report.needs_review and report.organizer_review_required
        assert report.state == "needs_review" and report.priority == "high"
        assert (
            report.note == "Original immutable note" and report.assessment == evidence
        )
        assert report.clarifications[0]["note"] == "broken bottles near the entrance"
        assert db.scalar(
            select(Event).where(Event.command_id == uuid5(message_id, "action"))
        )
        assert db.scalar(select(Task).where(Task.kind == "triage")) is None
        assert "recorded for organizer review" in outputs(db)[-1].text
    assert len(calls) == 1


def test_explicit_gps_can_resume_triage_without_reassessment(pilot_setup):
    pilot = pilot_setup
    with Session(pilot.engine) as db:
        report = db.get(Report, pilot.report_ids[0])
        report.location, report.state, report.assessment_status = (
            None,
            "needs_info",
            "assessed",
        )
        db.commit()
    inbound(pilot, "lat: 24.93 lon: 67.11")
    model, _ = client(
        {"kind": "clarification", "location": {"latitude": 24.93, "longitude": 67.11}}
    )
    assert worker.process_followup(pilot.engine, pilot.settings, model)
    with Session(pilot.engine) as db:
        report = db.get(Report, pilot.report_ids[0])
        assert report.location["latitude"] == 24.93 and not report.needs_review
        assert db.scalar(select(Task).where(Task.kind == "triage")) is not None
        assert db.scalar(select(Task).where(Task.kind == "assessment")) is None


def completed_job(pilot):
    with Session(pilot.engine) as db:
        crew = Crew(
            name="Pilot test crew",
            equipment=["gloves"],
            shift_minutes=120,
            start_location={"latitude": 24.92, "longitude": 67.09},
        )
        db.add(crew)
        db.flush()
        job = Job(
            status="completed",
            location={"latitude": 24.92, "longitude": 67.09},
            category="mixed_waste",
            required_equipment=["gloves"],
            estimated_service_minutes=5,
            assigned_crew_id=crew.id,
            route_position=0,
        )
        db.add(job)
        db.flush()
        report = db.get(Report, pilot.report_ids[0])
        report.job_id, report.state = job.id, "linked_to_job"
        db.commit()
        return job.id


def test_recheck_uses_server_command_and_completed_job_version(pilot_setup):
    pilot = pilot_setup
    job_id = completed_job(pilot)
    message_id, _ = inbound(pilot, "Please revisit; the rubbish is still there.")
    model, _ = client({"kind": "recheck", "reason": "the rubbish is still there"})
    assert worker.process_followup(pilot.engine, pilot.settings, model)
    with Session(pilot.engine) as db:
        assert db.get(Job, job_id).status == "recheck_requested"
        event = db.scalar(
            select(Event).where(Event.command_id == uuid5(message_id, "action"))
        )
        assert event.kind == "job.recheck_requested"
        assert event.details["reason"] == "the rubbish is still there"
        assert "recheck request was recorded" in outputs(db)[-1].text


@pytest.mark.parametrize("kind", ["clarification", "recheck"])
def test_inapplicable_actions_do_not_claim_success(pilot_setup, kind):
    pilot = pilot_setup
    if kind == "clarification":
        completed_job(pilot)
        raw = {"kind": kind, "note": "more bottles"}
    else:
        raw = {"kind": kind, "reason": "more bottles"}
    inbound(pilot, "Please check more bottles")
    model, _ = client(raw)
    assert worker.process_followup(pilot.engine, pilot.settings, model)
    with Session(pilot.engine) as db:
        assert not db.get(Report, pilot.report_ids[0]).clarifications
        assert "was recorded" not in outputs(db)[-1].text


@pytest.mark.parametrize(
    "raw",
    [
        httpx.ReadTimeout("must not leak provider details"),
        {"kind": "status", "role": "admin"},
    ],
)
def test_failed_interpretation_is_terminal_and_never_retried(pilot_setup, raw):
    pilot = pilot_setup
    message_id, task_id = inbound(pilot, "What is happening?")
    model, calls = client(raw)
    assert worker.process_followup(pilot.engine, pilot.settings, model)
    assert not worker.process_followup(pilot.engine, pilot.settings, model)
    with Session(pilot.engine) as db:
        assert db.get(Task, task_id).status == "failed"
        assert db.get(MessagingInbound, message_id).status == "failed"
        assert "No change was made" in outputs(db)[0].text
        assert "provider details" not in outputs(db)[0].text
    assert len(calls) == 1


def test_persisted_call_budget_prevents_thirteenth_call(pilot_setup):
    pilot = pilot_setup
    inbound(pilot, "What is happening?")
    with Session(pilot.engine) as db:
        db.get(MessagingPilot, pilot.settings.messaging_pilot_id).followup_calls = 12
        db.commit()
    model, calls = client({"kind": "status"})
    assert worker.process_followup(pilot.engine, pilot.settings, model)
    assert not calls
    with Session(pilot.engine) as db:
        assert "pilot message limit" in outputs(db)[0].text
        assert (
            db.get(MessagingPilot, pilot.settings.messaging_pilot_id).followup_calls
            == 12
        )


@pytest.mark.parametrize("saved", [False, True])
def test_expired_attempt_never_calls_model_twice(pilot_setup, saved):
    pilot = pilot_setup
    message_id, task_id = inbound(pilot, "What is happening?", model_attempted=True)
    with Session(pilot.engine) as db:
        task = db.get(Task, task_id)
        task.status, task.lease_id = "running", uuid4()
        task.leased_until = now() - timedelta(seconds=1)
        message = db.get(MessagingInbound, message_id)
        message.status = "running"
        if saved:
            message.interpretation = {
                "intent": {"kind": "status"},
                "report_version": 1,
                "job_id": None,
                "job_version": None,
            }
        db.commit()
    model, calls = client({"kind": "status"})
    assert worker.process_followup(pilot.engine, pilot.settings, model)
    assert not calls
    with Session(pilot.engine) as db:
        assert db.get(Task, task_id).status == ("succeeded" if saved else "failed")
        assert (
            "No change was made" in outputs(db)[0].text
            if not saved
            else "received" in outputs(db)[0].text
        )


@pytest.mark.parametrize("resumed", [False, True])
def test_stop_during_model_call_cancels_without_reply_or_action(pilot_setup, resumed):
    pilot = pilot_setup
    message_id, task_id = inbound(pilot, "There are more bottles.")

    def stop():
        with Session(pilot.engine) as db:
            thread = db.get(MessagingThread, pilot.thread_id)
            thread.paused, thread.consent_revision = not resumed, 3 if resumed else 2
            db.commit()

    model, calls = client({"kind": "clarification", "note": "more bottles"}, stop)
    assert worker.process_followup(pilot.engine, pilot.settings, model)
    assert len(calls) == 1
    with Session(pilot.engine) as db:
        assert db.get(MessagingInbound, message_id).status == "cancelled"
        assert db.get(Task, task_id).result["skipped"] == "consent_changed"
        assert not db.get(Report, pilot.report_ids[0]).clarifications
        assert not outputs(db)


def test_changed_report_version_prevents_stale_write(pilot_setup):
    pilot = pilot_setup
    inbound(pilot, "There are more bottles.")

    def changed():
        with Session(pilot.engine) as db:
            db.get(Report, pilot.report_ids[0]).version += 1
            db.commit()

    model, _ = client({"kind": "clarification", "note": "more bottles"}, changed)
    assert worker.process_followup(pilot.engine, pilot.settings, model)
    with Session(pilot.engine) as db:
        assert not db.get(Report, pilot.report_ids[0]).clarifications
        assert "report changed" in outputs(db)[0].text


def test_later_chat_item_cannot_overtake_running_predecessor(pilot_setup):
    pilot = pilot_setup
    first, first_task = inbound(pilot, "What is the first report doing?")
    second, _ = inbound(pilot, "What is the second report doing?", report_index=1)
    with Session(pilot.engine) as db:
        task = db.get(Task, first_task)
        task.status, task.lease_id = "running", uuid4()
        task.leased_until = now() + timedelta(minutes=1)
        db.get(MessagingInbound, first).status = "running"
        db.commit()
    model, calls = client({"kind": "status"})
    assert not worker.process_followup(pilot.engine, pilot.settings, model)
    assert not calls
    with Session(pilot.engine) as db:
        assert not db.get(MessagingInbound, second).model_attempted


@pytest.mark.parametrize("expired", [False, True])
def test_out_of_scope_tasks_are_untouched_even_when_expired(pilot_setup, expired):
    pilot = pilot_setup
    message_id, task_id = inbound(pilot, "What is happening?")
    with Session(pilot.engine) as db:
        db.get(MessagingThread, pilot.thread_id).external_id = "unapproved-chat"
        if expired:
            task = db.get(Task, task_id)
            task.status, task.lease_id = "running", uuid4()
            task.leased_until = now() - timedelta(minutes=1)
            db.get(MessagingInbound, message_id).model_attempted = True
        db.commit()
    model, calls = client({"kind": "status"})
    assert not worker.process_followup(pilot.engine, pilot.settings, model)
    assert not calls
    with Session(pilot.engine) as db:
        assert db.get(Task, task_id).attempts == 0
        assert not outputs(db)


def test_database_failure_reuses_saved_interpretation(pilot_setup, monkeypatch):
    pilot = pilot_setup
    message_id, task_id = inbound(pilot, "There are more bottles.")
    model, calls = client({"kind": "clarification", "note": "more bottles"})
    original = worker.queue_text

    def failed_queue(*args, **kwargs):
        raise OperationalError("test-only", {}, Exception("database unavailable"))

    monkeypatch.setattr(worker, "queue_text", failed_queue)
    assert worker.process_followup(pilot.engine, pilot.settings, model)
    with Session(pilot.engine) as db:
        assert db.get(MessagingInbound, message_id).interpretation is not None
        assert not db.get(Report, pilot.report_ids[0]).clarifications
        assert not outputs(db)
        db.get(Task, task_id).leased_until = now() - timedelta(seconds=1)
        db.commit()
    monkeypatch.setattr(worker, "queue_text", original)
    assert worker.process_followup(pilot.engine, pilot.settings, model)
    assert len(calls) == 1
    with Session(pilot.engine) as db:
        assert len(db.get(Report, pilot.report_ids[0]).clarifications) == 1
        assert db.get(Task, task_id).status == "succeeded"


def test_changed_active_selection_does_not_retarget_queued_message(pilot_setup):
    pilot = pilot_setup
    inbound(pilot, "How is my report doing?")
    with Session(pilot.engine) as db:
        db.get(MessagingThread, pilot.thread_id).selected_link_id = (
            pilot.conversation_ids[1]
        )
        db.commit()
    model, _ = client({"kind": "status"})
    assert worker.process_followup(pilot.engine, pilot.settings, model)
    with Session(pilot.engine) as db:
        assert outputs(db)[0].conversation_id == pilot.conversation_ids[0]


@pytest.mark.parametrize("during_inference", [False, True])
def test_unlink_then_relink_cannot_revive_cancelled_inbound(
    pilot_setup, during_inference
):
    pilot = pilot_setup
    message_id, task_id = inbound(pilot, "There are more bottles.")

    def unlink_and_relink():
        with Session(pilot.engine) as db:
            # Relinking can reactivate a report without resuming old cancelled work.
            conversation = db.get(Conversation, pilot.conversation_ids[0])
            conversation.active = True
            db.get(MessagingInbound, message_id).status = "cancelled"
            db.commit()

    if not during_inference:
        unlink_and_relink()
    model, calls = client(
        {"kind": "clarification", "note": "more bottles"},
        unlink_and_relink if during_inference else None,
    )
    assert worker.process_followup(pilot.engine, pilot.settings, model)
    assert len(calls) == (1 if during_inference else 0)
    with Session(pilot.engine) as db:
        assert db.get(Task, task_id).result["skipped"] == "consent_changed"
        assert db.get(MessagingInbound, message_id).status == "cancelled"
        assert not db.get(Report, pilot.report_ids[0]).clarifications
        assert not outputs(db)


def test_unconfigured_client_preserves_queued_work(pilot_setup):
    pilot = pilot_setup
    message_id, task_id = inbound(pilot, "How is my report doing?")
    assert not worker.process_followup(pilot.engine, pilot.settings, None)
    with Session(pilot.engine) as db:
        assert db.get(Task, task_id).attempts == 0
        assert not db.get(MessagingInbound, message_id).model_attempted
