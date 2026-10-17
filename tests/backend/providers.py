"""Test-only deterministic provider. This is not Chalk or a production planner."""

from uuid import uuid4

from api.schemas import (
    FollowupResult,
    PlanProposal,
    PlanStop,
    TriageRecommendation,
    UnassignedJob,
)


class TestProvider:
    __test__ = False

    def triage_report(self, request):
        r = request.snapshot.report
        note = (r.note or "").lower()
        hazard = "hazard" in note
        missing = r.location is None
        return TriageRecommendation(
            command_id=uuid4(),
            report_id=r.id,
            expected_version=r.version,
            category="litter",
            proposed_equipment=["gloves", "trash_bags"],
            hazard=hazard,
            evidence_sufficient=True,
            missing_information=["location"] if missing else [],
            decision_summary="Test-only structured recommendation",
            evidence_report_ids=[r.id],
            next_action=(
                "review" if hazard else "request_info" if missing else "create_job"
            ),
            estimated_service_minutes=15,
        )

    def generate_plan(self, request):
        index = {node: i for i, node in enumerate(request.node_ids)}
        stops = list(request.fixed_assignments)
        totals = dict(request.completed_minutes)
        tail = {c.id: f"crew:{c.id}" for c in request.crews}
        positions = {c.id: 0 for c in request.crews}
        for stop in sorted(stops, key=lambda s: s.position):
            totals[str(stop.crew_id)] += stop.service_minutes + stop.travel_minutes
            tail[stop.crew_id] = f"job:{stop.job_id}"
            positions[stop.crew_id] = max(positions[stop.crew_id], stop.position + 1)
        fixed = {s.job_id for s in stops}
        unassigned = []
        for job in request.jobs:
            if job.id in fixed:
                continue
            if job.held or job.status in ("blocked", "recheck_requested"):
                unassigned.append(
                    UnassignedJob(
                        job_id=job.id, reason_code="held" if job.held else job.status
                    )
                )
                continue
            eligible = [
                c
                for c in request.crews
                if c.available and set(job.required_equipment) <= set(c.equipment)
            ]
            chosen = False
            for crew in eligible:
                travel = request.travel_minutes[index[tail[crew.id]]][
                    index[f"job:{job.id}"]
                ]
                cost = travel + job.estimated_service_minutes
                if totals[str(crew.id)] + cost <= crew.shift_minutes:
                    stops.append(
                        PlanStop(
                            job_id=job.id,
                            crew_id=crew.id,
                            position=positions[crew.id],
                            travel_minutes=travel,
                            service_minutes=job.estimated_service_minutes,
                        )
                    )
                    positions[crew.id] += 1
                    totals[str(crew.id)] += cost
                    tail[crew.id] = f"job:{job.id}"
                    chosen = True
                    break
            if not chosen:
                unassigned.append(
                    UnassignedJob(
                        job_id=job.id,
                        reason_code="shift_limit" if eligible else "no_eligible_crew",
                    )
                )
        return PlanProposal(
            revision=request.revision,
            assignments=stops,
            unassigned=unassigned,
            travel_estimates_label=request.travel_estimates_label,
        )

    def handle_followup(self, request):
        return FollowupResult(
            reply_text=f"Stored status: {request.snapshot.report.display_status}",
            action={"kind": "none"},
        )

    def close(self):
        pass
