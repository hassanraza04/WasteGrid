import { useState } from "react";
import { Link, Route, Routes } from "react-router-dom";
import { ReportErrorBoundary } from "../app/ReportErrorBoundary";
import { CreateReportPage } from "../customer/CreateReportPage";
import { CustomerHomePage } from "../customer/CustomerHomePage";
import { ReportDetailPage } from "../customer/ReportDetailPage";
import { TrackReportPage } from "../customer/TrackReportPage";
import { BrowserReportRepository } from "../data/browserReportRepository";
import type { ReportRepository } from "../data/reportRepository";
import { createOrganizerApi, type OrganizerApi } from "./organizerApi";
import { OrganizerDashboard } from "./OrganizerDashboard";

function OrganizerConfigurationPage({ message }: { message: string }) {
  return <main><h1>Organiser sign in</h1><p role="alert">{message}</p></main>;
}

export function LiveApp({ api: suppliedApi, repository }: { api?: OrganizerApi; repository?: ReportRepository }) {
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
    <Route path="/" element={<CustomerHomeRoute repository={repository} />} />
    <Route path="/report/new" element={<CreateReportRoute repository={repository} />} />
    <Route path="/report/track" element={<TrackReportPage />} />
    <Route path="/report/:reference" element={<ReportDetailRoute repository={repository} />} />
    <Route path="/admin/*" element={dashboard.api ? <OrganizerDashboard api={dashboard.api} /> : <OrganizerConfigurationPage message={dashboard.configurationError} />} />
    <Route path="*" element={<main><h1>Page not found</h1><Link to="/">Home</Link></main>} />
  </Routes></ReportErrorBoundary>;
}

function useCustomerRepository(repository?: ReportRepository) {
  const [resolved] = useState<ReportRepository>(() => repository ?? new BrowserReportRepository(window.localStorage));
  return resolved;
}

function CustomerHomeRoute({ repository }: { repository?: ReportRepository }) {
  return <CustomerHomePage repository={useCustomerRepository(repository)} />;
}

function CreateReportRoute({ repository }: { repository?: ReportRepository }) {
  return <CreateReportPage repository={useCustomerRepository(repository)} />;
}

function ReportDetailRoute({ repository }: { repository?: ReportRepository }) {
  return <ReportDetailPage repository={useCustomerRepository(repository)} />;
}
