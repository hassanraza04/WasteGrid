"""Grant a protected backend role to an existing Supabase Auth user."""

import argparse
from uuid import UUID

from sqlalchemy.orm import Session

from api.config import Settings
from api.db import make_engine, mutation_lock
from api.models import Crew, StaffRole


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--user-id", type=UUID, required=True)
    parser.add_argument("--role", choices=["organizer", "crew"], required=True)
    parser.add_argument("--crew-id", type=UUID)
    args = parser.parse_args()
    if (args.role == "crew") != bool(args.crew_id):
        parser.error("Crew roles require --crew-id; organizer roles must omit it")
    engine = make_engine(Settings())
    if engine is None:
        raise SystemExit("Configure DATABASE_URL")
    try:
        with Session(engine) as db:
            mutation_lock(db)
            if args.crew_id and db.get(Crew, args.crew_id) is None:
                raise SystemExit("Crew does not exist")
            role = db.get(StaffRole, args.user_id)
            if role is None:
                role = StaffRole(user_id=args.user_id)
                db.add(role)
            role.role = args.role
            role.crew_id = args.crew_id
            db.commit()
            print("Staff role provisioned")
    finally:
        engine.dispose()


if __name__ == "__main__":
    main()
