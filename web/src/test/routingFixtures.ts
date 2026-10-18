import type { OrganizerApi, OrganizerCrew, OrganizerRoutePreview } from "../live/organizerApi";
import type { OrganizerIndexedJob } from "../live/organizerTypes";
import { DEFAULT_CONSTRAINTS } from "../live/dispatchJournal";
export const ACTOR = "60000000-0000-4000-8000-000000000002";
export const COMMAND = "50000000-0000-4000-8000-000000000002";
export const ENVIRONMENT = "https://api.example.invalid";
const crewLocationTime = new Date().toISOString();
export const crew: OrganizerCrew = {
  id: "crew-1", name: "Crew One", equipment: ["gloves"], shift_minutes: 480, available: true,
  start_location: { latitude: 24.92, longitude: 67.09, landmark: "Depot" }, illustrative: false,
  location_checked_at: crewLocationTime,
  location_recorded_at: crewLocationTime, location_received_at: crewLocationTime, location_revision: 1,
};
export const job: OrganizerIndexedJob = {
  id: "job-1", status: "unassigned", location: { latitude: 24.93, longitude: 67.1, landmark: "Gate" },
  category: "General waste", priority: "medium", required_equipment: ["gloves"], estimated_service_minutes: 15,
  assigned_crew_id: null, locked: false, held: false, route_position: null, travel_minutes: 0,
  decision_summary: "Approved collection", unassigned_reason: null, version: 1, illustrative: false,
  eligible: true, eligibility_reasons: [], public_references: ["WG-A1B2C3D4E5F6"], address: "Park gate", photo_id: null,
};
export function routePreview(jobIds = ["job-1"]): OrganizerRoutePreview {
  return {
    id: "preview-1", job_ids: jobIds, computed_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60_000).toISOString(), matrix_id: "matrix-1", travel_label: "OSRM road estimates",
    routes: [{ crew_id: "crew-1", duration_minutes: 20, travel_minutes: 5, return_travel_minutes: 2, returns_to_start: true, stops: [{ job_id: "job-1", position: 0, priority: "medium", travel_minutes: 5, service_minutes: 15, completion_minutes: 20, fixed: false, service_estimate_source: "assessment" }] }],
    exclusions: [], unassigned: [], metrics: { weighted_wait: 1, latest_finish: 20, total_travel: 5, score: 1 }, termination_reason: "local_optimum", dispatchable: true, reassignments: [], settings: { constraints: { ...DEFAULT_CONSTRAINTS } }, plan_id: null,
  };
}
export function committedPreview(source = routePreview(), acceptPartial = false): OrganizerRoutePreview {
  return { ...source, plan_id: "plan-1", dispatch_receipt: { command_id: COMMAND, actor_id: ACTOR, plan_id: "plan-1", accept_partial: acceptPartial } };
}
export type MockApi = OrganizerApi;
