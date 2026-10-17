import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, Alert, StyleSheet } from "react-native";
import { router, useFocusEffect } from "expo-router";

import { AppText, Button, Card, EmptyState, Screen, ScreenHeader } from "@/components/ui";
import { AccountButton } from "@/components/account/account-button";
import { getSession, useSession } from "@/auth/session";
import { claimDeviceDrafts, countUnclaimedDrafts, discardDraft, listDrafts, refreshReport, sendDraft } from "@/services/reports";
import type { ReportDraft, SavedReport } from "@/services/report-client";
import { Spacing } from "@/theme";

type History = { owner: string; drafts: ReportDraft[]; reports: Record<string, SavedReport>; unclaimed: number; error: string };

export default function Reports() {
  const session = useSession();
  const owner = session?.userId;
  const [history, setHistory] = useState<History | null>(null);
  const [busy, setBusy] = useState(false);
  const operation = useRef(0);
  const working = useRef(false);

  useFocusEffect(useCallback(() => {
    const revision = ++operation.current;
    working.current = false;
    if (!owner) { setBusy(false); setHistory(null); return; }
    setBusy(true);
    Promise.all([listDrafts(), countUnclaimedDrafts()]).then(([drafts, unclaimed]) => {
      if (revision === operation.current) setHistory({ owner, drafts, unclaimed, reports: {}, error: "" });
    }).catch(() => {
      if (revision === operation.current) setHistory({ owner, drafts: [], unclaimed: 0, reports: {}, error: "Unable to read reports saved on this device." });
    }).finally(() => { if (revision === operation.current) setBusy(false); });
    return () => { operation.current++; };
  }, [owner]));

  // Account changes must hide the previous account's data before effects run.
  const visible = history?.owner === owner ? history : null;
  const run = async (action: () => Promise<SavedReport | null | void>) => {
    if (!owner || busy || working.current) return;
    working.current = true; setBusy(true);
    const revision = ++operation.current;
    let error = "", report: SavedReport | null | void;
    try {
      report = await action();
      if (report === null) error = "This report has not reached WasteGrid yet. Retry the saved upload, or discard it if it was rejected.";
    } catch (failure) { error = failure instanceof Error ? failure.message : "Unable to sync this report. Your saved upload remains on this device."; }
    try {
      const [drafts, unclaimed] = await Promise.all([listDrafts(), countUnclaimedDrafts()]);
      if (revision === operation.current && getSession()?.userId === owner) setHistory(previous => ({
        owner, drafts, unclaimed, error,
        reports: { ...(previous?.owner === owner ? previous.reports : {}), ...(report ? { [report.id]: report } : {}) },
      }));
    } catch { if (revision === operation.current) setHistory(previous => previous ? { ...previous, error: "Unable to reload saved reports." } : null); }
    finally { if (revision === operation.current) { working.current = false; setBusy(false); } }
  };

  const discard = (draft: ReportDraft) => Alert.alert("Discard rejected upload?", "This removes the rejected photo and draft from this device. You can create a corrected report afterward.", [
    { text: "Cancel", style: "cancel" },
    { text: "Discard", style: "destructive", onPress: () => void run(() => discardDraft(draft)) },
  ]);

  if (!session) return <Screen>
    <ScreenHeader title="My reports" trailing={<AccountButton />} />
    <EmptyState icon="file-text" title="Log in to see your reports" message="Track reports saved on this device for your account." action={<Button label="Log in" onPress={() => router.push("/login")} />} />
  </Screen>;

  return <Screen>
    <ScreenHeader title="My reports" trailing={<AccountButton />} />
    <AppText tone="muted">Reports saved on this device for your account. Keep the app&apos;s storage to retain access.</AppText>
    {busy && <ActivityIndicator />}
    {visible?.error ? <AppText accessibilityRole="alert">{visible.error}</AppText> : null}
    {!!visible?.unclaimed && <Card style={s.card}>
      <AppText>{visible.unclaimed} reports were saved here before sign-in.</AppText>
      <Button label="Import this device's reports" variant="outline" disabled={busy} onPress={() => Alert.alert("Import device reports?", "Only import these reports if this is your device. They will be linked locally to the signed-in account.", [
        { text: "Cancel", style: "cancel" }, { text: "Import", onPress: () => void run(claimDeviceDrafts) },
      ])} />
    </Card>}
    {!busy && visible && !visible.drafts.length && <EmptyState icon="inbox" title="No reports yet" message="Your reports will appear here after submission or import." />}
    {visible?.drafts.map(draft => <Card key={draft.id} style={s.card}>
      <AppText variant="headline">{draft.fields.title}</AppText>
      <AppText selectable>{visible.reports[draft.id]?.public_reference ?? draft.reference ?? "Saved on device — upload not confirmed"}</AppText>
      {visible.reports[draft.id] && <AppText>Status: {visible.reports[draft.id].display_status} · Assessment: {visible.reports[draft.id].assessment_status}</AppText>}
      {draft.rejection && <AppText accessibilityRole="alert">{draft.rejection}</AppText>}
      <Button disabled={busy} label={draft.reference || draft.rejection ? "Check status" : "Retry saved upload"} variant="outline" onPress={() => void run(() => draft.reference || draft.rejection ? refreshReport(draft) : sendDraft(draft))} />
      {draft.rejection && !draft.reference && <Button disabled={busy} label="Discard rejected upload" variant="outline" onPress={() => discard(draft)} />}
    </Card>)}
    <Button label="New report" icon="camera" disabled={busy} onPress={() => router.push("/report")} />
  </Screen>;
}
const s = StyleSheet.create({ card: { gap: Spacing.md } });
