import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
import { expect, test, vi } from "vitest";

import { OrganizerReportDetails } from "./OrganizerReportDetails";
import { AccessError, type OrganizerApi, type OrganizerReportDetails as ReportDetails } from "./organizerApi";

const details: ReportDetails = {
  report: {
    id: "report-123", location: { latitude: 24.86, longitude: 67.01, landmark: "Main entrance" }, public_reference: "WG-123", title: "Overflowing bin", address: "1 Main Street",
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

function setup(value: ReportDetails = details) {
  const api = { report: vi.fn().mockResolvedValue(value), job: vi.fn(), photo: vi.fn().mockResolvedValue("https://photos.example/signed"), applyDecision: vi.fn(), setPriority: vi.fn() } as unknown as OrganizerApi;
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


test("shows coordinates, location corrections, timestamps and the review requirement", async () => {
  setup({ ...details, report: { ...details.report, clarifications: [{ note: "Corrected entrance", location: { latitude: 24.87, longitude: 67.02, landmark: "North gate" }, created_at: "2026-10-18T02:00:00Z" }] } });
  await screen.findByRole("heading", { name: "WG-123" });
  expect(screen.getByText("Main entrance")).toBeInTheDocument();
  expect(screen.getByText("24.86")).toBeInTheDocument();
  expect(screen.getByText("67.01")).toBeInTheDocument();
  expect(screen.getByText("North gate")).toBeInTheDocument();
  expect(screen.getByText("24.87")).toBeInTheDocument();
  expect(screen.getByText((_, node) => node?.textContent === "Review required: true")).toBeInTheDocument();
  expect(screen.getByText((_, node) => node?.textContent === `Created: ${new Date(details.report.created_at).toLocaleString()}`)).toBeInTheDocument();
  expect(screen.getByText((_, node) => node?.textContent === `Updated: ${new Date(details.report.updated_at).toLocaleString()}`)).toBeInTheDocument();
});

test("shows missing coordinates and records without assessment, triage, clarifications or activity", async () => {
  setup({ report: { ...details.report, location: null, note: "", assessment: null, triage: null, clarifications: [], illustrative: false }, events: [] });
  await screen.findByRole("heading", { name: "WG-123" });
  expect(screen.getByText("Coordinates not recorded.")).toBeInTheDocument();
  expect(screen.getByText("No assessment has been recorded yet.")).toBeInTheDocument();
  expect(screen.getByText("No organiser decision has been recorded yet.")).toBeInTheDocument();
  expect(screen.getByText("No clarifications recorded.")).toBeInTheDocument();
  expect(screen.getByText("No activity recorded.")).toBeInTheDocument();
});

test("shows safe priority and triage rationales without rendering arbitrary nested event payloads", async () => {
  setup({ ...details, events: [
    { ...details.events[0], id: "priority-event", kind: "report.priority_set", details: { reason: "School path needs priority", priority: "high", photo_url: "PRIVATE_URL", secret: "PRIVATE_SECRET" } },
    { ...details.events[0], id: "triage-event", kind: "report.triaged", details: { decision: { decision_summary: "Human reviewed collection evidence", unexpected: "PRIVATE_NESTED_SECRET" }, applied_state: "needs_review" } },
    { ...details.events[0], id: "other-event", details: { reason: "PRIVATE_UNRECOGNIZED_REASON", priority: { nested: "PRIVATE_OBJECT" } } },
    { ...details.events[0], id: "bad-reason", kind: "report.priority_set", details: { reason: { token: "PRIVATE_OBJECT" } } },
    { ...details.events[0], id: "bad-decision", kind: "report.triaged", details: { decision: null } },
    { ...details.events[0], id: "malformed-decision", kind: "report.triaged", details: { decision: { decision_summary: 42 } } },
  ] });
  await screen.findByRole("heading", { name: "WG-123" });
  expect(screen.getByText("Reason: School path needs priority")).toBeInTheDocument();
  expect(screen.getByText("Decision Summary: Human reviewed collection evidence")).toBeInTheDocument();
  expect(screen.getByText("Applied State: needs_review")).toBeInTheDocument();
  expect(document.body.textContent).not.toContain("PRIVATE_");
});

test("retries report loading after a service failure", async () => {
  const api = { report: vi.fn().mockRejectedValueOnce(new Error("Service waking up")).mockResolvedValue(details), photo: vi.fn() } as unknown as OrganizerApi;
  render(<MemoryRouter initialEntries={["/admin/reports/report-123"]}><Routes><Route path="/admin/reports/:reportId" element={<OrganizerReportDetails api={api} />} /></Routes></MemoryRouter>);
  expect(await screen.findByRole("alert")).toHaveTextContent("Service waking up");
  await userEvent.setup().click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByRole("heading", { name: "WG-123" });
  expect(api.report).toHaveBeenCalledTimes(2);
});

test("expires the current organiser session when report details access is rejected", async () => {
  const api = { report: vi.fn().mockRejectedValue(new AccessError("Session expired")) } as unknown as OrganizerApi;
  const onSessionExpired = vi.fn();
  render(<MemoryRouter initialEntries={["/admin/reports/report-123"]}><Routes><Route path="/admin/reports/:reportId" element={<OrganizerReportDetails api={api} onSessionExpired={onSessionExpired} />} /></Routes></MemoryRouter>);
  await waitFor(() => expect(onSessionExpired).toHaveBeenCalledWith(expect.any(AccessError)));
});

test.each(["success", "failure"])("ignores a report request's late %s after its route is replaced", async outcome => {
  let resolve!: (value: ReportDetails) => void;
  let reject!: (reason: Error) => void;
  const api = { report: vi.fn().mockReturnValueOnce(new Promise<ReportDetails>((ok, fail) => { resolve = ok; reject = fail; })).mockResolvedValue({ ...details, report: { ...details.report, id: "report-456", public_reference: "WG-456" } }) } as unknown as OrganizerApi;
  const onSessionExpired = vi.fn();
  render(<MemoryRouter initialEntries={["/admin/reports/report-123"]}><Link to="/admin/reports/report-456">Other report</Link><Routes><Route path="/admin/reports/:reportId" element={<OrganizerReportDetails api={api} onSessionExpired={onSessionExpired} />} /></Routes></MemoryRouter>);
  await userEvent.setup().click(screen.getByRole("link", { name: "Other report" }));
  await screen.findByRole("heading", { name: "WG-456" });
  await act(async () => outcome === "success" ? resolve(details) : reject(new AccessError("Old session expired")));
  expect(screen.queryByRole("heading", { name: "WG-123" })).not.toBeInTheDocument();
  expect(onSessionExpired).not.toHaveBeenCalled();
});

test("requires a report identity before making a details request", async () => {
  const api = { report: vi.fn() } as unknown as OrganizerApi;
  render(<MemoryRouter><OrganizerReportDetails api={api} /></MemoryRouter>);
  expect(await screen.findByRole("alert")).toHaveTextContent("A report reference is required");
  expect(api.report).not.toHaveBeenCalled();
});


test("loads the linked job's current persisted state separately from the report", async () => {
  const api = {
    report: vi.fn().mockResolvedValue({ ...details, report: { ...details.report, state: "linked_to_job", job_id: "job-123", needs_review: false } }),
    job: vi.fn().mockResolvedValue({ job: { id: "job-123", status: "unassigned", location: { latitude: 24.86, longitude: 67.01, landmark: "Collection gate" }, category: "general waste", required_equipment: ["gloves"], estimated_service_minutes: 10, assigned_crew_id: null, held: false, locked: false, route_position: null, travel_minutes: 0, decision_summary: "Approved collection", unassigned_reason: "planning_pending", version: 1, illustrative: false }, photo_ids: [], events: [] }),
  } as unknown as OrganizerApi;
  render(<MemoryRouter initialEntries={["/admin/reports/report-123"]}><Routes><Route path="/admin/reports/:reportId" element={<OrganizerReportDetails api={api} />} /></Routes></MemoryRouter>);
  await screen.findByText("Approved collection");
  expect(screen.getByText((_, node) => node?.textContent === "Linked job ID: job-123")).toBeInTheDocument();
  expect(screen.getByText((_, node) => node?.textContent === "Job status: unassigned")).toBeInTheDocument();
  expect(screen.getByText((_, node) => node?.textContent === "Review required: false")).toBeInTheDocument();
  expect(api.job).toHaveBeenCalledWith("job-123");
});


test("shows the selected report UUID and its duplicate candidate for an accountable decision", async () => {
  setup({ ...details, report: { ...details.report, triage: { ...details.report.triage!, duplicate_candidate_id: "candidate-report-uuid" } } });
  await screen.findByRole("heading", { name: "WG-123" });
  expect(screen.getByText((_, node) => node?.textContent === "Report ID: report-123")).toBeInTheDocument();
  expect(screen.getByText((_, node) => node?.textContent === "Duplicate candidate: candidate-report-uuid")).toBeInTheDocument();
});


test("direct report navigation resets edited drafts and submits only the destination report's decision", async () => {
  const first = { ...details, report: { ...details.report, id: "report-a", public_reference: "WG-A", triage: { ...details.report.triage!, category: "Category A", decision_summary: "Original A", evidence_report_ids: ["report-a"] } } };
  const second = { ...details, report: { ...details.report, id: "report-b", public_reference: "WG-B", version: 15, triage: { ...details.report.triage!, category: "Category B", decision_summary: "Original B", evidence_report_ids: ["report-b"] } } };
  const api = {
    report: vi.fn(async (id: string) => id === "report-a" ? first : second),
    applyDecision: vi.fn().mockResolvedValue({ ...second.report, version: 16 }),
    setPriority: vi.fn(), photo: vi.fn(),
  } as unknown as OrganizerApi;
  render(<MemoryRouter initialEntries={["/admin/reports/report-a"]}><Link to="/admin/reports/report-b">Other report</Link><Routes><Route path="/admin/reports/:reportId" element={<OrganizerReportDetails api={api} />} /></Routes></MemoryRouter>);
  const user = userEvent.setup();
  await screen.findByRole("heading", { name: "WG-A" });
  await user.clear(screen.getByLabelText("Category"));
  await user.type(screen.getByLabelText("Category"), "Unsaved A category");
  await user.clear(screen.getByLabelText("Decision summary"));
  await user.type(screen.getByLabelText("Decision summary"), "Unsaved A rationale");
  await user.click(screen.getByRole("link", { name: "Other report" }));
  await screen.findByRole("heading", { name: "WG-B" });
  expect(screen.getByLabelText("Category")).toHaveValue("Category B");
  expect(screen.getByLabelText("Decision summary")).toHaveValue("Original B");
  expect(screen.getByLabelText("Evidence report IDs")).toHaveValue("report-b");
  await user.click(screen.getByRole("button", { name: "Review decision" }));
  await user.click(screen.getByRole("button", { name: "Apply organiser decision" }));
  expect(api.applyDecision).toHaveBeenCalledTimes(1);
  expect(api.applyDecision).toHaveBeenCalledWith("report-b", expect.objectContaining({ report_id: "report-b", expected_version: 15, category: "Category B", decision_summary: "Original B", evidence_report_ids: ["report-b"] }));
});

test("shows sanitized task progress separately from the report assessment and preserves original caption evidence", async () => {
  setup({ ...details, report: { ...details.report, title: "Original resident words" }, processing: { assessment: { status: "failed", attempts: 1, error_code: "assessment_timeout" }, triage: { status: "pending", attempts: 0, error_code: null }, demo_run_id: "run-a" } });
  await screen.findByRole("heading", { name: "WG-123" });
  expect(screen.getByText("Original resident words")).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Original resident words" })).not.toBeInTheDocument();
  expect(screen.getByText("Assessment: failed · 1 attempt · assessment_timeout")).toBeInTheDocument();
  expect(screen.getByText("Triage: pending · 0 attempts")).toBeInTheDocument();
});

test("reports unqueued processing work without inventing task success", async () => {
  setup({ ...details, processing: { assessment: null, triage: null, demo_run_id: null } });
  await screen.findByRole("heading", { name: "WG-123" });
  expect(screen.getByText("Assessment: Not queued")).toBeInTheDocument();
  expect(screen.getByText("Triage: Not queued")).toBeInTheDocument();
});

test("the 15-second report poll updates evidence without rebasing an unsaved organiser draft", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const { api, user } = setup();
  await screen.findByRole("heading", { name: "WG-123" });
  await user.clear(screen.getByLabelText("Decision summary"));
  await user.type(screen.getByLabelText("Decision summary"), "Unsubmitted organiser draft");
  vi.mocked(api.report).mockResolvedValue({ ...details, report: { ...details.report, version: 8, priority: "high", note: "Evidence added while the organiser was editing" } });
  try {
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(screen.getByText("Evidence added while the organiser was editing")).toBeInTheDocument();
    expect(screen.getByLabelText("Decision summary")).toHaveValue("Unsubmitted organiser draft");
    expect(screen.getByRole("button", { name: "Review decision" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reload latest report" })).toBeInTheDocument();
    expect(api.applyDecision).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});
