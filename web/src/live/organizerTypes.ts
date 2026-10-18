import type { OrganizerJobDetails, Priority } from "./organizerApi";

export interface ProcessingTask {
  status: "pending" | "running" | "succeeded" | "failed";
  attempts: number;
  error_code: string | null;
}
export interface ReportProcessing {
  assessment: ProcessingTask | null;
  triage: ProcessingTask | null;
  demo_run_id: string | null;
}
export interface DemoProcessingStatus {
  run_id: string | null;
  status: "inactive" | "active" | "draining" | "closed";
  reason: string | null;
  starts_at: string | null;
  expires_at: string | null;
  model: string | null;
  used_attempts: number;
  max_attempts: number;
  new_reports_admitted: number;
  max_new_reports: number;
  worker_online: boolean;
  last_heartbeat_at: string | null;
  last_success_at: string | null;
  queue: {
    pending: number;
    running: number;
    succeeded: number;
    failed: number;
  };
}
export interface OrganizerOverview {
  counts: {
    needs_review: number;
    high_priority_jobs: number;
    in_progress_jobs: number;
    available_crews: number;
    blocked_jobs: number;
    completed_24h: number;
    awaiting_assessment: number;
  };
  include_illustrative: boolean;
  configuration: {
    revision: string;
    organizer_routing_enabled: boolean;
    road_service_configured: boolean;
    messaging_pilot_enabled: boolean;
  };
  processing: DemoProcessingStatus;
}
export interface ReportIndexQuery {
  q?: string;
  view?: "all" | "needs_review" | "awaiting_assessment" | "active_cleanup";
  priority?: Priority;
  assessment_status?: string;
  sort?: "newest" | "oldest" | "priority";
  include_illustrative?: boolean;
  limit?: number;
  offset?: number;
}
export interface OrganizerSummaryReport {
  id: string;
  public_reference: string;
  category: string | null;
  title: string;
  address: string | null;
  photo_id: string;
  created_at: string;
  updated_at: string;
  display_status: string;
  state: string;
  assessment_status: string;
  priority: Priority | null;
  needs_review: boolean;
  illustrative: boolean;
  job_id: string | null;
  job_status: string | null;
  crew_id: string | null;
  crew_name: string | null;
  route_position: number | null;
}
export interface OrganizerReportIndex {
  items: OrganizerSummaryReport[];
  total: number;
  limit: number;
  offset: number;
}
export type OrganizerIndexedJob = OrganizerJobDetails["job"] & {
  priority: Priority | null;
  eligible: boolean;
  eligibility_reasons: string[];
  public_references: string[];
  address: string | null;
  photo_id: string | null;
};
export interface OrganizerJobIndex {
  items: OrganizerIndexedJob[];
  total: number;
  limit: number;
  offset: number;
}
export interface RoutingConstraints {
  max_duration_minutes: number | null;
  max_stops_per_crew: number;
  return_to_start: boolean;
  allow_partial: boolean;
}
export interface DispatchReceipt {
  command_id: string;
  actor_id: string;
  plan_id: string;
  accept_partial: boolean;
}
export interface RouteGeometry {
  status: "ready" | "unavailable" | "rate_limited";
  geometry: { type: "LineString"; coordinates: [number, number][] } | null;
  retry_after_seconds: number | null;
}
