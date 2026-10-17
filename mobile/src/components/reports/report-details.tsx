import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, StyleSheet, View } from "react-native";
import { Image } from "expo-image";
import { AppText, Button } from "@/components/ui";
import { reportPhoto, reportUpdates } from "@/services/reports";
import type { PhotoAccess, ReportDraft, ReportUpdate, SavedReport } from "@/services/report-client";
import { Spacing } from "@/theme";

export function PrivateReportPhoto({ draft, photoId, label }: { draft: ReportDraft; photoId: string; label: string }) {
  const [result, setResult] = useState<{ draft: ReportDraft; photoId: string; revision: number; access: PhotoAccess | null; error: boolean } | null>(null);
  const [revision, setRevision] = useState(0);
  const visible = result?.draft === draft && result.photoId === photoId && result.revision === revision ? result : null;
  const access = visible?.access;
  const error = visible?.error;
  const retried = useRef(false);
  const expiration = useRef(0);
  const expiryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    let active = true;
    expiration.current = 0;
    const failedResult = { draft, photoId, revision, access: null, error: true };
    reportPhoto(draft, photoId).then(value => {
      if (!active) return;
      const expiresAt = value.expiresAt;
      expiration.current = expiresAt;
      if (expiresAt <= Date.now()) { setResult(failedResult); return; }
      setResult({ draft, photoId, revision, access: value, error: false });
      expiryTimer.current = setTimeout(() => { setRevision(n => n + 1); }, Math.min(expiresAt - Date.now(), 2_147_483_647));
    }).catch(() => { if (active) setResult(failedResult); });
    const subscription = AppState.addEventListener("change", state => {
      if (state === "active" && expiration.current && Date.now() >= expiration.current) {
        setRevision(n => n + 1);
      }
    });
    return () => { active = false; clearTimeout(expiryTimer.current); subscription.remove(); };
  }, [draft, photoId, revision]);
  const failed = () => {
    expiration.current = 0; clearTimeout(expiryTimer.current);
    if (!retried.current) { retried.current = true; setRevision(n => n + 1); }
    else setResult({ draft, photoId, revision, access: null, error: true });
  };
  return <View style={s.section}>
    <AppText>{label}</AppText>
    {access && <Image source={{ uri: access.url }} accessibilityLabel={label} style={s.photo} contentFit="contain" cachePolicy="none" onError={failed} />}
    {error ? <><AppText tone="muted">Photo unavailable. Your report is still saved.</AppText><Button label="Retry photo" variant="outline" onPress={() => { retried.current = false; setRevision(n => n + 1); }} /></>
      : !access && <AppText tone="muted">Loading photo…</AppText>}
  </View>;
}

type DetailsProps = { draft: ReportDraft; report: SavedReport };
export function ReportDetails(props: DetailsProps) {
  return <ReportDetailsContent key={props.draft.id} {...props} />;
}
function ReportDetailsContent({ draft, report }: DetailsProps) {
  const [items, setItems] = useState<ReportUpdate[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const working = useRef(false);
  const load = useCallback((offset: number) => {
    if (working.current) return;
    working.current = true;
    const request = ++generation.current;
    return reportUpdates(draft, offset).then(page => {
      if (request !== generation.current) return;
      setError("");
      setItems(previous => [...new Map([...(offset ? previous : []), ...page.items].map(item => [item.id, item])).values()]);
      const end = page.offset + page.items.length;
      setNext(page.items.length && end < page.total ? end : null);
    }).catch(() => { if (request === generation.current) setError("Unable to load history. Please retry."); })
      .finally(() => { if (request === generation.current) { working.current = false; setBusy(false); } });
  }, [draft]);
  useEffect(() => {
    working.current = false;
    void load(0);
    const counter = generation;
    return () => { counter.current++; };
  }, [load]);
  const start = (offset: number) => {
    if (working.current) return;
    setBusy(true); setError("");
    if (!offset) { setItems([]); setNext(null); }
    void load(offset);
  };
  return <View style={s.section}>
    <AppText variant="headline">Status history</AppText>
    {items.map(item => <View key={item.id} style={s.section}>
      <AppText>{item.message}</AppText>
      <AppText tone="muted">{new Date(item.created_at).toLocaleString()}{item.status ? ` · ${item.status}` : ""}</AppText>
    </View>)}
    {!busy && !error && !items.length && <AppText tone="muted">No updates yet.</AppText>}
    {error ? <AppText accessibilityRole="alert">{error}</AppText> : null}
    <Button label="Refresh history" variant="outline" disabled={busy} onPress={() => start(0)} />
    {next !== null && <Button label="Load more updates" variant="outline" disabled={busy} onPress={() => start(next)} />}
    {busy && <AppText tone="muted">Loading history…</AppText>}
    {report.photo_id && <PrivateReportPhoto draft={draft} photoId={report.photo_id} label="Reported photo" />}
    {[...new Set(report.completion_photo_ids ?? [])].map(id => <PrivateReportPhoto key={id} draft={draft} photoId={id} label="Cleanup photo · crew-submitted" />)}
  </View>;
}
const s = StyleSheet.create({ section: { gap: Spacing.sm }, photo: { width: "100%", aspectRatio: 4 / 3 } });
