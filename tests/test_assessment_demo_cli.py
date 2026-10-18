"""Operator preflight has no image side effects and refuses stale/dirty code."""

from types import SimpleNamespace

import pytest

from api.assessment_demo import DemoRefused
from api.config import Settings
from scripts.assessment_demo import require_configuration
from scripts.verify_assessment import VerificationRefused

REVISION = "a" * 40


def config(**changes):
    return Settings(
        _env_file=None,
        **{
            "organizer_routing_enabled": True,
            "chalk_model": "xai/grok-4.3",
            "chalk_router_api_key": "fake-router-key",
            "chalk_env_id": "fake-environment",
            "supabase_url": "https://test.invalid",
            "supabase_secret_key": "fake-storage-key",
            **changes,
        },
    )


def fake_checkout(monkeypatch, *, revision=REVISION, dirty=""):
    calls = []

    def run(args, **kwargs):
        calls.append(args)
        assert kwargs["timeout"] == 10 and kwargs["capture_output"]
        return SimpleNamespace(stdout=revision if "rev-parse" in args else dirty)

    monkeypatch.setattr("scripts.assessment_demo.subprocess.run", run)
    return calls


def test_preflight_checks_frozen_revision_and_safety_without_images(monkeypatch):
    calls = fake_checkout(monkeypatch)
    checked = []
    monkeypatch.setattr(
        "scripts.assessment_demo.require_deployed_api",
        lambda url, revision, client: checked.append((url, revision)),
    )
    require_configuration(config(), REVISION, "https://api.invalid")
    assert len(calls) == 2
    assert checked == [("https://api.invalid", REVISION)]


@pytest.mark.parametrize(
    "changes",
    [
        {"organizer_routing_enabled": False},
        {"chalk_model": "another/model"},
        {"chalk_router_api_key": None},
        {"chalk_env_id": ""},
        {"supabase_secret_key": None},
    ],
)
def test_preflight_refuses_incomplete_or_changed_configuration(monkeypatch, changes):
    fake_checkout(monkeypatch)
    with pytest.raises(DemoRefused):
        require_configuration(config(**changes), REVISION, "https://api.invalid")


def test_preflight_refuses_wrong_local_revision(monkeypatch):
    fake_checkout(monkeypatch, revision="b" * 40)
    with pytest.raises(DemoRefused, match="must match"):
        require_configuration(config(), REVISION, "https://api.invalid")


def test_preflight_refuses_unreviewed_local_changes(monkeypatch):
    fake_checkout(monkeypatch, dirty=" M api/worker.py")
    with pytest.raises(DemoRefused, match="clean worker checkout"):
        require_configuration(config(), REVISION, "https://api.invalid")


def test_preflight_propagates_only_sanitized_deployed_refusal(monkeypatch):
    fake_checkout(monkeypatch)

    def refuse(*args):
        raise VerificationRefused("Deployed revision or safety flags do not match")

    monkeypatch.setattr("scripts.assessment_demo.require_deployed_api", refuse)
    with pytest.raises(DemoRefused, match="Deployed revision"):
        require_configuration(config(), REVISION, "https://api.invalid")
