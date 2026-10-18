import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Link, MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";

import { AccessError, type OrganizerApi } from "./organizerApi";
import type { OrganizerOverview as Overview, OrganizerReportIndex } from "./organizerTypes";
import { OrganizerOverview } from "./OrganizerOverview";
import { OrganizerReportList } from "./OrganizerReportList";
import { Dialog, useForegroundRefresh } from "./OrganizerUI";

const overview: Overview = {
  counts: { needs_review: 2, high_priority_jobs: 3, in_progress_jobs: 4, available_crews: 5, blocked_jobs: 6, completed_24h: 7, awaiting_assessment: 8 }, include_illustrative: false,
  configuration: { revision: "verified-revision", organizer_routing_enabled: true, road_service_configured: true, messaging_pilot_enabled: false },
  processing: { run_id: "run-a", status: "active", reason: "Supervised operation", starts_at: "2026-10-18T00:00:00Z", expires_at: "2026-10-18T01:00:00Z", model: "xai/grok-4.3", used_attempts: 1, max_attempts: 4, new_reports_admitted: 0, max_new_reports: 2, worker_online: false, last_heartbeat_at: null, last_success_at: null, queue: { pending: 1, running: 0, succeeded: 1, failed: 0 } },
};
const report = { id: "report-a", public_reference: "WG-A", title: "PRIVATE_RESIDENT_CAPTION", category: "general_waste", address: "Main street", photo_id: "photo-a", created_at: "2026-10-18T00:00:00Z", updated_at: "2026-10-18T00:00:00Z", display_status: "needs_review", state: "needs_review", assessment_status: "pending", priority: "high" as const, needs_review: true, illustrative: false, job_id: null, job_status: null, crew_id: null, crew_name: null, route_position: null };
const reportIndex: OrganizerReportIndex = { items: [report], total: 26, offset: 0, limit: 25 };
function Url() { return <output aria-label="Current URL">{useLocation().search}</output>; }
function overviewSetup(value = overview) {
  const api = { overview: vi.fn().mockResolvedValue(value), sessionVersion: 1 } as unknown as OrganizerApi;
  const expired = vi.fn();
  const view = render(<MemoryRouter><OrganizerOverview api={api} onSessionExpired={expired} /><Url /></MemoryRouter>);
  return { api, expired, user: userEvent.setup(), ...view };
}
function listSetup(path = "/admin/reports") {
  const api = { reportIndex: vi.fn().mockResolvedValue(reportIndex), sessionVersion: 1 } as unknown as OrganizerApi;
  const expired = vi.fn();
  const view = render(<MemoryRouter initialEntries={[path]}><Link to="/admin/reports?q=other">Other search</Link><OrganizerReportList api={api} onSessionExpired={expired} /><Url /></MemoryRouter>);
  return { api, expired, user: userEvent.setup(), ...view };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

test("overview shows server counts and separates configuration, heartbeat and observed success", async () => {
  const { api, user } = overviewSetup();
  await screen.findByText("verified-revision");
  expect(api.overview).toHaveBeenCalledWith(false);
  expect(screen.getByText("8 reports awaiting assessment")).toBeInTheDocument();
  expect(screen.getByText("Worker offline / stale")).toBeInTheDocument();
  expect(screen.getByText(/New-report slots are project-wide/)).toBeInTheDocument();
  expect(document.body.textContent).not.toContain("AI ready");
  expect(screen.getAllByText("View details ↗")[0]).toHaveAttribute("href", "/admin/reports?view=needs_review");
  await user.click(screen.getByRole("checkbox", { name: "Include illustrative demo data" }));
  await waitFor(() => expect(api.overview).toHaveBeenLastCalledWith(true));
  expect(screen.getAllByText("View details ↗")[0]).toHaveAttribute("href", "/admin/reports?view=needs_review&illustrative=true");
  await user.click(screen.getByRole("checkbox", { name: "Include illustrative demo data" }));
  await waitFor(() => expect(api.overview).toHaveBeenLastCalledWith(false));
  await user.click(screen.getByRole("button", { name: "Refresh overview" }));
  expect(api.overview).toHaveBeenCalledTimes(4);
});

test("overview exposes real provider success only when recorded and offers retries", async () => {
  const { api, user } = overviewSetup({ ...overview, configuration: { ...overview.configuration, organizer_routing_enabled: false, road_service_configured: false, messaging_pilot_enabled: true }, processing: { ...overview.processing, worker_online: true, last_heartbeat_at: "2026-10-18T00:00:00Z", last_success_at: "2026-10-18T00:01:00Z", expires_at: null } });
  await screen.findByText("Worker online");
  vi.mocked(api.overview).mockRejectedValueOnce(new Error("Cold start timeout"));
  await user.click(screen.getByRole("button", { name: "Refresh overview" }));
  expect(screen.getByRole("alert")).toHaveTextContent("Cold start timeout");
  await user.click(screen.getByRole("button", { name: "Retry overview" }));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

test.each(["resolve", "reject"])("departed overview ignores late %s", async outcome => {
  const { api, user, unmount, expired } = overviewSetup();
  await screen.findByText("verified-revision");
  let resolve!: (value: Overview) => void; let reject!: (error: Error) => void;
  vi.mocked(api.overview).mockReturnValueOnce(new Promise((ok, fail) => { resolve = ok; reject = fail; }));
  await user.click(screen.getByRole("button", { name: "Refresh overview" }));
  unmount();
  await act(async () => outcome === "resolve" ? resolve(overview) : reject(new AccessError("Old account")));
  expect(expired).not.toHaveBeenCalled();
});

test("current overview access rejection expires only the active session", async () => {
  const { api, user, expired } = overviewSetup();
  await screen.findByText("verified-revision");
  vi.mocked(api.overview).mockRejectedValueOnce(new AccessError("Expired"));
  await user.click(screen.getByRole("button", { name: "Refresh overview" }));
  expect(expired).toHaveBeenCalledWith(expect.any(AccessError));
});

test("report index uses URL filters, stable server pagination and neutral evidence headings", async () => {
  const { api, user } = listSetup("/admin/reports?view=needs_review&priority=high&sort=priority&q=WG&assessment=pending");
  await screen.findByRole("link", { name: "WG-A" });
  expect(api.reportIndex).toHaveBeenCalledWith(expect.objectContaining({ q: "WG", view: "needs_review", priority: "high", sort: "priority", assessment_status: "pending", include_illustrative: false, offset: 0, limit: 25 }));
  expect(screen.queryByText("PRIVATE_RESIDENT_CAPTION")).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "WG-A" })).toHaveAttribute("href", "/admin/reports/report-a");
  await user.clear(screen.getByRole("searchbox")); await user.type(screen.getByRole("searchbox"), "market"); await user.click(screen.getByRole("button", { name: "Search" }));
  await waitFor(() => expect(api.reportIndex).toHaveBeenLastCalledWith(expect.objectContaining({ q: "market", offset: 0 })));
  await user.selectOptions(screen.getByLabelText("Priority"), "routine");
  await user.selectOptions(screen.getByLabelText("Assessment"), "failed");
  await user.selectOptions(screen.getByLabelText("Sort by"), "oldest");
  await user.click(screen.getByRole("checkbox", { name: "Include illustrative demo data" }));
  await waitFor(() => expect(api.reportIndex).toHaveBeenLastCalledWith(expect.objectContaining({ priority: "routine", assessment_status: "failed", sort: "oldest", include_illustrative: true })));
  await user.click(screen.getByRole("button", { name: "Next page" }));
  await waitFor(() => expect(api.reportIndex).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 25 })));
  await user.click(screen.getByRole("button", { name: "Previous page" }));
  await waitFor(() => expect(api.reportIndex).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 0 })));
  await user.click(screen.getByRole("link", { name: "Awaiting assessment" }));
  await waitFor(() => expect(api.reportIndex).toHaveBeenLastCalledWith(expect.objectContaining({ view: "awaiting_assessment" })));
});

test("empty report result is useful and errors retry without losing filters", async () => {
  const { api, user } = listSetup();
  await screen.findByRole("link", { name: "WG-A" });
  vi.mocked(api.reportIndex).mockRejectedValueOnce(new Error("List timeout"));
  await user.click(screen.getByRole("button", { name: "Refresh reports" }));
  expect(screen.getByRole("alert")).toHaveTextContent("List timeout");
  vi.mocked(api.reportIndex).mockResolvedValueOnce({ ...reportIndex, items: [], total: 0 });
  await user.click(screen.getByRole("button", { name: "Retry reports" }));
  expect(screen.getByRole("heading", { name: "No matching reports" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();
});

test("report index exposes operational metadata while preserving private captions", async () => {
  const { api, user } = listSetup();
  await screen.findByRole("link", { name: "WG-A" });
  vi.mocked(api.reportIndex).mockResolvedValueOnce({ ...reportIndex, items: [{ ...report, category: null, address: null, priority: "medium", illustrative: true, needs_review: false, crew_name: "Crew A", route_position: 0 }, { ...report, id: "other", public_reference: "WG-B", priority: null, crew_name: "Crew B", route_position: null }] });
  await user.click(screen.getByRole("button", { name: "Refresh reports" }));
  expect(screen.getByText("Cleanup report")).toBeInTheDocument();
  expect(screen.getByText("Crew A · stop 1")).toBeInTheDocument();
  expect(screen.getByText("Crew B")).toBeInTheDocument();
  expect(screen.getByText("Illustrative demo report")).toBeInTheDocument();
});

test("report-index route replacement and account changes invalidate late results", async () => {
  const { api, user, expired } = listSetup();
  await screen.findByRole("link", { name: "WG-A" });
  let reject!: (reason: Error) => void;
  vi.mocked(api.reportIndex).mockReturnValueOnce(new Promise((_, fail) => { reject = fail; }));
  await user.click(screen.getByRole("button", { name: "Refresh reports" }));
  await user.click(screen.getByRole("link", { name: "Other search" }));
  await screen.findByRole("link", { name: "WG-A" });
  await act(async () => reject(new AccessError("Old result")));
  expect(expired).not.toHaveBeenCalled();
  vi.mocked(api.reportIndex).mockRejectedValueOnce(new AccessError("Current result"));
  await user.click(screen.getByRole("button", { name: "Refresh reports" }));
  expect(expired).toHaveBeenCalledOnce();
});

function RefreshHarness({ refresh, enabled = true }: { refresh: () => void; enabled?: boolean }) { useForegroundRefresh(refresh, enabled); return null; }
test("foreground refresh pauses while hidden and refreshes immediately on returning", async () => {
  vi.useFakeTimers();
  const refresh = vi.fn();
  const { rerender, unmount } = render(<RefreshHarness refresh={refresh} />);
  await act(async () => { vi.advanceTimersByTime(15_000); });
  expect(refresh).toHaveBeenCalledTimes(1);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  await act(async () => { vi.advanceTimersByTime(30_000); });
  expect(refresh).toHaveBeenCalledTimes(1);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  fireEvent(document, new Event("visibilitychange"));
  expect(refresh).toHaveBeenCalledTimes(2);
  rerender(<RefreshHarness refresh={refresh} enabled={false} />);
  await act(async () => { vi.advanceTimersByTime(15_000); });
  expect(refresh).toHaveBeenCalledTimes(2);
  unmount();
});

test("confirmation dialogs trap focus, restore it and suppress dismissal while saving", async () => {
  const close = vi.fn();
  const { rerender, unmount } = render(<Dialog title="Dispatch confirmation" onClose={close}><button>First action</button><button>Last action</button></Dialog>);
  const dialog = screen.getByRole("dialog");
  const closeButton = screen.getByRole("button", { name: "Close dialog" });
  const last = screen.getByRole("button", { name: "Last action" });
  closeButton.focus(); fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true }); expect(last).toHaveFocus();
  fireEvent.keyDown(dialog, { key: "Tab" }); expect(closeButton).toHaveFocus();
  fireEvent.keyDown(dialog, { key: "Escape" }); expect(close).toHaveBeenCalledTimes(1);
  rerender(<Dialog title="Dispatch confirmation" onClose={close} busy><button disabled>Disabled action</button></Dialog>);
  expect(dialog).toHaveFocus();
  fireEvent.keyDown(dialog, { key: "Tab" }); expect(dialog).toHaveFocus();
  fireEvent.keyDown(dialog, { key: "Escape" }); expect(close).toHaveBeenCalledTimes(1);
  unmount();
});
