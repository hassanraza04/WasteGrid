import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";

import { OrganizerDispatchWorkspace } from "./OrganizerDispatchWorkspace";
import { RoutingConflictError, type OrganizerApi, type OrganizerCrew, type OrganizerCurrentPlan, type OrganizerRoutePreview, type OrganizerRoutingJob } from "./organizerApi";

const crew: OrganizerCrew = {
  id: "crew-1", name: "Crew One", equipment: ["gloves"], shift_minutes: 480, available: true,
  start_location: { latitude: 24.92, longitude: 67.09, landmark: "Depot" }, illustrative: true,
  location_recorded_at: new Date().toISOString(), location_received_at: new Date().toISOString(), location_revision: 1,
};
const job: OrganizerRoutingJob = {
  id: "job-1", status: "unassigned" as const, location: { latitude: 24.93, longitude: 67.1, landmark: "Gate" },
  category: "General waste", priority: "medium", required_equipment: ["gloves"], estimated_service_minutes: 15,
  assigned_crew_id: null, locked: false, held: false, route_position: null, travel_minutes: 0,
  decision_summary: "Approved collection", unassigned_reason: null, version: 1, illustrative: false,
};
function preview(jobIds = ["job-1"]): OrganizerRoutePreview {
  return {
    id: "preview-1", job_ids: jobIds, computed_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60_000).toISOString(), matrix_id: "matrix-1", travel_label: "OSRM road estimates",
    routes: [{ crew_id: "crew-1", duration_minutes: 20, travel_minutes: 5, stops: [{ job_id: "job-1", position: 0, priority: "medium", travel_minutes: 5, service_minutes: 15, completion_minutes: 20, fixed: false, service_estimate_source: "assessment" }] }],
    exclusions: [], unassigned: [], metrics: { weighted_wait: 1, latest_finish: 20, total_travel: 5, score: 1 }, termination_reason: "dispatchable", dispatchable: true, reassignments: [], settings: {}, plan_id: null,
  };
}
function setup(result = preview(), currentPlan: OrganizerCurrentPlan = { plan: null }, crews = [crew], jobs = [job]) {
  const api = {
    sessionVersion: 1, crews: vi.fn().mockResolvedValue(crews), jobs: vi.fn().mockResolvedValue(jobs), currentPlan: vi.fn().mockResolvedValue(currentPlan),
    previewRouting: vi.fn().mockResolvedValue(result), dispatchRouting: vi.fn().mockResolvedValue({ preview_id: "preview-1", plan_id: "plan-1" }),
  } as unknown as OrganizerApi;
  render(<OrganizerDispatchWorkspace api={api} onSessionExpired={vi.fn()} />);
  return { api, user: userEvent.setup() };
}
async function selectScope(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "Select Crew One (crew-1)" }));
  await user.click(screen.getByRole("button", { name: "Select job General waste (job-1)" }));
}

test("computes only the reviewed scope and requires a separate dispatch confirmation", async () => {
  const { api, user } = setup();
  await selectScope(user);
  await user.click(screen.getByRole("button", { name: "Compute route preview" }));

  await waitFor(() => expect(api.previewRouting).toHaveBeenCalledWith(["crew-1"], ["job-1"]));
  expect(screen.getByText(/OSRM road estimates/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Review dispatch" })).toBeInTheDocument();
  expect(api.dispatchRouting).not.toHaveBeenCalled();

  await user.click(screen.getByRole("button", { name: "Review dispatch" }));
  await user.click(screen.getByRole("button", { name: "Confirm and dispatch" }));
  await waitFor(() => expect(api.dispatchRouting).toHaveBeenCalledWith("preview-1", expect.any(String)));
  await waitFor(() => expect(api.currentPlan).toHaveBeenCalledTimes(2));
  await user.click(screen.getByRole("button", { name: "Compute route preview" }));
  await waitFor(() => expect(api.previewRouting).toHaveBeenCalledTimes(2));
});

test("fails closed when the server returns a preview for a different scope", async () => {
  const { api, user } = setup(preview(["unreviewed-job"]));
  await selectScope(user);
  await user.click(screen.getByRole("button", { name: "Compute route preview" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("did not confirm the selected job scope");
  expect(screen.queryByRole("button", { name: "Review dispatch" })).not.toBeInTheDocument();
  expect(api.dispatchRouting).not.toHaveBeenCalled();
});

test("reports a routing contract error for a malformed preview payload", async () => {
  const malformedPreview = { id: "preview-1", job_ids: ["job-1"] } as unknown as OrganizerRoutePreview;
  const { api, user } = setup(malformedPreview);
  await selectScope(user);
  await user.click(screen.getByRole("button", { name: "Compute route preview" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("did not confirm the selected job scope");
  expect(screen.queryByRole("button", { name: "Review dispatch" })).not.toBeInTheDocument();
  expect(api.dispatchRouting).not.toHaveBeenCalled();
});

test("fails closed when preview details reference an unreviewed job", async () => {
  const result = preview();
  result.unassigned = [{ job_id: "unreviewed-job", reason: "Missing equipment" }];
  const { api, user } = setup(result);
  await selectScope(user);
  await user.click(screen.getByRole("button", { name: "Compute route preview" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("did not confirm the selected job scope");
  expect(screen.queryByRole("button", { name: "Review dispatch" })).not.toBeInTheDocument();
  expect(api.dispatchRouting).not.toHaveBeenCalled();
});

test("fails closed when a reassignment targets an unselected crew", async () => {
  const result = preview();
  result.reassignments = [{ job_id: "job-1", previous_crew_id: null, previous_position: null, proposed_crew_id: "crew-2", proposed_position: 0 }];
  const { api, user } = setup(result);
  await selectScope(user);
  await user.click(screen.getByRole("button", { name: "Compute route preview" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("did not confirm the selected job scope");
  expect(screen.queryByRole("button", { name: "Review dispatch" })).not.toBeInTheDocument();
  expect(api.dispatchRouting).not.toHaveBeenCalled();
});

test("invalidates a preview when the reviewed job selection changes", async () => {
  const { user } = setup();
  await selectScope(user);
  await user.click(screen.getByRole("button", { name: "Compute route preview" }));
  await screen.findByRole("button", { name: "Review dispatch" });

  await user.click(screen.getByRole("button", { name: "Remove job General waste (job-1)" }));
  expect(screen.queryByRole("button", { name: "Review dispatch" })).not.toBeInTheDocument();
});

test("shows current assignments and clearly labels held or fixed work before previewing", async () => {
  setup(preview(), { plan: { id: "plan-1", stale: false, travel_estimates_label: "OSRM road estimates", assignments: [{ crew_id: "crew-1", job_id: "job-1", position: 0, travel_minutes: 5, service_minutes: 15 }], unassigned: [] } });

  expect(await screen.findByText(/Crew One · stop 1 · job-1 · 5 minutes travel · 15 minutes service/)).toBeInTheDocument();
  expect(screen.getByText(/movable work/)).toBeInTheDocument();
});

test("marks stale plans, unavailable crews, missing GPS, and held work before previewing", async () => {
  const unavailableCrew = { ...crew, available: false, illustrative: false, location_recorded_at: null };
  const heldJob = { ...job, held: true };
  setup(preview(), { plan: { id: "plan-1", stale: true, travel_estimates_label: "OSRM road estimates", assignments: [], unassigned: [] } }, [unavailableCrew], [heldJob]);

  expect(await screen.findByText(/plan-1 · changed, review before replanning/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Select Crew One (crew-1)" })).toBeDisabled();
  expect(screen.getByText(/Real crew.*GPS not shared/)).toBeInTheDocument();
  expect(screen.getByText(/held work/)).toBeInTheDocument();
});

test("reuses one frozen command after an uncertain dispatch result", async () => {
  const { api, user } = setup();
  vi.mocked(api.dispatchRouting).mockRejectedValueOnce(new Error("Unable to reach WasteGrid. Please retry.")).mockResolvedValueOnce({ preview_id: "preview-1", plan_id: "plan-1" });
  await selectScope(user);
  await user.click(screen.getByRole("button", { name: "Compute route preview" }));
  await user.click(await screen.findByRole("button", { name: "Review dispatch" }));
  await user.click(screen.getByRole("button", { name: "Confirm and dispatch" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Unable to reach WasteGrid");

  await user.click(screen.getByRole("button", { name: "Confirm and dispatch" }));
  await waitFor(() => expect(api.dispatchRouting).toHaveBeenCalledTimes(2));
  const [[firstPreview, firstCommand], [secondPreview, secondCommand]] = vi.mocked(api.dispatchRouting).mock.calls;
  expect(secondPreview).toBe(firstPreview);
  expect(secondCommand).toBe(firstCommand);
});

test("a dispatch conflict clears the preview, refreshes state, and requires recomputation", async () => {
  const { api, user } = setup();
  vi.mocked(api.dispatchRouting).mockRejectedValueOnce(new RoutingConflictError("Routing state changed."));
  await selectScope(user);
  await user.click(screen.getByRole("button", { name: "Compute route preview" }));
  await user.click(await screen.findByRole("button", { name: "Review dispatch" }));
  await user.click(screen.getByRole("button", { name: "Confirm and dispatch" }));

  expect(await screen.findByRole("alert")).toHaveTextContent(/compute and review a new preview/i);
  expect(screen.queryByRole("button", { name: "Review dispatch" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Remove Crew One (crew-1)" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Remove job General waste (job-1)" })).toBeInTheDocument();
  await waitFor(() => expect(api.currentPlan).toHaveBeenCalledTimes(2));
  await user.click(screen.getByRole("button", { name: "Compute route preview" }));
  await waitFor(() => expect(api.previewRouting).toHaveBeenCalledTimes(2));
});

test("a preview conflict refreshes state before allowing a new preview", async () => {
  const { api, user } = setup();
  vi.mocked(api.previewRouting).mockRejectedValueOnce(new RoutingConflictError("Routing state changed."));
  await selectScope(user);
  await user.click(screen.getByRole("button", { name: "Compute route preview" }));

  expect(await screen.findByRole("alert")).toHaveTextContent(/compute and review a new preview/i);
  await waitFor(() => expect(api.currentPlan).toHaveBeenCalledTimes(2));
  await user.click(screen.getByRole("button", { name: "Compute route preview" }));
  await waitFor(() => expect(api.previewRouting).toHaveBeenCalledTimes(2));
});

test("does not submit selections that disappeared from refreshed routing state", async () => {
  const { api, user } = setup();
  await screen.findByRole("button", { name: "Select Crew One (crew-1)" });
  vi.mocked(api.crews).mockResolvedValueOnce([]);
  vi.mocked(api.jobs).mockResolvedValueOnce([]);
  await selectScope(user);
  await user.click(screen.getByRole("button", { name: "Refresh routing state" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("Select at least one crew");
  expect(screen.getByRole("button", { name: "Compute route preview" })).toBeDisabled();
  expect(api.previewRouting).not.toHaveBeenCalled();
});

test("distinguishes duplicate crew names and job categories by their stable IDs", async () => {
  const duplicateCrew = { ...crew, id: "crew-2" };
  const duplicateJob = { ...job, id: "job-2" };
  const { user } = setup(preview(), { plan: null }, [crew, duplicateCrew], [job, duplicateJob]);

  await user.click(await screen.findByRole("button", { name: "Select Crew One (crew-2)" }));
  await user.click(screen.getByRole("button", { name: "Select job General waste (job-2)" }));

  expect(screen.getByRole("button", { name: "Remove Crew One (crew-2)" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Remove job General waste (job-2)" })).toBeInTheDocument();
});

test("rechecks preview expiry when confirmation is submitted", async () => {
  const expiringPreview = preview();
  const clock = vi.spyOn(Date, "now");
  try {
    const { api, user } = setup(expiringPreview);
    await selectScope(user);
    await user.click(screen.getByRole("button", { name: "Compute route preview" }));
    await user.click(await screen.findByRole("button", { name: "Review dispatch" }));
    clock.mockReturnValue(Date.parse(expiringPreview.expires_at) + 1);

    await user.click(screen.getByRole("button", { name: "Confirm and dispatch" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/preview expired/i);
    expect(api.dispatchRouting).not.toHaveBeenCalled();
  } finally {
    clock.mockRestore();
  }
});
