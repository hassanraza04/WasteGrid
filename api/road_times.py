"""OSRM Table adapter. Null is a known missing road, never a zero-time fallback."""

import math
from contextlib import contextmanager
from threading import Lock
from time import monotonic
from urllib.parse import urlsplit

import httpx

USER_AGENT = "WasteGrid/0.2 (+https://github.com/hassanraza04/WasteGrid)"
PUBLIC_DEMO_HOSTS = {"routing.openstreetmap.de", "router.project-osrm.org"}
_public_request_lock = Lock()
_public_last_request_at = None


@contextmanager
def public_request_budget(base_url):
    """One in-flight public call and a one-second cooldown shared across aliases.

    The Free Render API runs one process. Multiple processes/replicas require a
    shared limiter or a different provider; this is not a distributed limiter.
    """
    if urlsplit(base_url).hostname not in PUBLIC_DEMO_HOSTS:
        yield
        return
    global _public_last_request_at
    if not _public_request_lock.acquire(blocking=False):
        raise TravelDataUnavailable("Public road service is busy; recompute later")
    try:
        if (
            _public_last_request_at is not None
            and monotonic() - _public_last_request_at < 1
        ):
            raise TravelDataUnavailable(
                "Public road service request limit reached; recompute after one second"
            )
        try:
            yield
        finally:
            # Completion-based spacing also covers a delayed client constructor.
            _public_last_request_at = monotonic()
    finally:
        _public_request_lock.release()


class TravelDataUnavailable(Exception):
    pass


class OSRMRoadTimes:
    def __init__(self, base_url, timeout=10):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    def matrix(self, locations):
        if not locations:
            return []
        coordinates = ";".join(f'{p["longitude"]},{p["latitude"]}' for p in locations)
        try:
            with (
                public_request_budget(self.base_url),
                httpx.Client(
                    timeout=self.timeout,
                    follow_redirects=False,
                    headers={"User-Agent": USER_AGENT},
                ) as client,
            ):
                response = client.get(
                    f"{self.base_url}/table/v1/driving/{coordinates}",
                    params={"annotations": "duration"},
                )
                response.raise_for_status()
                data = response.json()
            if not isinstance(data, dict) or data.get("code") != "Ok":
                raise ValueError("Provider did not return a complete table")
            matrix = data["durations"]
            n = len(locations)
            if len(matrix) != n or any(len(row) != n for row in matrix):
                raise ValueError("Invalid matrix shape")
            for row in matrix:
                for value in row:
                    if value is not None and (
                        isinstance(value, bool)
                        or not isinstance(value, (int, float))
                        or not math.isfinite(value)
                        or value < 0
                    ):
                        raise ValueError("Invalid road duration")
            # No fallback_speed is requested; preserve direction and no-route nulls.
            return [[v / 60 if v is not None else None for v in row] for row in matrix]
        except (httpx.HTTPError, ValueError, KeyError, TypeError) as exc:
            raise TravelDataUnavailable(
                "Road-time data unavailable; recompute required"
            ) from exc
