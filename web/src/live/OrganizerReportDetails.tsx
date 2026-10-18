import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";

import {
  AccessError,
  type OrganizerApi,
  type OrganizerAssessment,
  type OrganizerEvent,
  type OrganizerLocation,
  type OrganizerReport,
  type OrganizerReportDetails as Details,
} from "./organizerApi";
import { OrganizerDecisionForm } from "./OrganizerDecisionForm";
import { OrganizerJobDetails } from "./OrganizerJobDetails";
import { OrganizerPhoto } from "./OrganizerPhoto";
import {
  Alert,
  Chip,
  FieldValue as Value,
  LoadingState,
  useForegroundRefresh,
} from "./OrganizerUI";

export function OrganizerReportDetails({
  api,
  onSessionExpired,
}: {
  api: OrganizerApi;
  onSessionExpired?: (error: AccessError) => void;
}) {
  const { reportId } = useParams();
  const [details, setDetails] = useState<Details | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const mounted = useRef(false);
  const currentRoute = useRef(reportId);
  currentRoute.current = reportId;
  const sessionVersion = api.sessionVersion;

  function isCurrent() {
    return (
      mounted.current &&
      currentRoute.current === reportId &&
      api.sessionVersion === sessionVersion
    );
  }

  function sessionExpired(caught: AccessError) {
    if (isCurrent()) onSessionExpired?.(caught);
  }

  async function load(
    preserveVisible = false,
  ): Promise<OrganizerReport | null> {
    // A completed mutation from a departed route must not invalidate the active route's request.
    if (!isCurrent()) return null;
    if (!reportId) {
      setError("A report reference is required.");
      setBusy(false);
      return null;
    }
    const request = ++generation.current;
    let loaded: OrganizerReport | null = null;
    if (!preserveVisible) {
      setDetails(null);
      setBusy(true);
    }
    setError("");
    try {
      const result = await api.report(reportId);
      if (isCurrent() && request === generation.current) {
        setDetails(result);
        loaded = result.report;
      }
    } catch (caught) {
      if (isCurrent() && request === generation.current) {
        const error = caught as Error;
        setError(error.message);
        if (error instanceof AccessError) sessionExpired(error);
      }
    } finally {
      if (isCurrent() && request === generation.current && !preserveVisible)
        setBusy(false);
    }
    return loaded;
  }

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, [api, reportId]);

  useForegroundRefresh(() => {
    void load(true);
  });

  if (busy) return <LoadingState label="Loading report…" />;
  if (error && !details)
    return (
      <section className="wg-card">
        <Alert>{error}</Alert>
        <button className="wg-button" onClick={() => void load()}>
          Retry
        </button>
        <p>
          <Link to="/admin/reports">Back to reports</Link>
        </p>
      </section>
    );
  if (!details) return null;
  const { report, events } = details;
  return (
    <article>
      <div className="wg-page-heading">
        <div>
          <p className="wg-eyebrow">
            {report.triage?.category ?? "Cleanup report"}
          </p>
          <h2>{report.public_reference}</h2>
          <p className="wg-muted">
            {report.address ?? "Location captured on map"}
          </p>
        </div>
        <div className="wg-actions">
          <Chip tone={report.needs_review ? "amber" : "green"}>
            {report.display_status}
          </Chip>
          {report.priority && (
            <Chip tone={report.priority === "high" ? "red" : "neutral"}>
              {report.priority} priority
            </Chip>
          )}
          <Link className="wg-button wg-secondary" to="/admin/reports">
            Back to reports
          </Link>
        </div>
      </div>
      {error && <Alert>{error}</Alert>}
      {report.illustrative && (
        <p className="wg-alert">
          Illustrative demo report. This record is shown separately from real
          submissions.
        </p>
      )}
      <div className="wg-detail-layout">
        <div className="wg-stack">
          <section className="wg-card">
            <div className="wg-section-heading">
              <h3>Resident evidence</h3>
              <Chip>Original submission</Chip>
            </div>
            <OrganizerPhoto
              key={report.photo_id}
              api={api}
              id={report.photo_id}
              width={640}
              onSessionExpired={sessionExpired}
            />
            <div className="wg-evidence-caption">
              <p className="wg-eyebrow">Original resident caption</p>
              <p>{report.title}</p>
              {report.note && report.note !== report.title && (
                <p>{report.note}</p>
              )}
            </div>
            <div className="wg-facts wg-columns">
              <Value label="Address" value={report.address} />
              <Location value={report.location} />
              <Value label="Created" value={formatDate(report.created_at)} />
              <Value label="Updated" value={formatDate(report.updated_at)} />
              <Value
                label="Resident fire"
                value={report.resident_answers.fire}
              />
              <Value
                label="Resident sharp objects"
                value={report.resident_answers.sharp_objects}
              />
            </div>
            <details style={{ marginTop: 20 }}>
              <summary>
                Resident clarifications ({report.clarifications.length})
              </summary>
              {report.clarifications.length ? (
                <ul className="wg-timeline" style={{ marginTop: 16 }}>
                  {report.clarifications.map((item) => (
                    <li key={`${item.created_at}-${item.note}`}>
                      <p>{item.note}</p>
                      <p>{formatDate(item.created_at)}</p>
                      {item.location && <Location value={item.location} />}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="wg-muted">No clarifications recorded.</p>
              )}
            </details>
          </section>
          {(report.completion_photo_ids.length > 0 || report.display_status === "completed") && (
            <section className="wg-card wg-stack" aria-label="Cleanup evidence">
              <div className="wg-section-heading">
                <h3>Cleanup evidence</h3>
                <Chip>{report.display_status === "completed" ? "Crew reported complete" : "Previous completion"}</Chip>
              </div>
              {report.completion_photo_ids.length > 0 ? (
                <>
                  <p className="wg-muted">Crew-submitted photos after cleanup. Compare with the original resident evidence above.</p>
                  {report.completion_photo_ids.map((photoId, index) => (
                    <OrganizerPhoto
                      key={photoId}
                      api={api}
                      id={photoId}
                      width={640}
                      alt={`Cleanup completion photo ${index + 1}`}
                      onSessionExpired={sessionExpired}
                    />
                  ))}
                </>
              ) : (
                <p>Completed without a photo. The crew reported cleanup complete; no completion photo was submitted.</p>
              )}
            </section>
          )}
          <section className="wg-card">
            <div className="wg-section-heading">
              <div>
                <p className="wg-eyebrow">Photo understanding</p>
                <h3>Chalk assessment</h3>
              </div>
              <Chip>{report.assessment_status}</Chip>
            </div>
            {report.assessment ? (
              <Assessment value={report.assessment} />
            ) : (
              <p className="wg-muted">No assessment has been recorded yet.</p>
            )}
            {details.processing && (
              <div className="wg-info-panel" style={{ marginTop: 20 }}>
                <h4>Processing activity</h4>
                {(["assessment", "triage"] as const).map((kind) => {
                  const task = details.processing?.[kind];
                  return (
                    <p className="wg-small" key={kind}>
                      {humanizeKey(kind)}:{" "}
                      {task
                        ? `${task.status} · ${task.attempts} attempt${task.attempts === 1 ? "" : "s"}${task.error_code ? ` · ${task.error_code}` : ""}`
                        : "Not queued"}
                    </p>
                  );
                })}
              </div>
            )}
          </section>
          <section className="wg-card">
            <h3>Current organiser triage</h3>
            {report.triage ? (
              <div className="wg-facts">
                <p className="wg-assessment-lead">
                  {report.triage.decision_summary}
                </p>
                <Value label="Category" value={report.triage.category} />
                <Value
                  label="Equipment"
                  value={report.triage.proposed_equipment.join(", ")}
                />
                <Value
                  label="Duplicate candidate"
                  value={report.triage.duplicate_candidate_id}
                />
                <Value
                  label="Duplicate confirmed"
                  value={report.triage.duplicate_confirmed}
                />
                <Value label="Hazard" value={report.triage.hazard} />
                <Value
                  label="Evidence sufficient"
                  value={report.triage.evidence_sufficient}
                />
                <Value
                  label="Missing information"
                  value={report.triage.missing_information.join(", ")}
                />
                <Value
                  label="Evidence report IDs"
                  value={report.triage.evidence_report_ids.join(", ")}
                />
                <Value label="Next action" value={report.triage.next_action} />
                <Value
                  label="Estimated service minutes"
                  value={report.triage.estimated_service_minutes}
                />
              </div>
            ) : (
              <p className="wg-muted">
                No organiser decision has been recorded yet.
              </p>
            )}
          </section>
          {report.job_id && (
            <OrganizerJobDetails
              key={report.job_id}
              api={api}
              id={report.job_id}
              onSessionExpired={sessionExpired}
            />
          )}
          <section className="wg-card">
            <div className="wg-section-heading">
              <h3>Activity</h3>
              <Chip>Audit trail</Chip>
            </div>
            {events.length ? (
              <ol className="wg-timeline">
                {events.map((event) => (
                  <li key={event.id}>
                    <strong>{event.kind}</strong>
                    <p>
                      {formatDate(event.created_at)} · {event.actor}
                    </p>
                    {safeEventDetails(event).map(([key, value]) => (
                      <p key={key}>
                        {humanizeKey(key)}: {String(value)}
                      </p>
                    ))}
                  </li>
                ))}
              </ol>
            ) : (
              <p className="wg-muted">No activity recorded.</p>
            )}
          </section>
        </div>
        <aside className="wg-stack">
          <section className="wg-card">
            <div className="wg-section-heading">
              <h3>Review & priority</h3>
              <Chip tone={report.needs_review ? "amber" : "green"}>
                {report.needs_review
                  ? "Human decision needed"
                  : "Review recorded"}
              </Chip>
            </div>
            {report.needs_review && (
              <div className="wg-review-panel">
                <strong>Review hold remains active</strong>
                <p className="wg-small">
                  Inspect the original evidence and assessment before choosing
                  an action. A saved decision follows server triage rules and
                  may leave this hold in place.
                </p>
              </div>
            )}
            <div className="wg-facts">
              <Value label="Priority" value={report.priority} />
              <Value label="Priority reason" value={report.priority_reason} />
              <Value label="Review required" value={report.needs_review} />
              <Value label="State" value={report.state} />
              <Value label="Linked job ID" value={report.job_id} />
              <Value label="Report version" value={report.version} />
              <Value label="Report ID" value={report.id} />
            </div>
          </section>
          <section className="wg-card">
            <div className="wg-section-heading">
              <div>
                <p className="wg-eyebrow">Your next action</p>
                <h3>Organiser decision</h3>
              </div>
            </div>
            <OrganizerDecisionForm
              key={report.id}
              report={report}
              api={api}
              onReportUpdated={(updated) => {
                if (!isCurrent() || updated.id !== reportId) return;
                setDetails((current) =>
                  current ? { ...current, report: updated } : current,
                );
                void load(true);
              }}
              onReload={() => load(true)}
              onSessionExpired={sessionExpired}
            />
          </section>
        </aside>
      </div>
    </article>
  );
}

function Assessment({ value }: { value: OrganizerAssessment }) {
  return (
    <>
      <p className="wg-assessment-lead">{value.description}</p>
      <div className="wg-info-panel">
        <strong>Assessment reasoning</strong>
        <p>{value.reason}</p>
        {value.comparison_reason && <p>{value.comparison_reason}</p>}
      </div>
      <div className="wg-facts wg-columns">
        <Value label="Estimated size" value={value.size} />
        <Value label="Obstruction" value={value.obstruction} />
        <Value label="Obstruction level" value={value.obstruction_level} />
        <Value
          label="Forces people into traffic"
          value={value.forces_people_into_traffic}
        />
        <Value label="Special handling" value={value.special_handling} />
        <Value label="Visible fire" value={value.visible_fire} />
        <Value
          label="Visible sharp objects"
          value={value.visible_sharp_objects}
        />
        <Value
          label="Resident context agreement"
          value={value.resident_context_agreement}
        />
        <Value label="Model-reported confidence" value={value.confidence} />
      </div>
      <p className="wg-muted wg-small" style={{ marginTop: 12 }}>
        Model observations support review; confidence is not an independent
        verification.
      </p>
    </>
  );
}

function Location({ value }: { value: OrganizerLocation | null }) {
  return value ? (
    <>
      <Value label="Latitude" value={value.latitude} />
      <Value label="Longitude" value={value.longitude} />
      <Value label="Landmark" value={value.landmark} />
    </>
  ) : (
    <p>Coordinates not recorded.</p>
  );
}

function humanizeKey(value: string) {
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}
function formatDate(value: string) {
  return new Date(value).toLocaleString();
}
function safeEventDetails(event: OrganizerEvent) {
  const allowed = new Set([
    "assessment_status",
    "priority",
    "previous_priority",
    "report_state",
    "job_status",
    "state",
    "category",
    "next_action",
    "estimated_service_minutes",
    "duplicate_confirmed",
    "hazard",
    "evidence_sufficient",
  ]);
  const entries = Object.entries(event.details).filter(
    ([key, value]) =>
      allowed.has(key) &&
      ["string", "number", "boolean"].includes(typeof value),
  );
  if (
    event.kind === "report.priority_set" &&
    typeof event.details.reason === "string"
  )
    entries.push(["reason", event.details.reason]);
  if (event.kind === "report.triaged") {
    const decision = event.details.decision;
    if (
      decision &&
      typeof decision === "object" &&
      "decision_summary" in decision &&
      typeof decision.decision_summary === "string"
    )
      entries.push(["decision_summary", decision.decision_summary]);
    if (typeof event.details.applied_state === "string")
      entries.push(["applied_state", event.details.applied_state]);
  }
  return entries;
}
