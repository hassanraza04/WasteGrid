import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, StyleSheet, View } from "react-native";
import { AppText, Button, Card, TextField } from "@/components/ui";
import { getSession, useSession } from "@/auth/session";
import { phoneUpdates, sendPhoneUpdate } from "@/services/reports";
import type { ReportDraft } from "@/services/report-client";
import { isDefinitePhoneRejection, PhoneUpdatesError, statusCommand, type PhoneUpdates, type PhoneUpdateStatus } from "@/services/phone-updates-client";
import { Spacing } from "@/theme";

type PhoneState = PhoneUpdates & { pending: boolean };
const delivery: Record<PhoneUpdateStatus, string> = {
  queued: "Phone copy queued",
  sending: "Sending phone copy…",
  submitted: "Phone delivery pending",
  delivered: "Phone copy delivered",
  failed: "Phone copy could not be sent",
  uncertain: "Phone delivery unconfirmed",
  cancelled: "Phone copy cancelled",
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
  const [manualCheckId, setManualCheckId] = useState<string | null>(null);
  const alive = useRef(true);
  const working = useRef(false);
  const foreground = useRef(true);
  const polling = useRef<{ id: string; until: number } | null>(null);
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
      foreground.current = value === "active";
      if (foreground.current) void run(refresh);
    });
    return () => { alive.current = false; subscription.remove(); };
  }, [refresh, run]);
  const receipt = state?.latest_request;
  const awaitingDelivery = !!receipt && ["queued", "sending", "uncertain"].includes(receipt.status);
  const receiptId = receipt?.id;
  const receiptStatus = receipt?.status;
  useEffect(() => {
    if (!receiptId || !receiptStatus || !["queued", "sending", "submitted", "uncertain"].includes(receiptStatus)) return;
    if (polling.current?.id !== receiptId) polling.current = { id: receiptId, until: Date.now() + 90_000 };
    const until = polling.current.until;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (stopped) return;
      if (Date.now() >= until) { setManualCheckId(receiptId); return; }
      timer = setTimeout(async () => {
        if (stopped || !valid()) return;
        if (foreground.current) await run(refresh);
        schedule();
      }, 3_000);
    };
    schedule();
    return () => { stopped = true; clearTimeout(timer); };
  }, [receiptId, receiptStatus, refresh, run, valid]);
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
  const canCheck = !state?.pending && (!!error || receipt?.status === "uncertain" || (manualCheckId === receiptId && ["queued", "sending", "submitted", "uncertain"].includes(receiptStatus ?? "")));
  return <View style={s.section}>
    <AppText variant="title">Report updates</AppText>
    {state?.enabled && !state.pending && <>
      <AppText variant="caption" tone="muted">A copy will go to {state.phone_label?.replace(/^Registered /, "") ?? "the registered phone"}.</AppText>
      <View style={s.composer}>
        <TextField accessibilityLabel="Message for report update" placeholder="Type Status" value={message} style={s.field}
          onChangeText={setMessage} editable={!busy && !awaitingDelivery} autoCorrect={false} maxLength={100} />
        <Button label="Send" disabled={busy || awaitingDelivery || !message.trim()} onPress={() => send()} style={s.send} />
      </View>
    </>}
    {receipt && <Card padding={Spacing.lg} style={s.section}>
      <AppText accessibilityLiveRegion="polite">{receipt.message}</AppText>
      <AppText variant="caption" tone="muted" accessibilityLiveRegion="polite">{delivery[receipt.status]}</AppText>
    </Card>}
    {error ? <AppText variant="caption" accessibilityRole="alert">{error}</AppText> : null}
    {state?.pending && <View style={s.section}>
      <AppText variant="caption" tone="muted">Request saved. Retry to confirm the same request.</AppText>
      <Button label="Retry request" variant="ghost" disabled={busy} onPress={() => send(true)} style={s.recovery} />
    </View>}
    {state && !state.enabled && <AppText variant="caption" tone="muted">Phone updates unavailable. You can still track this report here.</AppText>}
    {canCheck && <Button label="Check again" variant="ghost" disabled={busy} onPress={() => void run(refresh)} style={s.recovery} />}
    {!state && busy && <AppText variant="caption" tone="muted">Loading updates…</AppText>}
  </View>;
}
const s = StyleSheet.create({
  section: { gap: Spacing.sm },
  composer: { flexDirection: "row", alignItems: "center", gap: Spacing.sm },
  field: { flex: 1, minWidth: 0 },
  send: { paddingHorizontal: Spacing.lg },
  recovery: { alignSelf: "flex-start" },
});
