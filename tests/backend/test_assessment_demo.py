"""Real-PostgreSQL tests for the explicitly approved four-image demo boundary."""

from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Event as ThreadEvent
from types import SimpleNamespace
from uuid import UUID, uuid4

import pytest
from sqlalchemy import select
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session

from api.assessment_demo import (
    APPROVED_REFERENCES,
    EXCLUDED_REFERENCES,
    MODEL,
    DemoRefused,
    acquire_owner,
    bind_new_assessment,
    create_run,
    heartbeat,
    processing_status,
    release_owner,
    stop_run,
)
from api.db import mutation_lock
from api.models import AssessmentDemoRun, Job, Photo, Report, Task, now
from api.schemas import WasteAssessment
from api.services import enqueue
from api.worker import process_one

REVISION = "a" * 40


def add_report(db, reference=None, **changes):
    rid, pid = uuid4(), uuid4()
    report = Report(
        id=rid,
        photo_id=pid,
        public_reference=reference or "WG-" + uuid4().hex[:12].upper(),
        token_hash="b" * 64,
        location={"latitude": 24.92, "longitude": 67.09},
    )
    for key, value in changes.items():
        setattr(report, key, value)
    db.add(report)
    db.flush()
    db.add(
        Photo(
            id=pid,
            report_id=rid,
            object_path=f"demo/{pid}",
            content_type="image/png",
            size_bytes=100,
        )
    )
    task = enqueue(db, "assessment", f"assessment:{rid}", {"report_id": str(rid)})
    db.flush()
    return report, task


@pytest.fixture
def demo(engine):
    with Session(engine) as db:
        mutation_lock(db)
        reports = [add_report(db, ref)[0] for ref in APPROVED_REFERENCES]
        # Existing review requirements on the second pending report survive activation.
        reports[1].needs_review = reports[1].organizer_review_required = True
        reports[1].state = "needs_review"
        ids = [r.id for r in reports]
        db.commit()
    return SimpleNamespace(engine=engine, report_ids=ids, run_id=None, owner=uuid4())


def activate(demo):
    with Session(demo.engine) as db:
        mutation_lock(db)
        run = create_run(db, REVISION)
        demo.run_id = run.id
        acquire_owner(db, run.id, demo.owner)
        db.commit()
    return demo


def assessment_client(callback=None, output=None, error=None):
    calls = []

    def assess(*args):
        calls.append(args)
        if callback:
            callback()
        if error:
            raise error
        return (
            output
            if output is not None
            else WasteAssessment(
                description="Ordinary litter beside a wall",
                size="small",
                obstruction="none_visible",
                obstruction_level="none",
                forces_people_into_traffic="no",
                special_handling="none_identified",
                reason="No visible obstruction",
                visible_fire="no",
                visible_sharp_objects="no",
                confidence=0.9,
                resident_context_agreement="not_provided",
                comparison_reason="No resident claims provided",
            )
        )

    return SimpleNamespace(assess=assess), calls


def process(demo, assessment=None, **kwargs):
    return process_one(
        demo.engine,
        None,
        SimpleNamespace(signed_url=lambda path: "https://photos.invalid/" + path),
        assessment,
        organizer_routing=True,
        duplicate_radius_meters=0,
        demo_run_id=demo.run_id,
        demo_owner=demo.owner,
        **kwargs,
    )


def status(demo):
    with Session(demo.engine) as db:
        return processing_status(db)


def test_exact_backlog_is_frozen_and_recreation_never_resets_approval(demo):
    activate(demo)
    with Session(demo.engine) as db:
        run = db.get(AssessmentDemoRun, demo.run_id)
        assert set(run.report_ids) == set(map(str, demo.report_ids))
        assert run.model == MODEL and run.revision == REVISION
        assert run.expires_at - run.starts_at == timedelta(minutes=60)
        assert db.scalar(select(Task).where(Task.demo_run_id == run.id)).attempts == 0
        with pytest.raises(DemoRefused, match="already exists"):
            create_run(db, REVISION)
    assert status(demo)["worker_online"]


@pytest.mark.parametrize(
    "change",
    [
        "attempted",
        "running",
        "missing_task",
        "assessed",
        "illustrative",
        "linked",
        "missing_coordinates",
        "triage",
    ],
)
def test_activation_refuses_changed_backlog_without_substitution(demo, change):
    with Session(demo.engine) as db:
        report = db.get(Report, demo.report_ids[0])
        task = db.scalar(
            select(Task).where(Task.payload["report_id"].as_string() == str(report.id))
        )
        if change == "attempted":
            task.attempts = 1
        elif change == "running":
            task.status = "running"
        elif change == "missing_task":
            db.delete(task)
        elif change == "assessed":
            report.assessment_status = "assessed"
        elif change == "illustrative":
            report.illustrative = True
        elif change == "linked":
            job = Job(
                location=report.location,
                category="mixed_waste",
                required_equipment=[],
                estimated_service_minutes=10,
            )
            db.add(job)
            db.flush()
            report.job_id = job.id
            report.state = "linked_to_job"
        elif change == "missing_coordinates":
            report.location = None
        else:
            enqueue(db, "triage", "unexpected-triage", {"report_id": str(report.id)})
        db.commit()
    with Session(demo.engine) as db:
        with pytest.raises(DemoRefused):
            create_run(db, REVISION)
        db.rollback()
        assert db.scalar(select(AssessmentDemoRun)) is None


def test_new_admission_is_bounded_project_wide_and_retries_keep_slots(demo):
    activate(demo)
    with Session(demo.engine) as db:
        for index in range(3):
            mutation_lock(db)
            report, task = add_report(db)
            assert bind_new_assessment(db, report, task) is (index < 2)
            assert not bind_new_assessment(db, report, task)
            db.commit()
        run = db.get(AssessmentDemoRun, demo.run_id)
        assert run.new_reports_admitted == 2
        assert (
            len(list(db.scalars(select(Task).where(Task.demo_run_id == run.id)))) == 4
        )


@pytest.mark.parametrize(
    "changes",
    [
        {"illustrative": True},
        {"location": None},
        {"created_at": now() - timedelta(days=1)},
        {"public_reference": EXCLUDED_REFERENCES[0]},
        {"public_reference": EXCLUDED_REFERENCES[1]},
    ],
)
def test_new_admission_rejects_non_scope_records(demo, changes):
    activate(demo)
    with Session(demo.engine) as db:
        report, task = add_report(db, **changes)
        assert not bind_new_assessment(db, report, task)
        db.commit()
        assert db.get(AssessmentDemoRun, demo.run_id).new_reports_admitted == 0
        assert db.get(Task, task.id).demo_run_id is None


def test_concurrent_admission_cannot_spend_more_than_two_slots(demo):
    activate(demo)

    def admit(_):
        with Session(demo.engine) as db:
            mutation_lock(db)
            report, task = add_report(db)
            admitted = bind_new_assessment(db, report, task)
            db.commit()
            return admitted

    with ThreadPoolExecutor(max_workers=4) as pool:
        assert sum(pool.map(admit, range(4))) == 2
    assert status(demo)["new_reports_admitted"] == 2


def test_one_concurrent_image_and_budget_reservation_precede_provider(demo):
    activate(demo)
    entered, release = ThreadEvent(), ThreadEvent()

    def pause():
        assert status(demo)["used_attempts"] == 1
        entered.set()
        assert release.wait(10)

    model, calls = assessment_client(pause)
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(process, demo, model)
        assert entered.wait(10)
        assert not process(demo, model)
        release.set()
        assert first.result(timeout=10)
    assert len(calls) == 1 and status(demo)["used_attempts"] == 1


def test_four_attempt_limit_survives_restarts_and_preserves_unrelated_work(demo):
    activate(demo)
    with Session(demo.engine) as db:
        for _ in range(2):
            report, task = add_report(db)
            assert bind_new_assessment(db, report, task)
        outsider, outsider_task = add_report(db, EXCLUDED_REFERENCES[1])
        outsider_ids = outsider.id, outsider_task.id
        # Do not drain unrelated planning work either.
        plan_task = enqueue(db, "plan", "untouched-plan", {})
        plan_id = plan_task.id
        db.commit()
    calls = []
    for _ in range(12):
        model, batch = assessment_client()
        worked = process(demo, model)
        calls.extend(batch)
        if not worked:
            break
    assert len(calls) == 4
    assert status(demo)["used_attempts"] == 4
    with Session(demo.engine) as db:
        assert db.get(Report, outsider_ids[0]).assessment_status == "pending"
        assert db.get(Task, outsider_ids[1]).attempts == 0
        assert db.get(Task, plan_id).attempts == 0
        assert db.get(Task, plan_id).status == "pending"
        assert all(job.assigned_crew_id is None for job in db.scalars(select(Job)))


@pytest.mark.parametrize("failure", ["malformed", "timeout"])
def test_invalid_or_timed_out_image_is_terminal_and_charged_once(demo, failure):
    activate(demo)
    model, calls = assessment_client(
        output={} if failure == "malformed" else None,
        error=TimeoutError() if failure == "timeout" else None,
    )
    assert process(demo, model)
    with Session(demo.engine) as db:
        task = db.scalar(select(Task).where(Task.status == "failed"))
        assert task.attempts == 1
        assert task.last_error in ("invalid_proposal", "provider_unavailable")
        report_id = UUID(task.payload["report_id"])
        assert db.get(Report, report_id).needs_review
        assert db.get(Report, report_id).assessment_status == "failed"
    assert len(calls) == 1 and status(demo)["used_attempts"] == 1
    # Second fresh image belongs to the other approved report, never a replay.
    assert process(demo, model)
    assert len(calls) == 2 and status(demo)["used_attempts"] == 2


def test_stop_during_image_allows_earned_triage_but_no_fresh_assessment(demo):
    activate(demo)

    def stop():
        with Session(demo.engine) as db:
            mutation_lock(db)
            stop_run(db, demo.run_id)
            db.commit()

    model, calls = assessment_client(stop)
    assert process(demo, model)
    assert process(demo, model)  # already earned deterministic triage
    assert not process(demo, model)
    assert len(calls) == 1
    with Session(demo.engine) as db:
        assert db.get(AssessmentDemoRun, demo.run_id).status == "closed"
        tasks = list(db.scalars(select(Task).where(Task.demo_run_id == demo.run_id)))
        assert sum(t.kind == "assessment" and t.attempts == 0 for t in tasks) == 1
        assert sum(t.kind == "triage" and t.status == "succeeded" for t in tasks) == 1
        assert len(list(db.scalars(select(Job)))) == 1


def test_expiry_stops_admission_and_images_while_allowing_interrupted_cleanup(
    demo, monkeypatch
):
    activate(demo)
    with Session(demo.engine) as db:
        task = db.scalar(
            select(Task)
            .where(Task.demo_run_id == demo.run_id)
            .order_by(Task.created_at)
        )
        task.status, task.attempts = "running", 1
        task.lease_id = uuid4()
        task.leased_until = now() - timedelta(seconds=1)
        run = db.get(AssessmentDemoRun, demo.run_id)
        run.used_attempts = 1
        future = run.expires_at + timedelta(seconds=1)
        db.commit()
    monkeypatch.setattr("api.assessment_demo.now", lambda: future)
    monkeypatch.setattr("api.worker.now", lambda: future)
    with Session(demo.engine) as db:
        acquire_owner(db, demo.run_id, demo.owner)
        report, task = add_report(db, created_at=future)
        assert not bind_new_assessment(db, report, task)
        db.commit()
    model, calls = assessment_client()
    assert process(demo, model)
    assert not process(demo, model)
    assert not calls
    assert status(demo)["reason"] == "window_expired"
    with Session(demo.engine) as db:
        failed = db.scalar(select(Task).where(Task.status == "failed"))
        assert failed.last_error == "assessment_interrupted"
        assert db.get(Report, UUID(failed.payload["report_id"])).needs_review
        assert db.get(AssessmentDemoRun, demo.run_id).used_attempts == 1


def test_late_result_cannot_clear_organizer_or_new_review_hold(demo):
    activate(demo)

    def hold():
        with Session(demo.engine) as db:
            mutation_lock(db)
            report = db.get(Report, demo.report_ids[0])
            report.organizer_review_required = report.needs_review = True
            report.state = "needs_review"
            report.version += 1
            db.commit()

    model, calls = assessment_client(hold)
    assert process(demo, model)
    with Session(demo.engine) as db:
        report = db.get(Report, demo.report_ids[0])
        assert report.organizer_review_required and report.needs_review
        assert report.state == report.assessment_status == "needs_review"
        assert report.job_id is None
        assert db.scalar(select(Task).where(Task.kind == "triage")) is None
    assert len(calls) == 1 and status(demo)["last_success_at"] is not None


def test_competing_owners_and_stale_heartbeat_are_reported_honestly(demo, monkeypatch):
    activate(demo)
    with Session(demo.engine) as db:
        with pytest.raises(DemoRefused, match="Another"):
            acquire_owner(db, demo.run_id, uuid4())
    future = now() + timedelta(seconds=46)
    monkeypatch.setattr("api.assessment_demo.now", lambda: future)
    assert not status(demo)["worker_online"]
    original = demo.owner
    demo.owner = uuid4()
    with Session(demo.engine) as db:
        acquire_owner(db, demo.run_id, demo.owner)
        db.commit()
        assert not heartbeat(db, demo.run_id, original)
        release_owner(db, demo.run_id, original)
        db.commit()
        assert db.get(AssessmentDemoRun, demo.run_id).worker_owner == demo.owner
    assert status(demo)["worker_online"]


def test_normal_workers_never_recover_or_claim_demo_owned_tasks(demo):
    activate(demo)
    with Session(demo.engine) as db:
        task = db.scalar(select(Task).where(Task.demo_run_id == demo.run_id))
        task.status, task.attempts = "running", 1
        task.leased_until = now() - timedelta(seconds=1)
        db.commit()
    model, calls = assessment_client()
    assert not process_one(demo.engine, None, None, model, organizer_routing=True)
    assert not calls
    with Session(demo.engine) as db:
        assert (
            db.scalar(select(Task).where(Task.status == "running")).last_error is None
        )


@pytest.mark.parametrize(
    "field,value",
    [
        ("used_attempts", 5),
        ("new_reports_admitted", 3),
        ("model", "another/model"),
        ("revision", "b" * 40),
    ],
)
def test_database_enforces_approval_and_caps(demo, field, value):
    activate(demo)
    with Session(demo.engine) as db:
        run = db.get(AssessmentDemoRun, demo.run_id)
        setattr(run, field, value)
        with pytest.raises(DBAPIError):
            db.commit()


def test_database_prevents_budget_reset_and_task_scope_rebinding(demo):
    activate(demo)
    model, _ = assessment_client()
    assert process(demo, model)
    with Session(demo.engine) as db:
        run = db.get(AssessmentDemoRun, demo.run_id)
        run.used_attempts = 0
        with pytest.raises(DBAPIError):
            db.commit()
        db.rollback()
        task = db.scalar(select(Task).where(Task.demo_run_id == demo.run_id))
        task.demo_run_id = None
        with pytest.raises(DBAPIError):
            db.commit()


def test_inactive_status_and_owned_empty_drain_are_explicit(engine):
    with Session(engine) as db:
        value = processing_status(db)
        assert value["status"] == "inactive"
        assert not value["worker_online"] and value["last_success_at"] is None
        assert value["queue"] == dict.fromkeys(
            ("pending", "running", "succeeded", "failed"), 0
        )


def test_operator_resume_releases_owner_and_retains_counter(demo):
    from api.config import Settings
    from scripts.assessment_demo import run_session

    activate(demo)
    with Session(demo.engine) as db:
        release_owner(db, demo.run_id, demo.owner)
        db.commit()
    settings = Settings(_env_file=None, chalk_model=MODEL, duplicate_radius_meters=0)
    cloud = SimpleNamespace(signed_url=lambda path: "https://photos.invalid/" + path)
    first, first_calls = assessment_client()
    first_status = run_session(
        demo.engine, settings, demo.run_id, cloud, first, once=True
    )
    assert first_status["used_attempts"] == 1
    assert not first_status["worker_online"]
    second, second_calls = assessment_client()
    second_status = run_session(
        demo.engine, settings, demo.run_id, cloud, second, once=True
    )
    assert second_status["used_attempts"] == 2
    assert not second_status["worker_online"]
    assert len(first_calls) == len(second_calls) == 1


def test_stopped_approval_cannot_admit_or_reactivate(demo):
    activate(demo)
    with Session(demo.engine) as db:
        run = stop_run(db, demo.run_id)
        report, task = add_report(db)
        assert not bind_new_assessment(db, report, task)
        db.commit()
        run.status = "active"
        with pytest.raises(DBAPIError):
            db.commit()
        db.rollback()
        with pytest.raises(DemoRefused, match="already exists"):
            create_run(db, REVISION)


def test_last_image_slot_is_reserved_once_under_competing_claims(demo):
    activate(demo)
    with Session(demo.engine) as db:
        run = db.get(AssessmentDemoRun, demo.run_id)
        run.used_attempts = 3  # Earlier attempts remain charged after a restart.
        db.commit()
    entered, release = ThreadEvent(), ThreadEvent()

    def pause():
        assert status(demo)["used_attempts"] == 4
        entered.set()
        assert release.wait(10)

    model, calls = assessment_client(pause)
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(process, demo, model)
        assert entered.wait(10)
        assert not process(demo, model)
        release.set()
        assert first.result(timeout=10)
    # Earned deterministic triage remains allowed at the cap.
    assert process(demo, model)
    assert not process(demo, model)
    assert len(calls) == 1 and status(demo)["used_attempts"] == 4


def test_lost_owner_during_storage_cannot_submit_its_old_image(demo):
    activate(demo)
    replacement = uuid4()

    def storage(path):
        with Session(demo.engine) as db:
            mutation_lock(db)
            run = db.get(AssessmentDemoRun, demo.run_id)
            # Simulates a stalled process resuming after ownership takeover.
            run.worker_owner = replacement
            db.commit()
        return "https://photos.invalid/private"

    model, calls = assessment_client()
    assert process_one(
        demo.engine,
        None,
        SimpleNamespace(signed_url=storage),
        model,
        organizer_routing=True,
        demo_run_id=demo.run_id,
        demo_owner=demo.owner,
    )
    assert not calls
    assert status(demo)["used_attempts"] == 1
    with Session(demo.engine) as db:
        task = db.scalar(select(Task).where(Task.status == "running"))
        assert task.attempts == 1
        # The reserved attempt is not refundable or automatically replayable.
        assert (
            db.get(Report, UUID(task.payload["report_id"])).assessment_status
            == "pending"
        )


def test_interrupted_earned_triage_resumes_after_stop_without_an_image(demo):
    activate(demo)
    model, calls = assessment_client()
    assert process(demo, model)
    with Session(demo.engine) as db:
        task = db.scalar(select(Task).where(Task.kind == "triage"))
        task.status, task.attempts = "running", 1
        task.lease_id = uuid4()
        task.leased_until = now() - timedelta(seconds=1)
        stop_run(db, demo.run_id)
        db.commit()
    assert process(demo, model)
    assert not process(demo, model)
    assert len(calls) == 1
    with Session(demo.engine) as db:
        assert len(list(db.scalars(select(Job)))) == 1
        assert (
            db.scalar(select(Task).where(Task.kind == "triage")).status == "succeeded"
        )


@pytest.mark.parametrize("nearby_held_report", [False, True])
def test_demo_preserves_nearby_illustrative_assignment_and_held_report(
    demo, seeded, nearby_held_report
):
    from api.models import Crew, Event

    with Session(demo.engine) as db:
        # Keep the other approved pending report away from the target, so this
        # isolates illustrative-context filtering from real duplicate review.
        db.get(Report, demo.report_ids[1]).location = {
            "latitude": 25.5,
            "longitude": 67.8,
        }
        fixture_job = Job(
            status="assigned",
            assigned_crew_id=seeded["crew_a"],
            route_position=0,
            location={"latitude": 24.92, "longitude": 67.09},
            category="mixed_waste",
            required_equipment=["gloves", "trash_bags"],
            estimated_service_minutes=10,
            illustrative=True,
            locked=True,
        )
        db.add(fixture_job)
        db.flush()
        fixture_report, fixture_task = add_report(
            db, illustrative=True, state="linked_to_job", job_id=fixture_job.id
        )
        held, held_task = add_report(
            db,
            EXCLUDED_REFERENCES[0],
            location={
                "latitude": 24.92 if nearby_held_report else 26,
                "longitude": 67.09,
            },
            state="needs_review",
            needs_review=True,
            organizer_review_required=True,
            priority_reason="Keep the existing organiser review hold",
        )
        fixture_ids = fixture_job.id, fixture_report.id, held.id
        scope = (
            (Crew, seeded["crew_a"]),
            (Job, fixture_job.id),
            (Report, fixture_report.id),
            (Report, held.id),
            (Task, fixture_task.id),
            (Task, held_task.id),
        )
        db.commit()

    def preserved_rows(db):
        return [
            tuple(
                getattr(db.get(kind, identity), column.name)
                for column in kind.__table__.columns
            )
            for kind, identity in scope
        ]

    with Session(demo.engine) as db:
        before = preserved_rows(db)
    activate(demo)
    model, calls = assessment_client()
    cloud = SimpleNamespace(signed_url=lambda path: "https://photos.invalid/" + path)
    for _ in range(3):
        assert process_one(
            demo.engine,
            None,
            cloud,
            model,
            organizer_routing=True,
            duplicate_radius_meters=10,
            demo_run_id=demo.run_id,
            demo_owner=demo.owner,
        )
    assert len(calls) == 2  # Images only for the two approved reports.
    with Session(demo.engine) as db:
        assert preserved_rows(db) == before
        target = db.get(Report, demo.report_ids[0])
        if nearby_held_report:
            assert target.state == "needs_review" and target.job_id is None
            assert target.triage["duplicate_candidate_id"] == str(fixture_ids[2])
        else:
            assert target.state == "linked_to_job"
            assert target.job_id != fixture_ids[0]
            created = db.get(Job, target.job_id)
            assert not created.illustrative and created.assigned_crew_id is None
        assert (
            db.scalar(
                select(Event.id).where(
                    (Event.job_id == fixture_ids[0])
                    | Event.report_id.in_(fixture_ids[1:])
                    | (Event.crew_id == seeded["crew_a"])
                )
            )
            is None
        )
