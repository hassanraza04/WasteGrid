import { FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";

export function TrackReportPage() {
  const navigate = useNavigate();
  const [reference, setReference] = useState("");

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    navigate(`/report/${reference.trim().toUpperCase()}`);
  }

  return (
    <main>
      <h1>Track a report</h1>
      <form onSubmit={submit}>
        <label htmlFor="reference">Report reference</label>
        <input
          id="reference"
          value={reference}
          onChange={(event) => setReference(event.target.value)}
        />
        <button type="submit">Track report</button>
      </form>
    </main>
  );
}
