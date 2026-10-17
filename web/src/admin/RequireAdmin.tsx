import { useEffect, useState, type ReactNode } from "react";
import { Navigate } from "react-router-dom";

import type { OrganizerSession } from "../auth/organizerSession";
import type { OrganizerApi } from "../data/organizerApi";

interface RequireAdminProperties {
  children: ReactNode;
  session: OrganizerSession;
  api: OrganizerApi;
}

type AuthorizationState = "checking" | "authorized" | "unauthorized";

export function RequireAdmin({ children, session, api }: RequireAdminProperties) {
  const [authorization, setAuthorization] = useState<AuthorizationState>("checking");

  useEffect(() => {
    let active = true;

    async function checkAccess(): Promise<void> {
      try {
        const accessToken = await session.getAccessToken();
        if (!accessToken) {
          if (active) {
            setAuthorization("unauthorized");
          }
          return;
        }
        const identity = await api.getIdentity(accessToken);
        if (active) {
          setAuthorization(identity.role === "organizer" ? "authorized" : "unauthorized");
        }
      } catch {
        await session.signOut().catch(() => undefined);
        if (active) {
          setAuthorization("unauthorized");
        }
      }
    }

    void checkAccess();
    return () => {
      active = false;
    };
  }, [api, session]);

  if (authorization === "checking") {
    return <p>Checking organizer access…</p>;
  }

  return authorization === "authorized" ? children : <Navigate replace to="/admin/sign-in" />;
}
