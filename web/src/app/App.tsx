import { Route, Routes } from "react-router-dom";

import { AdminDashboardPage } from "../admin/AdminDashboardPage";
import { AdminSignInPage } from "../admin/AdminSignInPage";
import { RequireAdmin } from "../admin/RequireAdmin";
import type { OrganizerSession } from "../auth/organizerSession";
import { CreateReportPage } from "../customer/CreateReportPage";
import { CustomerHomePage } from "../customer/CustomerHomePage";
import { ReportDetailPage } from "../customer/ReportDetailPage";
import { TrackReportPage } from "../customer/TrackReportPage";
import { BrowserReportRepository } from "../data/browserReportRepository";
import type { OrganizerApi } from "../data/organizerApi";
import type { ReportRepository } from "../data/reportRepository";
import { ReportErrorBoundary } from "./ReportErrorBoundary";

const defaultRepository = new BrowserReportRepository(window.localStorage);

interface OrganizerDependencies {
  session: OrganizerSession;
  api: OrganizerApi;
}

interface AppProperties {
  repository?: ReportRepository;
  organizer?: OrganizerDependencies;
  organizerConfigurationError?: string;
}

function OrganizerConfigurationPage({ message }: { message: string }) {
  return (
    <main>
      <h1>Organizer dashboard unavailable</h1>
      <p role="alert">{message}</p>
    </main>
  );
}

export function App({
  repository = defaultRepository,
  organizer,
  organizerConfigurationError,
}: AppProperties) {
  const adminRoutes = organizer ? (
    <>
      <Route
        path="/admin"
        element={
          <RequireAdmin api={organizer.api} session={organizer.session}>
            <AdminDashboardPage api={organizer.api} session={organizer.session} />
          </RequireAdmin>
        }
      />
      <Route path="/admin/sign-in" element={<AdminSignInPage session={organizer.session} />} />
    </>
  ) : organizerConfigurationError ? (
    <>
      <Route
        path="/admin"
        element={<OrganizerConfigurationPage message={organizerConfigurationError} />}
      />
      <Route
        path="/admin/sign-in"
        element={<OrganizerConfigurationPage message={organizerConfigurationError} />}
      />
    </>
  ) : null;

  return (
    <ReportErrorBoundary>
      <Routes>
        <Route path="/" element={<CustomerHomePage repository={repository} />} />
        <Route path="/report/new" element={<CreateReportPage repository={repository} />} />
        <Route path="/report/track" element={<TrackReportPage />} />
        <Route
          path="/report/:reference"
          element={<ReportDetailPage repository={repository} />}
        />
        {adminRoutes}
      </Routes>
    </ReportErrorBoundary>
  );
}
