import { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { AppText, Button, Card, Chip, Screen, ScreenHeader, TextField } from "@/components/ui";
import { AccountButton } from "@/components/account/account-button";
import { useStaffData } from "@/hooks/use-staff-data";
import { staffApi } from "@/services/staff";
import { pendingStaff, prepareStaff, submitStaff } from "@/services/pending-staff";
import type { Job, Preview } from "@/services/staff-client";
import { PendingActions } from "@/components/route/pending-actions";
import { RouteMap } from "@/components/route/route-map";
import { Spacing } from "@/theme";

export function LiveDispatch() {
  const read = useCallback(async () => {
    const [crews, jobs, pending] = await Promise.all([staffApi.crews(), staffApi.jobs(), pendingStaff()]);
    return { crews, jobs, pending };
  }, []);
  const state = useStaffData(read);
  const [selected, setSelected] = useState<string[]>([]);
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
    if (working.current || state.loading || !state.data || pendingDispatch) return;
    working.current = true; setBusy(true); setError(""); setResult(null);
    const version = ++revision.current;
    const jobs = state.data.jobs;
    try {
      const preview = await staffApi.compute(selected);
      const missing = [...new Set(preview.routes.flatMap(route => route.stops.map(stop => stop.job_id)))].filter(id => !jobs.some(job => job.id === id));
      const added = await Promise.all(missing.map(id => staffApi.job(id)));
      if (version === revision.current) setResult({ preview, jobs: [...jobs, ...added.map(details => details.job)] });
    } catch (error) { if (version === revision.current) setError(error instanceof Error ? error.message : "Unable to compute routes."); }
    finally { working.current = false; setBusy(false); }
  };
  const dispatch = async () => {
    if (working.current || !result || !canDispatch) return;
    working.current = true; setBusy(true); setError("");
    try {
      const command = await prepareStaff("dispatch", result.preview.id);
      await submitStaff(command);
      setResult(null);
    } catch (error) { setError(error instanceof Error ? error.message : "Dispatch confirmation pending. Recover the saved action."); }
    finally { working.current = false; setBusy(false); await state.refresh(); }
  };
  const preview = result?.preview;
  const canDispatch = !state.loading && !pendingDispatch && !!state.data && !state.error && !!preview?.dispatchable && !preview.plan_id && Date.parse(preview.expires_at) > now && preview.routes.some(route => route.stops.length);
  const crewName = (id: string | null) => state.data?.crews.find(crew => crew.id === id)?.name ?? id ?? "Unassigned";
  return <Screen>
    <ScreenHeader title="Dispatch" subtitle="All eligible jobs · road travel time and priority" trailing={<AccountButton />} />
    <Button label="Refresh crews and jobs" variant="outline" disabled={busy || state.loading} onPress={() => { void state.refresh(); }} />
    {state.loading && <AppText tone="muted">Refreshing fleet…</AppText>}
    {state.error ? <AppText accessibilityRole="alert">{state.error}</AppText> : null}
    <AppText>Select up to five crews. Their current locations are the route origins. Up to 25 eligible jobs can be routed per calculation. Fixed work and unselected crews are preserved.</AppText>
    {state.data?.crews.map(crew => <Card key={crew.id}>
      <Chip label={crew.name} selected={selected.includes(crew.id)} disabled={busy || (!crew.available && !selected.includes(crew.id)) || (selected.length >= 5 && !selected.includes(crew.id))} onPress={() => {
        revision.current++; setResult(null);
        setSelected(ids => ids.includes(crew.id) ? ids.filter(id => id !== crew.id) : [...ids, crew.id]);
      }} />
      <AppText tone="muted">{crew.available ? "Available" : "Unavailable"} · GPS {crew.location_recorded_at ? `${Math.max(0, Math.round((now - Date.parse(crew.location_recorded_at)) / 1000))}s ago` : "not shared"}</AppText>
      <AppText>{state.data?.jobs.filter(job => job.assigned_crew_id === crew.id).length} active stops</AppText>
    </Card>)}
    {pendingDispatch && <AppText>Recover or discard the saved dispatch before computing another preview.</AppText>}
    <Button label="Compute routes" disabled={busy || state.loading || pendingDispatch || !state.data || !selected.length || selected.some(id => !state.data?.crews.some(crew => crew.id === id && crew.available))} loading={busy} onPress={() => { void compute(); }} />
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
        {route.stops.map(stop => <AppText key={stop.job_id}>{stop.position + 1}. {result.jobs.find(job => job.id === stop.job_id)?.category ?? stop.job_id} · {stop.priority === "routine" ? "low" : stop.priority} · finish in {Math.round(stop.completion_minutes)} min{stop.fixed ? " · fixed" : ""}</AppText>)}
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
