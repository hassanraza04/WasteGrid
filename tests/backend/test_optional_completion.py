"""Optional crew evidence uses disposable PostgreSQL and fake external storage."""

import json
from hashlib import sha256
from io import BytesIO
from uuid import UUID, uuid4

import pytest
from PIL import Image
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from api.models import Event, Job, Photo, Plan, Report, Task
from tests.backend.conftest import auth, report


def started_job(client, png, engine, seeded, *, status="in_progress"):
    created = report(client, png)
    with Session(engine) as db:
        job = Job(
            status=status,
            location={"latitude": 24.92, "longitude": 67.09},
            category="litter",
            required_equipment=["gloves", "trash_bags"],
            estimated_service_minutes=10,
            assigned_crew_id=seeded["crew_a"],
            route_position=0,
            travel_minutes=2,
            decision_summary="Controlled synthetic completion fixture",
        )
        db.add(job)
        db.flush()
        row = db.get(Report, UUID(created["report"]["id"]))
        row.job_id, row.state = job.id, "linked_to_job"
        row.assessment_status, row.priority = "assessed", "routine"
        plan = Plan(payload={"assignments": []}, routing_mode="organizer")
        db.add(plan)
        db.commit()
        return created, str(job.id), job.version, plan.id


def command(version, **extra):
    return {"command_id": str(uuid4()), "expected_version": str(version), **extra}


def completion(client, job_id, body, *, photo=None, token="a"):
    fields = {"headers": auth(token), "data": body}
    if photo is not None:
        fields["files"] = {"photo": photo}
    return client.post(f"/jobs/{job_id}/completion", **fields)


def job_events(db, job_id):
    return list(
        db.scalars(
            select(Event).where(
                Event.job_id == UUID(job_id), Event.kind == "job.completed"
            )
        )
    )


def test_no_photo_completion_has_no_storage_or_photo_metadata_and_is_retry_safe(
    client, png, engine, seeded, monkeypatch
):
    created, job_id, version, plan_id = started_job(client, png, engine, seeded)
    cloud = client.app.state.cloud
    uploads_before = dict(cloud.uploads)
    with Session(engine) as db:
        photos_before = db.scalar(select(func.count()).select_from(Photo))

    def unexpected_storage(*args, **kwargs):
        pytest.fail("No-photo completion must not call object storage")

    monkeypatch.setattr(cloud, "upload", unexpected_storage)
    monkeypatch.setattr(cloud, "delete", unexpected_storage)
    body = command(version, note="PRIVATE-CREW-NOTE: collected without a photo")
    for _ in range(2):
        response = completion(client, job_id, body)
        assert response.status_code == 200, response.text
        assert response.json()["status"] == "completed"
        assert response.json()["version"] == version + 1
    assert cloud.uploads == uploads_before
    with Session(engine) as db:
        assert db.scalar(select(func.count()).select_from(Photo)) == photos_before
        records = job_events(db, job_id)
        assert len(records) == 1
        record = records[0]
        assert record.command_id == UUID(body["command_id"])
        assert record.actor == str(seeded["a_user"])
        assert record.job_status == "completed"
        assert record.details.get("photo_id") is None
        assert record.details["verification"] == "crew_submitted"
        assert record.details["note"] == body["note"]
        assert record.details["crew_id"] == str(seeded["crew_a"])
        assert record.details["consumed_minutes"] == 12
        assert db.get(Plan, plan_id).stale is True
        assert (
            db.scalar(select(func.count()).select_from(Task).where(Task.kind == "plan"))
            == 1
        )
        intake = db.scalar(select(Task).where(Task.kind == "assessment"))
        assert intake.status == "pending" and intake.attempts == 0

    resident = auth(created["access_token"])
    view = client.get(f"/reports/{created['report']['id']}", headers=resident)
    assert view.status_code == 200
    assert view.json()["display_status"] == "completed"
    assert view.json()["dashboard_status"] == "resolved"
    assert view.json()["completion_photo_ids"] == []
    assert "photo" not in view.json()["latest_update"]["message"].lower()
    history = client.get(
        f"/reports/{created['report']['id']}/updates", headers=resident
    )
    assert history.status_code == 200
    completed = [
        item for item in history.json()["items"] if item["kind"] == "job.completed"
    ]
    assert len(completed) == 1 and completed[0]["job_status"] == "completed"
    assert "photo" not in completed[0]["message"].lower()
    assert "PRIVATE-CREW-NOTE" not in history.text


@pytest.mark.parametrize(
    "photo,expected_status",
    [
        (("empty.png", b"", "image/png"), 415),
        (("invalid.png", b"not-an-image", "image/png"), 415),
        (("mismatch.jpg", None, "image/jpeg"), 415),
        (("too-large.png", b"12345", "image/png"), 413),
    ],
)
def test_supplied_invalid_photo_never_becomes_photo_free_completion(
    client, png, engine, seeded, photo, expected_status, monkeypatch
):
    _, job_id, version, plan_id = started_job(client, png, engine, seeded)
    filename, content, mime = photo
    if filename == "too-large.png":
        client.app.state.settings.photo_max_bytes = 4
    if content is None:
        content = png
    before = dict(client.app.state.cloud.uploads)
    response = completion(
        client, job_id, command(version), photo=(filename, content, mime)
    )
    assert response.status_code == expected_status, response.text
    with Session(engine) as db:
        row = db.get(Job, UUID(job_id))
        assert row.status == "in_progress" and row.version == version
        assert job_events(db, job_id) == []
        assert db.get(Plan, plan_id).stale is False
        assert (
            db.scalar(
                select(func.count()).select_from(Photo).where(Photo.job_id == row.id)
            )
            == 0
        )
    assert client.app.state.cloud.uploads == before


def test_explicit_empty_photo_field_is_not_an_absent_photo(client, png, engine, seeded):
    _, job_id, version, _ = started_job(client, png, engine, seeded)
    response = completion(client, job_id, command(version, photo=""))
    assert response.status_code in (415, 422), response.text
    with Session(engine) as db:
        assert db.get(Job, UUID(job_id)).status == "in_progress"
        assert job_events(db, job_id) == []


@pytest.mark.parametrize("first_photo", [False, True])
def test_photo_presence_cannot_change_when_reusing_a_completion_command(
    client, png, engine, seeded, first_photo
):
    _, job_id, version, _ = started_job(client, png, engine, seeded)
    body = command(version, note="Immutable completion")
    picture = ("evidence.png", png, "image/png")
    first = completion(client, job_id, body, photo=picture if first_photo else None)
    assert first.status_code == 200, first.text
    uploads = dict(client.app.state.cloud.uploads)
    changed = completion(client, job_id, body, photo=None if first_photo else picture)
    assert changed.status_code == 409, changed.text
    assert client.app.state.cloud.uploads == uploads
    with Session(engine) as db:
        assert len(job_events(db, job_id)) == 1
        assert db.get(Job, UUID(job_id)).version == version + 1


@pytest.mark.parametrize("has_photo", [False, True])
def test_completion_note_is_immutable_under_the_original_command(
    client, png, engine, seeded, has_photo
):
    _, job_id, version, _ = started_job(client, png, engine, seeded)
    picture = ("evidence.png", png, "image/png") if has_photo else None
    body = command(version, note="First explanation")
    assert completion(client, job_id, body, photo=picture).status_code == 200
    changed = completion(
        client, job_id, {**body, "note": "Different explanation"}, photo=picture
    )
    assert changed.status_code == 409
    with Session(engine) as db:
        assert len(job_events(db, job_id)) == 1


def test_photo_completion_rejects_changed_bytes_without_additional_upload(
    client, png, engine, seeded
):
    _, job_id, version, _ = started_job(client, png, engine, seeded)
    body = command(version)
    assert (
        completion(
            client, job_id, body, photo=("first.png", png, "image/png")
        ).status_code
        == 200
    )
    uploads = dict(client.app.state.cloud.uploads)
    buffer = BytesIO()
    Image.new("RGB", (8, 8), color="blue").save(buffer, format="PNG")
    changed = completion(
        client, job_id, body, photo=("different.png", buffer.getvalue(), "image/png")
    )
    assert changed.status_code == 409
    assert client.app.state.cloud.uploads == uploads


@pytest.mark.parametrize(
    "token,expected_status", [(None, 401), ("org", 403), ("b", 404), ("outsider", 403)]
)
def test_no_photo_completion_still_requires_the_assigned_crew(
    client, png, engine, seeded, token, expected_status
):
    _, job_id, version, _ = started_job(client, png, engine, seeded)
    headers = auth(token) if token else {}
    response = client.post(
        f"/jobs/{job_id}/completion", headers=headers, data=command(version)
    )
    assert response.status_code == expected_status, response.text
    with Session(engine) as db:
        assert db.get(Job, UUID(job_id)).status == "in_progress"
        assert job_events(db, job_id) == []


@pytest.mark.parametrize(
    "status", ["assigned", "blocked", "recheck_requested", "completed"]
)
def test_no_photo_completion_cannot_skip_the_in_progress_state(
    client, png, engine, seeded, status
):
    _, job_id, version, _ = started_job(client, png, engine, seeded, status=status)
    response = completion(client, job_id, command(version))
    assert response.status_code == 409, response.text
    with Session(engine) as db:
        assert db.get(Job, UUID(job_id)).status == status
        assert job_events(db, job_id) == []


def test_no_photo_completion_does_not_bypass_version_or_crew_ownership(
    client, png, engine, seeded
):
    _, job_id, version, _ = started_job(client, png, engine, seeded)
    assert completion(client, job_id, command(version + 1)).status_code == 409
    with Session(engine) as db:
        row = db.get(Job, UUID(job_id))
        row.assigned_crew_id = seeded["crew_b"]
        db.commit()
    assert completion(client, job_id, command(version)).status_code == 404
    with Session(engine) as db:
        assert job_events(db, job_id) == []


def test_legacy_photo_completion_fingerprint_replays_without_reupload(
    client, png, engine, seeded, monkeypatch
):
    _, job_id, version, plan_id = started_job(client, png, engine, seeded)
    body = command(version, note="Existing photo evidence")
    legacy_body = {
        **body,
        "expected_version": version,
        "photo_hash": sha256(png).hexdigest(),
    }
    fingerprint = sha256(
        ("job.completed" + job_id + json.dumps(legacy_body, sort_keys=True)).encode()
    ).hexdigest()
    with Session(engine) as db:
        job = db.get(Job, UUID(job_id))
        job.status, job.version = "completed", version + 1
        photo = Photo(
            job_id=job.id,
            object_path="legacy-completion-photo",
            content_type="image/png",
            size_bytes=len(png),
        )
        db.add(photo)
        db.flush()
        db.add(
            Event(
                job_id=job.id,
                kind="job.completed",
                command_id=UUID(body["command_id"]),
                request_hash=fingerprint,
                actor=str(seeded["a_user"]),
                job_status="completed",
                details={"photo_id": str(photo.id), "verification": "crew_submitted"},
            )
        )
        db.commit()

    def unexpected_upload(*args, **kwargs):
        pytest.fail("An existing photo command must replay without another upload")

    monkeypatch.setattr(client.app.state.cloud, "upload", unexpected_upload)
    response = completion(
        client, job_id, body, photo=("evidence.png", png, "image/png")
    )
    assert response.status_code == 200, response.text
    assert response.json()["version"] == version + 1
    with Session(engine) as db:
        assert len(job_events(db, job_id)) == 1
        assert (
            db.scalar(
                select(func.count())
                .select_from(Photo)
                .where(Photo.job_id == UUID(job_id))
            )
            == 1
        )
        assert db.get(Plan, plan_id).stale is False


@pytest.mark.parametrize("filename", [None, ""])
def test_empty_photo_part_without_a_filename_is_not_optional_evidence(
    client, png, engine, seeded, filename
):
    _, job_id, version, _ = started_job(client, png, engine, seeded)
    response = completion(
        client, job_id, command(version), photo=(filename, b"", "image/png")
    )
    assert response.status_code in (415, 422), response.text
    with Session(engine) as db:
        assert db.get(Job, UUID(job_id)).status == "in_progress"
        assert job_events(db, job_id) == []


def test_optional_evidence_does_not_clear_existing_report_review_holds(
    client, png, engine, seeded
):
    created, job_id, version, _ = started_job(client, png, engine, seeded)
    with Session(engine) as db:
        row = db.get(Report, UUID(created["report"]["id"]))
        row.needs_review = True
        row.organizer_review_required = True
        db.commit()
    response = completion(client, job_id, command(version))
    assert response.status_code == 200, response.text
    with Session(engine) as db:
        row = db.get(Report, UUID(created["report"]["id"]))
        assert row.needs_review is True
        assert row.organizer_review_required is True
