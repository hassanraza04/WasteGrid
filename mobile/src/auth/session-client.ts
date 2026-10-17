export type Role = "user" | "crew" | "admin";
export type Session = { userId: string; email: string; role: Role; crewId?: string };
export type AuthGateway = {
  signIn(email: string, password: string): Promise<{ userId: string; email: string; token: string }>;
  signOut(): Promise<void>;
};

export async function authenticate(
  email: string, password: string, auth: AuthGateway,
  request: typeof fetch, apiUrl: string,
): Promise<Session> {
  try {
    const user = await auth.signIn(email, password);
    return await verifyIdentity(user, request, apiUrl);
  } catch (error) {
    await auth.signOut();
    throw error;
  }
}

export async function verifyIdentity(
  user: { userId: string; email: string; token: string }, request: typeof fetch, apiUrl: string,
): Promise<Session> {
  const response = await request(`${apiUrl}/auth/me`, {
    headers: { Authorization: `Bearer ${user.token}` },
    signal: AbortSignal.timeout(60_000), redirect: "error",
  });
  // A verified Supabase user without a staff membership is a resident.
  if (response.status === 403) return { userId: user.userId, email: user.email, role: "user" };
  if (!response.ok) throw new Error("Unable to verify your account. Please try again.");
  const identity = await response.json();
  if (identity.user_id !== user.userId || !["organizer", "crew"].includes(identity.role)) {
    throw new Error("Unable to verify your account role.");
  }
  if (identity.role === "crew" && !identity.crew_id) throw new Error("Your crew account has not been assigned to a crew.");
  return { userId: user.userId, email: user.email, role: identity.role === "organizer" ? "admin" : "crew", crewId: identity.crew_id ?? undefined };
}

// Abort the actual transport, including response-body reads. Do not release the
// auth guard via Promise.race while an SDK request can still write credentials.
export async function authFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const callerSignal = init?.signal ?? (typeof Request !== "undefined" && input instanceof Request ? input.signal : undefined);
  const abort = () => controller.abort(callerSignal?.reason);
  callerSignal?.addEventListener("abort", abort, { once: true });
  if (callerSignal?.aborted) abort();
  const timer = setTimeout(() => controller.abort(new Error("Authentication request timed out. Please retry.")), 60_000);
  try {
    const response = await fetch(input, { ...init, signal: controller.signal });
    const body = await response.arrayBuffer();
    return new Response(body.byteLength ? body : null, {
      status: response.status, statusText: response.statusText, headers: response.headers,
    });
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", abort);
  }
}
