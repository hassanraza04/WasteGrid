"""Resident link codes may be minted only inside the active pilot scope."""

from uuid import UUID, uuid4

import pytest
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from api.models import LinkCode, MessagingPilot
from tests.backend import test_pilot_api
from tests.backend.conftest import auth

pilot = test_pilot_api.pilot


def request_code(pilot, *, token=None):
    created = pilot.reports[0]
    return pilot.client.post(
        f"/reports/{created['report']['id']}/followup-link",
        headers=auth(token or created["access_token"]),
        json={},
    )


@pytest.mark.parametrize(
    "field,value",
    [
        ("messaging_pilot_enabled", False),
        ("messaging_pilot_id", None),
        ("messaging_pilot_report_ids", []),
        ("messaging_pilot_report_ids", [uuid4()]),
        ("messaging_pilot_chat_ids", []),
        ("messaging_imessage_recipient", ""),
        ("photon_project_id", ""),
        ("photon_agent_sender_id", ""),
        ("organizer_routing_enabled", False),
    ],
)
def test_no_code_is_issued_before_pilot_activation(pilot, engine, field, value):
    settings = pilot.client.app.state.settings
    setattr(settings, field, value)
    response = request_code(pilot)
    assert response.status_code == 503, response.text
    with Session(engine) as db:
        assert db.scalar(select(func.count()).select_from(LinkCode)) == 0
        assert db.scalar(select(func.count()).select_from(MessagingPilot)) == 0


def test_link_code_requires_current_report_allowlist_and_resident_token(pilot, engine):
    settings = pilot.client.app.state.settings
    settings.messaging_pilot_report_ids = [uuid4(), uuid4()]
    assert request_code(pilot).status_code == 403
    assert (
        request_code(pilot, token=pilot.reports[1]["access_token"]).status_code == 404
    )
    with Session(engine) as db:
        assert db.scalar(select(func.count()).select_from(LinkCode)) == 0
        assert db.scalar(select(func.count()).select_from(MessagingPilot)) == 0


def test_code_creation_freezes_scope_without_charging_provider_budget(pilot, engine):
    response = request_code(pilot)
    assert response.status_code == 201, response.text
    settings = pilot.client.app.state.settings
    with Session(engine) as db:
        run = db.get(MessagingPilot, settings.messaging_pilot_id)
        assert run is not None
        assert run.report_ids == sorted(
            str(UUID(item["report"]["id"])) for item in pilot.reports
        )
        assert (run.image_calls, run.followup_calls, run.send_attempts) == (0, 0, 0)
        assert db.scalar(select(func.count()).select_from(LinkCode)) == 1

    settings.messaging_pilot_id = uuid4()
    assert request_code(pilot).status_code == 409
    with Session(engine) as db:
        assert db.scalar(select(func.count()).select_from(LinkCode)) == 1
        assert db.scalar(select(func.count()).select_from(MessagingPilot)) == 1
