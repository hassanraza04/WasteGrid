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

export interface OrganizerReport extends LiveReport {
  version: number;
  state: string;
  dashboard_status: string;
  priority: Priority | null;
  priority_reason: string | null;
  needs_review: boolean;
  assessment: OrganizerAssessment | null;
  triage: OrganizerTriage | null;
  resident_answers: { fire: boolean | null; sharp_objects: boolean | null };
  clarifications: Array<{ note: string; location: { latitude: number; longitude: number; landmark: string | null } | null; created_at: string }>;
  latest_update: { id: string; kind: string; created_at: string; message: string; status: string | null; report_state: string | null; job_status: string | null } | null;
  created_at: string;
  updated_at: string;
  job_id: string | null;
}

export interface OrganizerReportDetails {
  report: OrganizerReport;
  events: OrganizerEvent[];
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

export class OrganizerApi {
  constructor(private readonly auth: StaffAuth, private readonly baseUrl: string) {}

  async signIn(email: string, password: string): Promise<void> {
    await this.auth.signIn(email, password);
    try {
      const identity = await this.request<{ role: string }>("/auth/me");
      if (identity.role !== "organizer") throw new AccessError("This account does not have organiser access.");
    } catch (error) {
      await this.auth.signOut();
      throw error;
    }
  }

  signOut(): Promise<void> { return this.auth.signOut(); }

  reports(offset: number): Promise<LiveReport[]> {
    return this.request(`/organizer/reports?limit=50&offset=${offset}`, {}, "reports");
  }

  report(id: string): Promise<OrganizerReportDetails> {
    return this.request(`/organizer/reports/${encodeURIComponent(id)}`, {}, "details");
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
    const result = await this.request<{ url: string }>(`/photos/${encodeURIComponent(id)}/access`);
    return result.url;
  }

  private async request<T>(path: string, init: RequestInit = {}, action: "reports" | "details" | "mutation" = "details"): Promise<T> {
    const token = await this.auth.token();
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
    if (response.status === 401 || response.status === 403) throw new AccessError("Your session expired or access was denied. Please sign in again.");
    if (!response.ok) {
      if (action === "details" && response.status === 404) throw new Error("This report is no longer available. Refresh the reports list.");
      if (action === "mutation" && response.status === 409) throw new Error("This report changed or is not ready for that decision. Reload it and review the latest details.");
      if (action === "mutation" && response.status === 422) throw new Error("Check the decision fields and try again.");
      if (action === "mutation") throw new Error("Unable to save the organiser decision. Please retry.");
      if (action === "reports") throw new Error("Unable to load reports. Please retry.");
      throw new Error("Unable to load report details. Please retry.");
    }
    return response.json() as Promise<T>;
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
