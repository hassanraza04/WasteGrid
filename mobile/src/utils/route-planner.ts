// route-planner.ts — turns open reports in a city into one pickup route per crew.
// The UI is wired to planCrewRoutes; only its body needs writing.
import type { Coords } from "@/utils/location";

export type RouteConstraints = {
  hours: number;           // time each crew has available
  maxStopsPerCrew: number;
  returnToStart: boolean;  // end the route back at the crew's starting position
};

export type RouteRequest = {
  cityId: string;
  crewIds: string[];       // routes start from these crews' locations
  constraints: RouteConstraints;
};

export type RouteStop = { reportId: string; coords: Coords; address: string };

export type CrewRoute = {
  crewId: string;
  stops: RouteStop[];      // in visiting order
  distanceKm: number;
  durationMin: number;
};

export const DEFAULT_CONSTRAINTS: RouteConstraints = { hours: 2, maxStopsPerCrew: 10, returnToStart: true };

// TODO: fetch open reports for request.cityId, split them between the crews, and order each crew's stops
export async function planCrewRoutes(request: RouteRequest): Promise<CrewRoute[]> {
  console.log("planCrewRoutes not implemented yet", request);
  return [];
}
