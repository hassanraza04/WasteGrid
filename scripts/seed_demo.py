"""Create clearly illustrative demo data. Run only against the demo project."""

import argparse
from io import BytesIO
from secrets import token_urlsafe
from uuid import NAMESPACE_URL, uuid4, uuid5

from PIL import Image, ImageDraw
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from api.assessment import calculate_priority
from api.auth import digest
from api.config import Settings
from api.db import make_engine, mutation_lock
from api.models import (
    Assignment,
    Conversation,
    ConversationMessage,
    Crew,
    Event,
    Job,
    LinkCode,
    OutgoingMessage,
    Photo,
    Plan,
    Report,
    Task,
)
from api.schemas import (
    PlanProposal,
    PlanStop,
    TriageRecommendation,
    UnassignedJob,
    WasteAssessment,
)
from api.services import event
from api.storage import SupabaseCloud
from api.workflows import apply_plan, apply_triage, build_planning_input

NAMESPACE = uuid5(NAMESPACE_URL, "wastegrid:gulshan-illustrative-demo:v1")


def demo_id(name):
    return uuid5(NAMESPACE, name)


def fixture_photo(label):
    image = Image.new("RGB", (640, 360), "#eef5e9")
    drawing = ImageDraw.Draw(image)
    drawing.text((24, 30), "ILLUSTRATIVE WASTEGRID FIXTURE", fill="#163020")
    drawing.text(
        (24, 65), "Synthetic test image - not real cleanup evidence", fill="#163020"
    )
    drawing.text((24, 110), label, fill="#163020")
    buffer = BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


SCENARIOS = [
    ("Park-side litter", "routine", 10, ["gloves", "trash_bags", "broom"]),
    ("Bagged litter near a bus stop", "routine", 15, ["gloves", "trash_bags"]),
    ("Location needs clarification", "missing", 15, ["gloves", "trash_bags"]),
    (
        "Possible nearby duplicate; review needed",
        "possible_duplicate",
        15,
        ["gloves", "trash_bags"],
    ),
    ("Suspected hazardous containers", "hazard", 15, ["gloves", "trash_bags"]),
    ("Bulky waste requiring a pickup", "routine", 40, ["gloves", "pickup_truck"]),
    ("Large cleanup exceeds both shifts", "routine", 240, ["gloves", "shovel"]),
    ("Street sweeping", "routine", 15, ["gloves", "broom"]),
    ("Alley rubble requiring a wheelbarrow", "routine", 35, ["gloves", "wheelbarrow"]),
    (
        "Confirmed second report of park-side litter",
        "duplicate",
        10,
        ["gloves", "trash_bags"],
    ),
]


def seed(engine, cloud, reset=False):
    uploaded, removed = [], []
    committed = False
    try:
        with Session(engine) as db:
            mutation_lock(db)
            reports = list(db.scalars(select(Report)))
            jobs = list(db.scalars(select(Job)))
            if any(not r.illustrative for r in reports) or any(
                not j.illustrative for j in jobs
            ):
                raise RuntimeError(
                    "Seed/reset requires a demo-only database; real reports/jobs are present"
                )
            if reports and not reset:
                return {"status": "already_seeded", "reports": len(reports)}
            if reset:
                removed = list(db.scalars(select(Photo.object_path)))
                for model in (
                    ConversationMessage,
                    OutgoingMessage,
                    Task,
                    Assignment,
                    Plan,
                    Event,
                    Conversation,
                    LinkCode,
                    Photo,
                    Report,
                    Job,
                ):
                    db.execute(delete(model))
                db.flush()
            for name, equipment, shift in [
                ("A", ["gloves", "trash_bags", "broom", "shovel"], 120),
                (
                    "B",
                    ["gloves", "trash_bags", "shovel", "wheelbarrow", "pickup_truck"],
                    180,
                ),
            ]:
                cid = demo_id("crew-" + name)
                crew = db.get(Crew, cid)
                if crew is None:
                    crew = Crew(id=cid)
                    db.add(crew)
                crew.name = f"Illustrative Crew {name}"
                crew.equipment = equipment
                crew.shift_minutes = shift
                crew.available = True
                crew.start_location = {
                    "latitude": 24.923,
                    "longitude": 67.092,
                    "landmark": "Illustrative Gulshan-e-Iqbal depot",
                }
                crew.illustrative = True
            db.flush()
            job_ids = {}
            for i, (label, kind, minutes, equipment) in enumerate(SCENARIOS):
                rid, pid = demo_id(f"report-{i}"), demo_id(f"photo-{i}")
                # No resident token is published for seeded reports. Create a fresh
                # report through the app to demonstrate resident access and linking.
                row = Report(
                    id=rid,
                    token_hash=digest(token_urlsafe(32)),
                    photo_id=pid,
                    title="Illustrative: " + label,
                    address=(
                        None
                        if kind == "missing"
                        else "Illustrative park entrance, Gulshan-e-Iqbal, Karachi"
                    ),
                    location=(
                        None
                        if kind == "missing"
                        else {
                            "latitude": 24.920 + i * 0.0003,
                            "longitude": 67.090 + i * 0.0002,
                            "landmark": "Illustrative Gulshan-e-Iqbal location",
                        }
                    ),
                    note="ILLUSTRATIVE: " + label,
                    illustrative=True,
                )
                # Explicit synthetic evidence, never represented as a live AI result.
                assessment = WasteAssessment(
                    description="Illustrative: " + label,
                    size="medium",
                    obstruction="none_visible",
                    obstruction_level="none",
                    forces_people_into_traffic="no",
                    special_handling=(
                        "suspected" if kind == "hazard" else "none_identified"
                    ),
                    visible_fire="no",
                    visible_sharp_objects="no",
                    reason="Illustrative fixture; not an actual model result.",
                )
                priority = calculate_priority(assessment)
                row.assessment = assessment.model_dump(mode="json")
                row.assessment_status = (
                    "needs_review" if priority.needs_review else "assessed"
                )
                row.priority = priority.priority
                row.needs_review = priority.needs_review
                row.priority_reason = priority.priority_reason
                db.add(row)
                db.flush()
                content = fixture_photo(label)
                path = f"demo/{rid}/{uuid4()}.png"
                cloud.upload(path, content, "image/png")
                uploaded.append(path)
                db.add(
                    Photo(
                        id=pid,
                        object_path=path,
                        report_id=rid,
                        content_type="image/png",
                        size_bytes=len(content),
                    )
                )
                event(db, "report.received", report_id=rid, actor="demo-seed")
                proposal = TriageRecommendation(
                    command_id=demo_id(f"triage-{i}"),
                    expected_version=1,
                    report_id=rid,
                    category="illustrative_cleanup",
                    proposed_equipment=equipment,
                    duplicate_candidate_id=(
                        demo_id("report-0")
                        if kind in ("duplicate", "possible_duplicate")
                        else None
                    ),
                    duplicate_confirmed=kind == "duplicate",
                    hazard=kind == "hazard",
                    evidence_sufficient=True,
                    missing_information=(
                        ["Actionable location"] if kind == "missing" else []
                    ),
                    decision_summary="Illustrative fixture decision; not an actual model result. "
                    + label,
                    evidence_report_ids=[rid]
                    + (
                        [demo_id("report-0")]
                        if kind in ("duplicate", "possible_duplicate")
                        else []
                    ),
                    next_action=(
                        "request_info"
                        if kind == "missing"
                        else (
                            "review"
                            if kind in ("hazard", "possible_duplicate")
                            else "link_job" if kind == "duplicate" else "create_job"
                        )
                    ),
                    estimated_service_minutes=minutes,
                )
                apply_triage(db, proposal, actor="demo-seed")
                if row.job_id:
                    job_ids[i] = row.job_id
            # Fixture assignments go through the same feasibility validator.
            db.execute(delete(Task))
            inputs = build_planning_input(db)
            nodes = {node: i for i, node in enumerate(inputs.node_ids)}
            stops = []
            for crew_name, indices in [("A", [0, 1, 7]), ("B", [5, 8])]:
                cid = demo_id("crew-" + crew_name)
                previous = f"crew:{cid}"
                for position, index in enumerate(indices):
                    jid = job_ids[index]
                    travel = inputs.travel_minutes[nodes[previous]][nodes[f"job:{jid}"]]
                    stops.append(
                        PlanStop(
                            job_id=jid,
                            crew_id=cid,
                            position=position,
                            travel_minutes=travel,
                            service_minutes=SCENARIOS[index][2],
                        )
                    )
                    previous = f"job:{jid}"
            apply_plan(
                db,
                PlanProposal(
                    revision=inputs.revision,
                    assignments=stops,
                    unassigned=[
                        UnassignedJob(job_id=job_ids[6], reason_code="shift_limit")
                    ],
                    travel_estimates_label=inputs.travel_estimates_label,
                ),
            )
            db.commit()
            committed = True
        cleanup_pending = []
        for path in set(removed) - set(uploaded):
            try:
                cloud.delete(path)
            except Exception:
                cleanup_pending.append(path)
        return {
            "status": "seeded",
            "reports": 10,
            "orphan_cleanup_pending": cleanup_pending,
            "crews": {"A": str(demo_id("crew-A")), "B": str(demo_id("crew-B"))},
        }
    except Exception:
        for path in uploaded if not committed else []:
            if path not in removed:
                try:
                    cloud.delete(path)
                except Exception:
                    pass
        raise


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--reset-demo", action="store_true")
    args = parser.parse_args()
    settings = Settings()
    engine = make_engine(settings)
    cloud = SupabaseCloud(settings)
    if engine is None:
        raise SystemExit("Configure DATABASE_URL")
    try:
        print(seed(engine, cloud, args.reset_demo))
    finally:
        cloud.close()
        engine.dispose()


if __name__ == "__main__":
    main()
