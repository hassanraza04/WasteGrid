import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";

import type { OrganizerSession } from "../auth/organizerSession";

interface AdminSignInPageProperties {
  session: OrganizerSession;
}

export function AdminSignInPage({ session }: AdminSignInPageProperties) {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string>();
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function signIn(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(undefined);
    setIsSubmitting(true);

    try {
      await session.signIn(email, password);
      navigate("/admin");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Sign in failed.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main>
      <h1>Organizer sign in</h1>
      <form onSubmit={signIn}>
        <p>
          <label htmlFor="organizer-email">Email</label>
          <input
            autoComplete="email"
            id="organizer-email"
            onChange={(event) => setEmail(event.target.value)}
            required
            type="email"
            value={email}
          />
        </p>
        <p>
          <label htmlFor="organizer-password">Password</label>
          <input
            autoComplete="current-password"
            id="organizer-password"
            onChange={(event) => setPassword(event.target.value)}
            required
            type="password"
            value={password}
          />
        </p>
        {error ? <p role="alert">{error}</p> : null}
        <button disabled={isSubmitting} type="submit">
          Sign in
        </button>
      </form>
    </main>
  );
}
