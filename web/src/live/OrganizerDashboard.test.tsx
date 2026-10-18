import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { expect, test, vi } from "vitest";

import { LiveApp } from "./LiveApp";
import { AccessError, type OrganizerApi, type OrganizerReportDetails } from "./organizerApi";

const report = {
  id: "report-123", public_reference: "WG-123", title: "Overflowing bin", address: "1 Main Street",
  display_status: "Needs review", assessment_status: "needs_review", illustrative: false,
  photo_id: "photo-123", completion_photo_ids: [], note: "Beside the entrance", version: 7,
  location: null, state: "needs_review", dashboard_status: "submitted", priority: null, priority_reason: null,
  needs_review: true, assessment: null, triage: null, resident_answers: { fire: null, sharp_objects: null },
  clarifications: [], latest_update: null, created_at: "2026-10-18T00:00:00Z",
  updated_at: "2026-10-18T00:00:00Z", job_id: null,
};

function setup(path = "/admin") {
  const api = {
    signIn: vi.fn().mockResolvedValue(undefined),
    signOut: vi.fn().mockResolvedValue(undefined),
    reports: vi.fn().mockResolvedValue([report]),
    report: vi.fn().mockResolvedValue({ report, events: [] } satisfies OrganizerReportDetails),
    photo: vi.fn(), applyDecision: vi.fn(), setPriority: vi.fn(),
  } as unknown as OrganizerApi;
  const view = render(<MemoryRouter initialEntries={[path]}><LiveApp api={api} /></MemoryRouter>);
  return { api, user: userEvent.setup(), unmount: view.unmount };
}

async function signIn(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("Email"), "organizer@example.com");
  await user.type(screen.getByLabelText("Password"), "password");
  await user.click(screen.getByRole("button", { name: "Sign in" }));
}

test("opens a report detail route from the authenticated organiser list", async () => {
  const { api, user } = setup();
  await signIn(user);
  await user.click(await screen.findByRole("link", { name: "WG-123" }));
  expect(await screen.findByRole("heading", { name: "WG-123" })).toBeInTheDocument();
  expect(api.report).toHaveBeenCalledWith("report-123");
});

test("requires sign-in before loading a direct organiser detail route", async () => {
  const { api, user } = setup("/admin/reports/report-123");
  expect(screen.getByRole("heading", { name: "Organiser sign in" })).toBeInTheDocument();
  expect(api.report).not.toHaveBeenCalled();
  await signIn(user);
  expect(await screen.findByRole("heading", { name: "WG-123" })).toBeInTheDocument();
  expect(api.report).toHaveBeenCalledWith("report-123");
});

test("ignores an old decision rejection after another account signs in", async () => {
  const { api, user } = setup();
  let rejectMutation!: (error: Error) => void;
  vi.mocked(api.applyDecision).mockReturnValue(new Promise((_, reject) => { rejectMutation = reject; }));
  await signIn(user);
  await user.click(await screen.findByRole("link", { name: "WG-123" }));
  await screen.findByRole("heading", { name: "WG-123" });
  await user.type(screen.getByLabelText("Category"), "general waste");
  await user.click(screen.getByRole("checkbox", { name: "Gloves" }));
  await user.type(screen.getByLabelText("Decision summary"), "Keep under review");
  await user.click(screen.getByRole("button", { name: "Review decision" }));
  await user.click(screen.getByRole("button", { name: "Apply organiser decision" }));
  await user.click(screen.getByRole("button", { name: "Sign out" }));
  await user.clear(screen.getByLabelText("Email"));
  await user.type(screen.getByLabelText("Email"), "another-organizer@example.com");
  await user.type(screen.getByLabelText("Password"), "other-password");
  await user.click(screen.getByRole("button", { name: "Sign in" }));
  await screen.findByRole("heading", { name: "WG-123" });
  await act(async () => { rejectMutation(new AccessError("Old account expired")); });
  expect(screen.getByRole("heading", { name: "Organiser dashboard" })).toBeInTheDocument();
  expect(api.signOut).toHaveBeenCalledTimes(1);
});

test("does not submit a pending priority update after logout and another account signs in", async () => {
  const { api, user } = setup();
  let resolveMutation!: (value: typeof report) => void;
  vi.mocked(api.applyDecision).mockReturnValue(new Promise(resolve => { resolveMutation = resolve; }));
  vi.mocked(api.setPriority).mockResolvedValue({ ...report, version: 9, priority: "high" });
  await signIn(user);
  await user.click(await screen.findByRole("link", { name: "WG-123" }));
  await screen.findByRole("heading", { name: "WG-123" });
  await user.type(screen.getByLabelText("Category"), "general waste");
  await user.click(screen.getByRole("checkbox", { name: "Gloves" }));
  await user.type(screen.getByLabelText("Decision summary"), "Keep under review");
  await user.selectOptions(screen.getByLabelText("Priority override"), "high");
  await user.type(screen.getByLabelText("Priority reason"), "Specific test reason");
  await user.click(screen.getByRole("button", { name: "Review decision" }));
  await user.click(screen.getByRole("button", { name: "Apply organiser decision" }));
  await user.click(screen.getByRole("button", { name: "Sign out" }));
  await user.clear(screen.getByLabelText("Email"));
  await user.type(screen.getByLabelText("Email"), "another-organizer@example.com");
  await user.type(screen.getByLabelText("Password"), "other-password");
  await user.click(screen.getByRole("button", { name: "Sign in" }));
  await screen.findByRole("heading", { name: "WG-123" });
  await act(async () => { resolveMutation({ ...report, version: 8 }); });
  expect(api.setPriority).not.toHaveBeenCalled();
});

test("keeps sign-in available after a failed attempt without overlapping requests", async () => {
  const { api, user } = setup();
  let rejectLogin!: (error: Error) => void;
  vi.mocked(api.signIn).mockReturnValueOnce(new Promise((_, reject) => { rejectLogin = reject; }));
  await signIn(user);
  expect(screen.getByRole("button", { name: "Sign in" })).toBeDisabled();
  fireEvent.submit(screen.getByLabelText("Email").closest("form")!);
  expect(api.signIn).toHaveBeenCalledTimes(1);
  await act(async () => { rejectLogin(new Error("Sign-in failed. Please retry.")); });
  expect(screen.getByRole("alert")).toHaveTextContent("Sign-in failed");
  expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
  await user.click(screen.getByRole("button", { name: "Sign in" }));
  expect(await screen.findByRole("heading", { name: "Organiser dashboard" })).toBeInTheDocument();
});

test("waits for logout to finish before permitting another account login", async () => {
  const { api, user } = setup();
  let finishLogout!: () => void;
  vi.mocked(api.signOut).mockReturnValue(new Promise(resolve => { finishLogout = resolve; }));
  await signIn(user);
  await screen.findByRole("heading", { name: "Organiser dashboard" });
  await user.click(screen.getByRole("button", { name: "Sign out" }));
  expect(screen.getByRole("button", { name: "Sign in" })).toBeDisabled();
  fireEvent.submit(screen.getByLabelText("Email").closest("form")!);
  expect(api.signIn).toHaveBeenCalledTimes(1);
  await act(async () => { finishLogout(); });
  expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
});

test("handles logout failure without exposing its raw response", async () => {
  const { api, user } = setup();
  vi.mocked(api.signOut).mockRejectedValue(new Error("PRIVATE_AUTH_RESPONSE"));
  await signIn(user);
  await screen.findByRole("heading", { name: "Organiser dashboard" });
  await user.click(screen.getByRole("button", { name: "Sign out" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Unable to finish signing out");
  expect(screen.queryByText("PRIVATE_AUTH_RESPONSE")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
});

test("does not open reports when sign-in resolves after leaving the dashboard", async () => {
  const { api, user, unmount } = setup();
  let finishLogin!: () => void;
  vi.mocked(api.signIn).mockReturnValue(new Promise(resolve => { finishLogin = resolve; }));
  await signIn(user);
  unmount();
  await act(async () => { finishLogin(); });
  expect(api.reports).not.toHaveBeenCalled();
});

test("ends the current session on a current report access error", async () => {
  const { api, user } = setup("/admin/reports/report-123");
  vi.mocked(api.report).mockRejectedValue(new AccessError("Please sign in again."));
  await signIn(user);
  expect(await screen.findByRole("heading", { name: "Organiser sign in" })).toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent("Please sign in again");
  expect(api.signOut).toHaveBeenCalledTimes(1);
});
