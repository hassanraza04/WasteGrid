import { afterEach, expect, test, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { AccessError, OrganizerMutationRejectedError, createOrganizerApi, OrganizerApi, RoutingConflictError, RoutingContractError, type DecisionCommand, type OrganizerJobDetails, type OrganizerReportDetails, type StaffAuth } from "./organizerApi";
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
    location: { latitude: 24.92, longitude: 67.09, landmark: "Gate" },
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
  fetcher.mockResolvedValueOnce(Response.json({ role: "organizer", user_id: "11111111-1111-4111-8111-111111111111" })).mockResolvedValueOnce(Response.json([{ id: "persisted-id" }])).mockResolvedValueOnce(Response.json({ url: "https://storage.example/photo" }));
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
test("loads every active job page and sends an explicit reviewed routing scope", async () => {
  const { api, fetcher } = setup();
  const firstPage = Array.from({ length: 100 }, (_, index) => ({ id: `job-${index}` }));
  const preview = { id: "preview-1", job_ids: ["job-1"], routes: [], exclusions: [], unassigned: [], reassignments: [], dispatchable: false, expires_at: "2026-10-18T13:00:00Z", plan_id: null };
  fetcher.mockResolvedValueOnce(Response.json(firstPage)).mockResolvedValueOnce(Response.json([{ id: "job-100" }])).mockResolvedValueOnce(Response.json(preview));

  await expect(api.jobs()).resolves.toHaveLength(101);
  await expect(api.previewRouting(["crew-1"], ["job-1"])).resolves.toEqual(preview);

  expect(fetcher).toHaveBeenNthCalledWith(1, "https://api.example/jobs?active_only=true&limit=100&offset=0", expect.objectContaining({ headers: { Authorization: "Bearer user-jwt" } }));
  expect(fetcher).toHaveBeenNthCalledWith(2, "https://api.example/jobs?active_only=true&limit=100&offset=100", expect.objectContaining({ headers: { Authorization: "Bearer user-jwt" } }));
  expect(fetcher).toHaveBeenNthCalledWith(3, "https://api.example/routing/previews", expect.objectContaining({ method: "POST", body: JSON.stringify({ crew_ids: ["crew-1"], job_ids: ["job-1"] }), headers: { Authorization: "Bearer user-jwt", "Content-Type": "application/json" } }));
});
test.each([
  [422, RoutingContractError],
  [409, RoutingConflictError],
] as const)("classifies routing HTTP %s without exposing the server response", async (status, ErrorType) => {
  const { api, fetcher } = setup();
  fetcher.mockResolvedValue(new Response("private server response", { status }));

  await expect(api.previewRouting(["crew-1"], ["job-1"])).rejects.toBeInstanceOf(ErrorType);
  await expect(api.previewRouting(["crew-1"], ["job-1"])).rejects.not.toThrow("private server response");
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
  await expect(api.applyDecision("report-id", decision)).rejects.toMatchObject({ status });
  await expect(api.applyDecision("report-id", decision)).rejects.toBeInstanceOf(OrganizerMutationRejectedError);
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
test("preserves the generic safe error when private photo access fails", async () => {
  const { api, fetcher } = setup(); fetcher.mockResolvedValue(new Response("private server response", { status: 404 }));
  await expect(api.photo("photo-id")).rejects.toThrow("Unable to load reports. Please retry.");
  await expect(api.photo("photo-id")).rejects.not.toThrow("private server response");
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
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ role: "organizer", user_id: "11111111-1111-4111-8111-111111111111" })));
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

const jobDetails: OrganizerJobDetails = {
  job: {
    id: "job/id", status: "assigned", location: { latitude: 24.92, longitude: 67.09, landmark: null },
    category: "general waste", required_equipment: ["gloves", "trash_bags"], estimated_service_minutes: 20,
    assigned_crew_id: "crew-1", locked: false, held: false, route_position: 1, travel_minutes: 3.5,
    decision_summary: "Collection is needed", unassigned_reason: null, version: 4, illustrative: false,
  },
  photo_ids: ["photo-1"],
  events: [{ id: "job-event-1", kind: "job.assigned", actor: "organizer-id", created_at: "2026-10-18T12:00:00Z", details: {}, command_id: "dispatch-command" }],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test("loads the linked cleanup job and its photo and audit contracts with an encoded path", async () => {
  const { api, fetcher } = setup();
  fetcher.mockResolvedValue(Response.json(jobDetails));
  await expect(api.job("job/id")).resolves.toEqual(jobDetails);
  expect(fetcher).toHaveBeenCalledWith("https://api.example/jobs/job%2Fid", expect.objectContaining({ headers: { Authorization: "Bearer user-jwt" } }));
});

test.each([
  ["report", 404, "This report is no longer available"],
  ["report", 500, "Unable to load report details"],
  ["job", 404, "This cleanup job is no longer available"],
  ["job", 500, "Unable to load cleanup job details"],
] as const)("reports a safe %s HTTP %s failure", async (action, status, message) => {
  const { api, fetcher } = setup();
  fetcher.mockResolvedValue(new Response("private server response", { status }));
  await expect(api[action]("missing/id")).rejects.toThrow(message);
  await expect(api[action]("missing/id")).rejects.not.toThrow("private server response");
});

test("keeps server failures safe for an organiser mutation", async () => {
  const { api, fetcher } = setup();
  fetcher.mockResolvedValue(new Response("private server response", { status: 500 }));
  await expect(api.applyDecision("report-id", decision)).rejects.toThrow("Unable to save the organiser decision");
});

test("changes the session version as soon as authentication starts or sign-out is requested", async () => {
  const { api, auth, fetcher } = setup();
  const signingIn = deferred<void>();
  vi.mocked(auth.signIn).mockReturnValueOnce(signingIn.promise);
  const pending = api.signIn("organizer@example.com", "password");
  expect(api.sessionVersion).toBe(1);
  const signingOut = api.signOut();
  expect(api.sessionVersion).toBe(2);
  signingIn.resolve(undefined);
  await expect(pending).rejects.toThrow("session changed");
  await signingOut;
  expect(fetcher).not.toHaveBeenCalled();
  expect(auth.signOut).toHaveBeenCalledTimes(1);
});

test("never sends a pending command with a token resolved after the account changed", async () => {
  const { api, auth, fetcher } = setup();
  const token = deferred<string>();
  vi.mocked(auth.token).mockReturnValueOnce(token.promise);
  const pending = api.applyDecision("report-id", decision);
  fetcher.mockResolvedValue(Response.json({ role: "organizer", user_id: "11111111-1111-4111-8111-111111111111" }));
  await api.signOut();
  await api.signIn("other@example.com", "password");
  token.resolve("other-account-token");
  await expect(pending).rejects.toThrow("session changed");
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher).toHaveBeenCalledWith("https://api.example/auth/me", expect.anything());
});

test("rejects a stale response before classifying its access failure", async () => {
  const { api, fetcher } = setup();
  const response = deferred<Response>();
  fetcher.mockReturnValueOnce(response.promise);
  const pending = api.report("report-id");
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  await api.signOut();
  response.resolve(new Response("private server response", { status: 401 }));
  await expect(pending).rejects.toThrow("session changed");
});

test("does not return mutation success when the session changes while parsing its response", async () => {
  const { api, fetcher } = setup();
  const body = deferred<OrganizerReportDetails["report"]>();
  const json = vi.fn().mockReturnValue(body.promise);
  fetcher.mockResolvedValueOnce({ ok: true, status: 200, json } as unknown as Response);
  const pending = api.applyDecision("report-id", decision);
  await vi.waitFor(() => expect(json).toHaveBeenCalledOnce());
  await api.signOut();
  body.resolve(details.report);
  await expect(pending).rejects.toThrow("session changed");
});

test("rejects a second sign-in while the first organiser's role check is pending", async () => {
  const { api, auth, fetcher } = setup();
  const identity = deferred<{ role: string; user_id: string }>();
  const json = vi.fn().mockReturnValue(identity.promise);
  fetcher.mockResolvedValueOnce({ ok: true, status: 200, json } as unknown as Response)
    .mockResolvedValueOnce(Response.json({ role: "organizer", user_id: "11111111-1111-4111-8111-111111111111" }));
  const first = api.signIn("first@example.com", "password");
  await vi.waitFor(() => expect(json).toHaveBeenCalledOnce());
  await expect(api.signIn("second@example.com", "another-password")).rejects.toThrow("already in progress");
  expect(auth.signIn).toHaveBeenCalledTimes(1);
  identity.resolve({ role: "organizer", user_id: "11111111-1111-4111-8111-111111111111" });
  await first;
  expect(auth.signOut).not.toHaveBeenCalled();
});

test("rejects unsupported URL protocols and a missing public key before creating a client", () => {
  vi.stubEnv("VITE_API_BASE_URL", "ftp://api.example");
  expect(() => createOrganizerApi()).toThrow("VITE_API_BASE_URL must be a valid HTTP or HTTPS URL");
  vi.stubEnv("VITE_API_BASE_URL", "https://api.example");
  vi.stubEnv("VITE_SUPABASE_URL", "http://test.supabase.co");
  expect(() => createOrganizerApi()).toThrow("VITE_SUPABASE_URL must be a valid HTTPS URL");
  vi.stubEnv("VITE_SUPABASE_URL", "https://test.supabase.co");
  vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", undefined);
  expect(() => createOrganizerApi()).toThrow("not been configured");
  expect(createClient).not.toHaveBeenCalled();
});

test("logout waits for a late SDK sign-in write, blocks new logins and requests, then clears the session", async () => {
  const signingIn = deferred<void>();
  const clearing = deferred<void>();
  let sdkSession: string | undefined;
  const auth: StaffAuth = {
    signIn: vi.fn(async () => { await signingIn.promise; sdkSession = "old-account"; }),
    token: vi.fn(async () => sdkSession),
    signOut: vi.fn(async () => { await clearing.promise; sdkSession = undefined; }),
  };
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  const api = new OrganizerApi(auth, "https://api.example");
  const first = api.signIn("first@example.com", "first-password");
  const signingOut = api.signOut();
  const duplicateLogout = api.signOut();
  expect(duplicateLogout).toBe(signingOut);
  await expect(api.signIn("second@example.com", "do-not-queue")).rejects.toThrow("already in progress");
  await expect(api.reports(0)).rejects.toBeInstanceOf(AccessError);
  expect(auth.signOut).not.toHaveBeenCalled();
  signingIn.resolve(undefined);
  await expect(first).rejects.toThrow("session changed");
  await vi.waitFor(() => expect(auth.signOut).toHaveBeenCalledOnce());
  expect(sdkSession).toBe("old-account");
  await expect(api.signIn("second@example.com", "still-do-not-queue")).rejects.toThrow("already in progress");
  clearing.resolve(undefined);
  await signingOut;
  expect(sdkSession).toBeUndefined();
  expect(auth.signIn).toHaveBeenCalledOnce();
  expect(auth.token).not.toHaveBeenCalled();
  expect(fetcher).not.toHaveBeenCalled();
  fetcher.mockResolvedValue(Response.json({ role: "organizer", user_id: "11111111-1111-4111-8111-111111111111" }));
  await api.signIn("second@example.com", "new-attempt");
  expect(auth.signIn).toHaveBeenCalledTimes(2);
});

test("failed SDK sign-in cleanup holds the guard until completed and allows a fresh attempt", async () => {
  const { api, auth, fetcher } = setup();
  const cleanup = deferred<void>();
  vi.mocked(auth.signIn).mockRejectedValueOnce(new Error("Sign-in failed"));
  vi.mocked(auth.signOut).mockReturnValueOnce(cleanup.promise);
  const first = api.signIn("first@example.com", "wrong-password");
  await vi.waitFor(() => expect(auth.signOut).toHaveBeenCalledOnce());
  await expect(api.signIn("second@example.com", "do-not-queue")).rejects.toThrow("already in progress");
  cleanup.resolve(undefined);
  await expect(first).rejects.toThrow("Sign-in failed");
  fetcher.mockResolvedValue(Response.json({ role: "organizer", user_id: "11111111-1111-4111-8111-111111111111" }));
  await api.signIn("second@example.com", "new-attempt");
  expect(auth.signIn).toHaveBeenCalledTimes(2);
});

test("loads additive read contracts and persists verified identity only until logout", async () => {
  const { api, fetcher } = setup();
  fetcher.mockResolvedValueOnce(Response.json({ role: "organizer", user_id: "11111111-1111-4111-8111-111111111111" }));
  await api.signIn("user@example.com", "password");
  expect(api.verifiedUserId).toBe("11111111-1111-4111-8111-111111111111");
  expect(api.environment).toBe("https://api.example");
  fetcher.mockImplementation(() => Promise.resolve(Response.json({ items: [], total: 0 })));
  await api.overview(true); await api.reportIndex({ q: "WG abc", include_illustrative: false, limit: 25 });
  await api.jobIndex(100, true); await api.preview("p/id"); await api.geometry("p/id", "c/id");
  const urls = fetcher.mock.calls.map(call => call[0]);
  expect(urls).toContain("https://api.example/organizer/overview?include_illustrative=true");
  expect(urls).toContain("https://api.example/organizer/report-index?q=WG+abc&include_illustrative=false&limit=25");
  expect(urls).toContain("https://api.example/organizer/job-index?limit=100&offset=100&include_illustrative=true");
  expect(urls).toContain("https://api.example/routing/previews/p%2Fid/geometry/c%2Fid");
  await api.signOut(); expect(api.verifiedUserId).toBeNull();
});

test("requires a server verified UUID before treating an account as an organiser", async () => {
  const { api, auth, fetcher } = setup(); fetcher.mockResolvedValue(Response.json({ role: "organizer", user_id: "bad" }));
  await expect(api.signIn("user@example.com", "password")).rejects.toThrow("verify organiser identity");
  expect(api.verifiedUserId).toBeNull(); expect(auth.signOut).toHaveBeenCalled();
});

test("loads every enriched job page including illustrative ownership checks", async () => {
  const { api, fetcher } = setup();
  fetcher.mockResolvedValueOnce(Response.json({ items: Array.from({ length: 100 }, (_, i) => ({ id: `${i}` })), total: 101 }))
    .mockResolvedValueOnce(Response.json({ items: [{ id: "last" }], total: 101 }));
  expect(await api.indexedJobs()).toHaveLength(101);
  expect(fetcher.mock.calls[1][0]).toContain("offset=100&include_illustrative=true");
});

test("bounds an endlessly growing active job list", async () => {
  const { api, fetcher } = setup(); fetcher.mockImplementation(() => Promise.resolve(Response.json({ items: Array.from({ length: 100 }, () => ({ id: "j" })), total: 10001 })));
  await expect(api.indexedJobs()).rejects.toThrow("Too many jobs");
});

test("sends routing constraints and explicit partial intent unchanged", async () => {
  const { api, fetcher } = setup(); fetcher.mockImplementation(() => Promise.resolve(Response.json({})));
  const constraints = { max_duration_minutes: 120, max_stops_per_crew: 10, return_to_start: true, allow_partial: true };
  await api.previewRouting(["crew"], ["job"], constraints); await api.dispatchRouting("preview", "command", true);
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ crew_ids: ["crew"], job_ids: ["job"], constraints });
  expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ command_id: "command", accept_partial: true });
});

test("records only redacted bounded diagnostics for invalid responses and timeouts", async () => {
  const { api, fetcher } = setup();
  const { organizerDiagnostics } = await import("./organizerDiagnostics");
  fetcher.mockRejectedValueOnce(new DOMException("private signed URL", "TimeoutError"));
  await expect(api.photo("secret-report-id")).rejects.toThrow("service may be waking up");
  fetcher.mockResolvedValueOnce(new Response("private report text", { status: 200 }));
  await expect(api.overview()).rejects.toThrow("unreadable response");
  expect(organizerDiagnostics().some(item => item.category === "timeout")).toBe(true);
  expect(organizerDiagnostics().at(-1)?.category).toBe("invalid_response");
  expect(JSON.stringify(organizerDiagnostics())).not.toMatch(/private|signed|secret-report|user-jwt/);
  fetcher.mockImplementation(() => Promise.resolve(Response.json([])));
  for (let i = 0; i < 45; i++) await api.reports(0);
  const records = organizerDiagnostics(); expect(records).toHaveLength(40);
  expect(Object.keys(records[0]).sort()).toEqual(["category", "durationMs", "operation", "status"]);
});
