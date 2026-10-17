// assignments.ts — cleanup routes admins have assigned to crews.
//
// Backend seam: screens only use the async functions and `onAssignmentsChanged` below, never the store.
// To connect the API, replace each function body with its request (suggested endpoints in the comments),
// and fire the change listeners from a push channel or polling instead of from local writes.
import type { CrewRoute, RouteStop } from "@/utils/route-planner";

export type AssignedStop = RouteStop & {
  cleanedAt?: string; // ISO date, set when the crew marks the stop cleaned
};

export type Assignment = {
  id: string;
  crewId: string;
  cityId: string;
  stops: AssignedStop[]; // in visiting order
  distanceKm: number;
  durationMin: number;
  assignedAt: string; // ISO date
};

// GET /crews/:crewId/assignment — the crew's current route, or null if none is assigned
export async function getCrewAssignment(crewId: string): Promise<Assignment | null> {
  return store.find((a) => a.crewId === crewId) ?? null;
}

// GET /cities/:cityId/assignments — every crew's current route in a city
export async function getCityAssignments(cityId: string): Promise<Assignment[]> {
  return store.filter((a) => a.cityId === cityId);
}

// POST /cities/:cityId/assignments — gives each crew its route, replacing the crew's previous one
export async function assignRoutes(cityId: string, routes: CrewRoute[]): Promise<Assignment[]> {
  const assignedAt = new Date().toISOString();
  const created = routes.map((route): Assignment => ({
    id: `asg-${route.crewId}-${Date.now()}`,
    crewId: route.crewId,
    cityId,
    stops: route.stops.map((stop) => ({ ...stop })),
    distanceKm: route.distanceKm,
    durationMin: route.durationMin,
    assignedAt,
  }));
  const reassigned = new Set(created.map((a) => a.crewId));
  store = [...store.filter((a) => !reassigned.has(a.crewId)), ...created];
  emit();
  return created;
}

// PATCH /assignments/:assignmentId/stops/:reportId — mark a stop cleaned (or undo it)
export async function setStopCleaned(assignmentId: string, reportId: string, cleaned: boolean): Promise<Assignment> {
  const assignment = store.find((a) => a.id === assignmentId);
  if (!assignment) throw new Error(`No assignment ${assignmentId}`);

  const updated: Assignment = {
    ...assignment,
    stops: assignment.stops.map((stop) =>
      stop.reportId === reportId ? { ...stop, cleanedAt: cleaned ? new Date().toISOString() : undefined } : stop),
  };
  store = store.map((a) => (a.id === assignmentId ? updated : a));
  emit();
  return updated;
}

// Calls `listener` whenever assignments change, so screens can refetch. Returns an unsubscribe function.
export function onAssignmentsChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function countCleaned(assignment: Assignment): number {
  return assignment.stops.filter((stop) => stop.cleanedAt).length;
}

// ─── Demo store (goes away with the backend) ─────────────────────────────────

const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((listener) => listener());
}

// One route already assigned so "My route" has something to show for Crew A
let store: Assignment[] = [
  {
    id: "asg-demo-crew-a",
    crewId: "crew-a",
    cityId: "karachi",
    distanceKm: 6.8,
    durationMin: 95,
    assignedAt: "2026-10-17T06:00:00.000Z",
    stops: [
      { reportId: "WG-1042", address: "Khayaban-e-Ittehad, DHA Phase 6", coords: { latitude: 24.8091, longitude: 67.0402 },
        cleanedAt: "2026-10-17T07:10:00.000Z" },
      { reportId: "WG-1038", address: "Bukhari Commercial, DHA Phase 6", coords: { latitude: 24.8159, longitude: 67.0327 } },
      { reportId: "WG-1031", address: "Zamzama Boulevard, Clifton", coords: { latitude: 24.8205, longitude: 67.0289 } },
      { reportId: "WG-1027", address: "Sea View, Clifton", coords: { latitude: 24.7952, longitude: 67.0479 } },
    ],
  },
];
