import { afterEach, expect, test, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { AccessError, createOrganizerApi, OrganizerApi, type StaffAuth } from "./organizerApi";
vi.mock("@supabase/supabase-js", () => ({ createClient: vi.fn() }));
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.clearAllMocks(); });
function setup() {
  const auth: StaffAuth = { signIn: vi.fn().mockResolvedValue(undefined), token: vi.fn().mockResolvedValue("user-jwt"), signOut: vi.fn().mockResolvedValue(undefined) };
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  return { auth, fetcher, api: new OrganizerApi(auth, "https://api.example") };
}
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
