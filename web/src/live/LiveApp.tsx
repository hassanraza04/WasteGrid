import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, Route, Routes } from "react-router-dom";
import { ReportErrorBoundary } from "../app/ReportErrorBoundary";
import { CreateReportPage } from "../customer/CreateReportPage";
import { CustomerHomePage } from "../customer/CustomerHomePage";
import { ReportDetailPage } from "../customer/ReportDetailPage";
import { TrackReportPage } from "../customer/TrackReportPage";
import { BrowserReportRepository } from "../data/browserReportRepository";
import type { ReportRepository } from "../data/reportRepository";
import { AccessError, createOrganizerApi, type LiveReport, type OrganizerApi } from "./organizerApi";

const defaultRepository = new BrowserReportRepository(window.localStorage);

function OrganizerConfigurationPage() {
  return <main><h1>Organiser sign in</h1><p role="alert">Organiser sign-in has not been configured for this build.</p></main>;
}

export function LiveApp({ api: suppliedApi, repository = defaultRepository }: { api?: OrganizerApi; repository?: ReportRepository }) {
  const [api] = useState(() => {
    if (suppliedApi) return suppliedApi;
    try { return createOrganizerApi(); } catch { return null; }
  });
  return <ReportErrorBoundary><Routes>
    <Route path="/" element={<CustomerHomePage repository={repository} />} />
    <Route path="/report/new" element={<CreateReportPage repository={repository} />} />
    <Route path="/report/track" element={<TrackReportPage />} />
    <Route path="/report/:reference" element={<ReportDetailPage repository={repository} />} />
    <Route path="/admin/*" element={api ? <Dashboard api={api} /> : <OrganizerConfigurationPage />} />
    <Route path="*" element={<main><h1>Page not found</h1><Link to="/">Home</Link></main>} />
  </Routes></ReportErrorBoundary>;
}

function Dashboard({ api }: { api: OrganizerApi }) {
  const [signedIn, setSignedIn] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
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
        setError((caught as Error).message);
        if (caught instanceof AccessError) { setSignedIn(false); void api.signOut(); }
      }
    } finally { if (request === generation.current) setBusy(false); }
  }

  async function login(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      await api.signIn(email.trim(), password);
      setPassword(""); setSignedIn(true);
      await load(0);
    } catch (caught) { setError((caught as Error).message); }
    finally { setBusy(false); }
  }

  async function logout() {
    generation.current++; setReports([]); setSignedIn(false); setError(""); setBusy(false);
    await api.signOut();
  }

  if (!signedIn) return <main>
    <h1>Organiser sign in</h1>
    <form onSubmit={login}>
      <label>Email<input type="email" autoComplete="username" required value={email} onChange={e => setEmail(e.target.value)} /></label>
      <label>Password<input type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} /></label>
      <button disabled={busy}>Sign in</button>
    </form>
    {error && <p role="alert">{error}</p>}
  </main>;

  return <main>
    <h1>Organiser dashboard</h1>
    <button onClick={() => void logout()}>Sign out</button>
    <button disabled={busy} onClick={() => void load(0)}>Refresh reports</button>
    {busy && <p role="status">Loading reports…</p>}
    {error && <p role="alert">{error}</p>}
    {!busy && !error && !reports.length && <p>No reports on this page.</p>}
    <ul aria-label="Reports">{reports.map(report => <li key={report.id}>
      <h2>{report.title}</h2><p>{report.public_reference}</p>
      <p>Status: {report.display_status} · Assessment: {report.assessment_status}</p>
      <p>{report.address ?? "Address not supplied"}</p>
      {report.note && <p>{report.note}</p>}
      {report.illustrative && <p>Illustrative demo report</p>}
      <Photo api={api} id={report.photo_id} />
    </li>)}</ul>
    <button disabled={busy || offset === 0} onClick={() => void load(Math.max(0, offset - 50))}>Previous page</button>
    <button disabled={busy || reports.length < 50} onClick={() => void load(offset + 50)}>Next page</button>
  </main>;
}

function Photo({ api, id }: { api: OrganizerApi; id: string }) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function load() {
    setBusy(true); setError("");
    try { setUrl(await api.photo(id)); }
    catch { setError("Photo unavailable. Try loading it again."); }
    finally { setBusy(false); }
  }
  return <div>
    <button disabled={busy} onClick={() => void load()}>Load photo</button>
    {url && <img src={url} alt="Reported waste" width={240} onError={() => { setUrl(""); setError("Photo link expired. Load it again."); }} />}
    {error && <p role="alert">{error}</p>}
  </div>;
}
