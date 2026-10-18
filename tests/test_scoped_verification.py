"""A report-scoped check must not lease other queue work or demo reports."""

from datetime import timedelta
from types import SimpleNamespace
from uuid import uuid4

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from api.config import Settings
from api.models import Photo, Report, Task, now
from api.services import enqueue
from api.worker import process_one
from scripts.verify_assessment import verify
from tests.test_assessment import assessment, assessment_db  # noqa: F401


def add_report(engine, *, illustrative=False):
    report_id, photo_id = uuid4(), uuid4()
    with Session(engine) as db:
        db.add(
            Report(
                id=report_id,
                photo_id=photo_id,
                token_hash="test",
                location={"latitude": 40.7, "longitude": -73.9},
                illustrative=illustrative,
            )
        )
        db.flush()
        db.add(
            Photo(
                id=photo_id,
                report_id=report_id,
                object_path=f"test/{photo_id}",
                content_type="image/png",
                size_bytes=20,
            )
        )
        task = enqueue(
            db, "assessment", f"assessment:{report_id}", {"report_id": str(report_id)}
        )
        db.commit()
        return report_id, task.id


def test_scoped_worker_ignores_older_demo_and_global_tasks(assessment_db):
    real_id, real_task = add_report(assessment_db)
    demo_id, demo_task = add_report(assessment_db, illustrative=True)
    with Session(assessment_db) as db:
        plan = enqueue(db, "plan", "unrelated-plan", {})
        db.commit()
        plan_id = plan.id
    calls = []
    model = SimpleNamespace(assess=lambda *args: (calls.append(1), assessment())[1])
    cloud = SimpleNamespace(signed_url=lambda path: "https://photo.invalid/image")
    assert process_one(
        assessment_db,
        None,
        cloud,
        model,
        report_scope=real_id,
        scoped_kind="assessment",
    )
    assert calls == [1]
    with Session(assessment_db) as db:
        assert db.get(Task, real_task).status == "succeeded"
        assert db.get(Task, demo_task).status == "pending"
        assert db.get(Task, demo_task).attempts == 0
        assert db.get(Task, plan_id).status == "pending"
        assert db.get(Task, plan_id).attempts == 0
        assert db.get(Report, demo_id).assessment_status == "pending"
    with pytest.raises(ValueError, match="real"):
        process_one(
            assessment_db,
            None,
            cloud,
            model,
            report_scope=demo_id,
            scoped_kind="assessment",
        )


def test_scoped_verification_runs_only_assessment_and_triage(
    assessment_db, monkeypatch
):
    real_id, _ = add_report(assessment_db)
    demo_id, demo_task = add_report(assessment_db, illustrative=True)
    calls = []

    class FakeAssessment:
        def __init__(self, settings):
            pass

        def assess(self, *args):
            calls.append(1)
            return assessment()

        def close(self):
            pass

    class FakeCloud:
        def __init__(self, settings):
            pass

        def signed_url(self, path):
            return "https://photo.invalid/image"

        def close(self):
            pass

    monkeypatch.setattr(
        "scripts.verify_assessment.ChalkAssessmentClient", FakeAssessment
    )
    monkeypatch.setattr("scripts.verify_assessment.SupabaseCloud", FakeCloud)
    settings = Settings(
        _env_file=None,
        chalk_router_api_key="test",
        chalk_env_id="test",
        chalk_model="test/model",
        supabase_url="https://storage.invalid",
        supabase_secret_key="test",
        organizer_routing_enabled=True,
    )
    result = verify(assessment_db, settings, real_id)
    assert result == {
        "assessment_status": "assessed",
        "priority": "routine",
        "needs_review": False,
        "report_state": "linked_to_job",
        "job_created": True,
        "triage": "succeeded",
        "unrelated_unchanged": True,
    }
    assert calls == [1]
    with Session(assessment_db) as db:
        assert db.get(Task, demo_task).status == "pending"
        assert db.get(Task, demo_task).attempts == 0
        assert db.get(Report, demo_id).assessment_status == "pending"
        plans = list(db.scalars(select(Task).where(Task.kind == "plan")))
        assert len(plans) == 1 and plans[0].status == "pending"
        assert plans[0].attempts == 0


def test_verification_refuses_pilot_before_provider_call(assessment_db):
    report_id, task_id = add_report(assessment_db)
    settings = Settings(
        _env_file=None,
        messaging_pilot_enabled=True,
        messaging_pilot_report_ids=[uuid4(), uuid4()],
    )
    with pytest.raises(ValueError, match="pilot"):
        verify(assessment_db, settings, report_id)
    with Session(assessment_db) as db:
        assert db.get(Task, task_id).attempts == 0


def test_scoped_worker_does_not_recover_interrupted_assessment(assessment_db):
    report_id, task_id = add_report(assessment_db)
    with Session(assessment_db) as db:
        task = db.get(Task, task_id)
        task.status = "running"
        task.attempts = 1
        task.lease_id = uuid4()
        task.leased_until = now() - timedelta(minutes=1)
        db.commit()
    calls = []
    model = SimpleNamespace(assess=lambda *args: calls.append(1))
    assert not process_one(
        assessment_db,
        None,
        SimpleNamespace(signed_url=lambda path: "https://photo.invalid/image"),
        model,
        report_scope=report_id,
        scoped_kind="assessment",
    )
    assert calls == []
    with Session(assessment_db) as db:
        task = db.get(Task, task_id)
        assert task.status == "running" and task.attempts == 1
        assert db.get(Report, report_id).assessment_status == "pending"
