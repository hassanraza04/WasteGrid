"""Real database canary scope and single-attempt photo budget regression tests."""

from datetime import timedelta
from types import SimpleNamespace
from uuid import uuid4

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from api.config import Settings
from api.db import mutation_lock
from api.models import MessagingPilot, Photo, Report, Task, now
from api.schemas import WasteAssessment
from api.worker import process_one


@pytest.fixture
def assessment_pilot(engine):
    report_ids = [uuid4(), uuid4(), uuid4()]
    settings = Settings(
        _env_file=None,
        messaging_pilot_enabled=True,
        messaging_pilot_id=uuid4(),
        messaging_pilot_report_ids=report_ids[:2],
        messaging_pilot_chat_ids=["test-pilot-chat"],
        messaging_imessage_recipient="test-peer",
        photon_project_id="test-project",
        photon_agent_sender_id="test-sender",
        organizer_routing_enabled=True,
    )
    with Session(engine) as db:
        for report_id in report_ids:
            photo_id = uuid4()
            db.add(
                Report(
                    id=report_id,
                    photo_id=photo_id,
                    token_hash="b" * 64,
                    location={"latitude": 24.92, "longitude": 67.09},
                )
            )
            db.flush()
            db.add(
                Photo(
                    id=photo_id,
                    report_id=report_id,
                    object_path=f"pilot-assessment-test/{photo_id}",
                    content_type="image/png",
                    size_bytes=100,
                )
            )
        db.commit()
    return SimpleNamespace(engine=engine, settings=settings, report_ids=report_ids)


def task_for(pilot, report_id, *, expired=False, kind="assessment", key=None):
    with Session(pilot.engine) as db:
        task = Task(
            kind=kind,
            dedupe_key=key or f"{kind}:{report_id}",
            payload={"report_id": str(report_id)},
            status="running" if expired else "pending",
            attempts=1 if expired else 0,
            lease_id=uuid4() if expired else None,
            leased_until=now() - timedelta(minutes=1) if expired else None,
        )
        db.add(task)
        db.commit()
        return task.id


def model(callback=None):
    calls = []

    def assess(*arguments):
        calls.append(arguments)
        if callback:
            callback()
        return WasteAssessment(
            description="Mixed bags beside a wall",
            size="medium",
            obstruction="none_visible",
            obstruction_level="none",
            forces_people_into_traffic="no",
            special_handling="none_identified",
            reason="No visible obstruction or special handling concern.",
            visible_fire="no",
            visible_sharp_objects="no",
            confidence=0.8,
            resident_context_agreement="not_provided",
            comparison_reason="No resident claims were provided.",
        )

    return SimpleNamespace(assess=assess), calls


def process(pilot, assessment_client):
    return process_one(
        pilot.engine,
        None,
        SimpleNamespace(signed_url=lambda path: "https://photo.test.invalid/private"),
        assessment_client,
        organizer_routing=True,
        pilot_settings=pilot.settings,
    )


@pytest.mark.parametrize("expired", [False, True])
def test_unrelated_photo_task_is_not_leased_or_recovered(assessment_pilot, expired):
    pilot = assessment_pilot
    task_id = task_for(pilot, pilot.report_ids[2], expired=expired)
    assessment_client, calls = model()
    with Session(pilot.engine) as db:
        task = db.get(Task, task_id)
        before = (task.status, task.attempts, task.lease_id, task.leased_until)
    assert not process(pilot, assessment_client)
    assert not calls
    with Session(pilot.engine) as db:
        task = db.get(Task, task_id)
        assert (task.status, task.attempts, task.lease_id, task.leased_until) == before
        assert db.get(Report, pilot.report_ids[2]).assessment_status == "pending"
        assert db.get(MessagingPilot, pilot.settings.messaging_pilot_id) is None


def test_two_image_budget_survives_new_client_and_settings_instance(assessment_pilot):
    pilot = assessment_pilot
    first = task_for(pilot, pilot.report_ids[0])
    second = task_for(pilot, pilot.report_ids[1])
    assessment_client, first_calls = model()
    assert process(pilot, assessment_client)
    pilot.settings = pilot.settings.model_copy()
    restarted_client, second_calls = model()
    assert process(pilot, restarted_client)
    assert len(first_calls) == len(second_calls) == 1
    with Session(pilot.engine) as db:
        assert db.get(Task, first).status == db.get(Task, second).status == "succeeded"
        assert (
            db.get(MessagingPilot, pilot.settings.messaging_pilot_id).image_calls == 2
        )
        # A duplicate/errant queued assessment must not bypass the persisted cap.
        third = Task(
            kind="assessment",
            dedupe_key="test-extra-assessment",
            payload={"report_id": str(pilot.report_ids[0])},
            created_at=now() - timedelta(days=1),
        )
        db.add(third)
        db.commit()
        third_id = third.id
    assert not process(pilot, restarted_client)
    assert len(second_calls) == 1
    with Session(pilot.engine) as db:
        assert db.get(Task, third_id).status == "pending"
        assert db.get(Task, third_id).attempts == 0
        assert (
            db.get(MessagingPilot, pilot.settings.messaging_pilot_id).image_calls == 2
        )


def test_global_planning_is_left_queued_in_pilot_mode(assessment_pilot):
    pilot = assessment_pilot
    task_id = task_for(pilot, pilot.report_ids[0], kind="plan")
    assessment_client, calls = model()
    assert not process(pilot, assessment_client)
    assert not calls
    with Session(pilot.engine) as db:
        task = db.get(Task, task_id)
        assert task.status == "pending" and task.attempts == 0
        assert task.result is None and task.lease_id is None


def test_late_photo_result_preserves_new_resident_review_hold(assessment_pilot):
    pilot = assessment_pilot
    report_id = pilot.report_ids[0]
    task_for(pilot, report_id)

    def new_claim():
        with Session(pilot.engine) as db:
            mutation_lock(db)
            report = db.get(Report, report_id)
            report.needs_review, report.state = True, "needs_review"
            report.clarifications = [
                {
                    "note": "Resident reported additional sharp objects",
                    "location": None,
                    "created_at": now().isoformat(),
                }
            ]
            report.version += 1
            db.commit()

    assessment_client, calls = model(new_claim)
    assert process(pilot, assessment_client)
    assert len(calls) == 1
    with Session(pilot.engine) as db:
        report = db.get(Report, report_id)
        assert report.assessment_status == "needs_review" and report.needs_review
        assert report.state == "needs_review" and report.priority == "routine"
        assert report.assessment["visible_sharp_objects"] == "no"
        assert (
            report.clarifications[0]["note"]
            == "Resident reported additional sharp objects"
        )
        assert db.scalar(select(Task).where(Task.kind == "triage")) is None


def test_expired_scoped_attempt_fails_without_another_image_call(assessment_pilot):
    pilot = assessment_pilot
    task_id = task_for(pilot, pilot.report_ids[0], expired=True)
    assessment_client, calls = model()
    assert process(pilot, assessment_client)
    assert not calls
    with Session(pilot.engine) as db:
        assert db.get(Task, task_id).last_error == "assessment_interrupted"
        assert db.get(Report, pilot.report_ids[0]).needs_review
