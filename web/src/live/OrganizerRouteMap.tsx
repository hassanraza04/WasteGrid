import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { OrganizerApi, OrganizerRoutePreview } from "./organizerApi";
import type { RouteGeometry } from "./organizerTypes";

const pendingGeometry = new WeakMap<
  OrganizerApi,
  Map<string, Promise<RouteGeometry>>
>();
function geometryRequest(
  api: OrganizerApi,
  previewId: string,
  crewId: string,
): Promise<RouteGeometry> {
  const requests =
    pendingGeometry.get(api) ?? new Map<string, Promise<RouteGeometry>>();
  pendingGeometry.set(api, requests);
  const key = `${api.sessionVersion}|${previewId}|${crewId}`;
  const pending = requests.get(key);
  if (pending) return pending;
  const request = api.geometry(previewId, crewId).finally(() => {
    requests.delete(key);
  });
  requests.set(key, request);
  return request;
}

export function OrganizerRouteMap({
  api,
  preview,
}: {
  api: OrganizerApi;
  preview: OrganizerRoutePreview;
}) {
  const element = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState("Loading road geometry…");
  useEffect(() => {
    let cancelled = false;
    const version = api.sessionVersion;
    const map = L.map(element.current!, { scrollWheelZoom: false }).setView(
      [24.92, 67.09],
      12,
    );
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19,
    }).addTo(map);
    const bounds = L.latLngBounds([]);
    const colors = ["#12804D", "#286bc1", "#9752b2", "#b97018", "#bd4058"];
    void (async () => {
      let ready = 0,
        failed = 0;
      for (const [index, route] of preview.routes.entries()) {
        if (!route.stops.length || cancelled) continue;
        if (index) await new Promise((resolve) => setTimeout(resolve, 1100));
        if (cancelled || api.sessionVersion !== version) return;
        let result: RouteGeometry;
        try {
          result = await geometryRequest(api, preview.id, route.crew_id);
          // The table request can still be in the shared provider cooldown. Retry
          // this explicit read a bounded number of times, never the dispatch.
          for (
            let attempt = 1;
            result.status === "rate_limited" && attempt < 3;
            attempt++
          ) {
            await new Promise((resolve) =>
              setTimeout(
                resolve,
                Math.min(5, Math.max(1, result.retry_after_seconds ?? 1)) *
                  1000 +
                  100,
              ),
            );
            if (cancelled || api.sessionVersion !== version) return;
            result = await geometryRequest(api, preview.id, route.crew_id);
          }
        } catch {
          result = {
            status: "unavailable",
            geometry: null,
            retry_after_seconds: null,
          };
        }
        if (cancelled || api.sessionVersion !== version) return;
        if (result.status === "ready" && result.geometry) {
          const points = result.geometry.coordinates.map(([lng, lat]) =>
            L.latLng(lat, lng),
          );
          L.polyline(points, {
            color: colors[index % colors.length],
            weight: 5,
          }).addTo(map);
          points.forEach((point) => bounds.extend(point));
          ready++;
          if (bounds.isValid())
            map.fitBounds(bounds, { padding: [24, 24], maxZoom: 16 });
        } else failed++;
        setStatus(
          `${ready} road route${ready === 1 ? "" : "s"} displayed${failed ? ` · ${failed} unavailable; approved estimates unchanged` : ""}. OSRM estimates; no live traffic.`,
        );
      }
      if (!ready && !failed) setStatus("No route geometry for this preview.");
    })();
    return () => {
      cancelled = true;
      map.remove();
    };
  }, [api, preview.id]);
  return (
    <section className="wg-card wg-no-print" aria-label="Road route map">
      <div
        ref={element}
        className="wg-route-map"
        aria-label="OpenStreetMap road routes"
      />
      <p role="status" className="wg-muted">
        {status}
      </p>
    </section>
  );
}
