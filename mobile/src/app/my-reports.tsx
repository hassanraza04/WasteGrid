import { useCallback, useState } from "react";
import { ActivityIndicator, Button, ScrollView, Text, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { listDrafts, refreshReport, sendDraft } from "@/services/reports";
import type { ReportDraft, SavedReport } from "@/services/report-client";

export default function MyReports() {
  const [drafts, setDrafts] = useState<ReportDraft[]>([]);
  const [reports, setReports] = useState<Record<string, SavedReport>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>("loading");
  useFocusEffect(useCallback(() => {
    let active = true;
    listDrafts().then(value => { if (active) setDrafts(value); })
      .catch(() => { if (active) setError("Unable to read reports saved on this device."); })
      .finally(() => { if (active) setBusy(null); });
    return () => { active = false; };
  }, []));

  async function update(draft: ReportDraft, send: boolean) {
    if (busy) return;
    setBusy(draft.id); setError("");
    try {
      const report = send ? await sendDraft(draft) : await refreshReport(draft);
      if (report) {
        setReports(value => ({ ...value, [draft.id]: report }));
        setDrafts(await listDrafts());
      } else setError("This report has not reached WasteGrid yet. Retry the saved upload.");
    } catch { setError("Unable to sync this report. Your saved upload is still on this device; retry shortly."); }
    finally { setBusy(null); }
  }

  return <SafeAreaView style={{ flex: 1 }}><ScrollView contentContainerStyle={{ padding: 24, gap: 16 }}>
    <Button title="Back to map" onPress={() => router.replace("/")} />
    <Text accessibilityRole="header" style={{ fontSize: 24 }}>My reports</Text>
    <Text>Reports and their private access keys are saved on this device.</Text>
    {busy && <ActivityIndicator />}
    {error ? <Text accessibilityRole="alert">{error}</Text> : null}
    {!busy && !drafts.length && <Text>No reports saved yet.</Text>}
    {drafts.map(draft => <View key={draft.id} style={{ gap: 8, paddingVertical: 12 }}>
      <Text>{draft.fields.title}</Text>
      <Text selectable>{reports[draft.id]?.public_reference ?? draft.reference ?? "Saved on device — upload not confirmed"}</Text>
      {reports[draft.id] && <Text>Status: {reports[draft.id].display_status} · Assessment: {reports[draft.id].assessment_status}</Text>}
      <Button disabled={!!busy} title={draft.reference ? "Refresh status" : "Retry saved upload"} onPress={() => void update(draft, !draft.reference)} />
    </View>)}
  </ScrollView></SafeAreaView>;
}
