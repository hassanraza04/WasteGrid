import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

import { OrganizerDecisionForm } from "./OrganizerDecisionForm";
import type { OrganizerApi, OrganizerReport } from "./organizerApi";

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
