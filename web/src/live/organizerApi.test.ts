import { afterEach, expect, test, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { AccessError, createOrganizerApi, OrganizerApi, type DecisionCommand, type OrganizerReportDetails, type StaffAuth } from "./organizerApi";
vi.mock("@supabase/supabase-js", () => ({ createClient: vi.fn() }));
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.clearAllMocks(); });
function setup() {
  const auth: StaffAuth = { signIn: vi.fn().mockResolvedValue(undefined), token: vi.fn().mockResolvedValue("user-jwt"), signOut: vi.fn().mockResolvedValue(undefined) };
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  return { auth, fetcher, api: new OrganizerApi(auth, "https://api.example") };
}
const details: OrganizerReportDetails = {
  report: {
    id: "report/id", public_reference: "WG-123", title: "Overflowing waste", address: "1 Main St",
    display_status: "Needs review", assessment_status: "assessed", illustrative: false,
    photo_id: "photo-1", completion_photo_ids: [], note: "Near the entrance", version: 3,
    state: "needs_review", dashboard_status: "needs_review", priority: "medium", priority_reason: "",
    needs_review: true,
    assessment: {
      description: "A pile of waste", size: "medium", obstruction: "walkway", obstruction_level: "partial",
      forces_people_into_traffic: "no", special_handling: "none_identified", visible_fire: "no",
      visible_sharp_objects: "unknown", confidence: 0.8, resident_context_agreement: "not_provided",
      comparison_reason: null, reason: "Visible waste blocks part of the path",
    },
    triage: {
      category: "waste", proposed_equipment: ["gloves", "trash_bags"], duplicate_candidate_id: null,
      duplicate_confirmed: false, hazard: false, evidence_sufficient: true, missing_information: [],
      decision_summary: "Collect the waste", evidence_report_ids: ["report/id"], next_action: "create_job",
      estimated_service_minutes: 20,
    },
    resident_answers: { fire: null, sharp_objects: null }, clarifications: [], latest_update: null,
    created_at: "2026-10-18T12:00:00Z", updated_at: "2026-10-18T12:00:00Z", job_id: null,
  },
  events: [{ id: "event-1", kind: "received", actor: "resident", created_at: "2026-10-18T12:00:00Z", details: {} }],
};
const decision: DecisionCommand = {
  command_id: "cmd-1", expected_version: 3, report_id: "report/id", category: "waste",
  proposed_equipment: ["gloves", "trash_bags"], duplicate_candidate_id: null, duplicate_confirmed: false,
  hazard: false, evidence_sufficient: true, missing_information: [], decision_summary: "Collect the waste",
  evidence_report_ids: ["report/id"], next_action: "create_job", estimated_service_minutes: 20,
};
test("authenticates, verifies the server role, paginates, and obtains private photo access", async () => {
  const { api, auth, fetcher } = setup();
  fetcher.mockResolvedValueOnce(Response.json({ role: "organizer" })).mockResolvedValueOnce(Response.json([{ id: "persisted-id" }])).mockResolvedValueOnce(Response.json({ url: "https://storage.example/photo" }));
  await api.signIn("user@example.com", "password");
  expect(auth.signIn).toHaveBeenCalledWith("user@example.com", "password");
  expect(await api.reports(50)).toEqual([{ id: "persisted-id" }]);
  expect(fetcher).toHaveBeenNthCalledWith(2, "https://api.example/organizer/reports?limit=50&offset=50", expect.objectContaining({ headers: { Authorization: "Bearer user-jwt" }, redirect: "error" }));
  expect(await api.photo("photo/id")).toBe("https://storage.example/photo");
  await api.signOut(); expect(auth.signOut).toHaveBeenCalled();
});
test("loads typed report details with bearer auth and encodes the report path segment", async () => {
  const { api, fetcher } = setup(); fetcher.mockResolvedValue(Response.json(details));
  await expect(api.report("report/id")).resolves.toEqual(details);
  expect(fetcher).toHaveBeenLastCalledWith("https://api.example/organizer/reports/report%2Fid", expect.objectContaining({ headers: { Authorization: "Bearer user-jwt" } }));
});
test("applies a decision as authenticated JSON and returns the updated report", async () => {
  const { api, fetcher } = setup(); fetcher.mockResolvedValue(Response.json(details.report));
  await expect(api.applyDecision("report-id", decision)).resolves.toEqual(details.report);
  expect(fetcher).toHaveBeenLastCalledWith("https://api.example/organizer/reports/report-id/decision", expect.objectContaining({ method: "POST", body: JSON.stringify(decision), headers: { Authorization: "Bearer user-jwt", "Content-Type": "application/json" } }));
});
test("sets priority as authenticated JSON and returns the updated report", async () => {
  const { api, fetcher } = setup(); const command = { command_id: "cmd-2", expected_version: 3, priority: "high" as const, reason: "Blocks the entrance" };
  fetcher.mockResolvedValue(Response.json(details.report));
  await expect(api.setPriority("report-id", command)).resolves.toEqual(details.report);
  expect(fetcher).toHaveBeenLastCalledWith("https://api.example/organizer/reports/report-id/priority", expect.objectContaining({ method: "POST", body: JSON.stringify(command), headers: { Authorization: "Bearer user-jwt", "Content-Type": "application/json" } }));
});
test.each([[409, "changed or is not ready"], [422, "Check the decision fields"]])("keeps decision HTTP %s errors safe and action-specific", async (status, message) => {
  const { api, fetcher } = setup(); fetcher.mockResolvedValue(new Response("private server response", { status }));
  await expect(api.applyDecision("report-id", decision)).rejects.toThrow(message);
  await expect(api.applyDecision("report-id", decision)).rejects.not.toThrow("private server response");
});
test.each([401, 403])("preserves access errors for decision HTTP %s", async status => {
  const { api, fetcher } = setup(); fetcher.mockResolvedValue(new Response("private server response", { status }));
  await expect(api.applyDecision("report-id", decision)).rejects.toBeInstanceOf(AccessError);
});
test("denies a crew session and clears it before showing any organiser data", async () => {
  const { api, auth, fetcher } = setup(); fetcher.mockResolvedValue(Response.json({ role: "crew" }));
  await expect(api.signIn("crew@example.com", "password")).rejects.toBeInstanceOf(AccessError);
  expect(auth.signOut).toHaveBeenCalled(); expect(fetcher).toHaveBeenCalledTimes(1);
});
test.each([401, 403, 500])("handles HTTP %s without exposing the server response", async status => {
  const { api, fetcher } = setup(); fetcher.mockResolvedValue(new Response("private server response", { status }));
  await expect(api.reports(0)).rejects.toThrow(status === 500 ? "Unable to load" : "session expired");
});
test("fails closed on expired sessions and reports a network failure", async () => {
  const { api, auth, fetcher } = setup(); vi.mocked(auth.token).mockResolvedValueOnce(undefined);
  await expect(api.reports(0)).rejects.toThrow("Please sign in"); expect(fetcher).not.toHaveBeenCalled();
  fetcher.mockRejectedValue(new Error("secret connection details"));
  await expect(api.reports(0)).rejects.toThrow("Unable to reach WasteGrid");
});
test("requires only public configuration and uses an in-memory, refreshing Supabase session", async () => {
  vi.stubEnv("VITE_API_BASE_URL", "");
  expect(() => createOrganizerApi()).toThrow("not been configured");
  vi.stubEnv("VITE_API_BASE_URL", "https://api.example/"); vi.stubEnv("VITE_SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "sb_secret_DO_NOT_EMBED");
  expect(() => createOrganizerApi()).toThrow("not been configured");
  vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
  const auth = { signInWithPassword: vi.fn().mockResolvedValue({ error: null }), getSession: vi.fn().mockResolvedValue({ data: { session: { access_token: "jwt" } }, error: null }), signOut: vi.fn().mockResolvedValue({ error: null }) };
  vi.mocked(createClient).mockReturnValue({ auth } as unknown as ReturnType<typeof createClient>);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ role: "organizer" })));
  const api = createOrganizerApi(); await api.signIn("email", "password"); await api.signOut();
  expect(createClient).toHaveBeenCalledWith("https://test.supabase.co", "sb_publishable_test", expect.objectContaining({ auth: { persistSession: false, autoRefreshToken: true, detectSessionInUrl: false } }));
  auth.signInWithPassword.mockResolvedValueOnce({ error: new Error("private auth details") } as never);
  await expect(api.signIn("email", "wrong")).rejects.toThrow("Sign-in failed");
  auth.getSession.mockResolvedValueOnce({ error: new Error("expired"), data: { session: null } } as never);
  await expect(api.reports(0)).rejects.toThrow("Please sign in");
  auth.getSession.mockResolvedValueOnce({ error: null, data: { session: null } } as never);
  await expect(api.reports(0)).rejects.toThrow("Please sign in");
});
test("rejects a malformed Supabase URL before initializing the browser client", () => {
  vi.stubEnv("VITE_API_BASE_URL", "https://api.example");
  vi.stubEnv("VITE_SUPABASE_URL", "not-a-url");
  vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");

  expect(() => createOrganizerApi()).toThrow("VITE_SUPABASE_URL must be a valid HTTPS URL");
  expect(createClient).not.toHaveBeenCalled();
});
