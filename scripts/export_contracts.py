"""Export proposed OpenAPI, integration schemas, and validated example payloads."""

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import UUID

from pydantic import TypeAdapter

from api import pilot_schemas as P
from api import schemas as S
from api.auth import Principal
from api.config import Settings
from api.followup_ai import FollowupIntent
from api.main import create_app

DEST = Path(__file__).resolve().parents[1] / "docs" / "backend"


def fixtures():
    rid = UUID("10000000-0000-4000-8000-000000000001")
    jid = UUID("20000000-0000-4000-8000-000000000001")
    cid = UUID("30000000-0000-4000-8000-000000000001")
    pid = UUID("40000000-0000-4000-8000-000000000001")
    conversation_id = UUID("50000000-0000-4000-8000-000000000001")
    instant = datetime(2026, 10, 16, 22, 0, tzinfo=timezone.utc)
    location = S.Location(
        latitude=24.923,
        longitude=67.092,
        landmark="Illustrative Gulshan-e-Iqbal location",
    )
    report = S.ReportView(
        id=rid,
        public_reference="WG-A1B2C3D4E5F6",
        title="Illustrative litter near park gate",
        address="Illustrative park entrance, Gulshan-e-Iqbal, Karachi",
        state="received",
        display_status="received",
        dashboard_status="submitted",
        location=location,
        note="ILLUSTRATIVE: litter near park gate",
        clarifications=[],
        photo_id=pid,
        completion_photo_ids=[],
        job_id=None,
        version=1,
        illustrative=True,
        created_at=instant,
        updated_at=instant,
        latest_update=S.ReportUpdate(
            id=UUID("80000000-0000-4000-8000-000000000001"),
            kind="report.received",
            created_at=instant,
            message="Your report has been received.",
            status="submitted",
            report_state="received",
            job_status=None,
        ),
        timeline=[],
    )
    organizer_report = S.OrganizerReportView.model_validate(
        {**report.model_dump(), "triage": None}
    )
    snapshot = S.Snapshot(report=organizer_report, job=None)
    crew = S.CrewView(
        id=cid,
        name="Illustrative Crew A",
        equipment=["gloves", "trash_bags", "broom", "shovel"],
        shift_minutes=120,
        available=True,
        start_location=location,
        illustrative=True,
        version=1,
    )
    job = S.JobView(
        id=jid,
        status="unassigned",
        location=location,
        category="litter",
        required_equipment=["gloves", "trash_bags"],
        estimated_service_minutes=15,
        assigned_crew_id=None,
        locked=False,
        held=False,
        route_position=None,
        travel_minutes=0,
        decision_summary="Illustrative recommendation",
        unassigned_reason="planning_pending",
        version=1,
        illustrative=True,
    )
    planning = S.PlanningInput(
        jobs=[job],
        crews=[crew],
        fixed_assignments=[],
        completed_minutes={str(cid): 0},
        node_ids=[f"crew:{cid}", f"job:{jid}"],
        travel_minutes=[[0, 0], [0, 0]],
        travel_estimates_label="Illustrative estimate: straight-line distance × 1.3 at 20 km/h; no live traffic",
        revision="EXAMPLE_REVISION_REPLACE_WITH_CURRENT_INPUT",
    )
    conversation = S.ConversationView(
        id=conversation_id,
        report_id=rid,
        channel="imessage",
        external_id="illustrative-photon-space",
    )
    return {
        "report": report,
        "report-updates": S.ReportUpdates(
            items=[report.latest_update], limit=50, offset=0, total=1
        ),
        "organizer-report-list": [organizer_report],
        "organizer-report-detail": S.ReportDetails(report=organizer_report, events=[]),
        "auth-me": Principal(
            user_id=UUID("60000000-0000-4000-8000-000000000002"),
            role="organizer",
            crew_id=None,
        ),
        "conversation": conversation,
        "conversation-snapshot": snapshot,
        "incoming-followup": S.IncomingFollowup(
            message_id="illustrative-inbound-1", text="What is the status?"
        ),
        "followup-task": S.TaskView(
            id=UUID("60000000-0000-4000-8000-000000000003"),
            kind="followup",
            status="pending",
            attempts=0,
            last_error=None,
            result=None,
            created_at=instant,
        ),
        "delivery-ack": S.DeliveryAck(
            lease_id=UUID("90000000-0000-4000-8000-000000000001"),
            sent_text="Your report has been received.",
            provider_message_id="illustrative-outbound-1",
        ),
        "delivery-status": S.DeliveryStatus(
            id=UUID("70000000-0000-4000-8000-000000000001"),
            delivered_at=instant,
        ),
        "report-messages": S.ConversationMessages(
            items=[
                S.ConversationMessageView(
                    id=UUID("60000000-0000-4000-8000-000000000004"),
                    created_at=instant,
                    direction="inbound",
                    body="What is the status?",
                )
            ],
            limit=50,
            offset=0,
            total=1,
        ),
        "report-created": S.ReportCreated(
            report=report, access_token="EXAMPLE_ONLY_SAVE_ACTUAL_TOKEN_SECURELY"
        ),
        "crew": crew,
        "job": job,
        "triage-input": S.TriageInput(
            snapshot=snapshot,
            photo_url="https://example.invalid/short-lived-photo-url",
            nearby_reports=[],
            equipment_catalog=list(S.Equipment),
        ),
        "triage-recommendation": S.TriageRecommendation(
            command_id=UUID("60000000-0000-4000-8000-000000000001"),
            expected_version=1,
            report_id=rid,
            category="litter",
            proposed_equipment=["gloves", "trash_bags"],
            evidence_sufficient=True,
            missing_information=[],
            decision_summary="Illustrative routine cleanup recommendation",
            evidence_report_ids=[rid],
            next_action="create_job",
            estimated_service_minutes=15,
        ),
        "planning-input": planning,
        "plan-proposal": S.PlanProposal(
            revision=planning.revision,
            assignments=[
                S.PlanStop(
                    job_id=jid,
                    crew_id=cid,
                    position=0,
                    travel_minutes=0,
                    service_minutes=15,
                )
            ],
            unassigned=[],
            travel_estimates_label=planning.travel_estimates_label,
        ),
        "followup-input": S.FollowupInput(
            conversation=conversation,
            incoming_message="What is the status?",
            snapshot=snapshot,
        ),
        "followup-result": S.FollowupResult(
            reply_text="Your report has been received and is awaiting triage.",
            action=S.NoAction(),
        ),
        "outgoing-message": S.OutgoingView(
            id=UUID("70000000-0000-4000-8000-000000000001"),
            event_id=UUID("80000000-0000-4000-8000-000000000001"),
            conversation=conversation,
            payload={"kind": "report.received", "report_id": str(rid)},
            attempts=1,
            lease_id=UUID("90000000-0000-4000-8000-000000000001"),
            leased_until=instant,
        ),
        "pilot-inbound": P.PilotInboundEnvelope(
            project_id="example-project",
            agent_sender_id="example-bot",
            external_id="example-private-chat",
            message_id="example-inbound-1",
            peer_id="example-resident",
            space_kind="direct",
            text="What is the status?",
            created_at=instant,
        ),
        "pilot-outgoing": P.PilotOutgoingView(
            id=UUID("70000000-0000-4000-8000-000000000001"),
            lease_id=UUID("90000000-0000-4000-8000-000000000001"),
            thread_id=conversation_id,
            external_id="example-private-chat",
            sender_id="example-bot",
            text="WG-A1B2C3D4E5F6: Your report has been received.",
            provider_message_id=None,
            status="leased",
            consent_revision=1,
        ),
        "pilot-links": P.ResidentMessagingLinks(
            enabled=True,
            recipient="example-bot@invalid.example",
            links=[
                P.ResidentMessagingLink(
                    id=conversation_id, channel="imessage", active=True, paused=False
                )
            ],
        ),
        "followup-intent": FollowupIntent(kind="status"),
        "error": S.ErrorResponse(
            detail="State changed; fetch current state before retrying"
        ),
    }


def artifacts():
    app = create_app(Settings(_env_file=None))
    try:
        result = {"openapi.json": app.openapi()}
    finally:
        app.state.cloud.close()
    for name in (
        "TriageInput",
        "TriageRecommendation",
        "PlanningInput",
        "PlanProposal",
        "FollowupInput",
        "FollowupResult",
    ):
        result[f"schemas/{name}.json"] = getattr(S, name).model_json_schema()
    result["schemas/FollowupIntent.json"] = FollowupIntent.model_json_schema()
    result.update(
        {
            f"fixtures/{name}.json": TypeAdapter(Any).dump_python(value, mode="json")
            for name, value in fixtures().items()
        }
    )
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    for relative, value in artifacts().items():
        path = DEST / relative
        data = json.dumps(value, indent=2, ensure_ascii=False, sort_keys=True) + "\n"
        if args.check:
            if not path.exists() or path.read_text() != data:
                raise SystemExit(f"Contract export is stale: {relative}")
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(data)
    print("Contracts verified" if args.check else "Contracts exported")


if __name__ == "__main__":
    main()
