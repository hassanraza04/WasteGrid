// cities.ts — cities we have stats for, city search, and "which city am I in"
// TODO: load from the API once cities are defined server-side; screens only use the functions below.
import type { Coords } from "@/utils/location";

export type City = {
  id: string;
  name: string;
  region: string; // province/state and country, shown under the name
  center: Coords;
};

export const CITIES: City[] = [
  { id: "karachi", name: "Karachi", region: "Sindh, Pakistan", center: { latitude: 24.8607, longitude: 67.0011 } },
  { id: "lahore", name: "Lahore", region: "Punjab, Pakistan", center: { latitude: 31.5204, longitude: 74.3587 } },
  { id: "islamabad", name: "Islamabad", region: "Islamabad Capital Territory, Pakistan", center: { latitude: 33.6844, longitude: 73.0479 } },
  { id: "rawalpindi", name: "Rawalpindi", region: "Punjab, Pakistan", center: { latitude: 33.5651, longitude: 73.0169 } },
  { id: "faisalabad", name: "Faisalabad", region: "Punjab, Pakistan", center: { latitude: 31.4504, longitude: 73.135 } },
  { id: "multan", name: "Multan", region: "Punjab, Pakistan", center: { latitude: 30.1575, longitude: 71.5249 } },
  { id: "peshawar", name: "Peshawar", region: "Khyber Pakhtunkhwa, Pakistan", center: { latitude: 34.0151, longitude: 71.5249 } },
  { id: "hyderabad", name: "Hyderabad", region: "Sindh, Pakistan", center: { latitude: 25.396, longitude: 68.3578 } },
  { id: "quetta", name: "Quetta", region: "Balochistan, Pakistan", center: { latitude: 30.1798, longitude: 66.975 } },
];

const NEARBY_KM = 40; // how far from a city's center still counts as being in it

// Cities whose name matches the query; names that start with it come first
export async function searchCities(query: string): Promise<City[]> {
  const q = normalize(query);
  if (!q) return [];
  const matches = CITIES.filter((c) => normalize(c.name).includes(q));
  return matches.sort((a, b) => Number(normalize(b.name).startsWith(q)) - Number(normalize(a.name).startsWith(q)));
}

// The closest city we have data for, or null if none is within NEARBY_KM
export function findCityNear(coords: Coords): City | null {
  let best: { city: City; km: number } | null = null;
  for (const city of CITIES) {
    const km = distanceKm(coords, city.center);
    if (km <= NEARBY_KM && (!best || km < best.km)) best = { city, km };
  }
  return best?.city ?? null;
}

function normalize(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();
}

// Great-circle distance (haversine)
function distanceKm(a: Coords, b: Coords): number {
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLon = rad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}
