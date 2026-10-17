import { useSyncExternalStore } from "react";
import { AppState, Platform } from "react-native";
import * as SecureStore from "expo-secure-store";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { authenticate, authFetch, verifyIdentity, type Session } from "./session-client";
export type { Role, Session } from "./session-client";

let current: Session | null = null;
let client: SupabaseClient | undefined;
let generation = 0;
let pending: Promise<void> | null = null;
let loggingOut: Promise<void> | null = null;
let restorationBlocked = false;
let foreground = false;
let refreshRunning = false;
let refreshUpdate = Promise.resolve();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(listener => listener());
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
const storage = {
  getItem: (key: string) => SecureStore.getItemAsync(key),
  setItem: (key: string, value: string) => SecureStore.setItemAsync(key, value, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }),
  removeItem: (key: string) => SecureStore.deleteItemAsync(key),
};
function apiUrl() {
  const url = process.env.EXPO_PUBLIC_API_BASE_URL?.replace(/\/$/, "");
  if (!url) throw new Error("Account sign-in has not been configured for this app.");
  return url;
}
function supabase() {
  if (client) return client;
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const key = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key?.startsWith("sb_publishable_")) throw new Error("Account sign-in has not been configured for this app.");
  client = createClient(url, key, { global: { fetch: authFetch }, auth: {
    persistSession: Platform.OS !== "web", storage: Platform.OS !== "web" ? storage : undefined,
    autoRefreshToken: false, detectSessionInUrl: false,
  } });
  client.auth.onAuthStateChange(event => {
    if (event === "SIGNED_OUT") { generation++; current = null; emit(); }
    // Defer SDK calls until its auth lock has been released.
    if (event === "TOKEN_REFRESHED") setTimeout(() => { void restoreSession(); }, 0);
  });
  return client;
}
export const isAuthBusy = () => pending !== null || loggingOut !== null;

// Serialize refresh start/stop too: a delayed start must not restart refresh
// after logout or backgrounding. The SDK discards in-flight refreshes if the
// stored session has changed or been removed.
function syncAutoRefresh() {
  refreshUpdate = refreshUpdate.then(async () => {
    const enabled = foreground && current !== null && !isAuthBusy() && !restorationBlocked;
    if (!client || enabled === refreshRunning) return;
    if (enabled) await client.auth.startAutoRefresh();
    else await client.auth.stopAutoRefresh();
    refreshRunning = enabled;
  }).catch(() => { /* A later lifecycle transition can retry refresh setup. */ });
  return refreshUpdate;
}
function runAuthentication(action: () => Promise<void>) {
  // Claim the guard synchronously, before any SDK calls or awaits. Callers must
  // reject/skip when occupied; passwords are never queued behind another login.
  const operation = Promise.resolve().then(async () => {
    await syncAutoRefresh();
    await action();
  }).finally(() => {
    pending = null;
    emit();
    void syncAutoRefresh();
  });
  pending = operation;
  emit();
  return operation;
}
export function restoreSession(): Promise<void> {
  if (loggingOut || restorationBlocked) return Promise.resolve();
  if (pending) return pending.catch(() => {});
  const revision = ++generation;
  return runAuthentication(async () => {
    try {
      const { data, error } = await supabase().auth.getSession();
      if (revision !== generation) return;
      if (error) throw error;
      const saved = data.session;
      if (!saved) { current = null; emit(); return; }
      const verified = await verifyIdentity({ userId: saved.user.id, email: saved.user.email ?? "", token: saved.access_token }, authFetch, apiUrl());
      if (revision === generation) { current = verified; emit(); }
    } catch {
      // Keep protected credentials for a foreground retry if the network is down;
      // never restore a privileged role from locally persisted profile data.
      if (revision === generation) { current = null; emit(); }
    }
  });
}
export function startSessionLifecycle() {
  const update = (state: string) => {
    foreground = state === "active";
    if (foreground) void restoreSession();
    void syncAutoRefresh();
  };
  update(AppState.currentState ?? "active");
  const subscription = AppState.addEventListener("change", update);
  return () => { subscription.remove(); foreground = false; void syncAutoRefresh(); };
}
export function signIn(email: string, password: string): Promise<void> {
  if (isAuthBusy()) return Promise.reject(new Error("Authentication is already in progress. Please wait and try again."));
  const revision = ++generation;
  current = null;
  restorationBlocked = true;
  return runAuthentication(async () => {
    const url = apiUrl();
    const auth = supabase().auth;
    const verified = await authenticate(email, password, {
      async signIn(email, password) {
        const { data, error } = await auth.signInWithPassword({ email, password });
        if (error || !data.user || !data.session) {
          throw new Error(error?.message.includes("timed out") ? "Authentication request timed out. Please retry." : "Sign-in failed. Check your email and password.");
        }
        return { userId: data.user.id, email: data.user.email ?? email, token: data.session.access_token };
      },
      async signOut() {
        const { error } = await auth.signOut({ scope: "local" });
        if (error) throw new Error("Unable to clear authentication. Please sign out and retry.");
      },
    }, authFetch, url);
    if (revision !== generation) throw new Error("Sign-in was cancelled. Please try again.");
    current = verified;
    restorationBlocked = false;
    emit();
  });
}
export function signOut(): Promise<void> {
  if (loggingOut) return loggingOut;
  // Immediately revoke UI access, but keep the guard until the outstanding SDK
  // operation settles and its last possible credential write has been removed.
  generation++;
  current = null;
  restorationBlocked = true;
  const outstanding = pending;
  loggingOut = Promise.resolve().then(async () => {
    await syncAutoRefresh();
    await outstanding?.catch(() => {});
    const { error } = await supabase().auth.signOut({ scope: "local" });
    if (error) throw new Error("Unable to finish signing out. Please retry.");
  }).finally(() => {
    loggingOut = null;
    emit();
    void syncAutoRefresh();
  });
  emit();
  return loggingOut;
}
export const getSession = () => current;
export function useSession(): Session | null {
  return useSyncExternalStore(subscribe, getSession, () => null);
}
export function useAuthBusy(): boolean {
  return useSyncExternalStore(subscribe, isAuthBusy, () => false);
}
