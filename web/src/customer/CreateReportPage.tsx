import { FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";

import type { ReportRepository } from "../data/reportRepository";

interface CreateReportPageProperties {
  repository: ReportRepository;
}

export function CreateReportPage({ repository }: CreateReportPageProperties) {
  const navigate = useNavigate();
  const [title, setTitle] = useState("");
  const [address, setAddress] = useState("");
  const [error, setError] = useState<string>();

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    try {
      const report = repository.create({ title, address });
      navigate(`/report/${report.reference}`);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Unable to create report");
    }
  }

  return (
    <main>
      <h1>Create a report</h1>
      <form onSubmit={submit}>
        <label htmlFor="title">What needs attention?</label>
        <input id="title" value={title} onChange={(event) => setTitle(event.target.value)} />
        <label htmlFor="address">Address</label>
        <input id="address" value={address} onChange={(event) => setAddress(event.target.value)} />
        {error ? <p role="alert">{error}</p> : null}
        <button type="submit">Create report</button>
      </form>
    </main>
  );
}
