import { useState } from "react";
import { Link, Navigate, Route, Routes } from "react-router-dom";
import { ReportErrorBoundary } from "../app/ReportErrorBoundary";
import { createOrganizerApi, type OrganizerApi } from "./organizerApi";
import { OrganizerDashboard } from "./OrganizerDashboard";

function OrganizerConfigurationPage({ message }: { message: string }) {
  return <main><h1>Organiser sign in</h1><p role="alert">{message}</p></main>;
}

function WelcomePage() {
  return (
    <main className="wg-app wg-login">
      <section className="wg-card wg-login-card wg-stack">
        <p className="wg-eyebrow">Community cleanup</p>
        <h1 className="wg-welcome-brand"><img src="/brand/wastegrid-logo.png" alt="WasteGrid" /></h1>
        <p>Report waste. Coordinate a crew. Follow the cleanup.</p>
        <div className="wg-info-panel wg-stack">
          <h2>Residents and crews</h2>
          <p>Use the WasteGrid Android app to submit a photo, follow your report, or complete an assigned cleanup.</p>
          <p className="wg-muted">For this supervised demo, ask the demo host for the installed Android app.</p>
        </div>
        <div className="wg-stack">
          <h2>Organisers</h2>
          <p>Sign in here to review submitted reports, coordinate routes, and see cleanup evidence.</p>
          <Link className="wg-button" to="/admin">Organiser sign in</Link>
        </div>
        <p className="wg-muted wg-small">Report submission and tracking are available in the Android app. Earlier browser-local prototype reports were never submitted to the shared service.</p>
      </section>
    </main>
  );
}

export function LiveApp({ api: suppliedApi }: { api?: OrganizerApi }) {
  const [dashboard] = useState(() => {
    if (suppliedApi) return { api: suppliedApi, configurationError: "" };
    try { return { api: createOrganizerApi(), configurationError: "" }; }
    catch (caught) {
      return {
        api: null,
        configurationError: caught instanceof Error
          ? caught.message
          : "Organiser sign-in has not been configured for this build.",
      };
    }
  });
  return <ReportErrorBoundary><Routes>
    <Route path="/" element={<WelcomePage />} />
    <Route path="/report/*" element={<Navigate to="/" replace />} />
    <Route path="/admin/*" element={dashboard.api ? <OrganizerDashboard api={dashboard.api} /> : <OrganizerConfigurationPage message={dashboard.configurationError} />} />
    <Route path="*" element={<main><h1>Page not found</h1><Link to="/">Home</Link></main>} />
  </Routes></ReportErrorBoundary>;
}
