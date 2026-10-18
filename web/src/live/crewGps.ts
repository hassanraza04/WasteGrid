import type { OrganizerCrew } from "./organizerApi";

// Mirrors both timestamp checks enforced by api.routing.fresh_location.
export function crewGpsIssue(crew: OrganizerCrew, now = Date.now()): string {
  if (!crew.location_recorded_at || !crew.location_received_at)
    return "GPS not shared (no timestamped location)";
  const maxAge = (crew.location_max_age_seconds ?? 120) * 1000;
  if ([crew.location_recorded_at, crew.location_received_at].some((value) => {
    const age = now - Date.parse(value);
    return !Number.isFinite(age) || age < 0 || age > maxAge;
  })) return "GPS stale or invalid";
  return "";
}
