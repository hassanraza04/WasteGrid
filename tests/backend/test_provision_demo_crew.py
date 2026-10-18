"""The one-off preparation command preserves existing fleet and account state."""

from uuid import uuid4

import pytest
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from api.models import Assignment, Crew, Event, Job, Plan, StaffRole, now
from api.schemas import Location
from scripts.provision_demo_crew import (
    CREW_ID,
    CREW_NAME,
    PROVISION_COMMAND_ID,
    ProvisionRefused,
    provision,
)

INITIAL_LOCATION = Location(latitude=24.92, longitude=67.09)


def prepare(engine, seeded, **kwargs):
    return provision(engine, seeded["outsider"], INITIAL_LOCATION, **kwargs)


def test_creation_and_replay_preserve_fleet_and_do_not_manufacture_gps(engine, seeded):
    first = prepare(engine, seeded)
    assert first["status"] == "created"
    with Session(engine) as db:
        crew = db.get(Crew, CREW_ID)
        assert crew.name == CREW_NAME
        assert not crew.illustrative and crew.available
        assert crew.shift_minutes == 120
        assert set(crew.equipment) == {"gloves", "trash_bags", "broom"}
        assert crew.location_recorded_at is None
        assert crew.location_received_at is None
        assert crew.location_revision == 0
        assert db.scalar(select(func.count()).select_from(Crew)) == 3
        assert db.get(Crew, seeded["crew_a"]).illustrative
        assert db.get(StaffRole, seeded["a_user"]).crew_id == seeded["crew_a"]
        assert db.get(StaffRole, seeded["outsider"]).crew_id == CREW_ID
    assert prepare(engine, seeded)["status"] == "ready"
    with Session(engine) as db:
        assert db.scalar(select(func.count()).select_from(Crew)) == 3
        assert db.scalar(select(func.count()).select_from(Event)) == 1
        assert db.scalar(select(func.count()).select_from(Job)) == 0
        assert db.scalar(select(func.count()).select_from(Assignment)) == 0


def test_check_does_not_create_rows(engine, seeded):
    assert prepare(engine, seeded, check=True)["status"] == "would_create"
    with Session(engine) as db:
        assert db.get(Crew, CREW_ID) is None
        assert db.get(StaffRole, seeded["outsider"]) is None
        assert db.scalar(select(func.count()).select_from(Event)) == 0


@pytest.mark.parametrize("user_key", ["organizer", "a_user"])
def test_existing_staff_role_is_never_reassigned(engine, seeded, user_key):
    with pytest.raises(ProvisionRefused, match="different staff role"):
        provision(engine, seeded[user_key], INITIAL_LOCATION)
    with Session(engine) as db:
        assert db.get(Crew, CREW_ID) is None
        role = db.get(StaffRole, seeded[user_key])
        assert role.role == ("organizer" if user_key == "organizer" else "crew")


def test_unknown_auth_account_and_missing_initial_location_are_refused(engine, seeded):
    with pytest.raises(ProvisionRefused, match="does not exist"):
        provision(engine, uuid4(), INITIAL_LOCATION)
    with pytest.raises(ProvisionRefused, match="explicit"):
        provision(engine, seeded["outsider"])
    with Session(engine) as db:
        assert db.get(Crew, CREW_ID) is None


def test_name_collision_does_not_adopt_an_existing_crew(engine, seeded):
    with Session(engine) as db:
        crew = db.get(Crew, seeded["crew_a"])
        crew.name = CREW_NAME
        db.commit()
    with pytest.raises(ProvisionRefused, match="already uses"):
        prepare(engine, seeded)
    with Session(engine) as db:
        assert db.get(Crew, CREW_ID) is None
        assert db.get(Crew, seeded["crew_a"]).illustrative


def test_different_owner_cannot_claim_the_existing_demo_crew(engine, seeded):
    prepare(engine, seeded)
    # Remove another staff role only inside this disposable test to obtain a
    # second existing Auth account with which to attempt the conflicting claim.
    with Session(engine) as db:
        db.delete(db.get(StaffRole, seeded["a_user"]))
        db.commit()
    with pytest.raises(ProvisionRefused, match="another staff account"):
        provision(engine, seeded["a_user"], INITIAL_LOCATION)
    with Session(engine) as db:
        assert db.get(StaffRole, seeded["outsider"]).crew_id == CREW_ID
        assert db.get(StaffRole, seeded["a_user"]) is None


def test_missing_ownership_marker_is_not_silently_repaired(engine, seeded):
    prepare(engine, seeded)
    with Session(engine) as db:
        db.delete(
            db.scalar(select(Event).where(Event.command_id == PROVISION_COMMAND_ID))
        )
        db.commit()
    with pytest.raises(ProvisionRefused, match="ownership cannot"):
        prepare(engine, seeded)


def test_configuration_drift_is_not_overwritten(engine, seeded):
    prepare(engine, seeded)
    with Session(engine) as db:
        db.get(Crew, CREW_ID).shift_minutes = 60
        db.commit()
    with pytest.raises(ProvisionRefused, match="configuration changed"):
        prepare(engine, seeded)
    with Session(engine) as db:
        assert db.get(Crew, CREW_ID).shift_minutes == 60


@pytest.mark.parametrize("historical", [False, True])
def test_current_and_historical_work_cannot_be_reset(engine, seeded, historical):
    prepare(engine, seeded)
    with Session(engine) as db:
        job = Job(
            category="mixed_waste",
            location=INITIAL_LOCATION.model_dump(),
            required_equipment=["gloves"],
            estimated_service_minutes=10,
            assigned_crew_id=None if historical else CREW_ID,
            status="unassigned" if historical else "assigned",
            route_position=None if historical else 0,
        )
        db.add(job)
        db.flush()
        if historical:
            plan = Plan(payload={})
            db.add(plan)
            db.flush()
            db.add(
                Assignment(plan_id=plan.id, job_id=job.id, crew_id=CREW_ID, position=0)
            )
        db.commit()
        job_id = job.id
    with pytest.raises(ProvisionRefused, match="current or historical assignments"):
        prepare(engine, seeded)
    with Session(engine) as db:
        assert db.get(Job, job_id) is not None
        assert db.get(StaffRole, seeded["outsider"]).crew_id == CREW_ID


def test_replay_preserves_actual_device_location(engine, seeded):
    prepare(engine, seeded)
    recorded = now()
    moved = {"latitude": 24.93, "longitude": 67.1}
    with Session(engine) as db:
        crew = db.get(Crew, CREW_ID)
        crew.start_location = moved
        crew.location_recorded_at = recorded
        crew.location_received_at = recorded
        crew.location_revision = 1
        db.commit()
    assert provision(engine, seeded["outsider"], check=True)["status"] == "ready"
    assert prepare(engine, seeded)["status"] == "ready"
    with Session(engine) as db:
        crew = db.get(Crew, CREW_ID)
        assert crew.start_location == moved
        assert crew.location_recorded_at == recorded
        assert crew.location_revision == 1
