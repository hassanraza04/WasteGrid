import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { AccessError, type OrganizerApi, type OrganizerAssessment, type OrganizerReport, type OrganizerReportDetails as Details } from "./organizerApi";
import { OrganizerDecisionForm } from "./OrganizerDecisionForm";

export function OrganizerReportDetails({ api, onSessionExpired }: { api: OrganizerApi; onSessionExpired?: (error: AccessError) => void }) {
  const { reportId } = useParams();
  const [details, setDetails] = useState<Details | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const [photoUrl, setPhotoUrl] = useState("");
  const [photoError, setPhotoError] = useState("");
  const [photoBusy, setPhotoBusy] = useState(false);

  async function load() {
    if (!reportId) { setError("A report reference is required."); setBusy(false); return; }
    const request = ++generation.current;
    setBusy(true); setError("");
    try {
      const result = await api.report(reportId);
      if (request === generation.current) setDetails(result);
    } catch (caught) {
      if (request === generation.current) {
        const error = caught as Error;
        setError(error.message);
        if (error instanceof AccessError) onSessionExpired?.(error);
      }
    } finally {
      if (request === generation.current) setBusy(false);
    }
  }

  useEffect(() => { void load(); return () => { generation.current++; }; }, [reportId]);

  async function loadPhoto() {
    if (!details) return;
    setPhotoBusy(true); setPhotoError("");
    try { setPhotoUrl(await api.photo(details.report.photo_id)); }
    catch { setPhotoError("Photo unavailable. Try loading it again."); }
    finally { setPhotoBusy(false); }
  }

  if (busy) return <p role="status">Loading report…</p>;
  if (error) return <section><p role="alert">{error}</p><button onClick={() => void load()}>Retry</button><p><Link to="/admin">Back to reports</Link></p></section>;
  if (!details) return null;
  const { report, events } = details;
  return <article>
    <p><Link to="/admin">Back to reports</Link></p>
    <h2>{report.public_reference}</h2>
    <section><h3>Report overview</h3><Value label="Title" value={report.title} /><Value label="Address" value={report.address} /><Value label="State" value={report.state} /><Value label="Display status" value={report.display_status} /><Value label="Assessment status" value={report.assessment_status} /><Value label="Report version" value={report.version} /><Value label="Priority" value={report.priority} /><Value label="Priority reason" value={report.priority_reason} />{report.illustrative && <p>Illustrative demo report</p>}</section>
    <section><h3>Resident report</h3><Value label="Note" value={report.note} /><Value label="Resident fire" value={report.resident_answers.fire} /><Value label="Resident sharp objects" value={report.resident_answers.sharp_objects} /><h4>Clarifications</h4>{report.clarifications.length ? <ul>{report.clarifications.map(item => <li key={`${item.created_at}-${item.note}`}>{item.note} ({formatDate(item.created_at)})</li>)}</ul> : <p>No clarifications recorded.</p>}<button disabled={photoBusy} onClick={() => void loadPhoto()}>Load photo</button>{photoUrl && <img src={photoUrl} alt="Reported waste" width={320} onError={() => { setPhotoUrl(""); setPhotoError("Photo link expired. Load it again."); }} />}{photoError && <p role="alert">{photoError}</p>}</section>
    <section><h3>Chalk assessment</h3>{report.assessment ? <Assessment value={report.assessment} /> : <p>No assessment has been recorded yet.</p>}</section>
    <section><h3>Current organiser triage</h3>{report.triage ? <><Value label="Category" value={report.triage.category} /><Value label="Equipment" value={report.triage.proposed_equipment.join(", ")} /><Value label="Duplicate candidate" value={report.triage.duplicate_candidate_id} /><Value label="Duplicate confirmed" value={report.triage.duplicate_confirmed} /><Value label="Hazard" value={report.triage.hazard} /><Value label="Evidence sufficient" value={report.triage.evidence_sufficient} /><Value label="Missing information" value={report.triage.missing_information.join(", ")} /><Value label="Evidence report IDs" value={report.triage.evidence_report_ids.join(", ")} /><Value label="Decision summary" value={report.triage.decision_summary} /><Value label="Next action" value={report.triage.next_action} /><Value label="Estimated service minutes" value={report.triage.estimated_service_minutes} /></> : <p>No organiser decision has been recorded yet.</p>}</section>
    <section><h3>Activity</h3>{events.length ? <ul>{events.map(event => <li key={event.id}><strong>{event.kind}</strong><p>{formatDate(event.created_at)} · {event.actor}</p>{Object.entries(event.details).filter(([, value]) => ["string", "number", "boolean"].includes(typeof value)).map(([key, value]) => <p key={key}>{humanizeKey(key)}: {String(value)}</p>)}</li>)}</ul> : <p>No activity recorded.</p>}</section>
    <section><h3>Organiser decision</h3><OrganizerDecisionForm report={report} api={api} onReportUpdated={updated => { setDetails(current => current ? { ...current, report: updated } : current); void load(); }} onReload={() => void load()} /></section>
  </article>;
}

function Assessment({ value }: { value: OrganizerAssessment }) {
  return <>{Object.entries(value).map(([key, field]) => <Value key={key} label={humanizeKey(key)} value={field} />)}</>;
}

function Value({ label, value }: { label: string; value: string | number | boolean | null }) {
  return <p><strong>{label}:</strong> {value === null || value === "" ? "Not recorded" : String(value)}</p>;
}

function humanizeKey(value: string) { return value.replaceAll("_", " ").replace(/\b\w/g, letter => letter.toUpperCase()); }
function formatDate(value: string) { return new Date(value).toLocaleString(); }
