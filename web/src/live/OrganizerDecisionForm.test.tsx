import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

import { OrganizerDecisionForm } from "./OrganizerDecisionForm";
import { AccessError, type OrganizerApi, type OrganizerReport } from "./organizerApi";

const report: OrganizerReport = {
  id: "report-1", location: null, public_reference: "WG-123", title: "Overflowing bin", address: null,
  display_status: "Needs review", assessment_status: "needs_review", illustrative: false,
  photo_id: "photo-1", completion_photo_ids: [], note: null, version: 7, state: "needs_review",
  dashboard_status: "submitted", priority: null, priority_reason: null, needs_review: true,
  assessment: null, triage: null, resident_answers: { fire: null, sharp_objects: null },
  clarifications: [], latest_update: null, created_at: "2026-10-18T00:00:00Z",
  updated_at: "2026-10-18T00:00:00Z", job_id: null,
};

function setup(overrides: Partial<OrganizerApi> = {}, initialReport = report) {
  const api = {
    applyDecision: vi.fn().mockResolvedValue({ ...report, version: 8 }),
    setPriority: vi.fn().mockResolvedValue({ ...report, version: 9, priority: "high" }),
    ...overrides,
  } as unknown as OrganizerApi;
  const onReportUpdated = vi.fn();
  const onReload = vi.fn().mockResolvedValue(report);
  const view = render(<OrganizerDecisionForm report={initialReport} api={api} onReportUpdated={onReportUpdated} onReload={onReload} />);
  return { ...view, api, onReportUpdated, onReload, user: userEvent.setup() };
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
  expect(await screen.findByLabelText("Category")).toHaveValue("general waste");
  expect(screen.queryByRole("button", { name: "Apply organiser decision" })).not.toBeInTheDocument();
});

test("does not permit a stale decision to be edited or resent until reload succeeds", async () => {
  vi.stubGlobal("crypto", { randomUUID: vi.fn().mockReturnValue("decision-id") });
  const applyDecision = vi.fn().mockRejectedValue(new Error("This report changed or is not ready for that decision. Reload it and review the latest details."));
  const { onReload, user } = setup({ applyDecision });
  onReload.mockResolvedValue(null);
  await prepareReview(user);
  await user.click(screen.getByRole("button", { name: "Apply organiser decision" }));
  await user.click(screen.getByRole("button", { name: "Reload latest report" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Unable to refresh the latest report");
  expect(screen.queryByRole("button", { name: "Edit decision" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Apply organiser decision" })).not.toBeInTheDocument();
});

test("retries only priority with a fresh version when triage already succeeded", async () => {
  vi.stubGlobal("crypto", { randomUUID: vi.fn().mockReturnValueOnce("decision-id").mockReturnValueOnce("priority-id") });
  const applyDecision = vi.fn().mockResolvedValue({ ...report, version: 8 });
  const setPriority = vi.fn().mockRejectedValueOnce(new Error("This report changed or is not ready for that decision. Reload it and review the latest details.")).mockResolvedValueOnce({ ...report, version: 10, priority: "high" });
  const { api, onReload, user } = setup({ applyDecision, setPriority });
  onReload.mockResolvedValue({ ...report, version: 9 });
  await prepareReview(user, true);
  await user.click(screen.getByRole("button", { name: "Apply organiser decision" }));
  await user.click(screen.getByRole("button", { name: "Reload latest report" }));
  await user.click(await screen.findByRole("button", { name: "Apply priority update" }));
  expect(api.applyDecision).toHaveBeenCalledTimes(1);
  expect(api.setPriority).toHaveBeenNthCalledWith(1, "report-1", expect.objectContaining({ command_id: "priority-id", expected_version: 8 }));
  expect(api.setPriority).toHaveBeenNthCalledWith(2, "report-1", expect.objectContaining({ command_id: "priority-id", expected_version: 9 }));
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


function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const linkedReport: OrganizerReport = { ...report, version: 12, state: "linked_to_job", needs_review: false, job_id: "job-1", priority: "routine" };
const staleMessage = "This report changed or is not ready for that decision. Reload it and review the latest details.";
async function choosePriority(user: ReturnType<typeof userEvent.setup>) {
  await user.selectOptions(screen.getByLabelText("Priority override"), "high");
  await user.type(screen.getByLabelText("Priority reason"), "An accessible entrance is blocked");
  await user.click(screen.getByRole("button", { name: "Review decision" }));
}
async function triageFields(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("Category"), "waste");
  await user.type(screen.getByLabelText("Decision summary"), "Review evidence before proceeding");
}

test("reviews and sends only priority for a report already linked to a job, then resets the saved draft", async () => {
  const saved = { ...linkedReport, version: 13, priority: "high" as const };
  const { api, onReportUpdated, user } = setup({ setPriority: vi.fn().mockResolvedValue(saved) }, linkedReport);
  expect(screen.queryByLabelText("Category")).not.toBeInTheDocument();
  await choosePriority(user);
  expect(api.setPriority).not.toHaveBeenCalled();
  expect(screen.getByRole("heading", { name: "Review priority update" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Apply priority update" }));
  expect(api.applyDecision).not.toHaveBeenCalled();
  expect(api.setPriority).toHaveBeenCalledWith("report-1", expect.objectContaining({ expected_version: 12, priority: "high" }));
  expect(onReportUpdated).toHaveBeenCalledWith(saved);
  expect(screen.getByRole("status")).toHaveTextContent("Priority update recorded. Current priority: high.");
  expect(screen.getByRole("status")).toHaveTextContent("Linked cleanup job: job-1");
  expect(screen.getByLabelText("Priority override")).toHaveValue("");
});

test("requires a priority choice for an already linked report", async () => {
  const { user, api } = setup({}, linkedReport);
  await user.click(screen.getByRole("button", { name: "Review decision" }));
  expect(screen.getByRole("alert")).toHaveTextContent("Choose a priority override");
  expect(api.applyDecision).not.toHaveBeenCalled();
});

test.each([false, true])("freezes the selected LINK evidence without duplicates (already included: %s) and reports the committed hold", async included => {
  const { user, api } = setup();
  await triageFields(user);
  await user.selectOptions(screen.getByLabelText("Next action"), "link_job");
  await user.type(screen.getByLabelText("Duplicate report ID"), "candidate-1");
  await user.click(screen.getByLabelText("Confirm duplicate"));
  await user.click(screen.getByLabelText("Evidence sufficient"));
  await user.click(screen.getByLabelText("Hazard present"));
  await user.type(screen.getByLabelText("Missing information"), "specialist check, specialist check");
  if (included) await user.type(screen.getByLabelText("Evidence report IDs"), ",candidate-1,candidate-1");
  await user.click(screen.getByRole("button", { name: "Review decision" }));
  expect(screen.getByText(/^Evidence:/)).toHaveTextContent("report-1, candidate-1");
  await user.click(screen.getByRole("button", { name: "Apply organiser decision" }));
  expect(api.applyDecision).toHaveBeenCalledWith("report-1", expect.objectContaining({ duplicate_candidate_id: "candidate-1", duplicate_confirmed: true, proposed_equipment: [], evidence_report_ids: ["report-1", "candidate-1"], missing_information: ["specialist check"], next_action: "link_job", hazard: true, evidence_sufficient: true }));
  expect(screen.getByRole("status")).toHaveTextContent("still requires organiser review. No cleanup job is linked");
});

test.each(["review", "request_info"] as const)("saves %s without inventing equipment or service estimates", async nextAction => {
  const updated = { ...report, version: 8, state: nextAction === "review" ? "needs_review" : "needs_info", needs_review: nextAction === "review" };
  const { user, api } = setup({ applyDecision: vi.fn().mockResolvedValue(updated) });
  await triageFields(user);
  await user.selectOptions(screen.getByLabelText("Next action"), nextAction);
  await user.click(screen.getByRole("button", { name: "Review decision" }));
  await user.click(screen.getByRole("button", { name: "Apply organiser decision" }));
  expect(api.applyDecision).toHaveBeenCalledWith("report-1", expect.objectContaining({ proposed_equipment: [], estimated_service_minutes: null, next_action: nextAction }));
  expect(screen.getByRole("status")).toHaveTextContent(nextAction === "review" ? "requires organiser review" : "More information is required");
});

test("requires a LINK candidate and confirmation", async () => {
  const { user, api } = setup();
  await triageFields(user);
  await user.selectOptions(screen.getByLabelText("Next action"), "link_job");
  await user.click(screen.getByRole("button", { name: "Review decision" }));
  expect(screen.getByRole("alert")).toHaveTextContent("A duplicate report ID is required");
  await user.type(screen.getByLabelText("Duplicate report ID"), "candidate-1");
  await user.click(screen.getByRole("button", { name: "Review decision" }));
  expect(screen.getByRole("alert")).toHaveTextContent("Confirm the duplicate");
  expect(api.applyDecision).not.toHaveBeenCalled();
});

test("requires creation equipment and service time", async () => {
  const { user } = setup();
  await triageFields(user);
  await user.selectOptions(screen.getByLabelText("Next action"), "create_job");
  await user.click(screen.getByRole("button", { name: "Review decision" }));
  expect(screen.getByRole("alert")).toHaveTextContent("Select at least one equipment");
  await user.click(screen.getByLabelText("Gloves"));
  await user.click(screen.getByRole("button", { name: "Review decision" }));
  expect(screen.getByRole("alert")).toHaveTextContent("service-time estimate is required");
  await user.type(screen.getByLabelText("Estimated service minutes"), "10");
  await user.click(screen.getByRole("button", { name: "Review decision" }));
  expect(screen.getByText(/^Estimated service minutes:/)).toHaveTextContent("10");
});

test.each(["0", "1441", "1.5", "abc"])("rejects invalid service minutes %s", async minutes => {
  const { user } = setup();
  await triageFields(user);
  await user.type(screen.getByLabelText("Estimated service minutes"), minutes);
  await user.click(screen.getByRole("button", { name: "Review decision" }));
  expect(screen.getByRole("alert")).toHaveTextContent("whole number from 1 to 1440");
});

test("validates category, summary, duplicate confirmation and priority reason", async () => {
  const { user } = setup();
  await user.click(screen.getByRole("button", { name: "Review decision" }));
  expect(screen.getByRole("alert")).toHaveTextContent("A category is required");
  await user.type(screen.getByLabelText("Category"), "waste");
  await user.click(screen.getByRole("button", { name: "Review decision" }));
  expect(screen.getByRole("alert")).toHaveTextContent("A decision summary is required");
  await user.type(screen.getByLabelText("Decision summary"), "Review");
  await user.click(screen.getByLabelText("Confirm duplicate"));
  await user.click(screen.getByRole("button", { name: "Review decision" }));
  expect(screen.getByRole("alert")).toHaveTextContent("A duplicate report ID is required");
  await user.click(screen.getByLabelText("Confirm duplicate"));
  await user.selectOptions(screen.getByLabelText("Priority override"), "routine");
  await user.click(screen.getByRole("button", { name: "Review decision" }));
  expect(screen.getByRole("alert")).toHaveTextContent("A priority reason is required");
});

test("preserves the immutable priority command after a lost acknowledgement", async () => {
  const setPriority = vi.fn().mockRejectedValueOnce(new Error("Unable to reach WasteGrid")).mockResolvedValueOnce({ ...linkedReport, version: 13, priority: "high" });
  const { api, user } = setup({ setPriority }, linkedReport);
  await choosePriority(user);
  await user.click(screen.getByRole("button", { name: "Apply priority update" }));
  await user.click(screen.getByRole("button", { name: "Retry priority update" }));
  expect(api.setPriority).toHaveBeenCalledTimes(2);
  expect(vi.mocked(api.setPriority).mock.calls[1]).toEqual(vi.mocked(api.setPriority).mock.calls[0]);
  expect(api.applyDecision).not.toHaveBeenCalled();
});

test("rebases only priority after a definite linked-report conflict", async () => {
  const setPriority = vi.fn().mockRejectedValueOnce(new Error(staleMessage)).mockResolvedValueOnce({ ...linkedReport, version: 15, priority: "high" });
  const { api, user, onReload } = setup({ setPriority }, linkedReport);
  onReload.mockResolvedValue({ ...linkedReport, version: 14 });
  await choosePriority(user);
  await user.click(screen.getByRole("button", { name: "Apply priority update" }));
  await user.click(screen.getByRole("button", { name: "Reload latest report" }));
  await user.click(screen.getByRole("button", { name: "Apply priority update" }));
  expect(api.applyDecision).not.toHaveBeenCalled();
  expect(vi.mocked(api.setPriority).mock.calls[0][1].expected_version).toBe(12);
  expect(vi.mocked(api.setPriority).mock.calls[1][1].expected_version).toBe(14);
  expect(vi.mocked(api.setPriority).mock.calls[1][1].command_id).toBe(vi.mocked(api.setPriority).mock.calls[0][1].command_id);
});

test.each(["resolve", "reject"] as const)("does not continue after unexpected unmount (%s)", async result => {
  const request = deferred<OrganizerReport>();
  const { user, unmount, api, onReportUpdated } = setup({ applyDecision: vi.fn().mockReturnValue(request.promise) });
  await prepareReview(user, true);
  await user.click(screen.getByRole("button", { name: "Apply organiser decision" }));
  unmount();
  await act(async () => { if (result === "resolve") request.resolve({ ...report, version: 8 }); else request.reject(new Error("request failed")); });
  expect(api.setPriority).not.toHaveBeenCalled();
  expect(onReportUpdated).not.toHaveBeenCalled();
});

test("ignores an old response after switching reports", async () => {
  const request = deferred<OrganizerReport>();
  const { user, rerender, api, onReportUpdated, onReload } = setup({ applyDecision: vi.fn().mockReturnValue(request.promise) });
  await prepareReview(user, true);
  await user.click(screen.getByRole("button", { name: "Apply organiser decision" }));
  rerender(<OrganizerDecisionForm report={{ ...report, id: "report-2" }} api={api} onReportUpdated={onReportUpdated} onReload={onReload} />);
  await act(async () => request.resolve({ ...report, version: 8 }));
  expect(api.setPriority).not.toHaveBeenCalled();
  expect(onReportUpdated).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Category")).toHaveValue("");
});

test("does not start priority after the account changes during a decision", async () => {
  const request = deferred<OrganizerReport>();
  const { user, api, onReportUpdated } = setup({ applyDecision: vi.fn().mockReturnValue(request.promise) });
  let version = 0;
  Object.defineProperty(api, "sessionVersion", { get: () => version });
  await prepareReview(user, true);
  await user.click(screen.getByRole("button", { name: "Apply organiser decision" }));
  version++;
  await act(async () => request.resolve({ ...report, version: 8 }));
  expect(api.setPriority).not.toHaveBeenCalled();
  expect(onReportUpdated).not.toHaveBeenCalled();
});

test("ignores a priority response after account change", async () => {
  const request = deferred<OrganizerReport>();
  const { user, api, onReportUpdated } = setup({ setPriority: vi.fn().mockReturnValue(request.promise) });
  let version = 0;
  Object.defineProperty(api, "sessionVersion", { get: () => version });
  await prepareReview(user, true);
  await user.click(screen.getByRole("button", { name: "Apply organiser decision" }));
  expect(api.setPriority).toHaveBeenCalledTimes(1);
  version++;
  await act(async () => request.resolve({ ...report, version: 9 }));
  expect(onReportUpdated).not.toHaveBeenCalled();
});

test("ignores a stale-report reload after unmount", async () => {
  const reload = deferred<OrganizerReport | null>();
  const { user, onReload, unmount, api } = setup({ applyDecision: vi.fn().mockRejectedValue(new Error(staleMessage)) });
  onReload.mockReturnValue(reload.promise);
  await prepareReview(user);
  await user.click(screen.getByRole("button", { name: "Apply organiser decision" }));
  await user.click(screen.getByRole("button", { name: "Reload latest report" }));
  unmount();
  await act(async () => reload.resolve({ ...report, version: 8 }));
  expect(api.applyDecision).toHaveBeenCalledTimes(1);
});


test("keeps the reviewed priority version even if the same report refreshes before Apply", async () => {
  const { user, api, rerender, onReportUpdated, onReload } = setup({}, linkedReport);
  await choosePriority(user);
  rerender(<OrganizerDecisionForm report={{ ...linkedReport, version: 15 }} api={api} onReportUpdated={onReportUpdated} onReload={onReload} />);
  await user.click(screen.getByRole("button", { name: "Apply priority update" }));
  expect(api.setPriority).toHaveBeenCalledWith("report-1", expect.objectContaining({ expected_version: 12 }));
});

test("closing a decision confirmation restores keyboard focus to the new review trigger", async () => {
  const { user } = setup();
  await triageFields(user);
  await user.click(screen.getByRole("button", { name: "Review decision" }));
  expect(screen.getByRole("dialog", { name: "Review organiser decision" })).toBeInTheDocument();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Review decision" })).toHaveFocus();
});
