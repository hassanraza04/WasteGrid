import { useEffect } from "react";
import { Link, useParams } from "react-router-dom";

import type { ReportRepository } from "../data/reportRepository";

interface ReportDetailPageProperties {
  repository: ReportRepository;
}

export function ReportDetailPage({ repository }: ReportDetailPageProperties) {
  const { reference = "" } = useParams();
  const report = repository.getByReference(reference);

  useEffect(() => {
    if (report) {
      repository.remember(report.reference);
    }
  }, [report, repository]);

  if (!report) {
    return (
      <main>
        <h1>Report not found</h1>
        <p>Check the report reference and try again.</p>
        <Link to="/report/track">Track a report</Link>
      </main>
    );
  }

  return (
    <main>
      <h1>Report {report.reference}</h1>
      <p>{report.title}</p>
      <p>Status: {report.status}</p>
      <p>Address: {report.location.address}</p>
      <section aria-labelledby="latest-update">
        <h2 id="latest-update">Latest update</h2>
        <p>{report.latestUpdate.message}</p>
      </section>
    </main>
  );
}
