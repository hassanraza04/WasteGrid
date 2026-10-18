// Backend contracts shared by native adapters and transport/recovery tests.
export type StaffIdentity = { userId: string; role: string; crewId?: string };
export type StaffCredentials = { token: string; identity: StaffIdentity; isCurrent(): boolean };
export type Job = {
  id: string; status: string; version: number; category: string;
  assigned_crew_id: string | null; route_position: number | null;
  location: { latitude: number; longitude: number; landmark?: string | null };
  held: boolean; locked: boolean; decision_summary: string; unassigned_reason: string | null;
};
export type Crew = {
  id: string; name: string; available: boolean;
  start_location: Job["location"];
  location_recorded_at: string | null; location_received_at: string | null;
};
export type Stop = { job_id: string; position: number; priority: string; fixed: boolean; travel_minutes: number; service_minutes: number; completion_minutes: number };
export type Preview = {
  id: string; computed_at: string; expires_at: string; plan_id: string | null;
  dispatchable: boolean; termination_reason: string; travel_label: string;
  routes: { crew_id: string; duration_minutes: number; travel_minutes: number; stops: Stop[] }[];
  exclusions: { job_id: string; reason: string }[]; unassigned: { job_id: string; reason: string }[];
  reassignments: { job_id: string; previous_crew_id: string | null; proposed_crew_id: string; previous_position: number | null; proposed_position: number }[];
};
export type CurrentPlan = { plan: null | {
  id: string; stale: boolean; created_at: string; travel_estimates_label: string;
  assignments: { job_id: string; crew_id: string; position: number; travel_minutes: number; service_minutes: number }[];
} };
export type JobDetails = { job: Job; events: { command_id?: string | null; kind: string; details?: Record<string, unknown> }[] };
export class StaffApiError extends Error {
  constructor(public status: number) {
    super(({ 401: "Your staff session expired. Sign in again.", 403: "This account cannot perform that action.",
      404: "This job or preview is no longer available to your account.",
      409: "State changed or the action is blocked. Refresh and review before trying again.",
      413: "The photo exceeds the server's size or pixel limit. Retake a smaller photo.",
      415: "Use a JPEG, PNG or WebP photo.", 422: "The submitted details were rejected. Review your selection or photo.",
      503: "Routing or the backend is unavailable. Check service configuration and retry."
    } as Record<number, string>)[status] ?? "WasteGrid is unavailable. Keep your saved action and retry.");
  }
}
export class StaffClient {
  constructor(private base: () => string, private credentials: () => Promise<StaffCredentials>, private transport: typeof fetch) {}
  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const auth = await this.credentials();
    const base = this.base().replace(/\/+$/, "");
    if (!/^https:\/\//.test(base) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base)) throw new Error("Configure the staff API URL.");
    if (!auth.isCurrent()) throw new Error("Your account changed. Refresh and try again.");
    const response = await this.transport(base + path, { ...init,
      headers: { ...init.headers, Authorization: `Bearer ${auth.token}` },
      signal: AbortSignal.timeout(90_000), redirect: "error" });
    if (!auth.isCurrent()) throw new Error("Your account changed. Refresh and try again.");
    if (!response.ok) throw new StaffApiError(response.status);
    const result: T = await response.json();
    if (!auth.isCurrent()) throw new Error("Your account changed. Refresh and try again.");
    return result;
  }
  json<T>(path: string, body: unknown, method = "POST") {
    return this.request<T>(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  }
  currentPlan() { return this.request<CurrentPlan>("/plans/current"); }
  crews() { return this.request<Crew[]>("/crews"); }
  async jobs() {
    const jobs: Job[] = [];
    for (let offset = 0; offset < 10000; offset += 100) {
      const page = await this.request<Job[]>(`/jobs?active_only=true&limit=100&offset=${offset}`);
      if (page.some(job => job.status === "completed") || (page.length && page.every(job => jobs.some(previous => previous.id === job.id)))) {
        throw new Error("The API did not apply active-job filtering or pagination. Deploy the updated backend and refresh.");
      }
      jobs.push(...page);
      if (page.length < 100) return [...new Map(jobs.map(job => [job.id, job])).values()];
    }
    throw new Error("Too many active jobs to load. Narrow the operational scope before routing.");
  }
  job(id: string) { return this.request<JobDetails>(`/jobs/${encodeURIComponent(id)}`); }
  compute(ids: string[]) { return this.json<Preview>("/routing/previews", { crew_ids: ids }); }
  preview(id: string) { return this.request<Preview>(`/routing/previews/${encodeURIComponent(id)}`); }
  location(location: Job["location"], recordedAt: string) {
    return this.json("/crews/me/location", { location, recorded_at: recordedAt });
  }
}
