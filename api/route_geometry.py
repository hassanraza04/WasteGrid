"""Display-only OSRM roads from immutable preview inputs; never changes metrics."""

import math
from collections import OrderedDict
from threading import Lock
from time import monotonic

import httpx

from api.road_times import USER_AGENT, RoadRateLimited, public_request_budget


class PreviewGeometry:
    def __init__(self):
        self._cache = OrderedDict()
        self._lock = Lock()

    def read(self, preview, crew_id, base_url, timeout=10):
        cid = str(crew_id)
        key = (str(preview.id), cid)
        with self._lock:
            cached = self._cache.get(key)
            if cached and monotonic() - cached[0] < 600:
                return cached[1]
        snap, view = preview.payload["snapshot"], preview.payload["view"]
        route = next((r for r in view["routes"] if r["crew_id"] == cid), None)
        if route is None:
            return None
        origin = snap["locations"][cid]["location"]
        jobs = {j["id"]: j for j in snap["jobs"]}
        points = [origin] + [jobs[s["job_id"]]["location"] for s in route["stops"]]
        if route.get("returns_to_start", False):
            points.append(origin)
        unavailable = dict(
            status="unavailable", geometry=None, retry_after_seconds=None
        )
        if len(points) < 2 or not base_url:
            return unavailable
        coordinates = ";".join(f'{p["longitude"]},{p["latitude"]}' for p in points)
        try:
            with (
                public_request_budget(base_url),
                httpx.Client(
                    timeout=min(timeout, 10),
                    follow_redirects=False,
                    headers={"User-Agent": USER_AGENT},
                ) as client,
            ):
                response = client.get(
                    f"{base_url.rstrip('/')}/route/v1/driving/{coordinates}",
                    params={
                        "overview": "full",
                        "geometries": "geojson",
                        "steps": "false",
                    },
                )
                response.raise_for_status()
                result = response.json()
            if result["code"] != "Ok":
                return unavailable
            geometry = result["routes"][0]["geometry"]
            coords = geometry["coordinates"]
            if geometry["type"] != "LineString" or not 2 <= len(coords) <= 100000:
                return unavailable
            for pair in coords:
                if (
                    len(pair) != 2
                    or any(
                        isinstance(n, bool)
                        or not isinstance(n, (int, float))
                        or not math.isfinite(n)
                        for n in pair
                    )
                    or not (-180 <= pair[0] <= 180 and -90 <= pair[1] <= 90)
                ):
                    return unavailable
            value = dict(status="ready", geometry=geometry, retry_after_seconds=None)
            with self._lock:
                self._cache[key] = (monotonic(), value)
                while len(self._cache) > 128:
                    self._cache.popitem(last=False)
            return value
        except RoadRateLimited:
            return dict(status="rate_limited", geometry=None, retry_after_seconds=1)
        except (
            httpx.HTTPError,
            ValueError,
            KeyError,
            IndexError,
            TypeError,
            OverflowError,
        ):
            return unavailable
