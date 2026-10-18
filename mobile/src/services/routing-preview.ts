import type { Job, Preview, RoutingConstraints } from "./staff-client";

export const DEFAULT_ROUTING_CONSTRAINTS: RoutingConstraints = {
  max_duration_minutes: 120, max_stops_per_crew: 10, return_to_start: true, allow_partial: false,
};

// The preview must acknowledge both the explicit scope and every selected control.
// This also prevents an older API from silently computing a broader/default plan.
export function matchesRoutingRequest(preview: Preview, crewIds: string[], jobIds: string[], constraints: RoutingConstraints, jobs: Job[]) {
  const echoed = preview.settings?.constraints;
  if (preview.settings?.routing_contract_version !== 2 || !echoed ||
      echoed.max_duration_minutes !== constraints.max_duration_minutes || echoed.max_stops_per_crew !== constraints.max_stops_per_crew ||
      echoed.return_to_start !== constraints.return_to_start || echoed.allow_partial !== constraints.allow_partial) return false;
  if (!Array.isArray(preview.job_ids) || preview.job_ids.length !== jobIds.length || new Set(preview.job_ids).size !== jobIds.length || !jobIds.every(id => preview.job_ids!.includes(id))) return false;
  const routeCrews = preview.routes.map(route => route.crew_id);
  if (new Set(routeCrews).size !== routeCrews.length || routeCrews.some(id => !crewIds.includes(id)) || (preview.dispatchable && routeCrews.length !== crewIds.length)) return false;
  const stops = preview.routes.flatMap(route => route.stops.map(stop => stop.job_id));
  const omitted = preview.unassigned.map(issue => issue.job_id);
  const partition = [...stops, ...omitted];
  if (partition.length !== jobIds.length || new Set(partition).size !== jobIds.length || partition.some(id => !jobIds.includes(id)) || preview.unassigned.some(issue => !issue.reason)) return false;
  if (preview.dispatchable && (preview.exclusions.length || !stops.length || (omitted.length && !constraints.allow_partial))) return false;
  // Partial routing may leave new jobs unassigned; existing assigned work must survive.
  if (preview.dispatchable && jobs.some(job => jobIds.includes(job.id) && job.assigned_crew_id && !stops.includes(job.id))) return false;
  return preview.routes.every(route => {
    if (!Number.isFinite(route.duration_minutes) || route.duration_minutes < 0 || !Number.isFinite(route.travel_minutes) || route.travel_minutes < 0 || !Number.isFinite(route.return_travel_minutes) || route.return_travel_minutes < 0 || route.return_travel_minutes > route.travel_minutes) return false;
    if (route.returns_to_start !== constraints.return_to_start || route.stops.length > constraints.max_stops_per_crew) return false;
    return constraints.max_duration_minutes === null || route.duration_minutes <= constraints.max_duration_minutes;
  });
}
