"""Provision one isolated demo crew for an existing Supabase Auth account.

This command never creates an Auth account, resets work, or fabricates fresh GPS.
"""

import argparse
import json
from hashlib import sha256
from uuid import NAMESPACE_URL, UUID, uuid5

from pydantic import ValidationError
from sqlalchemy import select, text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from api.config import Settings
from api.db import make_engine, mutation_lock
from api.models import Assignment, Crew, Event, Job, StaffRole
from api.schemas import Equipment, Location

CREW_ID = uuid5(NAMESPACE_URL, "wastegrid:hackathon-demo-crew:v1")
CREW_NAME = "Hackathon Demo Crew"
PROVISION_COMMAND_ID = uuid5(CREW_ID, "provision")
OWNER = "script:provision_demo_crew"
DEFAULT_EQUIPMENT = ("gloves", "trash_bags", "broom")


class ProvisionRefused(ValueError):
    """An actionable refusal without database/provider exception details."""


def provision(engine, user_id, location=None, equipment=None, *, check=False):
    """Create atomically, or verify the same unused crew without changing it."""
    items = sorted(set(equipment or DEFAULT_EQUIPMENT))
    if not set(items) <= {item.value for item in Equipment}:
        raise ProvisionRefused("Use equipment from the supported catalog")
    if location is not None:
        location = Location.model_validate(location)
    with Session(engine) as db:
        if check:
            db.execute(text("SET TRANSACTION READ ONLY"))
        else:
            mutation_lock(db)
        if not db.scalar(
            text("SELECT id FROM auth.users WHERE id = :user_id"),
            {"user_id": user_id},
        ):
            raise ProvisionRefused("The designated Supabase Auth user does not exist")
        role = db.get(StaffRole, user_id)
        if role is not None and (role.role != "crew" or role.crew_id != CREW_ID):
            raise ProvisionRefused(
                "The user already has a different staff role; choose a dedicated account"
            )
        if db.scalar(
            select(Crew.id).where(Crew.name == CREW_NAME, Crew.id != CREW_ID).limit(1)
        ):
            raise ProvisionRefused("Another crew already uses the demo name")
        other_owner = db.scalar(
            select(StaffRole.user_id)
            .where(StaffRole.crew_id == CREW_ID, StaffRole.user_id != user_id)
            .limit(1)
        )
        if other_owner is not None:
            raise ProvisionRefused("The demo crew belongs to another staff account")
        crew = db.get(Crew, CREW_ID)
        marker = db.scalar(
            select(Event).where(Event.command_id == PROVISION_COMMAND_ID)
        )
        details = {"purpose": "hackathon-finish-v1", "user_id": str(user_id)}
        fingerprint = sha256(json.dumps(details, sort_keys=True).encode()).hexdigest()
        if crew is not None:
            if (
                role is None
                or marker is None
                or marker.kind != "crew.demo_provisioned"
                or marker.crew_id != CREW_ID
                or marker.actor != OWNER
                or marker.request_hash != fingerprint
                or marker.details != details
            ):
                raise ProvisionRefused("Existing crew ownership cannot be verified")
            if (
                crew.name != CREW_NAME
                or crew.illustrative
                or not crew.available
                or crew.shift_minutes != 120
                or sorted(crew.equipment) != items
            ):
                raise ProvisionRefused(
                    "Demo crew configuration changed; it will not be overwritten"
                )
            current_job = db.scalar(
                select(Job.id).where(Job.assigned_crew_id == CREW_ID).limit(1)
            )
            historical_assignment = db.scalar(
                select(Assignment.id).where(Assignment.crew_id == CREW_ID).limit(1)
            )
            if current_job is not None or historical_assignment is not None:
                raise ProvisionRefused(
                    "Demo crew has current or historical assignments; no reset is permitted"
                )
            status = "ready"
        else:
            if role is not None or marker is not None:
                raise ProvisionRefused(
                    "Incomplete demo ownership records require review"
                )
            if location is None:
                raise ProvisionRefused(
                    "Initial creation requires explicit --latitude and --longitude"
                )
            status = "would_create" if check else "created"
            if not check:
                crew = Crew(
                    id=CREW_ID,
                    name=CREW_NAME,
                    equipment=items,
                    shift_minutes=120,
                    available=True,
                    start_location=location.model_dump(mode="json"),
                    illustrative=False,
                    location_recorded_at=None,
                    location_received_at=None,
                    location_revision=0,
                )
                db.add(crew)
                db.flush()
                db.add(StaffRole(user_id=user_id, role="crew", crew_id=CREW_ID))
                db.add(
                    Event(
                        kind="crew.demo_provisioned",
                        crew_id=CREW_ID,
                        command_id=PROVISION_COMMAND_ID,
                        request_hash=fingerprint,
                        actor=OWNER,
                        details=details,
                    )
                )
                db.commit()
        return {
            "status": status,
            "crew_id": str(CREW_ID),
            "crew_name": CREW_NAME,
            "user_id": str(user_id),
            "fresh_device_gps_required_for_dispatch": True,
        }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", default=".env")
    parser.add_argument("--user-id", type=UUID, required=True)
    parser.add_argument("--latitude", type=float)
    parser.add_argument("--longitude", type=float)
    parser.add_argument(
        "--equipment", nargs="+", choices=[item.value for item in Equipment]
    )
    parser.add_argument(
        "--check", action="store_true", help="Read-only preparation check"
    )
    args = parser.parse_args()
    if (args.latitude is None) != (args.longitude is None):
        parser.error("Provide both latitude and longitude, or neither")
    engine = None
    try:
        location = (
            Location(latitude=args.latitude, longitude=args.longitude)
            if args.latitude is not None
            else None
        )
        engine = make_engine(Settings(_env_file=args.env_file))
        if engine is None:
            raise ProvisionRefused("Configure DATABASE_URL in the backend environment")
        result = provision(
            engine, args.user_id, location, args.equipment, check=args.check
        )
    except ProvisionRefused as exc:
        parser.exit(1, f"Provisioning refused: {exc}\n")
    except ValidationError:
        parser.exit(1, "Invalid coordinates or backend configuration\n")
    except SQLAlchemyError:
        parser.exit(1, "Database outcome unavailable; rerun --check before retrying\n")
    else:
        print(json.dumps(result))
    finally:
        if engine is not None:
            engine.dispose()


if __name__ == "__main__":
    main()
