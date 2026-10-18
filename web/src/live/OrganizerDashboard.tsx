import { useEffect, useRef, useState, type FormEvent } from "react";
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
  const generation = useRef(0);
  const authPending = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current++; };
  }, []);

  function current(request: number) {
    return mounted.current && request === generation.current;
  }

  async function login(event: FormEvent) {
    event.preventDefault();
    if (authPending.current) return;
    authPending.current = true;
    const request = ++generation.current;
    setBusy(true); setError("");
    try {
      await api.signIn(email.trim(), password);
      if (current(request)) { setPassword(""); setSignedIn(true); }
    } catch (caught) {
      if (current(request)) setError((caught as Error).message);
    } finally {
      if (current(request)) { authPending.current = false; setBusy(false); }
    }
  }

  async function logout(message = "") {
    const request = ++generation.current;
    authPending.current = true;
    setSignedIn(false); setError(message); setBusy(true); setPassword("");
    try {
      await api.signOut();
    } catch {
      if (current(request)) setError("Unable to finish signing out. Please try signing in again.");
    } finally {
      if (current(request)) { authPending.current = false; setBusy(false); }
    }
  }

  // A callback retained by an older report cannot end a newer login session.
  const session = generation.current;
  function sessionExpired(caught: AccessError) {
    if (current(session)) void logout(caught.message);
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
