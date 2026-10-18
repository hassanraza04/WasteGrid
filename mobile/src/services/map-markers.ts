import type { Region } from "react-native-maps";

export type MapMarkerLocation = { latitude: number; longitude: number };
export type MapMarkerPage = { items: MapMarkerLocation[]; truncated: boolean };

function normalizeLongitude(value: number): number {
  return ((value + 180) % 360 + 360) % 360 - 180;
}

export function mapBounds(region: Region) {
  const latitudeDelta = Math.max(region.latitudeDelta, 0.0001);
  const longitudeDelta = Math.max(region.longitudeDelta, 0.0001);
  const south = Math.max(-90, region.latitude - latitudeDelta / 2);
  const north = Math.min(90, region.latitude + latitudeDelta / 2);
  const west = longitudeDelta >= 360 ? -180 : normalizeLongitude(region.longitude - longitudeDelta / 2);
  const east = longitudeDelta >= 360 ? 180 : normalizeLongitude(region.longitude + longitudeDelta / 2);
  return { south, north, west, east };
}

export async function readMapMarkers(region: Region, request: typeof fetch = fetch): Promise<MapMarkerPage> {
  const base = process.env.EXPO_PUBLIC_API_BASE_URL?.replace(/\/$/, "");
  if (!base) throw new Error("The map service is not configured.");
  const query = Object.entries(mapBounds(region))
    .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`).join("&");
  const response = await request(`${base}/map/markers?${query}`, { signal: AbortSignal.timeout(20_000), redirect: "error" });
  if (!response.ok) throw new Error("Unable to refresh waste locations. Try again shortly.");
  const page: MapMarkerPage = await response.json();
  if (!Array.isArray(page.items) || page.items.length > 500 || typeof page.truncated !== "boolean" ||
      page.items.some(item => !item || !Number.isFinite(item.latitude) || !Number.isFinite(item.longitude) ||
        Math.abs(item.latitude) > 90 || Math.abs(item.longitude) > 180)) {
    throw new Error("Unable to read waste locations. Try again shortly.");
  }
  return page;
}
