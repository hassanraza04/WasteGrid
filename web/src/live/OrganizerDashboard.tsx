import { useState, type FormEvent } from "react";
import { Route, Routes } from "react-router-dom";

import { AccessError, type OrganizerApi } from "./organizerApi";
import { OrganizerReportDetails } from "./OrganizerReportDetails";
import { OrganizerReportList } from "./OrganizerReportList";

export function OrganizerDashboard({ api }: { api: OrganizerApi }) {
  const [signedIn, setSignedIn] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function login(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      await api.signIn(email.trim(), password);
      setPassword(""); setSignedIn(true);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    setSignedIn(false); setError(""); setBusy(false);
    await api.signOut();
  }

  function sessionExpired(caught: AccessError) {
    setSignedIn(false); setError(caught.message); setBusy(false);
    void api.signOut();
  }

  if (!signedIn) return <main>
    <h1>Organiser sign in</h1>
    <form onSubmit={login}>
      <label>Email<input type="email" autoComplete="username" required value={email} onChange={event => setEmail(event.target.value)} /></label>
      <label>Password<input type="password" autoComplete="current-password" required value={password} onChange={event => setPassword(event.target.value)} /></label>
      <button disabled={busy}>Sign in</button>
    </form>
    {error && <p role="alert">{error}</p>}
  </main>;

  return <main>
    <h1>Organiser dashboard</h1>
    <button onClick={() => void logout()}>Sign out</button>
    {error && <p role="alert">{error}</p>}
    <Routes>
      <Route index element={<OrganizerReportList api={api} onSessionExpired={sessionExpired} />} />
      <Route path="reports/:reportId" element={<OrganizerReportDetails api={api} onSessionExpired={sessionExpired} />} />
    </Routes>
  </main>;
}
