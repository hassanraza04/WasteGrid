from datetime import timedelta
from uuid import uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session

from api.assessment_demo import DemoRefused
from api.models import AssessmentDemoRun, now
from scripts.extend_assessment_demo import extend


def exhausted(engine):
    run_id = uuid4()
    at = now() - timedelta(minutes=2)
    with Session(engine) as db:
        db.add(
            AssessmentDemoRun(
                id=run_id,
                scope_key="organizer-demo-v1",
                status="closed",
                reason="attempt_limit",
                report_ids=[str(uuid4()), str(uuid4())],
                revision="a" * 40,
                model="xai/grok-4.3",
                starts_at=at,
                current_window_started_at=at,
                expires_at=at + timedelta(minutes=60),
                used_attempts=4,
                new_reports_admitted=2,
            )
        )
        db.commit()
    return run_id


def test_explicit_grant_preserves_consumption_and_is_idempotent(engine):
    run_id, command = exhausted(engine), uuid4()
    result = extend(
        engine,
        run_id,
        command,
        5,
        5,
        "b" * 40,
        "User requested more recording attempts",
    )
    assert result["status"] == "active"
    assert (result["used_attempts"], result["max_attempts"]) == (4, 9)
    assert (result["new_reports_admitted"], result["max_new_reports"]) == (2, 7)
    assert result["expires_at"] > now() + timedelta(minutes=59)
    replay = extend(
        engine,
        run_id,
        command,
        5,
        5,
        "b" * 40,
        "User requested more recording attempts",
    )
    assert replay["max_attempts"] == 9
    with engine.connect() as c:
        assert (
            c.scalar(
                text("select count(*) from wastegrid.assessment_demo_capacity_grants")
            )
            == 1
        )
    with pytest.raises(DemoRefused):
        extend(
            engine,
            run_id,
            command,
            6,
            5,
            "b" * 40,
            "User requested more recording attempts",
        )
    with pytest.raises(DBAPIError):
        with engine.begin() as c:
            c.execute(text("update wastegrid.assessment_demo_runs set used_attempts=0"))
    with pytest.raises(DBAPIError):
        with engine.begin() as c:
            c.execute(text("delete from wastegrid.assessment_demo_capacity_grants"))


def test_capacity_cannot_increase_without_an_audit_grant(engine):
    exhausted(engine)
    with pytest.raises(DBAPIError):
        with engine.begin() as c:
            c.execute(text("update wastegrid.assessment_demo_runs set max_attempts=9"))
