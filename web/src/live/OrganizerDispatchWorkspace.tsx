import { useEffect, useMemo, useRef, useState } from "react";

import { AccessError, RoutingConflictError, RoutingContractError, type OrganizerApi, type OrganizerRoutePreview } from "./organizerApi";

type Props = { api: OrganizerApi; onSessionExpired: (error: AccessError) => void };
type RoutingState = Awaited<ReturnType<typeof loadRoutingState>>;
type DispatchCommand = { previewId: string; commandId: string; attempted: boolean };

async function loadRoutingState(api: OrganizerApi) {
  const [crews, jobs, currentPlan] = await Promise.all([api.crews(), api.jobs(), api.currentPlan()]);
  return { crews, jobs, currentPlan };
}

export function OrganizerDispatchWorkspace({ api, onSessionExpired }: Props) {
  const [state, setState] = useState<RoutingState | null>(null);
  const [selectedCrewIds, setSelectedCrewIds] = useState<string[]>([]);
  const [selectedJobIds, setSelectedJobIds] = useState<string[]>([]);
  const [preview, setPreview] = useState<OrganizerRoutePreview | null>(null);
  const [dispatchCommand, setDispatchCommand] = useState<DispatchCommand | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const mounted = useRef(true);
  const recovering = dispatchCommand?.attempted === true;
  const selectionDisabled = busy || loading || recovering;

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => { mounted.current = false; generation.current++; };
  }, [api]);

  function isCurrent(request: number, sessionVersion: number) {
    return mounted.current && request === generation.current && api.sessionVersion === sessionVersion;
  }

  async function refresh(preserveError = false) {
    const request = ++generation.current;
    const sessionVersion = api.sessionVersion;
    // A submitted command stays frozen until the server confirms its outcome.
    if (!recovering) { setPreview(null); setDispatchCommand(null); }
    setLoading(true); if (!preserveError) setError("");
    try {
      const next = await loadRoutingState(api);
      if (isCurrent(request, sessionVersion)) {
        setState(next);
        setSelectedCrewIds(ids => ids.filter(id => next.crews.some(crew => crew.id === id && crew.available)));
        setSelectedJobIds(ids => ids.filter(id => next.jobs.some(job => job.id === id && job.status !== "completed")));
      }
    } catch (caught) {
      if (isCurrent(request, sessionVersion)) {
        if (caught instanceof AccessError) onSessionExpired(caught);
        else setError((caught as Error).message);
      }
    } finally {
      if (isCurrent(request, sessionVersion)) setLoading(false);
    }
  }

  function invalidatePreview() {
    generation.current++;
    setPreview(null); setDispatchCommand(null); setError("");
  }

  function toggleCrew(id: string) {
    if (selectionDisabled) return;
    invalidatePreview();
    setSelectedCrewIds(ids => ids.includes(id) ? ids.filter(value => value !== id) : ids.length < 5 ? [...ids, id] : ids);
  }

  function toggleJob(id: string) {
    if (selectionDisabled) return;
    invalidatePreview();
    setSelectedJobIds(ids => ids.includes(id) ? ids.filter(value => value !== id) : ids.length < 25 ? [...ids, id] : ids);
  }

  const scopeIssue = useMemo(() => {
    if (!selectedCrewIds.length) return "Select at least one crew.";
    if (!selectedJobIds.length) return "Select at least one job.";
    const selectedCrewJobs = state?.jobs.filter(job => job.assigned_crew_id && selectedCrewIds.includes(job.assigned_crew_id) && job.status !== "completed" && !selectedJobIds.includes(job.id)) ?? [];
    if (selectedCrewJobs.length) return "Include every unfinished job assigned to a selected crew.";
    const foreignJobs = state?.jobs.filter(job => selectedJobIds.includes(job.id) && job.assigned_crew_id && !selectedCrewIds.includes(job.assigned_crew_id)) ?? [];
    if (foreignJobs.length) return "Select the crew assigned to every reviewed job.";
    return "";
  }, [selectedCrewIds, selectedJobIds, state]);

  async function computePreview() {
    if (selectionDisabled || !state || scopeIssue) return;
    const request = ++generation.current;
    const sessionVersion = api.sessionVersion;
    const crewIds = [...selectedCrewIds];
    const jobIds = [...selectedJobIds];
    setBusy(true); setError(""); setPreview(null); setDispatchCommand(null);
    try {
      const result = await api.previewRouting(crewIds, jobIds);
      if (!sameScope(result, crewIds, jobIds)) throw new RoutingContractError("The routing service did not confirm the selected job scope. Deploy scoped routing support and compute again.");
      if (isCurrent(request, sessionVersion)) setPreview(result);
    } catch (caught) {
      if (isCurrent(request, sessionVersion)) {
        if (caught instanceof AccessError) onSessionExpired(caught);
        else if (caught instanceof RoutingConflictError) {
          setPreview(null); setDispatchCommand(null); setBusy(false);
          void refresh(true);
          setError("Routing state changed. Review the refreshed routing state, then compute and review a new preview.");
        }
        else setError((caught as Error).message);
      }
    } finally {
      if (isCurrent(request, sessionVersion)) setBusy(false);
    }
  }

  const canDispatch = !!preview && (recovering || (!scopeIssue && preview.dispatchable && !preview.plan_id && Date.parse(preview.expires_at) > Date.now() && preview.routes.some(route => route.stops.length > 0)));

  async function dispatch() {
    if (!preview || !dispatchCommand || busy || loading) return;
    // Expiry prevents a new dispatch, but a lost response may hide a committed
    // plan. The server can replay that exact command even after preview expiry.
    if (!dispatchCommand.attempted && Date.parse(preview.expires_at) <= Date.now()) {
      setPreview(null); setDispatchCommand(null);
      setError("This preview expired before dispatch. Compute and review a new preview.");
      return;
    }
    if (!canDispatch) return;
    const request = ++generation.current;
    const sessionVersion = api.sessionVersion;
    const command = { ...dispatchCommand, attempted: true };
    setDispatchCommand(command);
    setBusy(true); setError("");
    try {
      await api.dispatchRouting(command.previewId, command.commandId);
      if (isCurrent(request, sessionVersion)) {
        setPreview(null); setDispatchCommand(null); setBusy(false);
        await refresh();
      }
    } catch (caught) {
      if (isCurrent(request, sessionVersion)) {
        if (caught instanceof AccessError) onSessionExpired(caught);
        else if (caught instanceof RoutingConflictError) {
          setPreview(null); setDispatchCommand(null); setBusy(false);
          void refresh(true);
          setError("Routing state changed. Review the refreshed routing state, then compute and review a new preview.");
        }
        else setError((caught as Error).message);
      }
    } finally {
      if (isCurrent(request, sessionVersion)) setBusy(false);
    }
  }

  return <section aria-label="Routing dispatch workspace">
    <h2>Routing dispatch</h2>
    <p>Review only the crews and jobs you intend to route. Previewing does not assign work.</p>
    <button onClick={() => void refresh()} disabled={loading || busy}>Refresh routing state</button>
    {loading && <p role="status">Loading routing state…</p>}
    {error && <p role="alert">{error}</p>}
    {state && <>
      <section aria-label="Current plan">
        <h3>Current dispatched plan</h3>
        {state.currentPlan.plan ? <>
          <p>{state.currentPlan.plan.id} · {state.currentPlan.plan.stale ? "changed, review before replanning" : state.currentPlan.plan.travel_estimates_label}</p>
          {[...state.currentPlan.plan.assignments].sort((left, right) => left.crew_id.localeCompare(right.crew_id) || left.position - right.position).map(assignment => <p key={`${assignment.crew_id}:${assignment.job_id}`}>{state.crews.find(crew => crew.id === assignment.crew_id)?.name ?? assignment.crew_id} · stop {assignment.position + 1} · {assignment.job_id} · {assignment.travel_minutes} minutes travel · {assignment.service_minutes} minutes service</p>)}
        </> : <p>No dispatched plan.</p>}
      </section>
      <section aria-label="Crew selection">
        <h3>Crews</h3>
        {state.crews.map(crew => {
          const selected = selectedCrewIds.includes(crew.id);
          const crewLabel = `${crew.name} (${crew.id})`;
          return <article key={crew.id}>
            <button onClick={() => toggleCrew(crew.id)} disabled={selectionDisabled || (!selected && (!crew.available || selectedCrewIds.length >= 5))}>{selected ? `Remove ${crewLabel}` : `Select ${crewLabel}`}</button>
            <p>{crew.illustrative ? "Illustrative crew" : "Real crew"} · {crew.id} · {crew.available ? "available" : "unavailable"} · GPS {gpsAge(crew.location_recorded_at)}</p>
          </article>;
        })}
      </section>
      <section aria-label="Job selection">
        <h3>Reviewed jobs {selectedJobIds.length}/25</h3>
        {state.jobs.map(job => {
          const selected = selectedJobIds.includes(job.id);
          const jobLabel = `${job.category} (${job.id})`;
          const allowed = !job.assigned_crew_id || selectedCrewIds.includes(job.assigned_crew_id);
          return <article key={job.id}>
            <button onClick={() => toggleJob(job.id)} disabled={selectionDisabled || (!selected && (!allowed || job.status === "completed" || selectedJobIds.length >= 25))}>{selected ? `Remove job ${jobLabel}` : `Select job ${jobLabel}`}</button>
            <p>{job.illustrative ? "Illustrative demo job" : "Real report job"} · {job.id} · {job.status} · {job.held ? "held work" : job.locked || job.status === "in_progress" ? "fixed work" : "movable work"} · {job.assigned_crew_id ?? "unassigned"}</p>
          </article>;
        })}
      </section>
      {scopeIssue && !recovering && <p role="alert">{scopeIssue}</p>}
      <button onClick={() => void computePreview()} disabled={selectionDisabled || !!scopeIssue}>Compute route preview</button>
    </>}
    {preview && <PreviewReview preview={preview} crewNames={new Map(state?.crews.map(crew => [crew.id, crew.name]))} reviewing={!!dispatchCommand} recovering={recovering} canDispatch={canDispatch} busy={busy || loading} onReview={() => { setDispatchCommand({ previewId: preview.id, commandId: crypto.randomUUID(), attempted: false }); }} onDispatch={() => void dispatch()} />}
  </section>;
}

function sameScope(preview: OrganizerRoutePreview, crewIds: string[], jobIds: string[]) {
  try {
    const canonicalJobIds = preview.job_ids;
    const stops = preview.routes.flatMap(route => route.stops.map(stop => stop.job_id));
    const referencedJobs = [...stops, ...preview.exclusions.map(issue => issue.job_id), ...preview.unassigned.map(issue => issue.job_id), ...preview.reassignments.map(change => change.job_id)];
    return Array.isArray(canonicalJobIds) && canonicalJobIds.length === jobIds.length && new Set(canonicalJobIds).size === jobIds.length && jobIds.every(id => canonicalJobIds.includes(id)) && preview.routes.every(route => crewIds.includes(route.crew_id)) && preview.reassignments.every(change => crewIds.includes(change.proposed_crew_id)) && stops.length === new Set(stops).size && referencedJobs.every(id => jobIds.includes(id)) && jobIds.every(id => referencedJobs.includes(id));
  } catch {
    return false;
  }
}

function PreviewReview({ preview, crewNames, reviewing, recovering, canDispatch, busy, onReview, onDispatch }: { preview: OrganizerRoutePreview; crewNames: Map<string, string>; reviewing: boolean; recovering: boolean; canDispatch: boolean; busy: boolean; onReview: () => void; onDispatch: () => void }) {
  return <section aria-label="Route preview">
    <h3>Route preview</h3>
    <p>{preview.travel_label} · expires {new Date(preview.expires_at).toLocaleTimeString()}</p>
    <p>Road estimates use OSRM. © OpenStreetMap contributors.</p>
    {preview.routes.map(route => <article key={route.crew_id}>
      <h4>{crewNames.get(route.crew_id) ?? route.crew_id}</h4>
      <p>{route.travel_minutes} minutes travel · {route.duration_minutes} minutes total</p>
      {route.stops.map(stop => <p key={stop.job_id}>Stop {stop.position + 1}: {stop.job_id} · {stop.priority} priority · {stop.travel_minutes} minutes travel · {stop.service_minutes} minutes service{stop.fixed ? " · fixed" : ""}</p>)}
    </article>)}
    {[...preview.exclusions, ...preview.unassigned].map(issue => <p key={`${issue.job_id}:${issue.reason}`}>Excluded or unassigned {issue.job_id}: {issue.reason}</p>)}
    {preview.reassignments.map(change => <p key={change.job_id}>Reassignment {change.job_id}: {change.previous_crew_id ?? "unassigned"} to {change.proposed_crew_id}, stop {change.proposed_position + 1}</p>)}
    {recovering && <p role="status">Dispatch confirmation is pending. Recover this dispatch before changing the selected work.</p>}
    {!canDispatch && <p role="alert">Dispatch unavailable. Compute a new preview after reviewing current routing state.</p>}
    {!reviewing ? <button onClick={onReview} disabled={!canDispatch || busy}>Review dispatch</button> : <section aria-label="Dispatch confirmation"><p>Confirm this reviewed scope before dispatching.</p><button onClick={onDispatch} disabled={!canDispatch || busy}>{recovering ? "Recover dispatch" : "Confirm and dispatch"}</button></section>}
  </section>;
}

function gpsAge(recordedAt: string | null) {
  if (!recordedAt) return "not shared";
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(recordedAt)) / 1000));
  return `${seconds}s ago`;
}
