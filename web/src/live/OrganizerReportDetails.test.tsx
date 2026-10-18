import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
import { expect, test, vi } from "vitest";

import { OrganizerReportDetails } from "./OrganizerReportDetails";
import type { OrganizerApi, OrganizerReportDetails as ReportDetails } from "./organizerApi";

const details: ReportDetails = {
  report: {
    id: "report-123", public_reference: "WG-123", title: "Overflowing bin", address: "1 Main Street",
    display_status: "Needs review", assessment_status: "needs_review", illustrative: true,
    photo_id: "photo-123", completion_photo_ids: [], note: "Beside the entrance", version: 7,
    state: "needs_review", dashboard_status: "submitted", priority: "medium", priority_reason: "Partial walkway obstruction.",
    needs_review: true, resident_answers: { fire: false, sharp_objects: null }, clarifications: [{ note: "Near the school gate", location: null, created_at: "2026-10-18T01:00:00Z" }],
    latest_update: null, created_at: "2026-10-18T00:00:00Z", updated_at: "2026-10-18T00:00:00Z", job_id: null,
    assessment: { description: "Bags block part of the path", size: "medium", obstruction: "walkway", obstruction_level: "partial", forces_people_into_traffic: "no", special_handling: "none_identified", visible_fire: "no", visible_sharp_objects: "unknown", confidence: 0.8, resident_context_agreement: "consistent", comparison_reason: "Matches the resident note", reason: "Waste is visible in the image." },
    triage: { category: "general waste", proposed_equipment: ["gloves", "trash_bags"], duplicate_candidate_id: null, duplicate_confirmed: false, hazard: false, evidence_sufficient: true, missing_information: [], decision_summary: "Collection is needed.", evidence_report_ids: ["report-123"], next_action: "review", estimated_service_minutes: 20 },
  },
  events: [{ id: "event-1", kind: "report.assessed", actor: "organizer-id", created_at: "2026-10-18T02:00:00Z", details: { assessment_status: "needs_review", priority: "medium", photo_url: "https://private.example/signed", nested: { hidden: true } } }],
};

function setup() {
  const api = { report: vi.fn().mockResolvedValue(details), photo: vi.fn().mockResolvedValue("https://photos.example/signed"), applyDecision: vi.fn(), setPriority: vi.fn() } as unknown as OrganizerApi;
  render(<MemoryRouter initialEntries={["/admin/reports/report-123"]}><Routes><Route path="/admin/reports/:reportId" element={<OrganizerReportDetails api={api} />} /></Routes></MemoryRouter>);
  return { api, user: userEvent.setup() };
}

test("shows the complete persisted assessment, triage, and activity without loading the private photo", async () => {
  const { api } = setup();
  expect(await screen.findByRole("heading", { name: "WG-123" })).toBeInTheDocument();
  expect(screen.getByText("Bags block part of the path")).toBeInTheDocument();
  expect(screen.getAllByText("Collection is needed.").length).toBeGreaterThan(0);
  expect(screen.getByText((_, element) => element?.tagName === "P" && element.textContent === "Resident fire: false")).toBeInTheDocument();
  expect(screen.getByText((_, element) => element?.tagName === "P" && element.textContent === "Evidence sufficient: true")).toBeInTheDocument();
  expect(screen.getByText("report.assessed")).toBeInTheDocument();
  expect(screen.queryByText((_, element) => element?.tagName === "P" && element.textContent?.includes("https://private.example/signed") === true)).not.toBeInTheDocument();
  expect(screen.queryByAltText("Reported waste")).not.toBeInTheDocument();
  expect(api.photo).not.toHaveBeenCalled();
});

test("loads the signed private photo only after the organiser asks for it", async () => {
  const { api, user } = setup();
  await screen.findByRole("heading", { name: "WG-123" });
  await user.click(screen.getByRole("button", { name: "Load photo" }));
  expect(await screen.findByAltText("Reported waste")).toHaveAttribute("src", "https://photos.example/signed");
  expect(api.photo).toHaveBeenCalledWith("photo-123");
  expect(screen.queryByText("https://photos.example/signed")).not.toBeInTheDocument();
});

test("clears the previous report when loading a different report route fails", async () => {
  const api = { report: vi.fn().mockResolvedValueOnce(details).mockRejectedValueOnce(new Error("Unable to load report details. Please retry.")), photo: vi.fn().mockResolvedValue("https://photos.example/signed"), applyDecision: vi.fn(), setPriority: vi.fn() } as unknown as OrganizerApi;
  render(<MemoryRouter initialEntries={["/admin/reports/report-123"]}><Link to="/admin/reports/report-456">Other report</Link><Routes><Route path="/admin/reports/:reportId" element={<OrganizerReportDetails api={api} />} /></Routes></MemoryRouter>);
  const user = userEvent.setup();
  await screen.findByRole("heading", { name: "WG-123" });
  await user.click(screen.getByRole("button", { name: "Load photo" }));
  await screen.findByAltText("Reported waste");
  await user.click(screen.getByRole("link", { name: "Other report" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Unable to load report details");
  expect(screen.queryByRole("heading", { name: "WG-123" })).not.toBeInTheDocument();
  expect(screen.queryByAltText("Reported waste")).not.toBeInTheDocument();
});
