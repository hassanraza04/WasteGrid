"""OSRM Table adapter. Null is a known missing road, never a zero-time fallback."""

import math

import httpx


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
            with httpx.Client(timeout=self.timeout, follow_redirects=False) as client:
                response = client.get(
                    f"{self.base_url}/table/v1/driving/{coordinates}",
                    params={"annotations": "duration"},
                )
                response.raise_for_status()
                data = response.json()
            if data.get("code") != "Ok":
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
