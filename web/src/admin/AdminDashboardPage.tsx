import { useNavigate } from "react-router-dom";

import type { AdminSession } from "../auth/adminSession";
import type { ReportRepository } from "../data/reportRepository";

interface AdminDashboardPageProperties {
  repository: ReportRepository;
  session: AdminSession;
}

export function AdminDashboardPage({ repository, session }: AdminDashboardPageProperties) {
  const navigate = useNavigate();
  const reports = repository.list();

  function signOut(): void {
    session.signOut();
    navigate("/admin/sign-in");
  }

  return (
    <main>
      <h1>Organizer dashboard</h1>
      <button type="button" onClick={signOut}>
        Sign out
      </button>
      <ul aria-label="Reports">
        {reports.map((report) => (
          <li key={report.reference}>{report.reference}</li>
        ))}
      </ul>
    </main>
  );
}
