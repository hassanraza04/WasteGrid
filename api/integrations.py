"""Person 3 owns these computations. Backend providers never write the database."""

from importlib import import_module
from typing import Protocol

import httpx

from api.config import Settings
from api.schemas import (
    FollowupInput,
    FollowupResult,
    PlanningInput,
    PlanProposal,
    TriageInput,
    TriageRecommendation,
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
    return None
