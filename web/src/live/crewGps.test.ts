import { expect, test, vi, afterEach } from "vitest";
import { crew } from "../test/routingFixtures";
import { crewGpsAge, crewGpsIssue } from "./crewGps";

afterEach(() => vi.restoreAllMocks());
const checkedAt = Date.parse("2026-10-18T10:00:00Z");
const observation = {
  ...crew,
  location_max_age_seconds: 45,
  location_checked_at: new Date(checkedAt).toISOString(),
  location_recorded_at: new Date(checkedAt - 45_000).toISOString(),
  location_received_at: new Date(checkedAt).toISOString(),
};
test("accepts the exact server age boundary and rejects the next millisecond", () => {
  expect(crewGpsIssue(observation)).toBe("");
  expect(crewGpsIssue(observation, 1)).toBe("GPS stale or invalid");
  expect(crewGpsAge(observation)).toBe(45);
});
test.each([-3_600_000, 3_600_000])("uses server time even with organiser clock offset %s", offset => {
  vi.spyOn(Date, "now").mockReturnValue(checkedAt + offset);
  expect(crewGpsIssue(observation)).toBe("");
  expect(crewGpsAge(observation)).toBe(45);
  expect(crewGpsIssue(observation, 1)).toBe("GPS stale or invalid");
});
test("older APIs without a server clock defer freshness to the backend", () => {
  const legacy = { ...observation, location_checked_at: undefined };
  expect(crewGpsIssue(legacy, 60_000)).toBe("");
  expect(crewGpsAge(legacy)).toBeNull();
  expect(crewGpsIssue({ ...legacy, location_received_at: null })).toContain("GPS not shared");
});
