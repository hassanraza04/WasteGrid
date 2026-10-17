import { useNavigate } from "react-router-dom";

import type { AdminSession } from "../auth/adminSession";

interface AdminSignInPageProperties {
  session: AdminSession;
}

export function AdminSignInPage({ session }: AdminSignInPageProperties) {
  const navigate = useNavigate();

  function signIn(): void {
    session.signIn();
    navigate("/admin");
  }

  return (
    <main>
      <h1>Organizer sign in</h1>
      <p>This development-only session will be replaced by production authentication.</p>
      <button type="button" onClick={signIn}>
        Continue as organizer
      </button>
    </main>
  );
}
