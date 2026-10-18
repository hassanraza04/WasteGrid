import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { expect, test, vi } from "vitest";

import { LiveApp } from "./LiveApp";
import type { OrganizerApi, OrganizerReportDetails } from "./organizerApi";

const report = {
  id: "report-123", public_reference: "WG-123", title: "Overflowing bin", address: "1 Main Street",
  display_status: "Needs review", assessment_status: "needs_review", illustrative: false,
  photo_id: "photo-123", completion_photo_ids: [], note: "Beside the entrance", version: 7,
  state: "needs_review", dashboard_status: "submitted", priority: null, priority_reason: null,
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
  render(<MemoryRouter initialEntries={[path]}><LiveApp api={api} /></MemoryRouter>);
  return { api, user: userEvent.setup() };
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
