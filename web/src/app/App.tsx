import { Route, Routes } from "react-router-dom";

import { AdminDashboardPage } from "../admin/AdminDashboardPage";
import { AdminSignInPage } from "../admin/AdminSignInPage";
import { RequireAdmin } from "../admin/RequireAdmin";
import { BrowserAdminSession } from "../auth/browserAdminSession";
import type { AdminSession } from "../auth/adminSession";
import { CreateReportPage } from "../customer/CreateReportPage";
import { CustomerHomePage } from "../customer/CustomerHomePage";
import { ReportDetailPage } from "../customer/ReportDetailPage";
import { TrackReportPage } from "../customer/TrackReportPage";
import { BrowserReportRepository } from "../data/browserReportRepository";
import type { ReportRepository } from "../data/reportRepository";
import { ReportErrorBoundary } from "./ReportErrorBoundary";

const defaultRepository = new BrowserReportRepository(window.localStorage);
const defaultAdminSession = new BrowserAdminSession(window.localStorage);

interface AppProperties {
  repository?: ReportRepository;
  adminSession?: AdminSession;
}

export function App({
  repository = defaultRepository,
  adminSession = defaultAdminSession,
}: AppProperties) {
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
        <Route
          path="/admin"
          element={
            <RequireAdmin session={adminSession}>
              <AdminDashboardPage repository={repository} session={adminSession} />
            </RequireAdmin>
          }
        />
        <Route path="/admin/sign-in" element={<AdminSignInPage session={adminSession} />} />
      </Routes>
    </ReportErrorBoundary>
  );
}
