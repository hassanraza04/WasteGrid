"""Focused demo rules, gateway boundary, and persisted worker failure checks."""

import json
from datetime import timedelta
from types import SimpleNamespace
from uuid import uuid4

import httpx
import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy import DefaultClause, MetaData, create_engine, select, text
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from api.assessment import calculate_priority
from api.config import Settings
from api.integrations import ChalkAssessmentClient
from api.main import create_app
from api.models import Base, Photo, Report, Task, now
from api.schemas import WasteAssessment
from api.services import enqueue, report_view
from api.worker import process_one


def assessment(**changes):
    return WasteAssessment.model_validate(
        {
            "description": "Mixed bags and rubble",
            "size": "medium",
            "obstruction": "none_visible",
            "obstruction_level": "none",
            "forces_people_into_traffic": "no",
            "special_handling": "none_identified",
            "reason": "Waste is beside the path with no visible obstruction.",
            **changes,
        }
    )


@pytest.mark.parametrize(
    "changes,priority,review",
    [
        ({}, "routine", False),
        ({"obstruction": "entrance", "obstruction_level": "complete"}, "high", False),
        (
            {
                "obstruction": "road",
                "obstruction_level": "partial",
                "forces_people_into_traffic": "yes",
            },
            "high",
            False,
        ),
        (
            {
                "obstruction": "walkway",
                "obstruction_level": "unknown",
                "forces_people_into_traffic": "yes",
            },
            "high",
            False,
        ),
        ({"obstruction": "walkway", "obstruction_level": "partial"}, "medium", False),
        ({"obstruction": "drain", "obstruction_level": "partial"}, "medium", False),
        ({"special_handling": "suspected"}, None, True),
        (
            {
                "obstruction": "entrance",
                "obstruction_level": "complete",
                "special_handling": "suspected",
            },
            "high",
            True,
        ),
        ({"obstruction": "unknown", "obstruction_level": "unknown"}, None, True),
        ({"special_handling": "unknown"}, None, True),
        ({"forces_people_into_traffic": "unknown"}, None, True),
        ({"size": "large"}, "routine", False),
        ({"obstruction": "none_visible", "obstruction_level": "complete"}, None, True),
    ],
)
def test_demo_rules(changes, priority, review):
    result = calculate_priority(assessment(**changes))
    assert result.priority == priority
    assert result.needs_review is review
    assert result.priority_reason


def test_size_does_not_change_priority():
    results = [
        calculate_priority(assessment(size=s))
        for s in ("small", "medium", "large", "unknown")
    ]
    assert all(r == results[0] for r in results)


@pytest.mark.parametrize(
    "body,status",
    [
        ({"choices": [{"message": {"content": assessment().model_dump_json()}}]}, 200),
        ({"choices": [{"message": {"content": "not json"}}]}, 200),
        ({"error": "provider error"}, 503),
    ],
)
def test_gateway_one_request(body, status):
    calls = []
    settings = Settings(
        _env_file=None,
        chalk_router_api_key="test-key",
        chalk_env_id="test-env",
        assessment_timeout_seconds=7,
    )
    client = ChalkAssessmentClient(settings)

    def respond(request):
        calls.append(request)
        payload = json.loads(request.content)
        assert payload["model"] == settings.chalk_model
        assert (
            payload["messages"][1]["content"][1]["image_url"]["url"]
            == "https://photo.invalid/image"
        )
        assert request.headers["X-Chalk-Env-Id"] == "test-env"
        assert request.extensions["timeout"]["read"] == 7
        return httpx.Response(status, json=body)

    client.client.close()
    client.client = httpx.Client(
        base_url=settings.chalk_router_base_url + "/",
        headers={"X-Chalk-Env-Id": "test-env"},
        timeout=7,
        transport=httpx.MockTransport(respond),
    )
    try:
        if status != 200:
            with pytest.raises(httpx.HTTPStatusError):
                client.assess("https://photo.invalid/image", "Mixed litter")
        elif body["choices"][0]["message"]["content"] == "not json":
            with pytest.raises(ValidationError):
                client.assess("https://photo.invalid/image", None)
        else:
            assert client.assess("https://photo.invalid/image", None) == assessment()
        assert len(calls) == 1
    finally:
        client.close()


@pytest.fixture
def assessment_db(monkeypatch):
    # Use real transactions locally; PostgreSQL schema/migration checks stay in backend tests.
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    with engine.begin() as connection:
        connection.exec_driver_sql("ATTACH DATABASE ':memory:' AS wastegrid")
    metadata = MetaData()
    for table in Base.metadata.sorted_tables:
        table.to_metadata(metadata)
    metadata.tables["wastegrid.reports"].c.public_reference.server_default = (
        DefaultClause(text("('WG-' || upper(hex(randomblob(6))))"))
    )
    metadata.create_all(engine)
    monkeypatch.setattr("api.worker.mutation_lock", lambda db: None)
    monkeypatch.setattr("api.db.mutation_lock", lambda db: None)
    try:
        yield engine
    finally:
        engine.dispose()


@pytest.mark.parametrize("failure", [None, "invalid", "timeout", "provider"])
def test_worker_retains_report_and_exposes_result(assessment_db, failure):
    engine = assessment_db
    rid, pid = uuid4(), uuid4()
    with Session(engine) as db:
        db.add(
            Report(
                id=rid,
                public_reference="WG-A1B2C3D4E5F6",
                photo_id=pid,
                token_hash="test",
                note="Mixed waste",
            )
        )
        db.flush()
        db.add(
            Photo(
                id=pid,
                report_id=rid,
                object_path="test/photo",
                content_type="image/png",
                size_bytes=20,
            )
        )
        enqueue(db, "assessment", f"assessment:{rid}", {"report_id": str(rid)})
        db.commit()

    calls = []

    def assess(photo, note):
        calls.append((photo, note))
        if failure == "invalid":
            return {"description": "incomplete"}
        if failure == "timeout":
            raise httpx.ReadTimeout("secret URL must not leak")
        if failure == "provider":
            raise RuntimeError("secret key must not leak")
        return assessment()

    cloud = SimpleNamespace(signed_url=lambda path: "https://photo.invalid/image")
    client = SimpleNamespace(assess=assess)
    assert process_one(engine, None, cloud, client)
    assert not process_one(engine, None, cloud, client)
    assert len(calls) == 1
    with Session(engine) as db:
        report = db.get(Report, rid)
        assert report is not None
        view = report_view(db, report).model_dump(mode="json")
        assert view["assessment_status"] == ("failed" if failure else "assessed")
        assert view["priority"] == (None if failure else "routine")
        assert view["needs_review"] is bool(failure)
        assert bool(view["assessment"]) is (failure is None)
        assert "secret" not in json.dumps(view)
        task = db.scalar(select(Task))
        assert task.status == ("failed" if failure else "succeeded")
        assert task.attempts == 1


def test_expired_assessment_is_not_called_again(assessment_db):
    engine = assessment_db
    rid = uuid4()
    with Session(engine) as db:
        db.add(
            Report(
                id=rid,
                public_reference="WG-A1B2C3D4E5F6",
                photo_id=uuid4(),
                token_hash="test",
            )
        )
        db.flush()
        task = enqueue(db, "assessment", f"assessment:{rid}", {"report_id": str(rid)})
        task.status, task.attempts = "running", 1
        task.leased_until = now() - timedelta(minutes=1)
        db.commit()
    assert process_one(engine, None, None, None)
    with Session(engine) as db:
        assert db.get(Report, rid).assessment_status == "failed"


def test_report_api_returns_pending_then_assessment(assessment_db):
    from io import BytesIO

    from PIL import Image

    app = create_app(Settings(_env_file=None))
    app.state.engine = assessment_db
    app.state.cloud.close()
    cloud = SimpleNamespace(
        upload=lambda *args: None,
        delete=lambda path: None,
        signed_url=lambda path: "https://photo.invalid/image",
        close=lambda: None,
    )
    app.state.cloud = cloud
    image = BytesIO()
    Image.new("RGB", (8, 8)).save(image, "PNG")
    with TestClient(app) as client:
        response = client.post(
            "/reports",
            files={"photo": ("waste.png", image.getvalue(), "image/png")},
            data={"note": "Mixed waste"},
        )
        assert response.status_code == 201, response.text
        created = response.json()
        rid = created["report"]["id"]
        assert created["report"]["assessment_status"] == "pending"
        assert created["report"]["priority"] is None
        assert process_one(
            assessment_db,
            None,
            cloud,
            SimpleNamespace(assess=lambda *args: assessment()),
        )
        result = client.get(
            f"/reports/{rid}",
            headers={"Authorization": "Bearer " + created["access_token"]},
        )
        assert result.status_code == 200
        assert result.json()["priority"] == "routine"
        assert result.json()["assessment"]["size"] == "medium"
        assert result.json()["assessment_status"] == "assessed"


def test_suspected_handling_cannot_create_ordinary_job(assessment_db):
    from api.schemas import TriageRecommendation
    from api.workflows import apply_triage

    with Session(assessment_db) as db:
        row = Report(
            public_reference="WG-A1B2C3D4E5F6",
            photo_id=uuid4(),
            token_hash="test",
            location={"latitude": 24.9, "longitude": 67.0},
            assessment=assessment(special_handling="suspected").model_dump(),
        )
        db.add(row)
        db.flush()
        proposal = TriageRecommendation(
            report_id=row.id,
            command_id=uuid4(),
            expected_version=row.version,
            category="mixed",
            proposed_equipment=["gloves", "trash_bags"],
            missing_information=[],
            evidence_sufficient=True,
            decision_summary="Ordinary cleanup",
            evidence_report_ids=[row.id],
            next_action="create_job",
            estimated_service_minutes=20,
        )
        apply_triage(db, proposal)
        db.commit()
        assert row.state == "needs_review"
        assert row.job_id is None
