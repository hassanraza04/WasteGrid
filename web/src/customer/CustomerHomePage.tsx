import { Link, Navigate } from "react-router-dom";

import type { ReportRepository } from "../data/reportRepository";

interface CustomerHomePageProperties {
  repository: ReportRepository;
}

export function CustomerHomePage({ repository }: CustomerHomePageProperties) {
  const rememberedReference = repository.getRememberedReference();
  if (rememberedReference && repository.getByReference(rememberedReference)) {
    return <Navigate to={`/report/${rememberedReference}`} replace />;
  }

  return (
    <main>
      <h1>WasteGrid</h1>
      <p>Report a waste issue or follow the progress of an existing report.</p>
      <nav aria-label="Customer actions">
        <Link to="/report/new">Create a report</Link>
        <Link to="/report/track">Track a report</Link>
        <Link to="/admin">Organiser sign in</Link>
      </nav>
    </main>
  );
}
