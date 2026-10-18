import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

import { OrganizerDecisionForm } from "./OrganizerDecisionForm";
import { AccessError, type OrganizerApi, type OrganizerReport } from "./organizerApi";

const report: OrganizerReport = {
  id: "report-1", public_reference: "WG-123", title: "Overflowing bin", address: null,
  display_status: "Needs review", assessment_status: "needs_review", illustrative: false,
  photo_id: "photo-1", completion_photo_ids: [], note: null, version: 7, state: "needs_review",
  dashboard_status: "submitted", priority: null, priority_reason: null, needs_review: true,
  assessment: null, triage: null, resident_answers: { fire: null, sharp_objects: null },
  clarifications: [], latest_update: null, created_at: "2026-10-18T00:00:00Z",
  updated_at: "2026-10-18T00:00:00Z", job_id: null,
};

function setup(overrides: Partial<OrganizerApi> = {}) {
  const api = {
    applyDecision: vi.fn().mockResolvedValue({ ...report, version: 8 }),
    setPriority: vi.fn().mockResolvedValue({ ...report, version: 9, priority: "high" }),
    ...overrides,
  } as unknown as OrganizerApi;
  const onReportUpdated = vi.fn();
  const onReload = vi.fn();
  render(<OrganizerDecisionForm report={report} api={api} onReportUpdated={onReportUpdated} onReload={onReload} />);
  return { api, onReportUpdated, onReload, user: userEvent.setup() };
}

async function prepareReview(user: ReturnType<typeof userEvent.setup>, priority = false) {
  await user.type(screen.getByLabelText("Category"), "general waste");
  await user.click(screen.getByLabelText("Gloves"));
  await user.type(screen.getByLabelText("Decision summary"), "Collection is needed.");
  if (priority) {
    await user.selectOptions(screen.getByLabelText("Priority override"), "high");
    await user.type(screen.getByLabelText("Priority reason"), "Blocks the entrance");
  }
  await user.click(screen.getByRole("button", { name: "Review decision" }));
}

afterEach(() => vi.unstubAllGlobals());

test("requires review before sending an organiser decision and then uses the returned version for priority", async () => {
  vi.stubGlobal("crypto", { randomUUID: vi.fn().mockReturnValueOnce("decision-id").mockReturnValueOnce("priority-id") });
  const { api, onReportUpdated, user } = setup();
  expect(screen.queryByRole("button", { name: "Apply organiser decision" })).not.toBeInTheDocument();
  await prepareReview(user, true);
  expect(screen.getByText(/Category:/)).toHaveTextContent("general waste");
  expect(screen.getByText(/Decision summary:/)).toHaveTextContent("Collection is needed.");
  expect(screen.getByText(/Duplicate confirmed:/)).toHaveTextContent("false");
  expect(screen.getByText(/Hazard:/)).toHaveTextContent("false");
  expect(screen.getByText(/Evidence sufficient:/)).toHaveTextContent("false");
  expect(screen.getByText(/Priority reason:/)).toHaveTextContent("Blocks the entrance");
  expect(api.applyDecision).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Apply organiser decision" }));
  expect(api.applyDecision).toHaveBeenCalledWith("report-1", expect.objectContaining({ command_id: "decision-id", expected_version: 7, report_id: "report-1", proposed_equipment: ["gloves"] }));
  expect(api.setPriority).toHaveBeenCalledWith("report-1", { command_id: "priority-id", expected_version: 8, priority: "high", reason: "Blocks the entrance" });
  expect(onReportUpdated).toHaveBeenCalledWith(expect.objectContaining({ version: 9 }));
});

test("keeps the same decision command for an organiser-selected retry after a network failure", async () => {
  vi.stubGlobal("crypto", { randomUUID: vi.fn().mockReturnValue("same-decision-id") });
  const applyDecision = vi.fn().mockRejectedValueOnce(new Error("Unable to reach WasteGrid")).mockResolvedValueOnce({ ...report, version: 8 });
  const { api, onReportUpdated, user } = setup({ applyDecision });
  await prepareReview(user);
  await user.click(screen.getByRole("button", { name: "Apply organiser decision" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Unable to reach WasteGrid");
  await user.click(screen.getByRole("button", { name: "Retry organiser decision" }));
  expect(api.applyDecision).toHaveBeenNthCalledWith(1, "report-1", expect.objectContaining({ command_id: "same-decision-id" }));
  expect(api.applyDecision).toHaveBeenNthCalledWith(2, "report-1", expect.objectContaining({ command_id: "same-decision-id" }));
  expect(onReportUpdated).toHaveBeenCalledWith(expect.objectContaining({ version: 8 }));
});

test("does not send a priority request when the organiser leaves priority unchanged", async () => {
  vi.stubGlobal("crypto", { randomUUID: vi.fn().mockReturnValue("decision-id") });
  const { api, user } = setup();
  await prepareReview(user);
  await user.click(screen.getByRole("button", { name: "Apply organiser decision" }));
  expect(api.setPriority).not.toHaveBeenCalled();
});

test("keeps the draft but requires a fresh review after a stale decision response", async () => {
  vi.stubGlobal("crypto", { randomUUID: vi.fn().mockReturnValue("decision-id") });
  const applyDecision = vi.fn().mockRejectedValue(new Error("This report changed or is not ready for that decision. Reload it and review the latest details."));
  const { onReload, user } = setup({ applyDecision });
  await prepareReview(user);
  await user.click(screen.getByRole("button", { name: "Apply organiser decision" }));
  await user.click(screen.getByRole("button", { name: "Reload latest report" }));
  expect(onReload).toHaveBeenCalled();
  expect(screen.getByLabelText("Category")).toHaveValue("general waste");
  expect(screen.queryByRole("button", { name: "Apply organiser decision" })).not.toBeInTheDocument();
});

test("expires the organiser view instead of displaying a rejected mutation error", async () => {
  vi.stubGlobal("crypto", { randomUUID: vi.fn().mockReturnValue("decision-id") });
  const onSessionExpired = vi.fn();
  const applyDecision = vi.fn().mockRejectedValue(new AccessError("Your session expired or access was denied. Please sign in again."));
  const api = { applyDecision, setPriority: vi.fn() } as unknown as OrganizerApi;
  render(<OrganizerDecisionForm report={report} api={api} onReportUpdated={vi.fn()} onReload={vi.fn()} onSessionExpired={onSessionExpired} />);
  const user = userEvent.setup();
  await prepareReview(user);
  await user.click(screen.getByRole("button", { name: "Apply organiser decision" }));
  expect(onSessionExpired).toHaveBeenCalledWith(expect.any(AccessError));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
