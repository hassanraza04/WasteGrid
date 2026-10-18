"""Frozen route geometry is display-only and shares the public provider budget."""

from types import SimpleNamespace
from unittest.mock import patch

import httpx
import pytest

from api import road_times
from api.route_geometry import PreviewGeometry


def frozen(returning=True):
    return SimpleNamespace(
        id="preview",
        payload={
            "snapshot": {
                "locations": {"crew": {"location": {"longitude": 67, "latitude": 24}}},
                "jobs": [
                    {"id": "b", "location": {"longitude": 68, "latitude": 25}},
                    {"id": "a", "location": {"longitude": 69, "latitude": 26}},
                ],
            },
            "view": {
                "routes": [
                    {
                        "crew_id": "crew",
                        "stops": [{"job_id": "a"}, {"job_id": "b"}],
                        "returns_to_start": returning,
                    }
                ]
            },
        },
    )


def response(payload):
    return httpx.Response(
        200, json=payload, request=httpx.Request("GET", "https://roads.test")
    )


def valid():
    return {
        "code": "Ok",
        "routes": [
            {
                "geometry": {
                    "type": "LineString",
                    "coordinates": [[67, 24], [69, 26], [68, 25], [67, 24]],
                }
            }
        ],
    }


def test_frozen_order_return_cache_timeout_and_no_metric_mutation():
    original = frozen()
    with patch("api.route_geometry.httpx.Client") as cls:
        get = cls.return_value.__enter__.return_value.get
        get.return_value = response(valid())
        cache = PreviewGeometry()
        assert (
            cache.read(original, "crew", "https://roads.test", 30)["status"] == "ready"
        )
        assert cache.read(original, "crew", "https://roads.test")["status"] == "ready"
        assert get.call_count == 1
        assert get.call_args.args[0].endswith("67,24;69,26;68,25;67,24")
        assert get.call_args.kwargs["params"]["geometries"] == "geojson"
        assert cls.call_args.kwargs["timeout"] == 10
        assert cls.call_args.kwargs["follow_redirects"] is False
        assert original.payload["view"]["routes"][0]["stops"] == [
            {"job_id": "a"},
            {"job_id": "b"},
        ]
        assert cache.read(original, "unknown", "https://roads.test") is None


@pytest.mark.parametrize(
    "payload",
    [
        None,
        {},
        {"code": "NoRoute"},
        {"code": "Ok", "routes": []},
        {
            "code": "Ok",
            "routes": [
                {
                    "geometry": {
                        "type": "LineString",
                        "coordinates": [[True, 24], [67, 24]],
                    }
                }
            ],
        },
        {
            "code": "Ok",
            "routes": [
                {"geometry": {"type": "Polygon", "coordinates": [[67, 24], [67, 24]]}}
            ],
        },
        {
            "code": "Ok",
            "routes": [
                {
                    "geometry": {
                        "type": "LineString",
                        "coordinates": [[190, 24], [67, 24]],
                    }
                }
            ],
        },
    ],
)
def test_bad_geometry_never_becomes_straight_line_fallback(payload):
    with patch("api.route_geometry.httpx.Client") as cls:
        cls.return_value.__enter__.return_value.get.return_value = response(payload)
        assert PreviewGeometry().read(frozen(), "crew", "https://roads.test") == {
            "status": "unavailable",
            "geometry": None,
            "retry_after_seconds": None,
        }


def test_shared_provider_budget_blocks_geometry_without_provider_activity(monkeypatch):
    monkeypatch.setattr(road_times, "_public_last_request_at", None)
    with road_times.public_request_budget(
        "https://routing.openstreetmap.de/routed-car"
    ):
        with patch("api.route_geometry.httpx.Client") as cls:
            assert (
                PreviewGeometry().read(
                    frozen(), "crew", "https://router.project-osrm.org"
                )["status"]
                == "rate_limited"
            )
            cls.assert_not_called()
    monkeypatch.setattr(road_times, "_public_last_request_at", None)


def test_no_return_and_transport_failure_are_visible():
    with patch("api.route_geometry.httpx.Client") as cls:
        get = cls.return_value.__enter__.return_value.get
        get.side_effect = httpx.TimeoutException("private")
        assert (
            PreviewGeometry().read(frozen(False), "crew", "https://roads.test")[
                "status"
            ]
            == "unavailable"
        )
        assert get.call_args.args[0].endswith("67,24;69,26;68,25")
    assert PreviewGeometry().read(frozen(), "crew", "")["status"] == "unavailable"


def test_unbounded_provider_integer_is_reported_unavailable():
    payload = valid()
    payload["routes"][0]["geometry"]["coordinates"][0][0] = 10**400
    with patch("api.route_geometry.httpx.Client") as cls:
        cls.return_value.__enter__.return_value.get.return_value = response(payload)
        assert (
            PreviewGeometry().read(frozen(), "crew", "https://roads.test")["status"]
            == "unavailable"
        )
