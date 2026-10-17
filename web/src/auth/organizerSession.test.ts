import type { SupabaseClient } from "@supabase/supabase-js";
import { expect, test, vi } from "vitest";

import { SupabaseOrganizerSession } from "./organizerSession";

test("signs in, reads the access token, and signs out", async () => {
  const signInWithPassword = vi.fn().mockResolvedValue({ error: null });
  const getSession = vi.fn().mockResolvedValue({
    data: { session: { access_token: "access-token" } },
    error: null,
  });
  const signOut = vi.fn().mockResolvedValue({ error: null });
  const session = new SupabaseOrganizerSession({
    auth: { signInWithPassword, getSession, signOut },
  } as unknown as SupabaseClient);

  await session.signIn("organizer@example.test", "correct-password");

  expect(signInWithPassword).toHaveBeenCalledWith({
    email: "organizer@example.test",
    password: "correct-password",
  });
  await expect(session.getAccessToken()).resolves.toBe("access-token");

  await session.signOut();

  expect(signOut).toHaveBeenCalledOnce();
});

test("propagates an invalid-credentials provider error", async () => {
  const session = new SupabaseOrganizerSession({
    auth: {
      signInWithPassword: vi
        .fn()
        .mockResolvedValue({ error: new Error("Invalid login credentials") }),
    },
  } as unknown as SupabaseClient);

  await expect(session.signIn("organizer@example.test", "wrong-password")).rejects.toThrow(
    "Invalid login credentials",
  );
});
