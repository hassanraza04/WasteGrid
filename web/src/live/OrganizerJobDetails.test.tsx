import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";

import { OrganizerJobDetails } from "./OrganizerJobDetails";
import { AccessError, type OrganizerApi, type OrganizerJobDetails as Details } from "./organizerApi";

const details: Details = {
  job: {
    id: "job-123", status: "unassigned", location: { latitude: 24.86, longitude: 67.01, landmark: "School entrance" }, category: "general waste", required_equipment: ["gloves", "trash_bags"], estimated_service_minutes: 15,
    assigned_crew_id: null, locked: false, held: true, route_position: null, travel_minutes: 0, decision_summary: "Awaiting safe collection", unassigned_reason: "planning_pending", version: 3, illustrative: true,
  },
  photo_ids: ["photo-123"], events: [],
};

function setup() {
  const api = { job: vi.fn().mockResolvedValue(details), sessionVersion: 1 } as unknown as OrganizerApi;
  const onSessionExpired = vi.fn();
  const view = render(<OrganizerJobDetails api={api} id="job-123" onSessionExpired={onSessionExpired} />);
  return { api, onSessionExpired, ...view };
}

test("shows the linked job's actual persisted status, holds, location, and crew assignment", async () => {
  const { api } = setup();
  await screen.findByText("Awaiting safe collection");
  expect(api.job).toHaveBeenCalledWith("job-123");
  expect(screen.getByText((_, node) => node?.textContent === "Job status: unassigned")).toBeInTheDocument();
  expect(screen.getByText((_, node) => node?.textContent === "Job held: true")).toBeInTheDocument();
  expect(screen.getByText((_, node) => node?.textContent === "Assigned crew ID: Not recorded")).toBeInTheDocument();
  expect(screen.getByText("School entrance")).toBeInTheDocument();
  expect(screen.getByText("Illustrative demo job")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /dispatch|start|complete/i })).not.toBeInTheDocument();
});

test("loads another job without retaining the first job's details", async () => {
  const { api, rerender } = setup();
  await screen.findByText("Awaiting safe collection");
  vi.mocked(api.job).mockResolvedValueOnce({ ...details, job: { ...details.job, id: "job-456", assigned_crew_id: "crew-456", route_position: 2, decision_summary: "", illustrative: false } });
  rerender(<OrganizerJobDetails api={api} id="job-456" onSessionExpired={vi.fn()} />);
  await screen.findByText("crew-456");
  expect(screen.queryByText("Awaiting safe collection")).not.toBeInTheDocument();
  expect(screen.queryByText("Illustrative demo job")).not.toBeInTheDocument();
});

test("retries an unavailable linked job without mutating it", async () => {
  const { api, rerender, onSessionExpired } = setup();
  await screen.findByText("Awaiting safe collection");
  vi.mocked(api.job).mockRejectedValueOnce(new Error("Linked job unavailable"));
  rerender(<OrganizerJobDetails api={api} id="job-456" onSessionExpired={onSessionExpired} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Linked job unavailable");
  await userEvent.setup().click(screen.getByRole("button", { name: "Retry linked job" }));
  await screen.findByText("Awaiting safe collection");
  expect(onSessionExpired).not.toHaveBeenCalled();
});

test("expires the current session when linked job authorization is rejected", async () => {
  const api = { job: vi.fn().mockRejectedValue(new AccessError("Access denied")) } as unknown as OrganizerApi;
  const onSessionExpired = vi.fn();
  render(<OrganizerJobDetails api={api} id="job-123" onSessionExpired={onSessionExpired} />);
  await waitFor(() => expect(onSessionExpired).toHaveBeenCalledWith(expect.any(AccessError)));
});

test.each(["success", "failure"])("ignores a departed job's late %s", async outcome => {
  let resolve!: (value: Details) => void;
  let reject!: (reason: Error) => void;
  const api = { job: vi.fn().mockReturnValueOnce(new Promise<Details>((ok, fail) => { resolve = ok; reject = fail; })).mockResolvedValue(details), sessionVersion: 1 } as unknown as OrganizerApi;
  const onSessionExpired = vi.fn();
  const { rerender } = render(<OrganizerJobDetails api={api} id="old-job" onSessionExpired={onSessionExpired} />);
  rerender(<OrganizerJobDetails api={api} id="job-123" onSessionExpired={onSessionExpired} />);
  await screen.findByText("Awaiting safe collection");
  await act(async () => outcome === "success" ? resolve({ ...details, job: { ...details.job, decision_summary: "Old job result" } }) : reject(new AccessError("Old session expired")));
  expect(screen.queryByText("Old job result")).not.toBeInTheDocument();
  expect(onSessionExpired).not.toHaveBeenCalled();
});

test("ignores linked job completion after unmount or an authentication change", async () => {
  let resolve!: (value: Details) => void;
  const api = { job: vi.fn().mockReturnValue(new Promise<Details>(ok => { resolve = ok; })), sessionVersion: 1 } as unknown as OrganizerApi;
  const onSessionExpired = vi.fn();
  const { unmount } = render(<OrganizerJobDetails api={api} id="job-123" onSessionExpired={onSessionExpired} />);
  Object.defineProperty(api, "sessionVersion", { value: 2 });
  await act(async () => resolve(details));
  expect(screen.queryByText("Awaiting safe collection")).not.toBeInTheDocument();
  unmount();
});
