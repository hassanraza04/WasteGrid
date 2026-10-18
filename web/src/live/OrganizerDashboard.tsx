import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, Navigate, NavLink, Route, Routes, useLocation } from "react-router-dom";

import { AccessError, type OrganizerApi } from "./organizerApi";
import { OrganizerReportDetails } from "./OrganizerReportDetails";
import { OrganizerDispatchWorkspace } from "./OrganizerDispatchWorkspace";
import { OrganizerReportList } from "./OrganizerReportList";
import { OrganizerOverview } from "./OrganizerOverview";
import "./organizer.css";

export function OrganizerDashboard({ api }: { api: OrganizerApi }) {
  const location = useLocation();
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
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, []);

  function current(request: number) {
    return mounted.current && request === generation.current;
  }

  async function login(event: FormEvent) {
    event.preventDefault();
    if (authPending.current) return;
    authPending.current = true;
    const request = ++generation.current;
    setBusy(true);
    setError("");
    try {
      await api.signIn(email.trim(), password);
      if (current(request)) {
        setPassword("");
        setSignedIn(true);
      }
    } catch (caught) {
      if (current(request)) setError((caught as Error).message);
    } finally {
      if (current(request)) {
        authPending.current = false;
        setBusy(false);
      }
    }
  }

  async function logout(message = "") {
    const request = ++generation.current;
    authPending.current = true;
    setSignedIn(false);
    setError(message);
    setBusy(true);
    setPassword("");
    try {
      await api.signOut();
    } catch {
      if (current(request))
        setError("Unable to finish signing out. Please try signing in again.");
    } finally {
      if (current(request)) {
        authPending.current = false;
        setBusy(false);
      }
    }
  }

  // A callback retained by an older report cannot end a newer login session.
  const session = generation.current;
  function sessionExpired(caught: AccessError) {
    if (current(session)) void logout(caught.message);
  }

  if (!signedIn)
    return (
      <main className="wg-app wg-login">
        <section className="wg-card wg-login-card">
          <Brand />
          <div className="wg-login-copy">
            <p className="wg-eyebrow">Community operations</p>
            <h1>Organiser sign in</h1>
            <p>
              Review reports, coordinate crews and follow each cleanup from
              evidence to completion.
            </p>
          </div>
          <form onSubmit={login}>
            <label>
              Email
              <input
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>
            <label>
              Password
              <input
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            <button className="wg-button" disabled={busy}>
              Sign in
            </button>
          </form>
          {error && (
            <p className="wg-alert" role="alert">
              {error}
            </p>
          )}
          <p className="wg-muted wg-small">
            Staff access only. Resident reports remain private.
          </p>
        </section>
      </main>
    );

  const page = location.pathname.includes("/dispatch")
    ? "Routing"
    : location.pathname.includes("/reports/")
      ? "Report details"
      : location.pathname.includes("/reports")
        ? "Reports"
        : "Overview";
  return (
    <div className="wg-app wg-shell">
      <a className="wg-skip" href="#organizer-content">
        Skip to content
      </a>
      <aside className="wg-sidebar">
        <Brand />
        <nav className="wg-navigation" aria-label="Organiser navigation">
          <NavLink to="/admin" end>
            <span className="wg-nav-icon" aria-hidden="true">
              ▦
            </span>
            Overview
          </NavLink>
          <NavLink to="/admin/reports">
            <span className="wg-nav-icon" aria-hidden="true">
              ▤
            </span>
            Reports
          </NavLink>
          <NavLink to="/admin/dispatch" aria-label="Routing dispatch">
            <span className="wg-nav-icon" aria-hidden="true">
              ↗
            </span>
            Routing
          </NavLink>
        </nav>
        <p className="wg-sidebar-note">
          Cleaner streets.
          <br />
          Stronger communities.
          <br />
          <strong>Supervised hackathon prototype</strong>
        </p>
      </aside>
      <div className="wg-main">
        <header className="wg-topbar">
          <nav className="wg-breadcrumbs" aria-label="Breadcrumb">
            <Link to="/admin">Organiser dashboard</Link>
            <span aria-hidden="true">/</span>
            <span>{page}</span>
          </nav>
          <div className="wg-topbar-account">
            <div className="wg-topbar-environment">
              <span className="wg-chip wg-green">Authenticated API</span>
              {api.environment && (
                <small>{new URL(api.environment).host}</small>
              )}
            </div>
            <div className="wg-account">
              <strong>Organiser account</strong>
              {email}
            </div>
            <button
              className="wg-button wg-secondary"
              onClick={() => void logout()}
            >
              Sign out
            </button>
          </div>
        </header>
        <main id="organizer-content" className="wg-page" tabIndex={-1}>
          <h1 className="wg-visually-hidden">Organiser dashboard</h1>
          <Routes>
            <Route path="sign-in" element={<Navigate to="/admin" replace />} />
            <Route
              index
              element={
                <OrganizerOverview
                  api={api}
                  onSessionExpired={sessionExpired}
                />
              }
            />
            <Route
              path="reports"
              element={
                <OrganizerReportList
                  api={api}
                  onSessionExpired={sessionExpired}
                />
              }
            />
            <Route
              path="reports/:reportId"
              element={
                <OrganizerReportDetails
                  api={api}
                  onSessionExpired={sessionExpired}
                />
              }
            />
            <Route
              path="dispatch"
              element={
                <OrganizerDispatchWorkspace
                  api={api}
                  onSessionExpired={sessionExpired}
                />
              }
            />
            <Route
              path="*"
              element={
                <section className="wg-card">
                  <h2>Page not found</h2>
                  <p>
                    <Link to="/admin">Return to overview</Link>
                  </p>
                </section>
              }
            />
          </Routes>
        </main>
      </div>
    </div>
  );
}

function Brand() {
  return (
    <Link to="/admin" className="wg-brand" aria-label="WasteGrid overview">
      <img src="/brand/wastegrid-logo.png" alt="" />
    </Link>
  );
}
