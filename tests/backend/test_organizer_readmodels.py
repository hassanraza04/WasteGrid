"""Read-model truthfulness over real PostgreSQL, never provider/model calls."""

from datetime import datetime, timedelta
from uuid import UUID, uuid4

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from api.models import Crew, Event, Job, Photo, Report, Task, now
from api.organizer import report_processing
from tests.backend.conftest import auth
from tests.test_assessment import assessment


@pytest.fixture
def reads(client):
    return client


def seed_job(db, *, status="unassigned", illustrative=False, **changes):
    if status == "unassigned" and changes.get("assigned_crew_id"):
        status = "assigned"
    if status in ("assigned", "in_progress", "completed") and not changes.get(
        "assigned_crew_id"
    ):
        changes["assigned_crew_id"] = db.scalar(
            select(Crew.id).order_by(Crew.id).limit(1)
        )
    job = Job(
        status=status,
        illustrative=illustrative,
        location={"latitude": 24.92, "longitude": 67.09},
        category="litter",
        required_equipment=["gloves", "trash_bags"],
        estimated_service_minutes=5,
        **changes,
    )
    db.add(job)
    db.flush()
    return job


def seed_report(db, *, job=None, illustrative=False, **changes):
    values = dict(
        photo_id=uuid4(),
        token_hash="0" * 64,
        title="PRIVATE resident caption stays in evidence",
        note="PRIVATE resident narrative",
        address="Park gate",
        job_id=job.id if job else None,
        state="linked_to_job" if job else "received",
        assessment_status="assessed" if job else "pending",
        assessment=assessment().model_dump() if job else None,
        priority="routine" if job else None,
        illustrative=illustrative,
    )
    row = Report(**{**values, **changes})
    db.add(row)
    db.flush()
    db.add(
        Photo(
            id=row.photo_id,
            report_id=row.id,
            object_path=str(row.photo_id),
            content_type="image/png",
            size_bytes=10,
        )
    )
    db.flush()
    return row


def get(reads, path, **query):
    result = reads.get(path, params=query, headers=auth("org"))
    assert result.status_code == 200, result.text
    return result.json()


def test_index_auth_lean_evidence_and_illustrative_separation(reads, engine):
    with Session(engine) as db:
        real = seed_report(db)
        fake = seed_report(db, illustrative=True)
        reference, real_id, fake_id = real.public_reference, str(real.id), str(fake.id)
        db.commit()
    for path in (
        "/organizer/report-index",
        "/organizer/job-index",
        "/organizer/overview",
    ):
        assert reads.get(path).status_code == 401
        assert reads.get(path, headers=auth("a")).status_code == 403
        assert reads.get(path, headers=auth("outsider")).status_code == 403
    result = get(reads, "/organizer/report-index")
    assert result["total"] == 1
    assert result["items"][0]["id"] == real_id
    assert result["items"][0]["title"] == "Cleanup report · " + reference
    assert (
        not {"note", "assessment", "triage", "token_hash", "timeline"}
        & result["items"][0].keys()
    )
    assert "PRIVATE" not in str(result)
    all_rows = get(reads, "/organizer/report-index", include_illustrative=True)
    assert all_rows["total"] == 2
    assert {r["id"] for r in all_rows["items"]} == {real_id, fake_id}
    # Read models never mutate the original caption.
    with Session(engine) as db:
        assert db.get(Report, UUID(real_id)).title.startswith("PRIVATE resident")


def test_server_filters_stable_sort_and_literal_text_search(reads, engine):
    instant = now()
    with Session(engine) as db:
        job = seed_job(db, status="in_progress")
        rows = [
            seed_report(db, title="100% bags", created_at=instant),
            seed_report(db, title="1000 bags", created_at=instant, needs_review=True),
            seed_report(db, job=job, priority="high", created_at=instant),
            seed_report(db, assessment_status="failed", organizer_review_required=True),
        ]
        ids = [str(r.id) for r in rows]
        db.commit()
    first = get(reads, "/organizer/report-index", limit=2, sort="oldest")
    second = get(reads, "/organizer/report-index", limit=2, offset=2, sort="oldest")
    assert first["total"] == second["total"] == 4
    all_ids = [r["id"] for r in first["items"] + second["items"]]
    assert len(set(all_ids)) == 4
    assert all_ids[:3] == sorted(ids[:3])
    assert get(reads, "/organizer/report-index", q="100%")["items"][0]["id"] == ids[0]
    assert get(reads, "/organizer/report-index", q="100%")["total"] == 1
    assert get(reads, "/organizer/report-index", view="needs_review")["total"] == 2
    assert (
        get(reads, "/organizer/report-index", view="awaiting_assessment")["total"] == 2
    )
    active = get(reads, "/organizer/report-index", view="active_cleanup")
    assert active["total"] == 1 and active["items"][0]["job_status"] == "in_progress"
    assert (
        get(reads, "/organizer/report-index", sort="priority")["items"][0]["id"]
        == ids[2]
    )
    assert get(reads, "/organizer/report-index", priority="high")["total"] == 1
    assert (
        get(reads, "/organizer/report-index", assessment_status="failed")["total"] == 1
    )
    for query in (
        {"limit": 101},
        {"offset": -1},
        {"view": "bad"},
        {"priority": "urgent"},
        {"sort": "bad"},
    ):
        assert (
            reads.get(
                "/organizer/report-index", params=query, headers=auth("org")
            ).status_code
            == 422
        )


def test_overview_distinct_jobs_current_completions_and_truthful_availability(
    reads, engine, monkeypatch
):
    monkeypatch.setenv("RENDER_GIT_COMMIT", "a" * 40)
    with Session(engine) as db:
        crew = Crew(
            name="Real crew without GPS",
            equipment=["gloves"],
            shift_minutes=120,
            available=True,
            start_location={"latitude": 24.92, "longitude": 67.09},
        )
        db.add(crew)
        db.flush()
        crew_id = crew.id
        first = seed_job(db, status="in_progress")
        seed_report(db, job=first, priority="high")
        seed_report(db, job=first, priority="high")
        held = seed_job(db, held=True)
        seed_report(db, job=held, needs_review=True)
        done = seed_job(db, status="completed")
        old_done = seed_job(db, status="completed")
        undone = seed_job(db, status="assigned")
        seed_report(db, job=undone)
        for _ in range(2):
            db.add(
                Event(
                    kind="job.completed",
                    job_id=done.id,
                    created_at=now() - timedelta(hours=1),
                )
            )
        db.add(
            Event(
                kind="job.completed",
                job_id=old_done.id,
                created_at=now() - timedelta(hours=25),
            )
        )
        db.add(
            Event(
                kind="job.completed",
                job_id=undone.id,
                created_at=now() - timedelta(hours=1),
            )
        )
        seed_report(db)
        illustrative = seed_job(db, illustrative=True, status="in_progress")
        seed_report(db, job=illustrative, illustrative=True, priority="high")
        seed_report(db, illustrative=True, needs_review=True)
        db.commit()
    value = get(reads, "/organizer/overview")
    assert value["counts"] == dict(
        needs_review=1,
        high_priority_jobs=1,
        in_progress_jobs=1,
        available_crews=1,
        blocked_jobs=1,
        completed_24h=1,
        awaiting_assessment=1,
    )
    assert value["configuration"] == dict(
        revision="a" * 40,
        organizer_routing_enabled=False,
        road_service_configured=False,
        messaging_pilot_enabled=False,
    )
    assert value["processing"]["worker_online"] is False
    assert value["processing"]["last_success_at"] is None
    with Session(engine) as db:
        crew = db.get(Crew, crew_id)
        assert crew.location_recorded_at is None  # availability is not fresh GPS
    inclusive = get(reads, "/organizer/overview", include_illustrative=True)["counts"]
    assert inclusive["needs_review"] == 2
    assert inclusive["high_priority_jobs"] == 2
    assert inclusive["available_crews"] == 3


def test_job_index_matches_review_rules_and_retrieves_all_ownership(
    reads, engine, seeded
):
    with Session(engine) as db:
        valid = seed_job(db, locked=True, assigned_crew_id=seeded["crew_a"])
        high = seed_report(db, job=valid, priority="high")
        seed_report(db, job=valid, priority="routine")
        held = seed_job(db, held=True)
        seed_report(db, job=held)
        review = seed_job(db)
        seed_report(db, job=review, organizer_review_required=True)
        empty = seed_job(db)
        blocked = seed_job(db, status="blocked")
        seed_report(db, job=blocked)
        recheck = seed_job(db, status="recheck_requested")
        seed_report(db, job=recheck)
        fake = seed_job(db, illustrative=True, assigned_crew_id=seeded["crew_b"])
        seed_report(db, job=fake, illustrative=True)
        seed_job(db, status="completed")
        ids = {
            name: str(job.id)
            for name, job in [
                ("valid", valid),
                ("held", held),
                ("review", review),
                ("empty", empty),
                ("blocked", blocked),
                ("recheck", recheck),
                ("fake", fake),
            ]
        }
        reference = high.public_reference
        db.commit()
    result = get(reads, "/organizer/job-index")
    assert result["total"] == 6
    by_id = {j["id"]: j for j in result["items"]}
    assert by_id[ids["valid"]]["eligible"] is True
    assert by_id[ids["valid"]]["locked"] is True
    assert by_id[ids["valid"]]["priority"] == "high"
    assert reference in by_id[ids["valid"]]["public_references"]
    assert by_id[ids["held"]]["eligibility_reasons"] == ["held"]
    assert by_id[ids["review"]]["eligibility_reasons"] == [
        "assessment_or_priority_review"
    ]
    assert by_id[ids["empty"]]["eligible"] is False
    assert by_id[ids["blocked"]]["eligibility_reasons"] == ["blocked"]
    assert by_id[ids["recheck"]]["eligibility_reasons"] == ["recheck_requested"]
    pages = [
        get(reads, "/organizer/job-index", include_illustrative=True, limit=2, offset=i)
        for i in (0, 2, 4, 6)
    ]
    assert all(p["total"] == 7 for p in pages)
    assert len({j["id"] for p in pages for j in p["items"]}) == 7
    assert "PRIVATE" not in str(pages)


def test_processing_codes_are_sanitized_and_latest_task_wins(engine):
    with Session(engine) as db:
        report = seed_report(db)
        older = Task(
            kind="assessment",
            dedupe_key="old",
            payload={"report_id": str(report.id)},
            status="failed",
            attempts=1,
            last_error="assessment_interrupted",
            created_at=now() - timedelta(minutes=2),
        )
        latest = Task(
            kind="assessment",
            dedupe_key="latest",
            payload={"report_id": str(report.id)},
            status="failed",
            attempts=2,
            last_error="https://private.invalid/token=VERY-SECRET",
        )
        triage = Task(
            kind="triage",
            dedupe_key="triage",
            payload={"report_id": str(report.id)},
            status="pending",
            attempts=1,
            last_error="state_changed",
        )
        db.add_all([older, latest, triage])
        db.flush()
        value = report_processing(db, report.id)
        assert value.assessment.model_dump() == dict(
            status="failed", attempts=2, error_code="processing_failed"
        )
        assert value.triage.error_code == "state_changed"
        assert value.demo_run_id is None
        assert "SECRET" not in value.model_dump_json()
        assert report_processing(db, uuid4()).model_dump() == dict(
            assessment=None, triage=None, demo_run_id=None
        )


def test_audited_organizer_approval_never_bypasses_a_new_hold(reads, engine):
    with Session(engine) as db:
        job = seed_job(db)
        report = seed_report(
            db, job=job, assessment_status="needs_review", assessment=None
        )
        db.add(
            Event(
                kind="report.triaged",
                report_id=report.id,
                details={"organizer_override": True, "job_id": str(job.id)},
            )
        )
        report_id = report.id
        db.commit()
    item = get(reads, "/organizer/job-index")["items"][0]
    assert item["eligible"] is True
    # A fresh hold blocks routing even when an older approval exists.
    with Session(engine) as db:
        row = db.get(Report, report_id)
        row.organizer_review_required = True
        db.commit()
    item = get(reads, "/organizer/job-index")["items"][0]
    assert item["eligible"] is False
    assert item["eligibility_reasons"] == ["assessment_or_priority_review"]


def test_report_index_reports_job_event_recency_without_audit_payload(reads, engine):
    with Session(engine) as db:
        job = seed_job(db)
        seed_report(db, job=job, created_at=now() - timedelta(hours=2))
        event_at = now() - timedelta(minutes=1)
        db.add(
            Event(
                kind="job.started",
                job_id=job.id,
                created_at=event_at,
                details={"note": "PRIVATE event details"},
            )
        )
        db.commit()
    item = get(reads, "/organizer/report-index")["items"][0]
    assert datetime.fromisoformat(item["updated_at"]) == event_at
    assert "PRIVATE" not in str(item)
