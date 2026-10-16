import { Route, Routes } from "react-router-dom";

import { CreateReportPage } from "../customer/CreateReportPage";
import { CustomerHomePage } from "../customer/CustomerHomePage";
import { ReportDetailPage } from "../customer/ReportDetailPage";
import { TrackReportPage } from "../customer/TrackReportPage";
import { BrowserReportRepository } from "../data/browserReportRepository";
import type { ReportRepository } from "../data/reportRepository";

const defaultRepository = new BrowserReportRepository(window.localStorage);

interface AppProperties {
  repository?: ReportRepository;
}

export function App({ repository = defaultRepository }: AppProperties) {
  return (
    <Routes>
      <Route path="/" element={<CustomerHomePage repository={repository} />} />
      <Route path="/report/new" element={<CreateReportPage repository={repository} />} />
      <Route path="/report/track" element={<TrackReportPage />} />
      <Route
        path="/report/:reference"
        element={<ReportDetailPage repository={repository} />}
      />
    </Routes>
  );
}
