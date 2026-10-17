"""Person 3 owns these computations. Backend providers never write the database."""

import json
from importlib import import_module
from typing import Protocol

import httpx

from api.assessment import INSTRUCTION, AssessmentOutput
from api.config import Settings
from api.schemas import (
    FollowupInput,
    FollowupResult,
    Location,
    PlanningInput,
    PlanProposal,
    ResidentAnswers,
    TriageInput,
    TriageRecommendation,
    WasteAssessment,
)


class DecisionProvider(Protocol):
    def triage_report(self, request: TriageInput) -> TriageRecommendation: ...
    def generate_plan(self, request: PlanningInput) -> PlanProposal: ...
    def handle_followup(self, request: FollowupInput) -> FollowupResult: ...
    def close(self) -> None: ...


class HTTPDecisionProvider:
    """Proposed HTTP facade around Person 3's Chalk/Python implementation."""

    def __init__(self, settings: Settings):
        headers = {}
        if settings.person3_api_key:
            headers["Authorization"] = (
                "Bearer " + settings.person3_api_key.get_secret_value()
            )
        self.client = httpx.Client(
            base_url=settings.person3_base_url.rstrip("/") + "/",
            headers=headers,
            timeout=60,
        )

    def call(self, path, request, schema):
        response = self.client.post(path, json=request.model_dump(mode="json"))
        response.raise_for_status()
        return schema.model_validate(response.json())

    def triage_report(self, request: TriageInput) -> TriageRecommendation:
        return self.call("triage", request, TriageRecommendation)

    def generate_plan(self, request: PlanningInput) -> PlanProposal:
        return self.call("plan", request, PlanProposal)

    def handle_followup(self, request: FollowupInput) -> FollowupResult:
        return self.call("followup", request, FollowupResult)

    def close(self):
        self.client.close()


def load_provider(settings: Settings) -> DecisionProvider | None:
    if settings.integration_factory:
        module, name = settings.integration_factory.split(":", 1)
        return getattr(import_module(module), name)(settings)
    if settings.person3_base_url:
        return HTTPDecisionProvider(settings)
    if settings.chalk_router_api_key and settings.chalk_env_id:
        from api.decisions import AssessmentDecisionProvider

        return AssessmentDecisionProvider(settings.duplicate_radius_meters)
    return None


class ChalkAssessmentClient:
    """One gateway request, no SDK retries, tool loop, or output repair."""

    def __init__(self, settings: Settings):
        if not settings.chalk_router_api_key or not settings.chalk_env_id:
            raise ValueError("Configure CHALK_ROUTER_API_KEY and CHALK_ENV_ID")
        self.model = settings.chalk_model
        self.reasoning_effort = settings.chalk_reasoning_effort
        self.client = httpx.Client(
            base_url=settings.chalk_router_base_url.rstrip("/") + "/",
            headers={
                "Authorization": "Bearer "
                + settings.chalk_router_api_key.get_secret_value(),
                "X-Chalk-Env-Id": settings.chalk_env_id,
            },
            timeout=settings.assessment_timeout_seconds,
        )

    def assess(
        self,
        photo_url: str,
        note: str | None,
        location: dict | None = None,
        resident_answers: dict | None = None,
    ) -> WasteAssessment:
        location_value = (
            Location.model_validate(location).model_dump() if location else None
        )
        answers = ResidentAnswers.model_validate(resident_answers or {}).model_dump(
            exclude_none=True
        )
        response = self.client.post(
            "chat/completions",
            json={
                "model": self.model,
                "max_tokens": 600,
                **(
                    {"reasoning_effort": self.reasoning_effort}
                    if self.reasoning_effort is not None
                    else {}
                ),
                "response_format": {"type": "json_object"},
                "messages": [
                    {
                        "role": "system",
                        "content": INSTRUCTION
                        + "\nJSON schema: "
                        + json.dumps(AssessmentOutput.model_json_schema()),
                    },
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "text",
                                "text": json.dumps(
                                    {
                                        "resident_note": note,
                                        "location": location_value,
                                        "resident_answers": answers,
                                    }
                                ),
                            },
                            {"type": "image_url", "image_url": {"url": photo_url}},
                        ],
                    },
                ],
            },
        )
        response.raise_for_status()
        return AssessmentOutput.model_validate_json(
            response.json()["choices"][0]["message"]["content"]
        )

    def close(self):
        self.client.close()
