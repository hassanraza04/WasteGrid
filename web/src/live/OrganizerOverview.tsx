import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { AccessError, type OrganizerApi } from "./organizerApi";
import type { OrganizerOverview as Overview } from "./organizerTypes";
import {
  Alert,
  Chip,
  FieldValue,
  LoadingState,
  formatDate,
  useForegroundRefresh,
} from "./OrganizerUI";

export function OrganizerOverview({
  api,
  onSessionExpired,
}: {
  api: OrganizerApi;
  onSessionExpired: (error: AccessError) => void;
}) {
  const [params, setParams] = useSearchParams();
  const includeIllustrative = params.get("illustrative") === "true";
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const inFlight = useRef(false);
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
      const result = await api.overview(includeIllustrative);
      if (current()) setOverview(result);
    } catch (caught) {
      if (current()) {
        if (caught instanceof AccessError) onSessionExpired(caught);
        else setError((caught as Error).message);
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
    setOverview(null);
    void load();
    return () => {
      generation.current++;
    };
  }, [api, includeIllustrative]);
  useForegroundRefresh(() => void load());
  const processing = overview?.processing;
  const configuration = overview?.configuration;
  const metrics: Array<[string, number | undefined, string, string]> = [
    [
      "Review required",
      overview?.counts.needs_review,
      "/admin/reports?view=needs_review",
      "Reports awaiting a human decision",
    ],
    [
      "High-priority jobs",
      overview?.counts.high_priority_jobs,
      "/admin/reports?view=active_cleanup&priority=high",
      "Active jobs with effective high priority",
    ],
    [
      "Jobs in progress",
      overview?.counts.in_progress_jobs,
      "/admin/reports?view=active_cleanup",
      "Cleanup started by a crew",
    ],
    [
      "Available crews",
      overview?.counts.available_crews,
      "/admin/dispatch",
      "Availability does not imply fresh GPS",
    ],
    [
      "Blocked / held jobs",
      overview?.counts.blocked_jobs,
      "/admin/dispatch",
      "Distinct jobs requiring attention",
    ],
    [
      "Completed in 24 hours",
      overview?.counts.completed_24h,
      "/admin/reports",
      "Currently completed jobs with recent completion events",
    ],
  ];
  return (
    <>
      <div className="wg-page-heading">
        <div>
          <p className="wg-eyebrow">Community operations</p>
          <h2>Every report. A clearer next step.</h2>
          <p className="wg-muted">
            Review the evidence, plan the work and follow your crews.
          </p>
        </div>
        <button
          className="wg-button wg-secondary"
          disabled={busy}
          onClick={() => void load()}
        >
          Refresh overview
        </button>
      </div>
      <div className="wg-actions" style={{ marginBottom: 20 }}>
        <Chip tone={includeIllustrative ? "amber" : "green"}>
          {includeIllustrative ? "Real + illustrative records" : "Real records"}
        </Chip>
        <label className="wg-small">
          <input
            type="checkbox"
            checked={includeIllustrative}
            onChange={(event) =>
              setParams(event.target.checked ? { illustrative: "true" } : {})
            }
          />
          Include illustrative demo data
        </label>
        <span className="wg-muted wg-small">
          Refreshes every 15 seconds while this page is visible.
        </span>
      </div>
      {error && (
        <Alert>
          {error}{" "}
          <button
            className="wg-button wg-secondary"
            onClick={() => void load()}
          >
            Retry overview
          </button>
        </Alert>
      )}
      {!overview && busy ? (
        <LoadingState label="Loading overview…" />
      ) : (
        <div className="wg-metrics">
          {metrics.map(([label, value, href, explanation]) => (
            <section className="wg-card wg-metric" key={label}>
              <p className="wg-metric-label">{label}</p>
              <p className="wg-metric-value">{value ?? "—"}</p>
              <p className="wg-muted wg-small">{explanation}</p>
              <Link
                className="wg-metric-link"
                to={`${href}${includeIllustrative ? `${href.includes("?") ? "&" : "?"}illustrative=true` : ""}`}
              >
                View details ↗
              </Link>
            </section>
          ))}
        </div>
      )}
      {overview && (
        <div className="wg-grid wg-two">
          <section className="wg-card wg-stack">
            <div className="wg-section-heading">
              <div>
                <p className="wg-eyebrow">Automatic assessment</p>
                <h3>Supervised session</h3>
              </div>
              <Chip tone={processing?.worker_online ? "green" : "amber"}>
                {processing?.worker_online
                  ? "Worker online"
                  : "Worker offline / stale"}
              </Chip>
            </div>
            <div className="wg-info-panel">
              <strong>
                {overview.counts.awaiting_assessment} reports awaiting
                assessment
              </strong>
              <p className="wg-muted wg-small">
                Backlog and worker availability are separate. Only reports
                admitted to the scoped session can be processed.
              </p>
              <Link
                to={`/admin/reports?view=awaiting_assessment${includeIllustrative ? "&illustrative=true" : ""}`}
              >
                Inspect assessment backlog ↗
              </Link>
            </div>
            {processing && (
              <div className="wg-facts">
                <FieldValue label="Session status" value={processing.status} />
                <FieldValue label="Session reason" value={processing.reason} />
                <FieldValue
                  label="Image attempts"
                  value={`${processing.used_attempts} / ${processing.max_attempts}`}
                />
                <FieldValue
                  label="New reports admitted"
                  value={`${processing.new_reports_admitted} / ${processing.max_new_reports}`}
                />
                <FieldValue label="Model route" value={processing.model} />
                <FieldValue
                  label="Last heartbeat"
                  value={
                    processing.last_heartbeat_at
                      ? formatDate(processing.last_heartbeat_at)
                      : null
                  }
                />
                <FieldValue
                  label="Processing window ends"
                  value={
                    processing.expires_at
                      ? formatDate(processing.expires_at)
                      : null
                  }
                />
                <FieldValue
                  label="Last observed assessment success"
                  value={
                    processing.last_success_at
                      ? formatDate(processing.last_success_at)
                      : null
                  }
                />
                <p className="wg-muted wg-small">
                  New-report slots are project-wide. Session controls run
                  through the operator CLI; this console never starts workers.
                </p>
              </div>
            )}
          </section>
          <section className="wg-card wg-stack">
            <div>
              <p className="wg-eyebrow">Connected services</p>
              <h3>Configuration and observed activity</h3>
            </div>
            {configuration && (
              <div className="wg-facts">
                <FieldValue
                  label="API revision"
                  value={configuration.revision}
                />
                <FieldValue
                  label="Organiser routing"
                  value={
                    configuration.organizer_routing_enabled
                      ? "Enabled"
                      : "Disabled"
                  }
                />
                <FieldValue
                  label="Road service configuration"
                  value={
                    configuration.road_service_configured
                      ? "Configured"
                      : "Missing"
                  }
                />
                <FieldValue
                  label="Messaging pilot"
                  value={
                    configuration.messaging_pilot_enabled
                      ? "Enabled"
                      : "Disabled"
                  }
                />
              </div>
            )}
            <p className="wg-muted wg-small">
              A configured road service or healthy API does not confirm a
              successful provider request. Assessment success and worker
              heartbeat appear separately.
            </p>
            <div className="wg-info-panel">
              <strong>People approve the work</strong>
              <p className="wg-muted wg-small">
                Chalk assesses photos. Backend rules set priority and review
                requirements. OSRM road estimates feed deterministic
                optimisation. Dispatch always needs an organiser's confirmation.
              </p>
              <Link className="wg-button" to="/admin/dispatch">
                Open routing workspace
              </Link>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
