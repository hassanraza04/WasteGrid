import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Platform, StyleSheet, View } from "react-native";
import * as Linking from "expo-linking";
import { AppText, Button } from "@/components/ui";
import { getSession, useSession } from "@/auth/session";
import { followupLink, messagingLinks, reportMessages, unlinkReportMessaging } from "@/services/reports";
import type { FollowupLink, MessagingLinks, ReportDraft, ReportMessage } from "@/services/report-client";
import { Spacing } from "@/theme";

export function ReportMessaging({ draft }: { draft: ReportDraft }) {
  const session = useSession();
  if (!session || draft.ownerId !== session.userId) return null;
  return <ReportMessagingContent key={`${draft.id}:${session.userId}`} draft={draft} owner={session.userId} />;
}

function ReportMessagingContent({ draft, owner }: { draft: ReportDraft; owner: string }) {
  const [links, setLinks] = useState<MessagingLinks | null>(null);
  const [code, setCode] = useState<FollowupLink | null>(null);
  const [messages, setMessages] = useState<ReportMessage[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const alive = useRef(true);
  const working = useRef(false);
  const valid = useCallback(() => alive.current && getSession()?.userId === owner, [owner]);
  const run = useCallback(async (work: () => Promise<void>) => {
    if (working.current || !valid()) return;
    working.current = true; setBusy(true); setError("");
    try { await work(); }
    catch { if (valid()) setError("Messaging is temporarily unavailable. Check your connection and retry."); }
    finally { working.current = false; if (valid()) setBusy(false); }
  }, [valid]);
  const refresh = useCallback(async () => {
    const value = await messagingLinks(draft);
    if (!valid()) return;
    setLinks(value);
    if (value.links.some(link => link.active)) setCode(null);
  }, [draft, valid]);
  useEffect(() => {
    alive.current = true;
    // Defer startup to the next microtask so progress state is not changed
    // synchronously while React is applying effects.
    void Promise.resolve().then(() => run(refresh));
    const state = AppState.addEventListener("change", value => {
      if (value === "active") {
        setCode(previous => previous && Date.parse(previous.expires_at) <= Date.now() ? null : previous);
        void run(refresh);
      }
    });
    return () => { alive.current = false; state.remove(); };
  }, [refresh, run]);
  useEffect(() => {
    if (!code) return;
    const timer = setTimeout(() => setCode(null), Math.max(0, Math.min(Date.parse(code.expires_at) - Date.now(), 2_147_483_647)));
    return () => clearTimeout(timer);
  }, [code]);
  const loadMessages = async (offset: number) => {
    const page = await reportMessages(draft, offset);
    if (!valid()) return;
    setMessages(previous => [...new Map([...(offset ? previous : []), ...page.items].map(item => [item.id, item])).values()]);
    const end = page.offset + page.items.length;
    setNext(page.items.length && end < page.total ? end : null);
  };
  const active = links?.links.filter(link => link.active) ?? [];
  const liveCode = code;
  return <View style={s.section}>
    <AppText variant="title">iMessage updates</AppText>
    <AppText tone="muted">Optional: link this report to Messages for status updates and questions in English. Sending the link command consents to messages. Send STOP in the chat to pause updates, or unlink this report here.</AppText>
    {links && <AppText>{active.length ? active.some(link => link.paused) ? "Linked · updates paused. Send START in Messages to resume." : "Linked · updates enabled" : "This report is not linked."}</AppText>}
    {error ? <AppText accessibilityRole="alert">{error}</AppText> : null}
    {!active.length && <Button label="Get iMessage updates" disabled={busy || !links?.enabled} onPress={() => void run(async () => {
      const value = await followupLink(draft);
      if (valid()) setCode(value);
    })} />}
    {links && !links.enabled && <AppText tone="muted">iMessage linking is not available right now. Your report remains available in the app.</AppText>}
    {liveCode && <View style={s.section}>
      <AppText selectable>Send LINK {liveCode.link_code} to {liveCode.recipient} in iMessage.</AppText>
      <AppText tone="muted">This code expires at {new Date(liveCode.expires_at).toLocaleTimeString()}. Linking is confirmed only after WasteGrid receives the command.</AppText>
      {Platform.OS === "ios" ? <Button label="Open Messages" variant="outline" disabled={busy} onPress={() => void run(async () => {
        if (Date.parse(liveCode.expires_at) <= Date.now()) { if (valid()) setCode(null); return; }
        await Linking.openURL(`sms:${encodeURIComponent(liveCode.recipient)}&body=${encodeURIComponent(`LINK ${liveCode.link_code}`)}`);
      })} /> : <AppText tone="muted">Use an iMessage-capable Apple device to send this command. You can continue tracking the report here on this device.</AppText>}
    </View>}
    <Button label="Refresh messaging status" variant="outline" disabled={busy} onPress={() => void run(refresh)} />
    {active.map(link => <Button key={link.id} label="Unlink this report" variant="outline" disabled={busy} onPress={() => void run(async () => {
      await unlinkReportMessaging(draft, link.id);
      if (!valid()) return;
      setCode(null); await refresh();
    })} />)}
    <AppText variant="title">Report conversation</AppText>
    <AppText tone="muted">Only messages linked to this report appear here.</AppText>
    {messages.map(message => <View key={message.id} style={s.message}>
      <AppText>{message.direction === "inbound" ? "You" : "WasteGrid"}: {message.body}</AppText>
      <AppText tone="muted">{new Date(message.created_at).toLocaleString()}</AppText>
    </View>)}
    <Button label="Refresh conversation" variant="outline" disabled={busy} onPress={() => void run(() => loadMessages(0))} />
    {next !== null && <Button label="Load more messages" variant="outline" disabled={busy} onPress={() => void run(() => loadMessages(next))} />}
    {busy && <AppText tone="muted">Checking messaging…</AppText>}
  </View>;
}
const s = StyleSheet.create({ section: { gap: Spacing.sm }, message: { gap: Spacing.xs } });
