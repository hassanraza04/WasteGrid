import type { OrganizerCrew } from "./organizerApi";

// Advance the server observation time with elapsed monotonic browser time.
// Older APIs without a server time reference retain authoritative server checks.
export function crewGpsIssue(crew: OrganizerCrew, elapsedMilliseconds = 0): string {
  if (!crew.location_recorded_at || !crew.location_received_at)
    return "GPS not shared (no timestamped location)";
  const timestamps = [crew.location_recorded_at, crew.location_received_at].map(Date.parse);
  if (timestamps.some(value => !Number.isFinite(value))) return "GPS stale or invalid";
  const checkedAt = Date.parse(crew.location_checked_at ?? "");
  if (!Number.isFinite(checkedAt)) return "";
  const now = checkedAt + Math.max(0, elapsedMilliseconds);
  const maxAge = (crew.location_max_age_seconds ?? 120) * 1000;
  if (timestamps.some(value => now - value < 0 || now - value > maxAge))
    return "GPS stale or invalid";
  return "";
}

export function crewGpsAge(crew: OrganizerCrew, elapsedMilliseconds = 0): number | null {
  const recorded = Date.parse(crew.location_recorded_at ?? "");
  const checked = Date.parse(crew.location_checked_at ?? "");
  if (!Number.isFinite(recorded) || !Number.isFinite(checked)) return null;
  return Math.max(0, Math.round((checked - recorded + Math.max(0, elapsedMilliseconds)) / 1000));
}
