import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, afterEach, expect, test, vi } from "vitest";
import { OrganizerDispatchWorkspace } from "./OrganizerDispatchWorkspace";
import { AccessError, RoutingConflictError, type OrganizerApi, type OrganizerCurrentPlan } from "./organizerApi";
import * as journal from "./dispatchJournal";
import { ACTOR, COMMAND, ENVIRONMENT, committedPreview, crew, job, routePreview } from "../test/routingFixtures";
vi.mock("./OrganizerRouteMap", () => ({ OrganizerRouteMap: () => <div>Road map fixture</div> }));
beforeEach(() => { vi.stubGlobal("indexedDB", new IDBFactory()); vi.spyOn(crypto, "randomUUID").mockReturnValue(COMMAND); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function setup(result = routePreview(), crews = [crew], jobs = [job], plan: OrganizerCurrentPlan = { plan: null }) {
  let committed = false;
  const api = {
    sessionVersion: 1, verifiedUserId: ACTOR, environment: ENVIRONMENT,
    crews: vi.fn().mockResolvedValue(crews), indexedJobs: vi.fn().mockResolvedValue(jobs), currentPlan: vi.fn().mockResolvedValue(plan),
    previewRouting: vi.fn().mockResolvedValue(result),
    dispatchRouting: vi.fn().mockImplementation(async () => { committed = true; return { preview_id: result.id, plan_id: "plan-1" }; }),
    preview: vi.fn().mockImplementation(async () => committed ? committedPreview(result) : result),
  } as unknown as OrganizerApi;
  const onSessionExpired = vi.fn();
  const view = render(<OrganizerDispatchWorkspace api={api} onSessionExpired={onSessionExpired} />);
  return { api, user: userEvent.setup(), onSessionExpired, ...view };
}
async function selectScope(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "Select Crew One (crew-1)" }));
  await user.click(screen.getByRole("button", { name: "Select job General waste (job-1)" }));
}
async function review(user: ReturnType<typeof userEvent.setup>) {
  await selectScope(user);
  await user.click(screen.getByRole("button", { name: "Compute route preview" }));
  await screen.findByRole("button", { name: "Review dispatch" });
}
async function confirm(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Review dispatch" }));
  await user.click(screen.getByRole("button", { name: "Confirm and dispatch" }));
}
async function startNewReview(user: ReturnType<typeof userEvent.setup>, label = "Start a new review") {
  const button = screen.getByRole("button", { name: label });
  await waitFor(() => expect(button).toBeEnabled());
  await user.click(button);
  await waitFor(() => expect(screen.queryByRole("region", { name: "Route preview" })).not.toBeInTheDocument());
  await waitFor(() => expect(screen.getByRole("button", { name: "Compute route preview" })).toBeEnabled());
}
async function saved(stage: journal.DispatchJournal["stage"] = "attempted", extra: Partial<journal.DispatchJournal> = {}) {
  const entry = { ...journal.emptyJournal(), crewIds: ["crew-1"], jobIds: ["job-1"], previewId: "preview-1", commandId: COMMAND, stage, ...extra };
  await journal.writeJournal(ENVIRONMENT, ACTOR, entry); return entry;
}
test("defaults match mobile, computes exact scope, confirms separately and prints committed cards", async () => {
  const { api, user } = setup();
  await review(user);
  expect(screen.getByLabelText("Time limit (minutes)")).toHaveValue(120);
  expect(screen.getByLabelText("Maximum stops")).toHaveValue(10);
  expect(screen.getByLabelText("Return to start")).toBeChecked();
  expect(screen.getByLabelText("Allow partial dispatch preview")).not.toBeChecked();
  expect(api.previewRouting).toHaveBeenCalledWith(["crew-1"], ["job-1"], journal.DEFAULT_CONSTRAINTS);
  expect(api.dispatchRouting).not.toHaveBeenCalled();
  await confirm(user);
  await screen.findByRole("heading", { name: "Dispatch confirmed" });
  expect(api.dispatchRouting).toHaveBeenCalledWith("preview-1", COMMAND, false);
  expect((await journal.readJournal(ENVIRONMENT, ACTOR))?.stage).toBe("committed");
  const print = vi.spyOn(window, "print").mockImplementation(() => undefined);
  await user.click(screen.getByRole("button", { name: "Print committed route cards" })); expect(print).toHaveBeenCalled();
  await startNewReview(user);
  expect(screen.queryByRole("region", { name: "Route preview" })).not.toBeInTheDocument();
});
test.each(["scope", "malformed", "foreign job", "foreign crew", "constraints"])("rejects invalid %s before dispatch", async kind => {
  const result = routePreview();
  if (kind === "scope") result.job_ids = ["other-job"];
  if (kind === "malformed") result.metrics = undefined as never;
  if (kind === "foreign job") result.exclusions = [{ job_id: "other-job", reason: "held" }];
  if (kind === "foreign crew") result.routes[0].crew_id = "crew-2";
  if (kind === "constraints") result.settings = { constraints: { ...journal.DEFAULT_CONSTRAINTS, return_to_start: false } };
  const { api, user } = setup(result); await selectScope(user);
  await user.click(screen.getByRole("button", { name: "Compute route preview" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("did not confirm");
  expect(api.dispatchRouting).not.toHaveBeenCalled();
});
test("persists the attempted barrier before POST and blocks submission on storage failure", async () => {
  const { api, user } = setup(); await review(user);
  const original = journal.writeJournal;
  let release!: () => void;
  const write = vi.spyOn(journal, "writeJournal").mockImplementationOnce(async (...args) => { await new Promise<void>(resolve => { release = resolve; }); await original(...args); });
  await confirm(user); await waitFor(() => expect(write).toHaveBeenCalled());
  expect(api.dispatchRouting).not.toHaveBeenCalled();
  await act(async () => release());
  await screen.findByRole("heading", { name: "Dispatch confirmed" });
  await startNewReview(user);
  await user.click(screen.getByRole("button", { name: "Compute route preview" }));
  await screen.findByRole("button", { name: "Review dispatch" });
  write.mockRejectedValueOnce(new journal.JournalUnavailable());
  await confirm(user);
  expect(await screen.findByRole("alert")).toHaveTextContent("storage is unavailable");
  expect(api.dispatchRouting).toHaveBeenCalledTimes(1);
});
test("requires explicit partial omission consent and then final confirmation", async () => {
  const result = routePreview(["job-1", "job-2"]); result.unassigned = [{ job_id: "job-2", reason: "capacity" }];
  result.settings.constraints = { ...journal.DEFAULT_CONSTRAINTS, allow_partial: true };
  const { api, user } = setup(result, [crew], [job, { ...job, id: "job-2" }]);
  vi.mocked(api.preview).mockResolvedValue(committedPreview(result, true));
  await selectScope(user); await user.click(screen.getByRole("button", { name: "Select job General waste (job-2)" }));
  await user.click(screen.getByLabelText("Allow partial dispatch preview"));
  await user.click(screen.getByRole("button", { name: "Compute route preview" }));
  expect(await screen.findByRole("button", { name: "Review dispatch" })).toBeDisabled();
  await user.click(screen.getByLabelText("I reviewed and accept these partial omissions"));
  expect(api.dispatchRouting).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Review dispatch" }));
  expect(screen.getByRole("dialog")).toHaveTextContent("explicitly accepted 1 omitted");
  await user.click(screen.getByRole("button", { name: "Confirm and dispatch" }));
  await screen.findByRole("heading", { name: "Dispatch confirmed" });
  expect(api.dispatchRouting).toHaveBeenCalledWith("preview-1", COMMAND, true);
});
test("names required illustrative assigned jobs and explicitly includes them without widening beyond 25", async () => {
  const required = { ...job, id: "required-job", category: "Required litter", illustrative: true, assigned_crew_id: crew.id };
  const { user, api } = setup(routePreview(), [crew], [job, required]);
  await selectScope(user);
  expect(screen.getByText(/Required assigned jobs:/)).toHaveTextContent("Required litter");
  expect(screen.getByRole("button", { name: "Compute route preview" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Include required jobs" }));
  await user.click(screen.getByRole("button", { name: "Compute route preview" }));
  await waitFor(() => expect(api.previewRouting).toHaveBeenCalledWith(["crew-1"], ["job-1", "required-job"], journal.DEFAULT_CONSTRAINTS));
});
test("required scope over 25 stays blocked", async () => {
  const assigned = Array.from({ length: 26 }, (_, i) => ({ ...job, id: `assigned-${i}`, assigned_crew_id: crew.id }));
  const { user } = setup(routePreview(), [crew], assigned);
  await user.click(await screen.findByRole("button", { name: "Select Crew One (crew-1)" }));
  expect(screen.getByRole("button", { name: "Include required jobs" })).toBeDisabled();
  expect(screen.getByText(/exceeds 25 jobs/)).toBeInTheDocument();
});
test("selection and controls invalidate an unsubmitted preview", async () => {
  const { user } = setup(); await review(user);
  await user.click(screen.getByLabelText("Maximum stops"));
  await user.keyboard("{Control>}a{/Control}5");
  expect(screen.queryByRole("region", { name: "Route preview" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Review dispatch" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Remove job General waste (job-1)" }));
  expect(screen.getByRole("button", { name: "Compute route preview" })).toBeDisabled();
});
test("restores uncertain command after remount and recovers a committed receipt without resubmission", async () => {
  await saved(); const { api } = setup();
  vi.mocked(api.preview).mockResolvedValue(committedPreview());
  await screen.findByRole("heading", { name: "Dispatch confirmed" });
  expect(api.dispatchRouting).not.toHaveBeenCalled(); expect(api.preview).toHaveBeenCalledWith("preview-1");
});
test("unknown outcome stays frozen; recovery GETs first and retries exactly the original identity", async () => {
  const { api, user } = setup(); vi.mocked(api.dispatchRouting).mockRejectedValueOnce(new Error("Lost acknowledgement"));
  await review(user); await confirm(user); await screen.findByText("Lost acknowledgement");
  expect(screen.getByRole("button", { name: "Remove job General waste (job-1)" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Recover dispatch" }));
  await screen.findByRole("heading", { name: "Dispatch confirmed" });
  expect(vi.mocked(api.dispatchRouting).mock.calls).toEqual([["preview-1", COMMAND, false], ["preview-1", COMMAND, false]]);
  expect(vi.mocked(api.preview).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(api.dispatchRouting).mock.invocationCallOrder[1]);
});
test("mismatched receipt blocks recovery without generating another command", async () => {
  await saved(); const { api } = setup();
  vi.mocked(api.preview).mockResolvedValue({ ...committedPreview(), dispatch_receipt: { ...committedPreview().dispatch_receipt!, actor_id: "other" } });
  expect(await screen.findByRole("alert")).toHaveTextContent("different dispatch receipt");
  expect(api.dispatchRouting).not.toHaveBeenCalled();
});
test("definite dispatch conflict refreshes and requires a new preview", async () => {
  const { api, user } = setup(); vi.mocked(api.dispatchRouting).mockRejectedValueOnce(new RoutingConflictError("State changed"));
  await review(user); await confirm(user);
  await screen.findByText(/Review the refreshed crews and jobs/);
  expect(screen.queryByRole("region", { name: "Route preview" })).not.toBeInTheDocument();
  await waitFor(() => expect(api.currentPlan).toHaveBeenCalledTimes(2));
  expect((await journal.readJournal(ENVIRONMENT, ACTOR))?.stage).toBe("conflict");
});
test("rechecks preview expiry at confirmation time", async () => {
  const result = routePreview(); const { api, user } = setup(result); await review(user);
  await user.click(screen.getByRole("button", { name: "Review dispatch" }));
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(result.expires_at) + 1);
  await user.click(screen.getByRole("button", { name: "Confirm and dispatch" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("fresh dispatchable preview"); expect(api.dispatchRouting).not.toHaveBeenCalled();
});
test.each(["success", "failure"])("ignores a late preview %s after unmount or account change", async outcome => {
  const { api, user, unmount, onSessionExpired } = setup();
  let resolve!: (value: ReturnType<typeof routePreview>) => void, reject!: (error: Error) => void;
  vi.mocked(api.previewRouting).mockReturnValueOnce(new Promise((yes, no) => { resolve = yes; reject = no; }));
  await selectScope(user); await user.click(screen.getByRole("button", { name: "Compute route preview" })); unmount();
  Object.assign(api, { sessionVersion: 2 });
  await act(async () => { if (outcome === "success") resolve(routePreview()); else reject(new AccessError("Old session")); });
  expect(onSessionExpired).not.toHaveBeenCalled(); expect(api.dispatchRouting).not.toHaveBeenCalled();
});
test("missing durable storage fails closed before preview or dispatch", async () => {
  vi.stubGlobal("indexedDB", undefined); const { api } = setup();
  expect(await screen.findByRole("alert")).toHaveTextContent("storage is unavailable");
  expect(screen.getByRole("button", { name: "Compute route preview" })).toBeDisabled(); expect(api.previewRouting).not.toHaveBeenCalled();
});

test("account switching clears visible scope before loading the new partition", async () => {
  const { api, user, rerender, onSessionExpired } = setup(); await review(user);
  let release!: (entry: journal.DispatchJournal | null) => void;
  vi.spyOn(journal, "readJournal").mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
  Object.assign(api, { verifiedUserId: "other-organizer", sessionVersion: 2 });
  rerender(<OrganizerDispatchWorkspace api={api} onSessionExpired={onSessionExpired} />);
  expect(screen.queryByRole("button", { name: "Review dispatch" })).not.toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "Route preview" })).not.toBeInTheDocument();
  await act(async () => release(null));
  expect(await screen.findByRole("button", { name: "Select Crew One (crew-1)" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Compute route preview" })).toBeDisabled();
  expect((await journal.readJournal(ENVIRONMENT, ACTOR))?.stage).toBe("reviewed");
});
test("losing committed-outcome storage recovers the existing receipt without another POST", async () => {
  const { api, user } = setup(); await review(user); const original = journal.writeJournal;
  let failCommit = true;
  vi.spyOn(journal, "writeJournal").mockImplementation(async (...args) => {
    if (args[2].stage === "committed" && failCommit) { failCommit = false; throw new journal.JournalUnavailable(); }
    return original(...args);
  });
  await confirm(user); await screen.findByRole("heading", { name: "Unconfirmed dispatch" });
  expect((await journal.readJournal(ENVIRONMENT, ACTOR))?.stage).toBe("attempted");
  await user.click(screen.getByRole("button", { name: "Recover dispatch" }));
  await screen.findByRole("heading", { name: "Dispatch confirmed" }); expect(api.dispatchRouting).toHaveBeenCalledTimes(1);
});
test("startup network failure retains GET-first recovery of the stored command", async () => {
  await saved(); const { api, user } = setup(); vi.mocked(api.preview).mockRejectedValueOnce(new Error("Render cold start"));
  expect(await screen.findByRole("alert")).toHaveTextContent("Render cold start");
  await user.click(screen.getByRole("button", { name: "Recover dispatch" }));
  await screen.findByRole("heading", { name: "Dispatch confirmed" });
  expect(api.previewRouting).not.toHaveBeenCalled(); expect(api.dispatchRouting).toHaveBeenCalledWith("preview-1", COMMAND, false);
});
test("an uncertain receipt still freezes scope when a second GET returns a mismatched command", async () => {
  await saved(); const { api, user } = setup();
  await screen.findByRole("heading", { name: "Unconfirmed dispatch" });
  vi.mocked(api.preview).mockResolvedValue({ ...committedPreview(), dispatch_receipt: { ...committedPreview().dispatch_receipt!, command_id: "other" } });
  await user.click(screen.getByRole("button", { name: "Recover dispatch" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("different command or consent"); expect(api.dispatchRouting).not.toHaveBeenCalled();
});
test("failed initial routing state retries and surfaces access expiry", async () => {
  const { api, user, onSessionExpired } = setup(); vi.mocked(api.indexedJobs).mockRejectedValueOnce(new Error("Read unavailable"));
  expect(await screen.findByRole("alert")).toHaveTextContent("Read unavailable");
  await user.click(screen.getByRole("button", { name: "Refresh routing state" }));
  await screen.findByRole("button", { name: "Select Crew One (crew-1)" });
  vi.mocked(api.indexedJobs).mockRejectedValueOnce(new AccessError("Expired"));
  await user.click(screen.getByRole("button", { name: "Refresh routing state" })); await waitFor(() => expect(onSessionExpired).toHaveBeenCalled());
});
test("preview conflict refreshes state before recomputation and stale refreshes cannot win", async () => {
  const { api, user } = setup(); vi.mocked(api.previewRouting).mockRejectedValueOnce(new RoutingConflictError("Refresh required"));
  await selectScope(user); await user.click(screen.getByRole("button", { name: "Compute route preview" }));
  await waitFor(() => expect(api.currentPlan).toHaveBeenCalledTimes(2));
  let release!: (jobs: typeof job[]) => void;
  vi.mocked(api.indexedJobs).mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
  await user.click(screen.getByRole("button", { name: "Refresh routing state" }));
  vi.mocked(api.indexedJobs).mockResolvedValueOnce([]);
  await user.click(screen.getByRole("button", { name: "Refresh routing state" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Remove job General waste (job-1)" })).not.toBeInTheDocument());
  await act(async () => release([job]));
  expect(screen.queryByRole("button", { name: "Remove job General waste (job-1)" })).not.toBeInTheDocument();
  expect(screen.getByText("Some selected jobs are no longer active. Review your selection.")).toBeInTheDocument();
});
test("refreshing a vanished crew blocks a fresh preview", async () => {
  const { api, user } = setup(); await selectScope(user); vi.mocked(api.crews).mockResolvedValueOnce([]);
  await user.click(screen.getByRole("button", { name: "Refresh routing state" }));
  expect(await screen.findByText("Selected crews are no longer available. Review your selection.")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Compute route preview" })).toBeDisabled();
});
test("controls preserve entered limits and require the assigned crew for a selected job", async () => {
  const other = { ...crew, id: "crew-2", name: "Crew Two" };
  const { user, api } = setup(routePreview(), [crew, other], [{ ...job, assigned_crew_id: "crew-2" }]);
  await selectScope(user); expect(screen.getByText("Select the crew assigned to every reviewed job.")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Select Crew Two (crew-2)" }));
  await user.clear(screen.getByLabelText("Time limit (minutes)")); await user.type(screen.getByLabelText("Time limit (minutes)"), "90");
  await user.click(screen.getByLabelText("Return to start"));
  await user.click(screen.getByRole("button", { name: "Compute route preview" }));
  await waitFor(() => expect(api.previewRouting).toHaveBeenCalledWith(["crew-1", "crew-2"], ["job-1"], expect.objectContaining({ max_duration_minutes: 90, return_to_start: false })));
});
test("crew and job limits disable only additional selections and distinguish GPS from availability", async () => {
  const crews = Array.from({ length: 6 }, (_, i) => ({ ...crew, id: `crew-${i + 1}`, name: `Crew ${i + 1}` }));
  const jobs = Array.from({ length: 26 }, (_, i) => ({ ...job, id: `job-${i + 1}`, public_references: [] }));
  await journal.writeJournal(ENVIRONMENT, ACTOR, { ...journal.emptyJournal(), crewIds: crews.slice(0, 5).map(c => c.id), jobIds: jobs.slice(0, 25).map(j => j.id) });
  setup(routePreview(), crews, jobs);
  expect(await screen.findByRole("button", { name: "Select Crew 6 (crew-6)" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Select job General waste (job-26)" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Remove Crew 1 (crew-1)" })).toBeEnabled();
});
test("labels fixed work, route changes, existing plan, illustration and missing GPS truthfully", async () => {
  const result = routePreview(); result.routes[0].stops[0].fixed = true; result.routes[0].returns_to_start = false;
  result.reassignments = [{ job_id: job.id, previous_crew_id: "older-crew", previous_position: null, proposed_crew_id: crew.id, proposed_position: 0 }];
  const plan = { plan: { id: "old-plan", stale: true, travel_estimates_label: "Old estimate", assignments: [{ crew_id: "older-crew", job_id: "old-job", position: 0, travel_minutes: 3, service_minutes: 5 }], unassigned: [] } };
  const { user } = setup(result, [crew, { ...crew, id: "unavailable", name: "Offline Crew", available: false, illustrative: true, location_recorded_at: null }], [job, { ...job, id: "held", held: true, eligible: false, priority: null, eligibility_reasons: ["held"], address: null, location: { latitude: 0, longitude: 0, landmark: null }, public_references: [], illustrative: true }], plan);
  await screen.findByText(/old-plan · changed/); await user.click(screen.getByLabelText("Include illustrative data"));
  expect(screen.getByRole("button", { name: "Select Offline Crew (unavailable)" })).toBeDisabled();
  expect(screen.getByText(/Illustrative crew · GPS not shared/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Select job General waste (held)" })).toBeDisabled();
  expect(screen.getByText("Priority review")).toBeInTheDocument();
  await review(user); expect(screen.getByText("Fixed work")).toBeInTheDocument(); expect(screen.getByText(/Finish at last stop/)).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Changes from current plan" })).toBeInTheDocument();
  await startNewReview(user, "Discard preview and review selection");
});

test("foreground refresh runs only while the console is visible and idle", async () => {
  const { api, user } = setup(); await selectScope(user);
  document.dispatchEvent(new Event("visibilitychange")); await waitFor(() => expect(api.currentPlan).toHaveBeenCalledTimes(2));
  let release!: (value: ReturnType<typeof routePreview>) => void;
  vi.mocked(api.previewRouting).mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
  await user.click(screen.getByRole("button", { name: "Compute route preview" }));
  document.dispatchEvent(new Event("visibilitychange")); expect(api.currentPlan).toHaveBeenCalledTimes(2);
  await act(async () => release(routePreview()));
});
test("storage failure while changing scope blocks all submission", async () => {
  const { api, user } = setup(); await screen.findByRole("button", { name: "Select Crew One (crew-1)" });
  vi.spyOn(journal, "writeJournal").mockRejectedValueOnce(new journal.JournalUnavailable());
  await user.click(screen.getByRole("button", { name: "Select Crew One (crew-1)" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("storage is unavailable");
  expect(screen.getByRole("button", { name: "Compute route preview" })).toBeDisabled(); expect(api.previewRouting).not.toHaveBeenCalled();
});
test("a malformed restored scope cannot be used for recovery", async () => {
  await saved(); const { api, user } = setup(); vi.mocked(api.preview).mockResolvedValue(routePreview(["other-job"]));
  expect(await screen.findByRole("alert")).toHaveTextContent("Saved preview does not match");
  await user.click(screen.getByRole("button", { name: "Recover dispatch" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Original preview scope changed"); expect(api.dispatchRouting).not.toHaveBeenCalled();
});
test("a successful POST with an unverifiable receipt stays recoverable", async () => {
  const { api, user } = setup(); vi.mocked(api.preview).mockResolvedValue(routePreview());
  await review(user); await confirm(user);
  expect(await screen.findByRole("alert")).toHaveTextContent("receipt could not be verified");
  expect(screen.getByRole("button", { name: "Recover dispatch" })).toBeEnabled();
});
test.each(["success", "failure"])("initial loading ignores late %s after unmount", async outcome => {
  const { api, unmount, onSessionExpired } = setup();
  let finish!: (jobs: typeof job[]) => void, fail!: (error: Error) => void;
  vi.mocked(api.indexedJobs).mockReturnValueOnce(new Promise((resolve, reject) => { finish = resolve; fail = reject; }));
  await waitFor(() => expect(api.indexedJobs).toHaveBeenCalled()); unmount();
  await act(async () => { if (outcome === "success") finish([job]); else fail(new AccessError("Old load")); });
  expect(onSessionExpired).not.toHaveBeenCalled();
});
test.each(["success", "failure"])("dispatch ignores late %s after navigation", async outcome => {
  const { api, user, unmount, onSessionExpired } = setup();
  let finish!: (value: { preview_id: string; plan_id: string }) => void, fail!: (error: Error) => void;
  vi.mocked(api.dispatchRouting).mockReturnValueOnce(new Promise((resolve, reject) => { finish = resolve; fail = reject; }));
  await review(user); await confirm(user); await waitFor(() => expect(api.dispatchRouting).toHaveBeenCalled()); unmount();
  await act(async () => { if (outcome === "success") finish({ preview_id: "preview-1", plan_id: "plan-1" }); else fail(new AccessError("Old dispatch")); });
  expect(onSessionExpired).not.toHaveBeenCalled(); expect(api.preview).not.toHaveBeenCalled();
  expect((await journal.readJournal(ENVIRONMENT, ACTOR))?.stage).toBe("attempted");
});
test("an interrupted attempt-barrier commit never submits after navigation", async () => {
  const { api, user, unmount } = setup(); await review(user); const original = journal.writeJournal;
  let release!: () => void;
  vi.spyOn(journal, "writeJournal").mockImplementationOnce(async (...args) => { await new Promise<void>(resolve => { release = resolve; }); await original(...args); });
  await confirm(user); unmount(); await act(async () => release()); expect(api.dispatchRouting).not.toHaveBeenCalled();
  expect((await journal.readJournal(ENVIRONMENT, ACTOR))?.stage).toBe("attempted");
});
test("reviewed previews restore without creating a replacement command", async () => {
  await saved("reviewed"); const { api, user } = setup();
  await screen.findByRole("button", { name: "Review dispatch" });
  expect(api.previewRouting).not.toHaveBeenCalled(); await user.click(screen.getByRole("button", { name: "Review dispatch" }));
  await user.click(screen.getByRole("button", { name: "Cancel" })); expect(api.dispatchRouting).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Remove Crew One (crew-1)" }));
  expect(screen.queryByRole("region", { name: "Route preview" })).not.toBeInTheDocument();
});
test("multiple crew cards preserve empty routes and show reassignment from unassigned", async () => {
  const result = routePreview(); result.routes.push({ crew_id: "crew-2", stops: [], duration_minutes: 0, travel_minutes: 0 });
  result.routes[0].return_travel_minutes = undefined;
  result.reassignments = [{ job_id: job.id, previous_crew_id: null, previous_position: null, proposed_crew_id: crew.id, proposed_position: 0 }];
  const { user } = setup(result, [crew, { ...crew, id: "crew-2", name: "Crew Two" }]);
  await selectScope(user); await user.click(screen.getByRole("button", { name: "Select Crew Two (crew-2)" }));
  await user.click(screen.getByRole("button", { name: "Compute route preview" }));
  expect(await screen.findByText("No stops assigned.")).toBeInTheDocument();
  expect(screen.getByText(/: unassigned → Crew One stop 1/)).toBeInTheDocument();
});


test("provider-unavailable preview preserves explicit omissions without claiming a scope error", async () => {
  const result = routePreview(); result.routes = []; result.dispatchable = false;
  result.unassigned = [{ job_id: "job-1", reason: "travel_data_unavailable" }];
  const { api, user } = setup(result); await review(user);
  expect(screen.getByRole("heading", { name: "Omitted jobs" })).toBeInTheDocument();
  expect(screen.getByText(/travel data unavailable/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Review dispatch" })).toBeDisabled();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument(); expect(api.dispatchRouting).not.toHaveBeenCalled();
});


test("a pending new-review storage write cannot restore the previous account's scope", async () => {
  const { api, user, rerender, onSessionExpired } = setup();
  await review(user); await confirm(user);
  await screen.findByRole("heading", { name: "Dispatch confirmed" });
  await waitFor(() => expect(screen.getByRole("button", { name: "Start a new review" })).toBeEnabled());
  const original = journal.writeJournal; let release!: () => void;
  const write = vi.spyOn(journal, "writeJournal").mockImplementationOnce(async (...args) => {
    await new Promise<void>(resolve => { release = resolve; });
    await original(...args);
  });
  await user.click(screen.getByRole("button", { name: "Start a new review" }));
  await waitFor(() => expect(write).toHaveBeenCalled());
  Object.assign(api, { verifiedUserId: "next-organizer", sessionVersion: 2 });
  rerender(<OrganizerDispatchWorkspace api={api} onSessionExpired={onSessionExpired} />);
  await screen.findByRole("button", { name: "Select Crew One (crew-1)" });
  const readsForNewAccount = vi.mocked(api.currentPlan).mock.calls.length;
  await act(async () => release());
  expect(screen.queryByRole("region", { name: "Route preview" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Compute route preview" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Select Crew One (crew-1)" })).toBeEnabled();
  expect(api.currentPlan).toHaveBeenCalledTimes(readsForNewAccount);
  expect(await journal.readJournal(ENVIRONMENT, "next-organizer")).toBeNull();
  expect(api.dispatchRouting).toHaveBeenCalledTimes(1);
});


test.each([
  ["missing recorded timestamp", { location_recorded_at: null }, "GPS not shared"],
  ["missing received timestamp", { location_received_at: null }, "GPS not shared"],
  ["stale GPS", { location_recorded_at: new Date(Date.now() - 121_000).toISOString() }, "GPS stale"],
  ["stale receipt", { location_received_at: new Date(Date.now() - 121_000).toISOString() }, "GPS stale"],
  ["invalid timestamp", { location_recorded_at: "invalid" }, "GPS stale or invalid"],
  ["future timestamp", { location_recorded_at: new Date(Date.now() + 60_000).toISOString() }, "GPS stale or invalid"],
] as const)("labels and prevents preview for %s", async (_label, changes, message) => {
  const { api, user } = setup(routePreview(), [{ ...crew, ...changes }]);
  const button = await screen.findByRole("button", { name: "Select Crew One (crew-1)" });
  expect(button).toBeDisabled(); expect(screen.getByText(new RegExp(message))).toBeInTheDocument();
  await user.click(button); await user.click(screen.getByRole("button", { name: "Compute route preview" }));
  expect(api.previewRouting).not.toHaveBeenCalled();
});
test("a restored crew selection with stale GPS blocks preview and explains recovery", async () => {
  await journal.writeJournal(ENVIRONMENT, ACTOR, { ...journal.emptyJournal(), crewIds: [crew.id], jobIds: [job.id] });
  const { api } = setup(routePreview(), [{ ...crew, location_received_at: null }]);
  await screen.findByRole("button", { name: "Remove Crew One (crew-1)" });
  expect(screen.getByRole("button", { name: "Compute route preview" })).toBeDisabled();
  expect(screen.getByText(/Crew One: GPS not shared/)).toHaveTextContent("crew’s mobile screen");
  expect(api.previewRouting).not.toHaveBeenCalled();
});
test("uses the server freshness limit and blocks an already selected crew as GPS ages", async () => {
  const { api, user } = setup(routePreview(), [{ ...crew, location_max_age_seconds: 10 }]);
  await selectScope(user); expect(screen.getByRole("button", { name: "Compute route preview" })).toBeEnabled();
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 11_000);
  await waitFor(() => expect(screen.getByRole("button", { name: "Compute route preview" })).toBeDisabled(), { timeout: 2000 });
  expect(screen.getByText(/Crew One: GPS stale/)).toBeInTheDocument();
  expect(api.previewRouting).not.toHaveBeenCalled();
  vi.useRealTimers();
});
test("shows the backend reason when preview races a GPS update or job eligibility change", async () => {
  const { api, user } = setup(); vi.mocked(api.previewRouting).mockRejectedValueOnce(new RoutingConflictError("Selected job is not eligible"));
  await selectScope(user); await user.click(screen.getByRole("button", { name: "Compute route preview" }));
  expect(await screen.findByText("Selected job is not eligible")).toBeInTheDocument();
  await waitFor(() => expect(api.currentPlan).toHaveBeenCalledTimes(2));
});

test("refreshing after the crew shares GPS enables preview for its saved selection", async () => {
  await journal.writeJournal(ENVIRONMENT, ACTOR, { ...journal.emptyJournal(), crewIds: [crew.id], jobIds: [job.id] });
  const { api, user } = setup(routePreview(), [{ ...crew, location_recorded_at: null }]);
  await screen.findByRole("button", { name: "Remove Crew One (crew-1)" });
  expect(screen.getByRole("button", { name: "Compute route preview" })).toBeDisabled();
  vi.mocked(api.crews).mockResolvedValueOnce([{ ...crew, location_recorded_at: new Date().toISOString(), location_received_at: new Date().toISOString() }]);
  await user.click(screen.getByRole("button", { name: "Refresh routing state" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Compute route preview" })).toBeEnabled());
  await user.click(screen.getByRole("button", { name: "Compute route preview" }));
  await waitFor(() => expect(api.previewRouting).toHaveBeenCalledTimes(1));
});
