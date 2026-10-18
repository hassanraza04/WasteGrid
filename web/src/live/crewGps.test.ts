import { expect, test } from "vitest";
import { crew } from "../test/routingFixtures";
import { crewGpsIssue } from "./crewGps";

test("accepts the exact server age boundary and rejects the next millisecond", () => {
  const now = Date.now();
  const observation = {
    ...crew,
    location_max_age_seconds: 45,
    location_recorded_at: new Date(now - 45_000).toISOString(),
    location_received_at: new Date(now).toISOString(),
  };
  expect(crewGpsIssue(observation, now)).toBe("");
  expect(crewGpsIssue(observation, now + 1)).toBe("GPS stale or invalid");
});
