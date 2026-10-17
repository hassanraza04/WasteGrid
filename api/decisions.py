"""Minimal deterministic Person 3 decisions over validated backend snapshots.

The photo assessment is the only model call. This provider never writes state.
"""

from uuid import uuid4

from api.assessment import calculate_priority
from api.schemas import (
    FollowupInput,
    FollowupResult,
    PlanningInput,
    PlanProposal,
    PlanStop,
    TriageInput,
    TriageRecommendation,
    UnassignedJob,
)


class AssessmentDecisionProvider:
    def __init__(self, duplicate_radius_meters=10):
        self.duplicate_radius_meters = duplicate_radius_meters

    def triage_report(self, request: TriageInput) -> TriageRecommendation:
        from api.workflows import distance_km

        report = request.snapshot.report
        result = (
            calculate_priority(report.assessment, report.resident_answers)
            if report.assessment is not None
            else None
        )
        eligible = bool(
            report.assessment_status == "assessed"
            and not report.needs_review
            and result is not None
            and not result.needs_review
            and result.priority is not None
        )
        nearby = next(
            (
                item.report
                for item in request.nearby_reports
                if self.duplicate_radius_meters > 0
                and report.location is not None
                and item.report.location is not None
                and not item.report.illustrative
                and (
                    item.job is None
                    or item.job.status not in ("completed", "recheck_requested")
                )
                and distance_km(
                    report.location.model_dump(), item.report.location.model_dump()
                )
                * 1000
                <= self.duplicate_radius_meters
            ),
            None,
        )
        size = report.assessment.size if report.assessment else "unknown"
        equipment = ["gloves", "trash_bags"] + (
            ["pickup_truck"] if size == "large" else []
        )
        catalog_ok = set(equipment) <= set(request.equipment_catalog)
        missing = ["location"] if report.location is None else []
        action = (
            "review"
            if not eligible or nearby or not catalog_ok
            else "request_info" if missing else "create_job"
        )
        return TriageRecommendation(
            command_id=uuid4(),
            report_id=report.id,
            expected_version=report.version,
            category="mixed_waste",
            proposed_equipment=equipment,
            duplicate_candidate_id=nearby.id if nearby else None,
            duplicate_confirmed=False,
            hazard=bool(result and result.needs_review),
            evidence_sufficient=eligible and catalog_ok,
            missing_information=missing,
            decision_summary=(
                "Nearby report is only a possible duplicate; organizer review required."
                if nearby
                else report.priority_reason or "Assessment requires organizer review."
            ),
            evidence_report_ids=[report.id] + ([nearby.id] if nearby else []),
            next_action=action,
            estimated_service_minutes={
                "small": 10,
                "medium": 20,
                "large": 40,
                "unknown": 30,
            }[size],
        )

    def generate_plan(self, request: PlanningInput) -> PlanProposal:
        """Greedy shortest next leg across eligible crews; not a global optimum."""
        nodes = {node: i for i, node in enumerate(request.node_ids)}
        jobs = {job.id: job for job in request.jobs}
        crews = {crew.id: crew for crew in request.crews}
        used = dict(request.completed_minutes)
        tails = {cid: f"crew:{cid}" for cid in crews}
        positions = {cid: 0 for cid in crews}
        stops = []
        for stop in sorted(
            request.fixed_assignments, key=lambda s: (str(s.crew_id), s.position)
        ):
            job = jobs[stop.job_id]
            travel = (
                stop.travel_minutes
                if job.status == "in_progress"
                else request.travel_minutes[nodes[tails[stop.crew_id]]][
                    nodes[f"job:{job.id}"]
                ]
            )
            stops.append(stop.model_copy(update={"travel_minutes": travel}))
            used[str(stop.crew_id)] += travel + stop.service_minutes
            tails[stop.crew_id] = f"job:{job.id}"
            positions[stop.crew_id] = max(positions[stop.crew_id], stop.position + 1)
        fixed = {stop.job_id for stop in stops}
        remaining = {jid: job for jid, job in jobs.items() if jid not in fixed}
        unassigned = []
        for jid, job in list(remaining.items()):
            if job.held or job.status in ("blocked", "recheck_requested"):
                unassigned.append(
                    UnassignedJob(
                        job_id=jid, reason_code="held" if job.held else job.status
                    )
                )
                del remaining[jid]

        def eligible_crews(job):
            return [
                crew
                for crew in crews.values()
                if crew.available and set(job.required_equipment) <= set(crew.equipment)
            ]

        while remaining:
            choices = []
            for jid, job in remaining.items():
                for crew in eligible_crews(job):
                    travel = request.travel_minutes[nodes[tails[crew.id]]][
                        nodes[f"job:{jid}"]
                    ]
                    if (
                        used[str(crew.id)] + travel + job.estimated_service_minutes
                        <= crew.shift_minutes
                    ):
                        choices.append(
                            (
                                travel,
                                used[str(crew.id)],
                                str(crew.id),
                                str(jid),
                                crew.id,
                                jid,
                            )
                        )
            if not choices:
                break
            travel, _, _, _, cid, jid = min(choices)
            job = remaining.pop(jid)
            stops.append(
                PlanStop(
                    job_id=jid,
                    crew_id=cid,
                    position=positions[cid],
                    travel_minutes=travel,
                    service_minutes=job.estimated_service_minutes,
                )
            )
            used[str(cid)] += travel + job.estimated_service_minutes
            tails[cid] = f"job:{jid}"
            positions[cid] += 1
        for jid, job in remaining.items():
            unassigned.append(
                UnassignedJob(
                    job_id=jid,
                    reason_code=(
                        "shift_limit" if eligible_crews(job) else "no_eligible_crew"
                    ),
                )
            )
        return PlanProposal(
            revision=request.revision,
            assignments=stops,
            unassigned=unassigned,
            travel_estimates_label=request.travel_estimates_label,
        )

    def handle_followup(self, request: FollowupInput) -> FollowupResult:
        report = request.snapshot.report
        # Explicit commands only. Free text is never interpreted as authority or GPS.
        text = request.incoming_message.strip()
        if text.startswith(("/recheck ", "/clarify ")) and len(text[9:].strip()) > 2000:
            return FollowupResult(
                reply_text="Please keep your additional information or recheck reason within 2000 characters.",
                action={"kind": "none"},
            )
        if (
            text.startswith("/recheck ")
            and request.snapshot.job
            and request.snapshot.job.status == "completed"
        ):
            return FollowupResult(
                reply_text="Your cleanup recheck request has been recorded.",
                action={
                    "kind": "recheck",
                    "data": {
                        "command_id": uuid4(),
                        "expected_version": request.snapshot.job.version,
                        "reason": text[9:].strip(),
                    },
                },
            )
        if text.startswith("/clarify ") and report.state not in (
            "received",
            "needs_info",
            "needs_review",
        ):
            return FollowupResult(
                reply_text=f"Report {report.public_reference}: {report.display_status}. Clarification is unavailable after job linking; contact the organizer for changes.",
                action={"kind": "none"},
            )
        if text.startswith("/clarify "):
            return FollowupResult(
                reply_text="Your additional report information has been recorded.",
                action={
                    "kind": "clarification",
                    "data": {
                        "command_id": uuid4(),
                        "expected_version": report.version,
                        "note": text[9:].strip(),
                    },
                },
            )
        return FollowupResult(
            reply_text=f"Report {report.public_reference}: {report.display_status}. "
            "Use /clarify followed by additional information, or /recheck followed by a reason after cleanup.",
            action={"kind": "none"},
        )

    def close(self):
        pass
