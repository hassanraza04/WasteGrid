import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, StyleSheet, View } from "react-native";
import { AppText, Button, TextField } from "@/components/ui";
import { getSession, useSession } from "@/auth/session";
import { phoneUpdates, sendPhoneUpdate } from "@/services/reports";
import type { ReportDraft } from "@/services/report-client";
import { isDefinitePhoneRejection, PhoneUpdatesError, statusCommand, type PhoneUpdates, type PhoneUpdateStatus } from "@/services/phone-updates-client";
import { Spacing } from "@/theme";

type PhoneState = PhoneUpdates & { pending: boolean };
const delivery: Record<PhoneUpdateStatus, string> = {
  queued: "Update queued.",
  sending: "Submitting update to the phone service.",
  submitted: "Update submitted. Delivery has not been confirmed.",
  delivered: "Update delivered to the registered phone.",
  failed: "The phone update could not be sent.",
  uncertain: "Delivery is uncertain. Check delivery status before requesting another update.",
  cancelled: "Phone update cancelled.",
};

export function ReportMessaging({ draft }: { draft: ReportDraft }) {
  const session = useSession();
  if (!session || draft.ownerId !== session.userId) return null;
  return <PhoneUpdatesContent key={`${draft.id}:${session.userId}`} draft={draft} owner={session.userId} />;
}
function PhoneUpdatesContent({ draft, owner }: { draft: ReportDraft; owner: string }) {
  const [state, setState] = useState<PhoneState | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const alive = useRef(true);
  const working = useRef(false);
  const valid = useCallback(() => alive.current && getSession()?.userId === owner, [owner]);
  const run = useCallback(async (work: () => Promise<void>) => {
    if (working.current || !valid()) return;
    working.current = true; setBusy(true); setError("");
    try { await work(); }
    catch (failure) {
      if (valid()) setError(failure instanceof PhoneUpdatesError ? failure.message : "Phone updates could not be checked. Please try again.");
    } finally { working.current = false; if (valid()) setBusy(false); }
  }, [valid]);
  const refresh = useCallback(async () => {
    const value = await phoneUpdates(draft);
    if (valid()) setState(value);
  }, [draft, valid]);
  useEffect(() => {
    alive.current = true;
    void Promise.resolve().then(() => run(refresh));
    const subscription = AppState.addEventListener("change", value => {
      if (value === "active") void run(refresh);
    });
    return () => { alive.current = false; subscription.remove(); };
  }, [refresh, run]);
  const receipt = state?.latest_request;
  const awaitingDelivery = !!receipt && ["queued", "sending", "uncertain"].includes(receipt.status);
  const send = (retry = false) => {
    if (!state || (retry ? !state.pending : !state.enabled || awaitingDelivery)) return;
    let text: string;
    try { text = statusCommand(retry ? "Status" : message); }
    catch (failure) { setError((failure as Error).message); return; }
    void run(async () => {
      try {
        const value = await sendPhoneUpdate(draft, text);
        if (!valid()) return;
        setState(previous => previous ? { ...previous, latest_request: value, pending: false } : previous);
        setMessage("");
      } catch (failure) {
        if (valid() && failure instanceof PhoneUpdatesError && failure.status === 409) await refresh().catch(() => {});
        if (valid() && !isDefinitePhoneRejection(failure)) {
          setState(previous => previous ? { ...previous, pending: true } : previous);
        }
        throw failure;
      }
    });
  };
  if (state && !state.enabled && !receipt && !state.pending && !error) return null;
  return <View style={s.section}>
    <AppText variant="title">Phone updates</AppText>
    <AppText tone="muted">Your report status stays available here in the app.</AppText>
    {state?.phone_label && <AppText>{state.phone_label}</AppText>}
    {error ? <AppText accessibilityRole="alert">{error}</AppText> : null}
    {state && !state.enabled && <AppText tone="muted">Phone updates are not available for this report right now. Keep tracking it here.</AppText>}
    {receipt && <View style={s.section}>
      <AppText>{delivery[receipt.status]}</AppText>
      <AppText tone="muted">{receipt.message}</AppText>
    </View>}
    {state?.pending && <View style={s.section}>
      <AppText tone="muted">Your last request is saved, but confirmation is missing. Check its status or retry the same request.</AppText>
      <Button label="Retry request" variant="outline" disabled={busy} onPress={() => send(true)} />
    </View>}
    {state?.enabled && !state.pending && <>
      <TextField label="Message" accessibilityLabel="Message for phone update" placeholder="Type Status" value={message}
        onChangeText={setMessage} editable={!busy && !awaitingDelivery} autoCorrect={false} maxLength={100} />
      <AppText tone="muted">Tapping Send to phone sends this report&apos;s current status to the registered phone shown above.</AppText>
      <Button label="Send to phone" disabled={busy || awaitingDelivery || !message.trim()} onPress={() => send()} />
    </>}
    <Button label="Check delivery status" variant="outline" disabled={busy} onPress={() => void run(refresh)} />
    {busy && <AppText tone="muted">Checking phone updates…</AppText>}
  </View>;
}
const s = StyleSheet.create({ section: { gap: Spacing.sm } });
