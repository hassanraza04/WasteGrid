import { useSyncExternalStore } from "react";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { authenticate, type Session } from "./session-client";
export type { Role, Session } from "./session-client";

let current: Session | null = null;
let client: SupabaseClient | undefined;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(listener => listener());
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
function supabase() {
  if (client) return client;
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const key = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key?.startsWith("sb_publishable_")) throw new Error("Account sign-in has not been configured for this app.");
  client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: true, detectSessionInUrl: false } });
  client.auth.onAuthStateChange(event => {
    if (event === "SIGNED_OUT") { current = null; emit(); }
  });
  return client;
}
export async function signIn(email: string, password: string) {
  const apiUrl = process.env.EXPO_PUBLIC_API_BASE_URL?.replace(/\/$/, "");
  if (!apiUrl) throw new Error("Account sign-in has not been configured for this app.");
  const auth = supabase().auth;
  current = await authenticate(email, password, {
    async signIn(email, password) {
      const { data, error } = await auth.signInWithPassword({ email, password });
      if (error || !data.user || !data.session) throw new Error("Sign-in failed. Check your email and password.");
      return { userId: data.user.id, email: data.user.email ?? email, token: data.session.access_token };
    },
    async signOut() { await auth.signOut({ scope: "local" }); },
  }, fetch, apiUrl);
  emit();
}
export async function signOut() {
  current = null;
  emit();
  await client?.auth.signOut({ scope: "local" });
}
export const getSession = () => current;
export function useSession(): Session | null {
  return useSyncExternalStore(subscribe, getSession, () => null);
}
