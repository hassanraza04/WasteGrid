"""Public road-provider limits apply before HTTP, across request-local clients."""

from concurrent.futures import ThreadPoolExecutor
from threading import Event

import httpx
import pytest

from api import road_times
from api.road_times import OSRMRoadTimes, TravelDataUnavailable


@pytest.fixture
def road_requests(monkeypatch):
    original = httpx.Client
    calls = []

    def respond(request):
        calls.append(request)
        return httpx.Response(200, json={"code": "Ok", "durations": [[0]]})

    monkeypatch.setattr(
        road_times.httpx,
        "Client",
        lambda **kwargs: original(transport=httpx.MockTransport(respond), **kwargs),
    )
    monkeypatch.setattr(road_times, "_public_last_request_at", None)
    return calls


POINT = [{"latitude": 24.86, "longitude": 67.01}]


def test_demo_aliases_share_budget_before_http_and_allow_next_second(
    monkeypatch, road_requests
):
    times = iter([100.0, 100.5, 101.0, 101.0])
    monkeypatch.setattr(road_times, "monotonic", lambda: next(times))
    first = OSRMRoadTimes("https://routing.openstreetmap.de/routed-car")
    second = OSRMRoadTimes("https://router.project-osrm.org")
    assert first.matrix(POINT) == [[0.0]]
    with pytest.raises(TravelDataUnavailable, match="request limit"):
        second.matrix(POINT)
    assert second.matrix(POINT) == [[0.0]]
    assert len(road_requests) == 2
    for request in road_requests:
        assert request.headers["user-agent"] == road_times.USER_AGENT
        assert dict(request.url.params) == {"annotations": "duration"}
        assert "fallback_speed" not in request.url.params


def test_concurrent_demo_clients_submit_at_most_one_request(monkeypatch, road_requests):
    monkeypatch.setattr(road_times, "monotonic", lambda: 100.0)

    def request(_):
        try:
            OSRMRoadTimes("https://routing.openstreetmap.de/routed-car").matrix(POINT)
            return True
        except TravelDataUnavailable:
            return False

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(request, range(8)))
    assert sum(results) == len(road_requests) == 1


def test_private_road_provider_is_not_given_the_public_demo_limit(
    monkeypatch, road_requests
):
    monkeypatch.setattr(road_times, "monotonic", lambda: 100.0)
    provider = OSRMRoadTimes("https://roads.example.test")
    assert provider.matrix(POINT) == provider.matrix(POINT) == [[0.0]]
    assert len(road_requests) == 2


def test_delayed_client_setup_cannot_overlap_another_public_submission(
    monkeypatch, road_requests
):
    clock = [100.0]
    entered, release = Event(), Event()
    factory = road_times.httpx.Client
    calls = [0]

    def delayed_client(**kwargs):
        calls[0] += 1
        if calls[0] == 1:
            entered.set()
            assert release.wait(timeout=3)
        return factory(**kwargs)

    monkeypatch.setattr(road_times.httpx, "Client", delayed_client)
    monkeypatch.setattr(road_times, "monotonic", lambda: clock[0])
    provider = OSRMRoadTimes("https://routing.openstreetmap.de/routed-car")
    alias = OSRMRoadTimes("https://router.project-osrm.org")
    with ThreadPoolExecutor(max_workers=1) as pool:
        first = pool.submit(provider.matrix, POINT)
        try:
            assert entered.wait(timeout=3)
            clock[0] = 101.0
            with pytest.raises(TravelDataUnavailable, match="busy"):
                alias.matrix(POINT)
        finally:
            release.set()
        assert first.result(timeout=3) == [[0.0]]
    clock[0] = 101.5
    with pytest.raises(TravelDataUnavailable, match="request limit"):
        alias.matrix(POINT)
    assert len(road_requests) == 1
    clock[0] = 102.0
    assert alias.matrix(POINT) == [[0.0]]
    assert len(road_requests) == 2
