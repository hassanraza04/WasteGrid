"""Only accepted, unresolved, non-illustrative reports reach the public map."""

from uuid import UUID

from sqlalchemy.orm import Session

from api.models import Job, Report
from tests.backend.conftest import report

BOUNDS = {"south": 24.90, "north": 24.95, "west": 67.07, "east": 67.12}


def test_public_map_marker_follows_report_and_job_lifecycle(client, png):
    created = report(client, png, latitude=24.92123, longitude=67.09123)
    response = client.get("/map/markers", params=BOUNDS)
    assert response.status_code == 200
    assert response.json() == {
        "items": [{"latitude": 24.921, "longitude": 67.091}],
        "truncated": False,
    }
    # Bounds are applied to the public grid, not the underlying exact GPS.
    assert client.get(
        "/map/markers",
        params={"south": 24.9209, "north": 24.9211, "west": 67.0909, "east": 67.0911},
    ).json()["items"] == [{"latitude": 24.921, "longitude": 67.091}]
    assert (
        client.get("/map/markers", params={**BOUNDS, "west": 68, "east": 69}).json()[
            "items"
        ]
        == []
    )

    with Session(client.app.state.engine) as db:
        saved = db.get(Report, UUID(created["report"]["id"]))
        job = Job(
            location=saved.location,
            category="litter",
            required_equipment=["gloves"],
            estimated_service_minutes=15,
            status="unassigned",
        )
        db.add(job)
        db.flush()
        saved.job_id = job.id
        saved.state = "linked_to_job"
        db.commit()

    assert len(client.get("/map/markers", params=BOUNDS).json()["items"]) == 1
    with Session(client.app.state.engine) as db:
        db.get(Job, job.id).status = "completed"
        db.commit()
    assert client.get("/map/markers", params=BOUNDS).json()["items"] == []


def test_public_map_hides_illustrative_reports_and_rejects_bad_bounds(client, png):
    created = report(client, png, latitude=24.92123, longitude=67.09123)
    with Session(client.app.state.engine) as db:
        db.get(Report, UUID(created["report"]["id"])).illustrative = True
        db.commit()
    assert client.get("/map/markers", params=BOUNDS).json()["items"] == []
    assert (
        client.get(
            "/map/markers", params={**BOUNDS, "north": BOUNDS["south"]}
        ).status_code
        == 422
    )
