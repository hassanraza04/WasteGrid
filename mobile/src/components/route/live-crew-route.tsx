import { useCallback, useRef, useState } from "react";
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const working = useRef(false);
  const run = async (job: Job, photoUri?: string) => {
    if (working.current) return;
    working.current = true; setBusy(true); setError(""); setMessage("");
    try {
      const command = await prepareStaff(photoUri ? "completion" : "start", job, photoUri);
      // Recovery owns durable, immutable bytes once the action is saved.
      if (photoUri) setPhoto(null);
      await submitStaff(command);
      setMessage(photoUri ? "Cleanup confirmed. The resident can see your completion photo." : "Stop started. Submit a cleanup photo when finished.");
    } catch (error) { setError(error instanceof Error ? error.message : "Unable to confirm. Recover the saved action."); }
    finally { working.current = false; setBusy(false); await state.refresh(); }
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
    {photo && <Card>
      <AppText variant="headline">Review cleanup evidence</AppText>
      <Image source={{ uri: photo.uri }} contentFit="contain" style={{ width: "100%", aspectRatio: 4 / 3 }} />
      <Button label="Submit cleanup photo" disabled={busy} onPress={() => { void run(photo.job, photo.uri); }} />
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
      {job.status === "assigned" && <Button label="Start stop" disabled={busy || state.loading || pendingFor(job.id) || next?.id !== job.id} onPress={() => { void run(job); }} />}
      {job.status === "in_progress" && <Button label="Take cleanup photo" disabled={busy || state.loading || pendingFor(job.id) || !!photo} onPress={() => setCamera(job)} />}
    </Card>)}
    {state.data && <PendingActions commands={state.data.pending} refresh={state.refresh} />}
    {!state.loading && state.data && !jobs.length && <AppText>No active stops assigned. Completed stops have cleared from your route.</AppText>}
  </Screen>;
}
