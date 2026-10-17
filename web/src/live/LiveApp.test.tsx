import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import { LiveApp } from "./LiveApp";
import { AccessError, type OrganizerApi } from "./organizerApi";
afterEach(() => vi.unstubAllEnvs());
const row = { id: "mobile-report-id", public_reference: "WG-LIVE", title: "Mobile upload", address: null, note: "Photo from mobile", display_status: "received", assessment_status: "pending", illustrative: false, photo_id: "photo-id", completion_photo_ids: [] };
function setup(path = "/admin") {
 const api = { signIn: vi.fn().mockResolvedValue(undefined), signOut: vi.fn().mockResolvedValue(undefined), reports: vi.fn().mockResolvedValue([row]), photo: vi.fn().mockResolvedValue("https://photos.example/signed") };
 render(<MemoryRouter initialEntries={[path]}><LiveApp api={api as unknown as OrganizerApi} /></MemoryRouter>);
 return { api, user: userEvent.setup() };
}
async function login(user: ReturnType<typeof userEvent.setup>) {
 await user.type(screen.getByLabelText("Email"), "organizer@example.com");
 await user.type(screen.getByLabelText("Password"), "test-password");
 await user.click(screen.getByRole("button", { name: "Sign in" }));
}
test("shows the mobile report from the API, refreshes photos and clears private data on logout", async () => {
 const { api, user } = setup(); await login(user);
 expect(await screen.findByText("WG-LIVE")).toBeInTheDocument();
 expect(screen.getByText(/Assessment: pending/)).toBeInTheDocument();
 await user.click(screen.getByRole("button", { name: "Load photo" }));
 const image = await screen.findByAltText("Reported waste"); expect(image).toHaveAttribute("src", "https://photos.example/signed");
 fireEvent.error(image); expect(screen.getByRole("alert")).toHaveTextContent("expired");
 api.photo.mockRejectedValueOnce(new Error("denied"));
 await user.click(screen.getByRole("button", { name: "Load photo" })); expect(await screen.findByRole("alert")).toHaveTextContent("Photo unavailable");
 api.reports.mockResolvedValueOnce([]);
 await user.click(screen.getByRole("button", { name: "Refresh reports" }));
 expect(await screen.findByText("No reports on this page.")).toBeInTheDocument();
 await user.click(screen.getByRole("button", { name: "Sign out" })); expect(await screen.findByRole("heading", { name: "Organiser sign in" })).toBeInTheDocument();
 expect(screen.queryByText("WG-LIVE")).not.toBeInTheDocument(); expect(api.signOut).toHaveBeenCalled();
});
test("paginates and labels synthetic records without treating them as real uploads", async () => {
 const { api, user } = setup();
 api.reports.mockResolvedValueOnce(Array.from({ length: 50 }, (_, i) => ({ ...row, id: String(i), public_reference: `WG-${i}`, address: "Park", note: null, illustrative: true })));
 await login(user); await screen.findByText("WG-0");
 expect(screen.getAllByText("Illustrative demo report")).toHaveLength(50);
 await user.click(screen.getByRole("button", { name: "Next page" })); await screen.findByText("WG-LIVE");
 expect(api.reports).toHaveBeenLastCalledWith(50);
 await user.click(screen.getByRole("button", { name: "Previous page" })); await waitFor(() => expect(api.reports).toHaveBeenLastCalledWith(0));
});
test("handles login and list failures, and returns to sign-in on expired authorization", async () => {
 const { api, user } = setup(); api.signIn.mockRejectedValueOnce(new Error("Invalid credentials"));
 await login(user); expect(await screen.findByRole("alert")).toHaveTextContent("Invalid credentials");
 api.reports.mockRejectedValueOnce(new Error("Offline")); await user.click(screen.getByRole("button", { name: "Sign in" }));
 expect(await screen.findByRole("alert")).toHaveTextContent("Offline");
 api.reports.mockRejectedValueOnce(new AccessError("Session expired"));
 await user.click(screen.getByRole("button", { name: "Refresh reports" }));
 expect(await screen.findByRole("heading", { name: "Organiser sign in" })).toBeInTheDocument();
 expect(screen.getByRole("alert")).toHaveTextContent("Session expired");
});
test("does not show reports when a request completes after sign-out", async () => {
 const { api, user } = setup(); await login(user); await screen.findByText("WG-LIVE");
 let finish!: (value: typeof row[]) => void;
 api.reports.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
 await user.click(screen.getByRole("button", { name: "Refresh reports" }));
 await user.click(screen.getByRole("button", { name: "Sign out" })); finish([row]);
 await waitFor(() => expect(screen.queryByText("WG-LIVE")).not.toBeInTheDocument());
});
test("public home links to real staff login and unmatched routes show a fallback", async () => {
 const { user } = setup("/"); expect(screen.getByRole("heading", { name: "WasteGrid" })).toBeInTheDocument();
 await user.click(screen.getByRole("link", { name: "Organiser sign in" })); expect(screen.getByLabelText("Password")).toBeInTheDocument();
});
test("unknown routes show a fallback", () => { setup("/not-a-route"); expect(screen.getByRole("heading", { name: "Page not found" })).toBeInTheDocument(); });
test("keeps customer report routes available beside the hosted dashboard", async () => {
 const { user } = setup("/report/new");
 await user.type(screen.getByLabelText("What needs attention?"), "Overflowing bin");
 await user.type(screen.getByLabelText("Address"), "14 Market Street");
 await user.click(screen.getByRole("button", { name: "Create report" }));
 expect(await screen.findByRole("heading", { name: /Report WG-/ })).toBeInTheDocument();
});
test("missing public configuration fails closed", () => {
 vi.stubEnv("VITE_API_BASE_URL", "");
 render(<MemoryRouter initialEntries={["/admin"]}><LiveApp /></MemoryRouter>);
 expect(screen.getByRole("alert")).toHaveTextContent("not been configured");
});
test("malformed organizer configuration stays on the organizer route with a specific error", () => {
 vi.stubEnv("VITE_API_BASE_URL", "https://api.example");
 vi.stubEnv("VITE_SUPABASE_URL", "not-a-url");
 vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
 render(<MemoryRouter initialEntries={["/admin"]}><LiveApp /></MemoryRouter>);
 expect(screen.getByRole("alert")).toHaveTextContent("VITE_SUPABASE_URL must be a valid HTTPS URL");
});
