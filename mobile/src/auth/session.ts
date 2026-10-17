import { useSyncExternalStore } from "react";
import { AppState, Platform } from "react-native";
import * as SecureStore from "expo-secure-store";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { authenticate, verifyIdentity, type Session } from "./session-client";
export type { Role, Session } from "./session-client";

let current: Session | null = null;
let client: SupabaseClient | undefined;
let generation = 0;
let signingIn = false;
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
  client = createClient(url, key, { auth: {
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
export async function restoreSession() {
  if (signingIn) return;
  const revision = ++generation;
  try {
    const { data, error } = await supabase().auth.getSession();
    if (revision !== generation) return;
    if (error) throw error;
    const saved = data.session;
    if (!saved) { current = null; emit(); return; }
    const verified = await verifyIdentity({ userId: saved.user.id, email: saved.user.email ?? "", token: saved.access_token }, fetch, apiUrl());
    if (revision === generation) { current = verified; emit(); }
  } catch {
    // Keep protected credentials for a foreground retry if the network is down;
    // never restore a privileged role from locally persisted profile data.
    if (revision === generation) { current = null; emit(); }
  }
}
export function startSessionLifecycle() {
  const update = (state: string) => {
    try {
      if (state === "active") { void supabase().auth.startAutoRefresh(); void restoreSession(); }
      else { void client?.auth.stopAutoRefresh(); }
    } catch { /* Unconfigured builds still support anonymous reporting. */ }
  };
  update(AppState.currentState ?? "active");
  const subscription = AppState.addEventListener("change", update);
  return () => { subscription.remove(); void client?.auth.stopAutoRefresh(); };
}
export async function signIn(email: string, password: string) {
  const url = apiUrl();
  const auth = supabase().auth;
  signingIn = true;
  const revision = ++generation;
  current = null; emit();
  try {
    const verified = await authenticate(email, password, {
      async signIn(email, password) {
        const { data, error } = await auth.signInWithPassword({ email, password });
        if (error || !data.user || !data.session) throw new Error("Sign-in failed. Check your email and password.");
        return { userId: data.user.id, email: data.user.email ?? email, token: data.session.access_token };
      },
      async signOut() { await auth.signOut({ scope: "local" }); },
    }, fetch, url);
    if (revision === generation) { current = verified; emit(); }
  } finally { signingIn = false; }
}
export async function signOut() {
  generation++;
  const result = await client?.auth.signOut({ scope: "local" });
  if (result?.error) throw new Error("Unable to finish signing out. Please retry.");
  current = null; emit();
}
export const getSession = () => current;
export function useSession(): Session | null {
  return useSyncExternalStore(subscribe, getSession, () => null);
}
