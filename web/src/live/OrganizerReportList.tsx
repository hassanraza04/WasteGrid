import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { AccessError, type LiveReport, type OrganizerApi } from "./organizerApi";
import { OrganizerPhoto } from "./OrganizerPhoto";

export function OrganizerReportList({ api, onSessionExpired }: { api: OrganizerApi; onSessionExpired: (error: AccessError) => void }) {
  const [reports, setReports] = useState<LiveReport[]>([]);
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);

  async function load(page: number) {
    const request = ++generation.current;
    setBusy(true); setError(""); setReports([]);
    try {
      const result = await api.reports(page);
      if (request === generation.current) { setReports(result); setOffset(page); }
    } catch (caught) {
      if (request === generation.current) {
        const error = caught as Error;
        setError(error.message);
        if (error instanceof AccessError) onSessionExpired(error);
      }
    } finally {
      if (request === generation.current) setBusy(false);
    }
  }

  useEffect(() => { void load(0); }, []);

  return <>
    <button disabled={busy} onClick={() => void load(0)}>Refresh reports</button>
    {busy && <p role="status">Loading reports…</p>}
    {error && <p role="alert">{error}</p>}
    {!busy && !error && !reports.length && <p>No reports on this page.</p>}
    <ul aria-label="Reports">{reports.map(report => <li key={report.id}>
      <h2>{report.title}</h2>
      <p><Link to={`reports/${report.id}`}>{report.public_reference}</Link></p>
      <p>Status: {report.display_status} · Assessment: {report.assessment_status}</p>
      <p>{report.address ?? "Address not supplied"}</p>
      {report.note && <p>{report.note}</p>}
      {report.illustrative && <p>Illustrative demo report</p>}
      <OrganizerPhoto api={api} id={report.photo_id} width={240} onSessionExpired={onSessionExpired} />
    </li>)}</ul>
    <button disabled={busy || offset === 0} onClick={() => void load(Math.max(0, offset - 50))}>Previous page</button>
    <button disabled={busy || reports.length < 50} onClick={() => void load(offset + 50)}>Next page</button>
  </>;
}
