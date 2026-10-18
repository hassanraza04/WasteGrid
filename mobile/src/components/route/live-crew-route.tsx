import { useCallback, useEffect, useRef, useState } from "react";
import { Linking } from "react-native";
import { Image } from "expo-image";
import { AppText, Button, Card, Screen, ScreenHeader } from "@/components/ui";
import { AccountButton } from "@/components/account/account-button";
import { CameraStep } from "@/components/report/camera-step";
import { RouteMap } from "@/components/route/route-map";
import { PendingActions } from "@/components/route/pending-actions";
import { useCrewLocation } from "@/hooks/use-crew-location";
import { useStaffData } from "@/hooks/use-staff-data";
import { staffApi } from "@/services/staff";
import { pendingStaff, prepareStaff, submitStaff } from "@/services/pending-staff";
import type { Job } from "@/services/staff-client";

export function LiveCrewRoute() {
  const read = useCallback(async () => {
    const [jobs, pending] = await Promise.all([staffApi.jobs(), pendingStaff()]);
    return { jobs, pending };
  }, []);
  const state = useStaffData(read);
  const location = useCrewLocation();
  const [camera, setCamera] = useState<Job | null>(null);
  const [photo, setPhoto] = useState<{ job: Job; uri: string } | null>(null);
  const [completion, setCompletion] = useState<Job | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const working = useRef(false);
  const revision = useRef(0);
  useEffect(() => () => { revision.current++; }, []);
  const run = async (job: Job, kind: "start" | "completion", photoUri?: string) => {
    if (working.current) return;
    working.current = true; setBusy(true); setError(""); setMessage("");
    const request = revision.current;
    try {
      const command = await prepareStaff(kind, job, photoUri);
      if (request !== revision.current) return;
      // Recovery owns the immutable evidence choice and any durable photo bytes.
      if (kind === "completion") { setPhoto(null); setCompletion(null); }
      await submitStaff(command);
      if (request === revision.current) setMessage(kind === "start" ? "Stop started. Confirm cleanup when finished; a photo is optional."
        : command.photoUri ? "Cleanup confirmed. The resident can see your completion photo." : "Cleanup confirmed. No cleanup photo was attached.");
    } catch (error) { if (request === revision.current) setError(error instanceof Error ? error.message : "Unable to confirm. Recover the saved action."); }
    finally {
      working.current = false;
      if (request === revision.current) { setBusy(false); await state.refresh(); }
    }
  };
  if (camera) return <CameraStep onClose={() => setCamera(null)} onCapture={uri => { setPhoto({ job: camera, uri }); setCamera(null); }} />;
  const jobs = state.data?.jobs ?? [];
  const pendingFor = (id: string) => state.data?.pending.some(command => command.resource_id === id);
  const next = jobs.find(job => job.status !== "completed");
  return <Screen>
    <ScreenHeader title="My route" subtitle={`${jobs.length} active stops · server order`} trailing={<AccountButton />} />
    <AppText tone="muted">{location.message}</AppText>
    <Button label="Refresh GPS" variant="outline" onPress={() => { void location.refresh(); }} />
    <Button label="Refresh route" variant="outline" disabled={state.loading || busy} onPress={() => { void state.refresh(); }} />
    {state.loading && <AppText tone="muted">Refreshing assigned work…</AppText>}
    {state.error ? <AppText accessibilityRole="alert">{state.error}</AppText> : null}
    {error ? <AppText accessibilityRole="alert">{error}</AppText> : null}
    {message ? <AppText>{message}</AppText> : null}
    {completion && <Card>
      <AppText variant="headline">Confirm completion without a photo</AppText>
      <AppText>This records crew-reported completion without a cleanup photo.</AppText>
      <Button label="Confirm completion without photo" disabled={busy || state.loading || pendingFor(completion.id)} onPress={() => { void run(completion, "completion"); }} />
      <Button label="Cancel completion" variant="outline" disabled={busy} onPress={() => setCompletion(null)} />
    </Card>}
    {photo && <Card>
      <AppText variant="headline">Review cleanup evidence</AppText>
      <Image source={{ uri: photo.uri }} contentFit="contain" style={{ width: "100%", aspectRatio: 4 / 3 }} />
      <Button label="Submit cleanup photo" disabled={busy} onPress={() => { void run(photo.job, "completion", photo.uri); }} />
      <Button label="Retake cleanup photo" variant="outline" disabled={busy} onPress={() => { setCamera(photo.job); setPhoto(null); }} />
      <Button label="Cancel photo" variant="outline" disabled={busy} onPress={() => setPhoto(null)} />
    </Card>}
    {!!jobs.length && <RouteMap stops={jobs.map(job => ({ reportId: job.id, address: job.location.landmark ?? job.category, coords: job.location }))} />}
    {jobs.map((job, index) => <Card key={job.id}>
      <AppText variant="headline">{index + 1}. {job.location.landmark || job.category.replaceAll("_", " ")}</AppText>
      <AppText selectable>{job.id}</AppText><AppText>{job.status.replaceAll("_", " ")}</AppText>
      {job.status === "recheck_requested" && <AppText>Await organiser review and release before continuing this route.</AppText>}
      {job.status === "blocked" && <AppText>This stop needs organiser attention.</AppText>}
      <Button label="Directions" variant="outline" onPress={() => { void Linking.openURL(`https://www.google.com/maps/dir/?api=1&destination=${job.location.latitude},${job.location.longitude}&travelmode=driving`); }} />
      {job.status === "assigned" && <Button label="Start stop" disabled={busy || state.loading || pendingFor(job.id) || next?.id !== job.id} onPress={() => { void run(job, "start"); }} />}
      {job.status === "in_progress" && <>
        <Button label="Mark cleanup complete" disabled={busy || state.loading || pendingFor(job.id) || !!photo || !!completion} onPress={() => setCompletion(job)} />
        <Button label="Take cleanup photo" disabled={busy || state.loading || pendingFor(job.id) || !!photo || !!completion} onPress={() => setCamera(job)} />
      </>}
    </Card>)}
    {state.data && <PendingActions commands={state.data.pending} refresh={state.refresh} />}
    {!state.loading && state.data && !jobs.length && <AppText>No active stops assigned. Completed stops have cleared from your route.</AppText>}
  </Screen>;
}
