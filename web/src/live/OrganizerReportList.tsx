import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { AccessError, type OrganizerApi, type Priority } from "./organizerApi";
import type { OrganizerReportIndex, ReportIndexQuery } from "./organizerTypes";
import { OrganizerPhoto } from "./OrganizerPhoto";
import {
  Alert,
  Chip,
  EmptyState,
  LoadingState,
  formatDate,
  humanize,
  useForegroundRefresh,
} from "./OrganizerUI";

const views = [
  ["all", "All reports"],
  ["needs_review", "Review required"],
  ["awaiting_assessment", "Awaiting assessment"],
  ["active_cleanup", "Active cleanup"],
] as const;
export function OrganizerReportList({
  api,
  onSessionExpired,
}: {
  api: OrganizerApi;
  onSessionExpired: (error: AccessError) => void;
}) {
  const [params, setParams] = useSearchParams();
  const key = params.toString();
  const [search, setSearch] = useState(params.get("q") ?? "");
  const [result, setResult] = useState<OrganizerReportIndex | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const inFlight = useRef(false);
  const view = views.some(([value]) => value === params.get("view"))
    ? (params.get("view") as ReportIndexQuery["view"])
    : "all";
  const illustrative = params.get("illustrative") === "true";
  const offset = Math.max(0, Number(params.get("offset")) || 0);
  function update(values: Record<string, string>) {
    const next = new URLSearchParams(params);
    for (const [name, value] of Object.entries(values)) {
      if (value) next.set(name, value);
      else next.delete(name);
    }
    if (!("offset" in values)) next.delete("offset");
    setParams(next);
  }
  async function load() {
    if (inFlight.current) return;
    inFlight.current = true;
    const request = ++generation.current;
    const session = api.sessionVersion;
    const current = () =>
      request === generation.current && session === api.sessionVersion;
    setBusy(true);
    setError("");
    try {
      const data = await api.reportIndex({
        q: params.get("q") || undefined,
        view,
        priority: (params.get("priority") || undefined) as Priority | undefined,
        assessment_status: params.get("assessment") || undefined,
        sort: (params.get("sort") || "newest") as ReportIndexQuery["sort"],
        include_illustrative: illustrative,
        limit: 25,
        offset,
      });
      if (current()) setResult(data);
    } catch (caught) {
      if (current()) {
        setError((caught as Error).message);
        if (caught instanceof AccessError) onSessionExpired(caught);
      }
    } finally {
      if (request === generation.current) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  }
  useEffect(() => {
    inFlight.current = false;
    setResult(null);
    setSearch(params.get("q") ?? "");
    void load();
    return () => {
      generation.current++;
    };
  }, [api, key]);
  useForegroundRefresh(() => void load());
  function submit(event: FormEvent) {
    event.preventDefault();
    update({ q: search.trim() });
  }
  return (
    <>
      <div className="wg-page-heading">
        <div>
          <p className="wg-eyebrow">Resident evidence</p>
          <h2>Reports</h2>
          <p className="wg-muted">
            From first photo to verified cleanup, keep the next action clear.
          </p>
        </div>
        <button
          className="wg-button wg-secondary"
          disabled={busy}
          onClick={() => void load()}
        >
          Refresh reports
        </button>
      </div>
      <nav className="wg-view-tabs" aria-label="Report views">
        {views.map(([value, label]) => {
          const next = new URLSearchParams(params);
          next.set("view", value);
          next.delete("offset");
          return (
            <Link
              key={value}
              to={`/admin/reports?${next}`}
              aria-current={view === value ? "page" : undefined}
            >
              {label}
            </Link>
          );
        })}
      </nav>
      <section className="wg-card">
        <form onSubmit={submit} className="wg-filters">
          <label>
            Search reports
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Reference or address"
              type="search"
            />
          </label>
          <label>
            Priority
            <select
              value={params.get("priority") ?? ""}
              onChange={(event) => update({ priority: event.target.value })}
            >
              <option value="">Any priority</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="routine">Routine</option>
            </select>
          </label>
          <label>
            Assessment
            <select
              value={params.get("assessment") ?? ""}
              onChange={(event) => update({ assessment: event.target.value })}
            >
              <option value="">Any assessment</option>
              <option value="pending">Pending</option>
              <option value="assessed">Assessed</option>
              <option value="needs_review">Needs review</option>
              <option value="failed">Failed</option>
            </select>
          </label>
          <label>
            Sort by
            <select
              value={params.get("sort") ?? "newest"}
              onChange={(event) => update({ sort: event.target.value })}
            >
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
              <option value="priority">Priority</option>
            </select>
          </label>
          <button className="wg-button">Search</button>
        </form>
        <div className="wg-actions" style={{ marginBottom: 16 }}>
          <label className="wg-small">
            <input
              type="checkbox"
              checked={illustrative}
              onChange={(event) =>
                update({ illustrative: event.target.checked ? "true" : "" })
              }
            />
            Include illustrative demo data
          </label>
          <Chip tone={illustrative ? "amber" : "green"}>
            {illustrative ? "Real + illustrative records" : "Real records"}
          </Chip>
        </div>
        {error && (
          <Alert>
            {error}{" "}
            <button
              className="wg-button wg-secondary"
              onClick={() => void load()}
            >
              Retry reports
            </button>
          </Alert>
        )}
        {busy && !result && <LoadingState label="Loading reports…" />}
        {result &&
          (result.items.length ? (
            <div className="wg-table-wrap">
              <table className="wg-table">
                <caption className="wg-visually-hidden">Reports</caption>
                <thead>
                  <tr>
                    <th scope="col">Report</th>
                    <th scope="col">Location</th>
                    <th scope="col">Priority</th>
                    <th scope="col">Status</th>
                    <th scope="col">Received</th>
                  </tr>
                </thead>
                <tbody>
                  {result.items.map((report) => (
                    <tr key={report.id}>
                      <td>
                        <div className="wg-report-cell">
                          <OrganizerPhoto
                            api={api}
                            id={report.photo_id}
                            width={70}
                            onSessionExpired={onSessionExpired}
                          />
                          <div>
                            <h3>
                              {report.category
                                ? humanize(report.category)
                                : "Cleanup report"}
                            </h3>
                            <Link to={`/admin/reports/${report.id}`}>
                              {report.public_reference}
                            </Link>
                            {report.illustrative && (
                              <p>
                                <Chip tone="amber">
                                  Illustrative demo report
                                </Chip>
                              </p>
                            )}
                          </div>
                        </div>
                      </td>
                      <td>{report.address ?? "Map coordinates recorded"}</td>
                      <td>
                        <Chip
                          tone={
                            report.priority === "high"
                              ? "red"
                              : report.priority === "medium"
                                ? "amber"
                                : "neutral"
                          }
                        >
                          {report.priority
                            ? humanize(report.priority)
                            : "Awaiting assessment"}
                        </Chip>
                      </td>
                      <td>
                        <p>{humanize(report.display_status)}</p>
                        <p className="wg-muted">
                          Assessment: {humanize(report.assessment_status)}
                        </p>
                        {report.needs_review && (
                          <Chip tone="amber">Review required</Chip>
                        )}
                        {report.crew_name && (
                          <p>
                            {report.crew_name}
                            {report.route_position !== null
                              ? ` · stop ${report.route_position + 1}`
                              : ""}
                          </p>
                        )}
                      </td>
                      <td className="wg-no-wrap">
                        {formatDate(report.created_at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState title="No matching reports">
              Try another search or filter. New real reports will appear here
              after submission.
            </EmptyState>
          ))}
        <div className="wg-pagination">
          <span aria-live="polite">
            {result
              ? `${result.total ? result.offset + 1 : 0}–${Math.min(result.offset + result.items.length, result.total)} of ${result.total} reports`
              : "Reports are loading"}
          </span>
          <div className="wg-actions">
            <button
              className="wg-button wg-secondary"
              disabled={busy || offset === 0}
              onClick={() =>
                update({ offset: String(Math.max(0, offset - 25)) })
              }
            >
              Previous page
            </button>
            <button
              className="wg-button wg-secondary"
              disabled={
                busy || !result || offset + result.items.length >= result.total
              }
              onClick={() => update({ offset: String(offset + 25) })}
            >
              Next page
            </button>
          </div>
        </div>
      </section>
    </>
  );
}
