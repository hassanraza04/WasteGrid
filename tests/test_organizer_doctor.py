"""Startup checks distinguish configuration from worker/model readiness."""

import json

import httpx
import pytest

from scripts.organizer_doctor import (
    REQUIRED_PATHS,
    deployed_checks,
    public_configuration,
)


def configuration():
    return {
        "VITE_API_BASE_URL": "https://api.example",
        "VITE_SUPABASE_URL": "https://project.supabase.co",
        "VITE_SUPABASE_PUBLISHABLE_KEY": "sb_publishable_example",
        "DASHBOARD_ORIGIN": "http://127.0.0.1:5173",
        "CORS_ORIGINS": '["http://127.0.0.1:5173"]',
        "ORGANIZER_ROUTING_ENABLED": "true",
        "MESSAGING_PILOT_ENABLED": "false",
        "ROUTING_OSRM_BASE_URL": "https://routing.openstreetmap.de/routed-car",
    }


def test_valid_configuration_contains_no_ai_ready_claim():
    assert public_configuration(configuration()) == []


@pytest.mark.parametrize(
    "origin",
    [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "https://wastegrid-organizer.onrender.com",
        "https://organizer.example:8443",
        "https://[2001:db8::1]:8443",
    ],
)
def test_dashboard_accepts_exact_local_or_https_origin(origin):
    values = {
        **configuration(),
        "DASHBOARD_ORIGIN": origin,
        "CORS_ORIGINS": json.dumps([origin]),
    }
    assert public_configuration(values) == []
    values["CORS_ORIGINS"] = '["https://another-organizer.example"]'
    assert any("CORS_ORIGINS" in issue for issue in public_configuration(values))


@pytest.mark.parametrize(
    "origin",
    [
        "http://organizer.example",
        "https://organizer.example/",
        "https://organizer.example/reports",
        "https://organizer.example?token=never-echo",
        "https://organizer.example?",
        "https://organizer.example#reports",
        "https://organizer.example#",
        "https://never-echo@organizer.example",
        "https://user:never-echo@organizer.example",
        "https://organizer.example:invalid",
        "https://organizer.example:99999",
        "https://organizer.example:",
        "https://organizer.example:443",
        "https://ORGANIZER.example",
        "https://organizer^example",
        "https://organizer.example\x00",
        "https://[::1",
        "https://",
        "https://organizer .example",
        "https://organizer.example\\reports",
        "https://*.example",
        "https://%65xample.com",
    ],
)
def test_dashboard_rejects_url_instead_of_origin_even_when_cors_matches(origin):
    issues = public_configuration(
        {
            **configuration(),
            "DASHBOARD_ORIGIN": origin,
            "CORS_ORIGINS": json.dumps([origin]),
        }
    )
    assert any("DASHBOARD_ORIGIN" in issue for issue in issues)
    assert origin not in str(issues)
    assert "never-echo" not in str(issues)


@pytest.mark.parametrize(
    "field,value",
    [
        ("VITE_API_BASE_URL", "https://secret@example.com"),
        ("VITE_SUPABASE_URL", "http://project"),
        ("VITE_SUPABASE_PUBLISHABLE_KEY", "sb_secret_never_log"),
        ("DASHBOARD_ORIGIN", "http://localhost:5174"),
        ("CORS_ORIGINS", "bad-json"),
        ("ORGANIZER_ROUTING_ENABLED", "false"),
        ("MESSAGING_PILOT_ENABLED", "true"),
        ("ROUTING_OSRM_BASE_URL", ""),
    ],
)
def test_mismatches_are_reported_without_values(field, value):
    values = configuration()
    values[field] = value
    issues = public_configuration(values)
    assert issues
    assert value not in str(issues) or not value or value in ("true", "false")


@pytest.mark.parametrize(
    "origin", ["http://127.0.0.1:5173", "https://wastegrid-organizer.onrender.com"]
)
def test_deployed_contract_revision_flags_and_exact_cors(origin):
    def handler(request):
        if request.url.path == "/ready":
            return httpx.Response(
                200,
                json={"status": "ready"},
                headers={
                    "X-WasteGrid-Revision": "a" * 40,
                    "X-WasteGrid-Organizer-Routing": "true",
                    "X-WasteGrid-Messaging-Pilot": "false",
                    "X-WasteGrid-Road-Service": "true",
                },
            )
        if request.url.path == "/openapi.json":
            return httpx.Response(
                200,
                json={
                    "paths": dict.fromkeys(REQUIRED_PATHS, {}),
                    "components": {
                        "schemas": {
                            "RoutePreviewView": {
                                "properties": {"dispatch_receipt": {}}
                            },
                            "ComputeRoutes": {"properties": {"constraints": {}}},
                        }
                    },
                },
            )
        return httpx.Response(200, headers={"access-control-allow-origin": origin})

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        assert deployed_checks(client, "https://api.example", origin, "a" * 40) == []
        assert deployed_checks(
            client, "https://api.example", "https://another-organizer.example", "a" * 40
        ) == ["Deployed CORS does not allow the exact dashboard origin"]
        assert deployed_checks(client, "https://api.example", origin, "b" * 40)


@pytest.mark.parametrize(
    "field,value",
    [
        ("VITE_API_BASE_URL", "https://["),
        ("VITE_API_BASE_URL", "https://api.example:invalid"),
        ("VITE_SUPABASE_URL", "https://project.supabase.co:99999"),
        ("VITE_SUPABASE_URL", "https://"),
        ("VITE_SUPABASE_URL", "https://project .supabase.co"),
        ("DASHBOARD_ORIGIN", "http://localhost:invalid"),
        ("DASHBOARD_ORIGIN", "http://[::1"),
        ("DASHBOARD_ORIGIN", "http://user@127.0.0.1:5173"),
        ("ROUTING_OSRM_BASE_URL", "https://["),
        ("ROUTING_OSRM_BASE_URL", "https://unused:never-echo@roads.example"),
    ],
)
def test_malformed_urls_return_redacted_issues_instead_of_crashing(field, value):
    issues = public_configuration({**configuration(), field: value})
    assert issues
    assert value not in str(issues)


@pytest.mark.parametrize(
    "raw",
    [
        "null",
        '"http://127.0.0.1:5173"',
        '{"http://127.0.0.1:5173": true}',
        "42",
        "true",
        '["http://127.0.0.1:5173", null]',
        '["http://127.0.0.1:5173", 42]',
    ],
)
def test_cors_configuration_requires_an_actual_list_of_strings(raw):
    issues = public_configuration({**configuration(), "CORS_ORIGINS": raw})
    assert any("CORS_ORIGINS" in issue for issue in issues)
    assert raw not in str(issues)
