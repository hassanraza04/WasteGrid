import { useEffect, useRef, useState } from "react";

import { AccessError, type OrganizerApi, type OrganizerJobDetails as JobDetails } from "./organizerApi";

export function OrganizerJobDetails({ api, id, onSessionExpired }: { api: OrganizerApi; id: string; onSessionExpired: (error: AccessError) => void }) {
  const [details, setDetails] = useState<JobDetails | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const generation = useRef(0);

  async function load() {
    const request = ++generation.current;
    const sessionVersion = api.sessionVersion;
    const isCurrent = () => request === generation.current && api.sessionVersion === sessionVersion;
    setDetails(null); setBusy(true); setError("");
    try {
      const result = await api.job(id);
      if (isCurrent()) setDetails(result);
    } catch (caught) {
      if (isCurrent()) {
        if (caught instanceof AccessError) onSessionExpired(caught);
        else setError((caught as Error).message);
      }
    } finally {
      if (isCurrent()) setBusy(false);
    }
  }

  useEffect(() => {
    void load();
    return () => { generation.current++; };
  }, [api, id]);

  return <section aria-label="Linked job">
    <h3>Linked job</h3>
    {busy && <p role="status">Loading linked job…</p>}
    {error && <><p role="alert">{error}</p><button onClick={() => void load()}>Retry linked job</button></>}
    {details && <>
      <Value label="Job ID" value={details.job.id} /><Value label="Job status" value={details.job.status} /><Value label="Job version" value={details.job.version} />
      <Value label="Job latitude" value={details.job.location.latitude} /><Value label="Job longitude" value={details.job.location.longitude} /><Value label="Job landmark" value={details.job.location.landmark} />
      <Value label="Job category" value={details.job.category} /><Value label="Required equipment" value={details.job.required_equipment.join(", ")} /><Value label="Job service minutes" value={details.job.estimated_service_minutes} />
      <Value label="Assigned crew ID" value={details.job.assigned_crew_id} /><Value label="Job held" value={details.job.held} /><Value label="Job locked" value={details.job.locked} />
      <Value label="Route position" value={details.job.route_position} /><Value label="Travel minutes" value={details.job.travel_minutes} /><Value label="Unassigned reason" value={details.job.unassigned_reason} /><Value label="Job decision summary" value={details.job.decision_summary} />
      {details.job.illustrative && <p>Illustrative demo job</p>}
    </>}
  </section>;
}

function Value({ label, value }: { label: string; value: string | number | boolean | null }) {
  return <p><strong>{label}:</strong> {value === null || value === "" ? "Not recorded" : String(value)}</p>;
}
