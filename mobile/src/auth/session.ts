// session.ts — who is signed in. Frontend placeholder: nothing is checked and it resets when the app restarts.
// Swap the internals for real auth later; screens only use useSession / signIn / signOut.
import { useSyncExternalStore } from "react";

// user: reports waste. crew: also works an assigned cleanup route. admin: also plans and assigns routes.
export type Role = "user" | "crew" | "admin";

export type Session = {
  email: string;
  role: Role;
  crewId?: string; // set for crew members: which crew's route they see
};

let current: Session | null = null;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function signIn(session: Session) {
  current = session;
  emit();
}

export function signOut() {
  current = null;
  emit();
}

// Re-renders the calling component whenever someone signs in or out
export function useSession(): Session | null {
  return useSyncExternalStore(subscribe, () => current);
}
