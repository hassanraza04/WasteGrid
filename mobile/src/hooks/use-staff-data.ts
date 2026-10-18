import { useCallback, useRef, useState } from "react";
import { AppState } from "react-native";
import { useFocusEffect } from "expo-router";
import { getSession, useSession } from "@/auth/session";

// Focused, foreground-only polling. Old accounts and overlapping reads cannot publish.
export function useStaffData<T>(read: () => Promise<T>, interval = 15000) {
  const session = useSession();
  const [result, setResult] = useState<{ owner: typeof session; data: T | null; error: string; loading: boolean } | null>(null);
  const refresh = useRef<() => Promise<void>>(async () => {});
  useFocusEffect(useCallback(() => {
    let active = true, busy = false, queued = false;
    const load = async () => {
      if (!active || AppState.currentState !== "active" || !session) return;
      if (busy) { queued = true; return; }
      busy = true;
      setResult(previous => ({ owner: session, data: previous?.owner === session ? previous.data : null, error: "", loading: true }));
      try {
        const data = await read();
        if (active && getSession() === session) setResult({ owner: session, data, error: "", loading: false });
      } catch (error) {
        if (active && getSession() === session) setResult({ owner: session, data: null, error: error instanceof Error ? error.message : "Unable to refresh. Try again.", loading: false });
      } finally {
        busy = false;
        // A mutation/focus refresh during a read must observe the new server
        // state, rather than being silently dropped behind an older snapshot.
        if (queued && active) { queued = false; void load(); }
      }
    };
    refresh.current = load;
    void load();
    const timer = setInterval(() => { void load(); }, interval);
    const subscription = AppState.addEventListener("change", state => { if (state === "active") void load(); });
    return () => { active = false; clearInterval(timer); subscription.remove(); };
  }, [session, read, interval]));
  const visible = result?.owner === session ? result : null;
  return { data: visible?.data ?? null, error: visible?.error ?? "", loading: visible?.loading ?? true, refresh: () => refresh.current() };
}
