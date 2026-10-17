import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import type { OrganizerSession } from "../auth/organizerSession";
import {
  type OrganizerApi,
  OrganizerApiError,
  type OrganizerReport,
} from "../data/organizerApi";

interface AdminDashboardPageProperties {
  session: OrganizerSession;
  api: OrganizerApi;
}

export function AdminDashboardPage({ session, api }: AdminDashboardPageProperties) {
  const navigate = useNavigate();
  const [reports, setReports] = useState<OrganizerReport[]>();
  const [error, setError] = useState<string>();

  const loadReports = useCallback(async (): Promise<void> => {
    setReports(undefined);
    setError(undefined);

    try {
      const accessToken = await session.getAccessToken();
      if (!accessToken) {
        await session.signOut();
        navigate("/admin/sign-in");
        return;
      }
      setReports(await api.listReports(accessToken));
    } catch (caught) {
      if (caught instanceof OrganizerApiError && caught.kind === "unauthorized") {
        await session.signOut();
        navigate("/admin/sign-in");
        return;
      }
      setError("Reports could not be loaded.");
    }
  }, [api, navigate, session]);

  useEffect(() => {
    void loadReports();
  }, [loadReports]);

  async function signOut(): Promise<void> {
    await session.signOut();
    navigate("/admin/sign-in");
  }

  return (
    <main>
      <h1>Organizer dashboard</h1>
      <button type="button" onClick={() => void signOut()}>
        Sign out
      </button>
      {error ? (
        <>
          <p role="alert">{error}</p>
          <button type="button" onClick={() => void loadReports()}>
            Retry
          </button>
        </>
      ) : reports ? (
        <ul aria-label="Reports">
          {reports.map((report) => (
            <li key={report.id}>
              <span>{report.publicReference}</span>: <span>{report.title}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p>Loading reports…</p>
      )}
    </main>
  );
}
