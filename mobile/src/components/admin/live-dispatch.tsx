import { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { Link } from "expo-router";
import { AppText, Button, Card, Chip, Screen, ScreenHeader, TextField } from "@/components/ui";
import { AccountButton } from "@/components/account/account-button";
import { useStaffData } from "@/hooks/use-staff-data";
import { staffApi } from "@/services/staff";
import { pendingStaff, prepareStaff, reconcileDispatchConflict, submitStaff } from "@/services/pending-staff";
import { StaffApiError, type Job, type Preview } from "@/services/staff-client";
import type { StaffCommand } from "@/services/staff-commands";
import { PendingActions } from "@/components/route/pending-actions";
import { RouteMap } from "@/components/route/route-map";
import { Spacing } from "@/theme";

export function LiveDispatch() {
  const read = useCallback(async () => {
    const [crews, jobs, pending, currentPlan] = await Promise.all([staffApi.crews(), staffApi.jobs(), pendingStaff(), staffApi.currentPlan()]);
    return { crews, jobs, pending, currentPlan };
  }, []);
  const state = useStaffData(read);
  const [selected, setSelected] = useState<string[]>([]);
  const [selectedJobs, setSelectedJobs] = useState<string[]>([]);
  const [result, setResult] = useState<{ preview: Preview; jobs: Job[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const working = useRef(false);
  const revision = useRef(0);
  const pendingDispatch = !!state.data?.pending.some(command => command.kind === "dispatch");
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    const counter = revision;
    return () => { clearInterval(timer); counter.current++; };
  }, []);
  const compute = async () => {
    if (working.current || state.loading || !state.data || pendingDispatch || selectionIssue) return;
    working.current = true; setBusy(true); setError(""); setResult(null);
    const version = ++revision.current;
    const jobs = state.data.jobs;
    try {
      const requestedJobs = [...selectedJobs];
      const preview = await staffApi.compute(selected, requestedJobs);
      if (!matchesScope(preview, requestedJobs) || preview.routes.some(route => !selected.includes(route.crew_id) || route.stops.some(stop => !requestedJobs.includes(stop.job_id)))) {
        throw new Error("The backend did not confirm the selected job scope. Deploy scoped routing support and compute again before dispatch.");
      }
      const missing = [...new Set(preview.routes.flatMap(route => route.stops.map(stop => stop.job_id)))].filter(id => !jobs.some(job => job.id === id));
      const added = await Promise.all(missing.map(id => staffApi.job(id)));
      if (version === revision.current) setResult({ preview, jobs: [...jobs, ...added.map(details => details.job)] });
    } catch (error) { if (version === revision.current) setError(error instanceof Error ? error.message : "Unable to compute routes."); }
    finally { working.current = false; if (version === revision.current) setBusy(false); }
  };
  const dispatch = async () => {
    if (working.current || !result || !canDispatch) return;
    working.current = true; setBusy(true); setError("");
    const version = ++revision.current;
    let command: StaffCommand | undefined;
    try {
      command = await prepareStaff("dispatch", result.preview.id);
      if (version !== revision.current) return;
      await submitStaff(command);
      if (version === revision.current) setResult(null);
    } catch (error) {
      if (version !== revision.current) return;
      if (command && error instanceof StaffApiError && error.status === 409) {
        setResult(null);
        setError("This routing proposal is no longer available for approval. Refresh routing state, then compute and review a new preview.");
        try {
          await reconcileDispatchConflict(command);
        } catch {
          if (version === revision.current) setError("Unable to reconcile the saved dispatch. Use Refresh routing state on its saved action before computing a new preview.");
        }
      } else setError(error instanceof Error ? error.message : "Dispatch confirmation pending. Recover the saved action.");
    }
    finally {
      working.current = false;
      if (version === revision.current) { setBusy(false); await state.refresh(); }
    }
  };
  const unavailableJobs = selectedJobs.filter(id => !state.data?.jobs.some(job => job.id === id && job.status !== "completed"));
  const foreignJobs = state.data?.jobs.filter(job => selectedJobs.includes(job.id) && job.assigned_crew_id && !selected.includes(job.assigned_crew_id)) ?? [];
  const omittedAssignments = state.data?.jobs.filter(job => job.status !== "completed" && job.assigned_crew_id && selected.includes(job.assigned_crew_id) && !selectedJobs.includes(job.id)) ?? [];
  const selectionIssue = !selected.length ? "Select at least one crew."
    : !selectedJobs.length ? "Select at least one job."
    : selectedJobs.length > 25 ? "Select at most 25 jobs."
    : unavailableJobs.length ? "A selected job is no longer active. Clear the selection and review current work."
    : foreignJobs.length ? "A selected job belongs to an unselected crew. Include its crew or remove that job."
    : omittedAssignments.length ? "Include every unfinished job assigned to the selected crews, or choose an idle crew for an isolated test."
    : "";
  const preview = result?.preview;
  const canDispatch = !selectionIssue && !!preview && matchesScope(preview, selectedJobs) && !state.loading && !pendingDispatch && !!state.data && !state.error && !!preview?.dispatchable && !preview.plan_id && Date.parse(preview.expires_at) > now && preview.routes.some(route => route.stops.length);
  const crewName = (id: string | null) => state.data?.crews.find(crew => crew.id === id)?.name ?? id ?? "Unassigned";
  return <Screen>
    <ScreenHeader title="Dispatch" subtitle="Selected jobs · road travel time and priority" trailing={<AccountButton />} />
    <AppText tone="muted">Road routing: OSRM. <Link href="https://www.openstreetmap.org/copyright" asChild><AppText tone="primary">© OpenStreetMap contributors (ODbL).</AppText></Link> <Link href="https://www.openstreetmap.org/fixthemap" asChild><AppText tone="primary">Fix the map</AppText></Link></AppText>
    <Button label="Refresh fleet and current plan" variant="outline" disabled={busy || state.loading} onPress={() => { void state.refresh(); }} />
    {state.loading && <AppText tone="muted">Refreshing fleet…</AppText>}
    {state.error ? <AppText accessibilityRole="alert">{state.error}</AppText> : null}
    {state.data && <Card>
      <AppText variant="title">Current dispatched plan</AppText>
      {state.data.currentPlan.plan ? <>
        <AppText selectable>{state.data.currentPlan.plan.id}</AppText>
        <AppText>{state.data.currentPlan.plan.stale ? "Plan changed; review current job statuses before replanning." : "Saved dispatch"} · {state.data.currentPlan.plan.travel_estimates_label}</AppText>
        {[...state.data.currentPlan.plan.assignments].sort((a, b) => a.crew_id.localeCompare(b.crew_id) || a.position - b.position).map(stop => {
          const job = state.data!.jobs.find(job => job.id === stop.job_id);
          return <AppText key={stop.job_id}>{crewName(stop.crew_id)} · stop {stop.position + 1} · {job?.category ?? stop.job_id} · {stop.travel_minutes} min travel · {stop.service_minutes} min service{job ? ` · ${job.status.replaceAll("_", " ")}${job.locked || job.status === "in_progress" ? " · fixed" : ""}` : " · historical stop"}</AppText>;
        })}
      </> : <AppText>No dispatched plan yet.</AppText>}
    </Card>}
    <AppText>Select up to five crews and 1–25 jobs explicitly. Crew GPS supplies the route origins. Include every unfinished assignment of a selected crew; choose an idle crew to isolate a test. Fixed work and unselected crews are preserved.</AppText>
    {state.data?.crews.map(crew => <Card key={crew.id}>
      <Chip label={crew.name} selected={selected.includes(crew.id)} disabled={busy || (!crew.available && !selected.includes(crew.id)) || (selected.length >= 5 && !selected.includes(crew.id))} onPress={() => {
        revision.current++; setResult(null); setError("");
        setSelected(ids => ids.includes(crew.id) ? ids.filter(id => id !== crew.id) : [...ids, crew.id]);
      }} />
      <AppText tone="muted">{crew.available ? "Available" : "Unavailable"} · GPS {crew.location_recorded_at ? `${Math.max(0, Math.round((now - Date.parse(crew.location_recorded_at)) / 1000))}s ago` : "not shared"}</AppText>
      <AppText>{state.data?.jobs.filter(job => job.assigned_crew_id === crew.id).length} active stops</AppText>
    </Card>)}
    <AppText variant="title">Selected job scope · {selectedJobs.length}/25</AppText>
    {state.data?.jobs.map(job => {
      const chosen = selectedJobs.includes(job.id);
      const available = job.status !== "completed" && (!job.assigned_crew_id || selected.includes(job.assigned_crew_id));
      return <Card key={job.id}>
        <Chip label={`Job ${job.id}`} selected={chosen} disabled={busy || (!chosen && (!available || selectedJobs.length >= 25))} onPress={() => {
          revision.current++; setResult(null); setError("");
          setSelectedJobs(ids => ids.includes(job.id) ? ids.filter(id => id !== job.id) : ids.length < 25 ? [...ids, job.id] : ids);
        }} />
        <AppText>{job.illustrative ? "Illustrative demo job" : "Real report job"} · {job.category} · {job.status.replaceAll("_", " ")}</AppText>
        <AppText>Assigned crew: {crewName(job.assigned_crew_id)} · {job.held ? "held" : "not held"}{job.locked || job.status === "in_progress" ? " · fixed work" : ""}</AppText>
        {!available && !chosen && <AppText tone="muted">Select the assigned crew before including this job.</AppText>}
      </Card>;
    })}
    {!!selectedJobs.length && <Button label="Clear job selection" variant="outline" disabled={busy} onPress={() => { revision.current++; setSelectedJobs([]); setResult(null); setError(""); }} />}
    {(selected.length > 0 || selectedJobs.length > 0) && !!selectionIssue && <AppText accessibilityRole="alert">{selectionIssue}</AppText>}
    {pendingDispatch && <AppText>Resolve the saved dispatch action below before computing another preview.</AppText>}
    <Button label="Compute routes" disabled={busy || state.loading || pendingDispatch || !state.data || !!selectionIssue || selected.some(id => !state.data?.crews.some(crew => crew.id === id && crew.available))} loading={busy} onPress={() => { void compute(); }} />
    {error ? <AppText accessibilityRole="alert">{error}</AppText> : null}
    {result && state.data && <>
      <AppText variant="title">Route preview</AppText>
      <AppText>{preview!.travel_label} · expires {new Date(preview!.expires_at).toLocaleTimeString()}</AppText>
      <AppText tone="muted">Maps show stop order. Use directions for road navigation.</AppText>
      {!canDispatch && <AppText accessibilityRole="alert">Dispatch unavailable: {Date.parse(preview!.expires_at) <= now ? "preview expired; compute again" : preview!.termination_reason.replaceAll("_", " ")}</AppText>}
      {preview!.routes.map(route => <Card key={route.crew_id}>
        <AppText variant="headline">{crewName(route.crew_id)} · {Math.round(route.duration_minutes)} min total</AppText>
        <AppText>{Math.round(route.travel_minutes)} min driving · {route.stops.length} stops</AppText>
        <RouteMap stops={route.stops.flatMap(stop => {
          const job = result.jobs.find(job => job.id === stop.job_id);
          return job ? [{ reportId: job.id, address: job.location.landmark ?? job.category, coords: job.location }] : [];
        })} />
        {route.stops.map(stop => <AppText key={stop.job_id}>{stop.position + 1}. {result.jobs.find(job => job.id === stop.job_id)?.category ?? stop.job_id} · {stop.priority === "routine" ? "low" : stop.priority} · {stop.travel_minutes} min travel · {stop.service_minutes} min service · finish in {Math.round(stop.completion_minutes)} min{stop.fixed ? " · fixed" : ""}</AppText>)}
      </Card>)}
      {[...preview!.exclusions, ...preview!.unassigned].map((issue, index) => <AppText key={`${issue.job_id}:${index}`}>Excluded/unassigned {issue.job_id}: {issue.reason.replaceAll("_", " ")}</AppText>)}
      {preview!.reassignments.map(change => <AppText key={change.job_id}>Assignment change {change.job_id}: {crewName(change.previous_crew_id)} → {crewName(change.proposed_crew_id)} · stop {change.proposed_position + 1}</AppText>)}
      <Button label="Approve and dispatch" disabled={!canDispatch || busy} onPress={() => { void dispatch(); }} />
    </>}
    {state.data && <PendingActions commands={state.data.pending} refresh={async () => { setResult(null); await state.refresh(); }} />}
    {state.data?.jobs.filter(job => job.status === "recheck_requested").map(job => <RecheckResolution key={`${job.id}:${job.version}`} job={job} refresh={async () => { setResult(null); await state.refresh(); }} />)}
    {!state.loading && state.data && !state.data.jobs.length && <AppText>No active jobs. Assessments must produce approved jobs before routing.</AppText>}
  </Screen>;
}
function matchesScope(preview: Preview, ids: string[]) {
  const stops = preview.routes.flatMap(route => route.stops.map(stop => stop.job_id));
  return Array.isArray(preview.job_ids) && preview.job_ids.length === ids.length
    && new Set(preview.job_ids).size === ids.length && ids.every(id => preview.job_ids!.includes(id))
    && stops.every(id => ids.includes(id))
    && (!preview.dispatchable || (stops.length === ids.length && new Set(stops).size === ids.length));
}

function RecheckResolution({ job, refresh }: { job: Job; refresh(): Promise<void> }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const working = useRef(false);
  const release = async () => {
    if (working.current || !reason.trim()) return;
    working.current = true; setBusy(true); setError("");
    try { await submitStaff(await prepareStaff("release", job, undefined, reason.trim())); }
    catch (error) { setError(error instanceof Error ? error.message : "Unable to resolve recheck."); }
    finally { working.current = false; setBusy(false); await refresh(); }
  };
  return <Card>
    <AppText variant="headline">Recheck awaiting organiser resolution</AppText><AppText selectable>{job.id}</AppText>
    <TextField label="Audit reason" value={reason} editable={!busy} maxLength={1000} onChangeText={setReason} />
    <View style={styles.actions}><Button label="Release recheck for replanning" disabled={busy || !reason.trim()} onPress={() => { void release(); }} /></View>
    {error ? <AppText accessibilityRole="alert">{error}</AppText> : null}
  </Card>;
}
const styles = StyleSheet.create({ actions: { gap: Spacing.md } });
