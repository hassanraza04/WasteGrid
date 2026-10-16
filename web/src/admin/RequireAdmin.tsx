import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";

import type { AdminSession } from "../auth/adminSession";

interface RequireAdminProperties {
  children: ReactNode;
  session: AdminSession;
}

export function RequireAdmin({ children, session }: RequireAdminProperties) {
  return session.isSignedIn() ? children : <Navigate to="/admin/sign-in" replace />;
}
