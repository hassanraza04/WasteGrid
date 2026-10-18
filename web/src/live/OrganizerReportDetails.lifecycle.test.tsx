import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
import { expect, test, vi } from "vitest";

import { AccessError, type OrganizerApi, type OrganizerReport, type OrganizerReportDetails as Details } from "./organizerApi";
import { OrganizerReportDetails } from "./OrganizerReportDetails";

interface Callbacks {
  report: OrganizerReport;
  onReportUpdated(report: OrganizerReport): void;
  onReload(): Promise<OrganizerReport | null>;
  onSessionExpired(error: AccessError): void;
}
const observed = vi.hoisted(() => ({ forms: [] as Callbacks[] }));
vi.mock("./OrganizerDecisionForm", () => ({ OrganizerDecisionForm(props: Callbacks) { observed.forms.push(props); return null; } }));

const report: OrganizerReport = {
  id: "report-a", public_reference: "WG-A", title: "Waste", address: null, location: null,
  display_status: "needs_review", assessment_status: "needs_review", illustrative: false, photo_id: "photo-a", completion_photo_ids: [], note: null,
  version: 7, state: "needs_review", dashboard_status: "submitted", priority: null, priority_reason: null, needs_review: true, assessment: null, triage: null,
  resident_answers: { fire: null, sharp_objects: null }, clarifications: [], latest_update: null, created_at: "2026-10-18T00:00:00Z", updated_at: "2026-10-18T00:00:00Z", job_id: null,
};
const second = { ...report, id: "report-b", public_reference: "WG-B" };

function setup() {
  observed.forms = [];
  const api = { report: vi.fn(async (id: string): Promise<Details> => ({ report: id === report.id ? report : second, events: [] })), sessionVersion: 1 } as unknown as OrganizerApi;
  const onSessionExpired = vi.fn();
  const view = render(<MemoryRouter initialEntries={["/admin/reports/report-a"]}><Link to="/admin/reports/report-b">Other report</Link><Routes><Route path="/admin/reports/:reportId" element={<OrganizerReportDetails api={api} onSessionExpired={onSessionExpired} />} /></Routes></MemoryRouter>);
  return { api, onSessionExpired, ...view };
}

test("a departed form cannot overwrite a different report, reload it, or expire its session", async () => {
  const { api, onSessionExpired } = setup();
  await screen.findByRole("heading", { name: "WG-A" });
  const oldForm = observed.forms.at(-1)!;
  await userEvent.setup().click(screen.getByRole("link", { name: "Other report" }));
  await screen.findByRole("heading", { name: "WG-B" });
  await act(async () => {
    oldForm.onReportUpdated({ ...report, version: 8 });
    expect(await oldForm.onReload()).toBeNull();
    oldForm.onSessionExpired(new AccessError("Old session"));
  });
  expect(screen.getByRole("heading", { name: "WG-B" })).toBeInTheDocument();
  expect(api.report).toHaveBeenCalledTimes(2);
  expect(onSessionExpired).not.toHaveBeenCalled();
});

test("current save refreshes persisted detail and preserves the report's identity", async () => {
  const { api } = setup();
  await screen.findByRole("heading", { name: "WG-A" });
  const currentForm = observed.forms.at(-1)!;
  vi.mocked(api.report).mockResolvedValueOnce({ report: { ...report, version: 8 }, events: [] });
  await act(async () => currentForm.onReportUpdated({ ...report, version: 8 }));
  expect(screen.getByText((_, node) => node?.textContent === "Report version: 8")).toBeInTheDocument();
  expect(api.report).toHaveBeenCalledTimes(2);
  await act(async () => currentForm.onReportUpdated(second));
  expect(screen.queryByRole("heading", { name: "WG-B" })).not.toBeInTheDocument();
});

test("failed refresh retains visible details and a retry keeps the form", async () => {
  const { api } = setup();
  await screen.findByRole("heading", { name: "WG-A" });
  const form = observed.forms.at(-1)!;
  vi.mocked(api.report).mockRejectedValueOnce(new Error("Refresh unavailable"));
  await act(async () => expect(await form.onReload()).toBeNull());
  expect(screen.getByRole("alert")).toHaveTextContent("Refresh unavailable");
  expect(screen.getByRole("heading", { name: "WG-A" })).toBeInTheDocument();
  await act(async () => expect((await form.onReload())?.id).toBe(report.id));
});

test("unmounted or superseded sessions cannot invoke save, reload, or authentication callbacks", async () => {
  const { api, onSessionExpired, unmount } = setup();
  await screen.findByRole("heading", { name: "WG-A" });
  const form = observed.forms.at(-1)!;
  Object.defineProperty(api, "sessionVersion", { value: 2 });
  await act(async () => {
    form.onReportUpdated(report);
    expect(await form.onReload()).toBeNull();
    form.onSessionExpired(new AccessError("Old session"));
  });
  unmount();
  await act(async () => expect(await form.onReload()).toBeNull());
  expect(api.report).toHaveBeenCalledTimes(1);
  expect(onSessionExpired).not.toHaveBeenCalled();
});
