import { createClient } from "@supabase/supabase-js";

export interface LiveReport {
  id: string;
  public_reference: string;
  title: string;
  address: string | null;
  display_status: string;
  assessment_status: string;
  illustrative: boolean;
  photo_id: string;
  completion_photo_ids: string[];
  note: string | null;
}

export type Priority = "high" | "medium" | "routine";
export type NextAction = "create_job" | "link_job" | "request_info" | "review";
export type Equipment = "gloves" | "trash_bags" | "broom" | "shovel" | "wheelbarrow" | "pickup_truck";

export interface OrganizerAssessment {
  description: string;
  size: string;
  obstruction: string;
  obstruction_level: string;
  forces_people_into_traffic: string;
  special_handling: string;
  visible_fire: string;
  visible_sharp_objects: string;
  confidence: number | null;
  resident_context_agreement: string;
  comparison_reason: string | null;
  reason: string;
}

export interface OrganizerTriage {
  category: string;
  proposed_equipment: Equipment[];
  duplicate_candidate_id: string | null;
  duplicate_confirmed: boolean;
  hazard: boolean;
  evidence_sufficient: boolean;
  missing_information: string[];
  decision_summary: string;
  evidence_report_ids: string[];
  next_action: NextAction;
  estimated_service_minutes: number | null;
}

export interface OrganizerEvent {
  id: string;
  kind: string;
  actor: string;
  created_at: string;
  details: Record<string, unknown>;
  command_id?: string | null;
}

export interface OrganizerLocation {
  latitude: number;
  longitude: number;
  landmark: string | null;
}

export interface OrganizerReport extends LiveReport {
  location: OrganizerLocation | null;
  version: number;
  state: string;
  dashboard_status: string;
  priority: Priority | null;
  priority_reason: string | null;
  needs_review: boolean;
  assessment: OrganizerAssessment | null;
  triage: OrganizerTriage | null;
  resident_answers: { fire: boolean | null; sharp_objects: boolean | null };
  clarifications: Array<{ note: string; location: OrganizerLocation | null; created_at: string }>;
  latest_update: { id: string; kind: string; created_at: string; message: string; status: string | null; report_state: string | null; job_status: string | null } | null;
  created_at: string;
  updated_at: string;
  job_id: string | null;
}

export interface OrganizerReportDetails {
  report: OrganizerReport;
  events: OrganizerEvent[];
}

export interface OrganizerJobDetails {
  job: {
    id: string;
    status: "unassigned" | "assigned" | "in_progress" | "blocked" | "completed" | "recheck_requested";
    location: OrganizerLocation;
    category: string;
    required_equipment: Equipment[];
    estimated_service_minutes: number;
    assigned_crew_id: string | null;
    locked: boolean;
    held: boolean;
    route_position: number | null;
    travel_minutes: number;
    decision_summary: string;
    unassigned_reason: string | null;
    version: number;
    illustrative: boolean;
  };
  photo_ids: string[];
  events: OrganizerEvent[];
}

export interface OrganizerCrew {
  id: string;
  name: string;
  equipment: Equipment[];
  shift_minutes: number;
  available: boolean;
  start_location: OrganizerLocation;
  illustrative: boolean;
  location_recorded_at: string | null;
  location_received_at: string | null;
  location_revision: number;
}

export interface OrganizerRoutingJob {
  id: string;
  status: OrganizerJobDetails["job"]["status"];
  location: OrganizerLocation;
  category: string;
  required_equipment: Equipment[];
  estimated_service_minutes: number;
  assigned_crew_id: string | null;
  locked: boolean;
  held: boolean;
  route_position: number | null;
  travel_minutes: number;
  decision_summary: string;
  unassigned_reason: string | null;
  version: number;
  illustrative: boolean;
}

export interface OrganizerPlanAssignment {
  job_id: string;
  crew_id: string;
  position: number;
  travel_minutes: number;
  service_minutes: number;
}

export interface OrganizerCurrentPlan {
  plan: {
    id: string;
    stale: boolean;
    assignments: OrganizerPlanAssignment[];
    unassigned: Array<{ job_id: string; reason_code: string }>;
    travel_estimates_label: string;
  } | null;
}

export interface OrganizerRouteStop {
  job_id: string;
  position: number;
  priority: Priority;
  travel_minutes: number;
  service_minutes: number;
  completion_minutes: number;
  fixed: boolean;
  service_estimate_source: string;
}

export interface OrganizerRoutePreview {
  id: string;
  job_ids: string[] | null;
  computed_at: string;
  expires_at: string;
  matrix_id: string | null;
  travel_label: string;
  routes: Array<{ crew_id: string; stops: OrganizerRouteStop[]; duration_minutes: number; travel_minutes: number }>;
  unassigned: Array<{ job_id: string; reason: string }>;
  exclusions: Array<{ job_id: string; reason: string }>;
  metrics: { weighted_wait: number; latest_finish: number; total_travel: number; score: number };
  termination_reason: string;
  dispatchable: boolean;
  reassignments: Array<{ job_id: string; previous_crew_id: string | null; previous_position: number | null; proposed_crew_id: string; proposed_position: number }>;
  settings: Record<string, unknown>;
  plan_id: string | null;
}

export interface OrganizerDispatchResult {
  preview_id: string;
  plan_id: string;
}

export interface DecisionCommand {
  command_id: string;
  expected_version: number;
  report_id: string;
  category: string;
  proposed_equipment: Equipment[];
  duplicate_candidate_id: string | null;
  duplicate_confirmed: boolean;
  hazard: boolean;
  evidence_sufficient: boolean;
  missing_information: string[];
  decision_summary: string;
  evidence_report_ids: string[];
  next_action: NextAction;
  estimated_service_minutes?: number | null;
}

export interface PriorityCommand {
  command_id: string;
  expected_version: number;
  priority: Priority;
  reason: string;
}

export interface StaffAuth {
  signIn(email: string, password: string): Promise<void>;
  token(): Promise<string | undefined>;
  signOut(): Promise<void>;
}

export class AccessError extends Error {}

export class DashboardConfigurationError extends Error {}

export class RoutingContractError extends Error {}

export class RoutingConflictError extends Error {}

export class OrganizerApi {
  private authenticationVersion = 0;
  private signingIn: Promise<void> | null = null;
  private signingOut: Promise<void> | null = null;

  get sessionVersion(): number { return this.authenticationVersion; }

  constructor(private readonly auth: StaffAuth, private readonly baseUrl: string) {}

  signIn(email: string, password: string): Promise<void> {
    if (this.signingIn || this.signingOut) return Promise.reject(new Error("Authentication is already in progress. Please wait and try again."));
    const version = ++this.authenticationVersion;
    this.signingIn = this.authenticate(email, password, version).finally(() => { this.signingIn = null; });
    return this.signingIn;
  }

  private async authenticate(email: string, password: string, version: number): Promise<void> {
    try {
      await this.auth.signIn(email, password);
      this.requireSession(version);
      const identity = await this.request<{ role: string }>("/auth/me");
      if (identity.role !== "organizer") throw new AccessError("This account does not have organiser access.");
    } catch (error) {
      if (version === this.authenticationVersion) {
        this.authenticationVersion++;
        await this.auth.signOut();
      }
      throw error;
    }
  }

  signOut(): Promise<void> {
    this.authenticationVersion++;
    if (this.signingOut) return this.signingOut;
    const pendingSignIn = this.signingIn;
    this.signingOut = this.clearAuthentication(pendingSignIn).finally(() => { this.signingOut = null; });
    return this.signingOut;
  }

  private async clearAuthentication(pendingSignIn: Promise<void> | null): Promise<void> {
    // An SDK sign-in can write its session after logout was requested.
    if (pendingSignIn) await pendingSignIn.catch(() => undefined);
    await this.auth.signOut();
  }

  reports(offset: number): Promise<LiveReport[]> {
    return this.request(`/organizer/reports?limit=50&offset=${offset}`, {}, "reports");
  }

  report(id: string): Promise<OrganizerReportDetails> {
    return this.request(`/organizer/reports/${encodeURIComponent(id)}`, {}, "details");
  }

  job(id: string): Promise<OrganizerJobDetails> {
    return this.request(`/jobs/${encodeURIComponent(id)}`, {}, "job");
  }

  crews(): Promise<OrganizerCrew[]> {
    return this.request("/crews", {}, "routing");
  }

  async jobs(): Promise<OrganizerRoutingJob[]> {
    const jobs: OrganizerRoutingJob[] = [];
    for (let offset = 0; ; offset += 100) {
      const page = await this.request<OrganizerRoutingJob[]>(`/jobs?active_only=true&limit=100&offset=${offset}`, {}, "routing");
      jobs.push(...page);
      if (page.length < 100) return jobs;
    }
  }

  currentPlan(): Promise<OrganizerCurrentPlan> {
    return this.request("/plans/current", {}, "routing");
  }

  previewRouting(crewIds: string[], jobIds: string[]): Promise<OrganizerRoutePreview> {
    if (crewIds.length < 1 || crewIds.length > 5 || new Set(crewIds).size !== crewIds.length) throw new RoutingContractError("Choose between 1 and 5 distinct crews.");
    if (jobIds.length < 1 || jobIds.length > 25 || new Set(jobIds).size !== jobIds.length) throw new RoutingContractError("Choose between 1 and 25 distinct jobs.");
    return this.request("/routing/previews", {
      method: "POST",
      body: JSON.stringify({ crew_ids: crewIds, job_ids: jobIds }),
      headers: { "Content-Type": "application/json" },
    }, "routing");
  }

  dispatchRouting(previewId: string, commandId: string): Promise<OrganizerDispatchResult> {
    return this.request(`/routing/previews/${encodeURIComponent(previewId)}/dispatch`, {
      method: "POST",
      body: JSON.stringify({ command_id: commandId }),
      headers: { "Content-Type": "application/json" },
    }, "routing");
  }

  applyDecision(id: string, command: DecisionCommand): Promise<OrganizerReport> {
    return this.request(`/organizer/reports/${encodeURIComponent(id)}/decision`, {
      method: "POST",
      body: JSON.stringify(command),
      headers: { "Content-Type": "application/json" },
    }, "mutation");
  }

  setPriority(id: string, command: PriorityCommand): Promise<OrganizerReport> {
    return this.request(`/organizer/reports/${encodeURIComponent(id)}/priority`, {
      method: "POST",
      body: JSON.stringify(command),
      headers: { "Content-Type": "application/json" },
    }, "mutation");
  }

  async photo(id: string): Promise<string> {
    const result = await this.request<{ url: string }>(`/photos/${encodeURIComponent(id)}/access`, {}, "reports");
    return result.url;
  }

  private async request<T>(path: string, init: RequestInit = {}, action: "reports" | "details" | "job" | "mutation" | "routing" = "details"): Promise<T> {
    const version = this.sessionVersion;
    if (this.signingOut) throw new AccessError("Please sign in again.");
    const token = await this.auth.token();
    this.requireSession(version);
    if (!token) throw new AccessError("Please sign in again.");
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: { ...init.headers as Record<string, string>, Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(60_000),
        redirect: "error",
      });
    } catch {
      throw new Error("Unable to reach WasteGrid. The service may be waking up; please retry.");
    }
    this.requireSession(version);
    if (response.status === 401 || response.status === 403) throw new AccessError("Your session expired or access was denied. Please sign in again.");
    if (!response.ok) {
      if (action === "job" && response.status === 404) throw new Error("This cleanup job is no longer available. Reload the report.");
      if (action === "details" && response.status === 404) throw new Error("This report is no longer available. Refresh the reports list.");
      if (action === "mutation" && response.status === 409) throw new Error("This report changed or is not ready for that decision. Reload it and review the latest details.");
      if (action === "mutation" && response.status === 422) throw new Error("Check the decision fields and try again.");
      if (action === "mutation") throw new Error("Unable to save the organiser decision. Please retry.");
      if (action === "routing" && response.status === 409) throw new RoutingConflictError("Routing state changed. Refresh and compute a new preview before dispatch.");
      if (action === "routing" && response.status === 422) throw new RoutingContractError("The selected route scope was rejected. Refresh routing state and verify the scoped-routing deployment.");
      if (action === "routing") throw new Error("Unable to load routing state. Please retry.");
      if (action === "reports") throw new Error("Unable to load reports. Please retry.");
      if (action === "job") throw new Error("Unable to load cleanup job details. Please retry.");
      throw new Error("Unable to load report details. Please retry.");
    }
    const result = await response.json() as T;
    this.requireSession(version);
    return result;
  }

  private requireSession(version: number): void {
    if (version !== this.authenticationVersion) throw new Error("Your organiser session changed. Please sign in again.");
  }
}

export function createOrganizerApi(): OrganizerApi {
  const baseUrl = configuredUrl(import.meta.env.VITE_API_BASE_URL, "VITE_API_BASE_URL", ["http:", "https:"]);
  const supabaseUrl = configuredUrl(import.meta.env.VITE_SUPABASE_URL, "VITE_SUPABASE_URL", ["https:"]);
  const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (!key?.startsWith("sb_publishable_")) {
    throw new DashboardConfigurationError("Organiser sign-in has not been configured for this build.");
  }
  const client = createClient(supabaseUrl, key, {
    auth: { persistSession: false, autoRefreshToken: true, detectSessionInUrl: false },
  });
  return new OrganizerApi({
    async signIn(email, password) {
      const { error } = await client.auth.signInWithPassword({ email, password });
      if (error) throw new Error("Sign-in failed. Check your email and password and try again.");
    },
    async token() {
      const { data, error } = await client.auth.getSession();
      if (error) return undefined;
      return data.session?.access_token;
    },
    async signOut() {
      // Clears this tab's session even if the logout request cannot reach Auth.
      await client.auth.signOut({ scope: "local" });
    },
  }, baseUrl);
}

function configuredUrl(value: string | undefined, setting: string, protocols: string[]): string {
  if (!value) {
    throw new DashboardConfigurationError("Organiser sign-in has not been configured for this build.");
  }
  try {
    const url = new URL(value);
    if (!protocols.includes(url.protocol)) throw new Error();
    return url.toString().replace(/\/$/, "");
  } catch {
    const protocol = protocols.length === 1 ? protocols[0].replace(":", "").toUpperCase() : "HTTP or HTTPS";
    throw new DashboardConfigurationError(`${setting} must be a valid ${protocol} URL`);
  }
}
