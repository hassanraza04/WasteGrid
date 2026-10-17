import { createClient } from "@supabase/supabase-js";

export interface LiveReport {
  id: string;
  public_reference: string;
  title: string;
  address: string | null;
  display_status: string;
  assessment_status: string;
  illustrative: boolean;
  photo_id: string;
  completion_photo_ids: string[];
  note: string | null;
}

export interface StaffAuth {
  signIn(email: string, password: string): Promise<void>;
  token(): Promise<string | undefined>;
  signOut(): Promise<void>;
}

export class AccessError extends Error {}

export class DashboardConfigurationError extends Error {}

export class OrganizerApi {
  constructor(private readonly auth: StaffAuth, private readonly baseUrl: string) {}

  async signIn(email: string, password: string): Promise<void> {
    await this.auth.signIn(email, password);
    try {
      const identity = await this.get<{ role: string }>("/auth/me");
      if (identity.role !== "organizer") throw new AccessError("This account does not have organiser access.");
    } catch (error) {
      await this.auth.signOut();
      throw error;
    }
  }

  signOut(): Promise<void> { return this.auth.signOut(); }

  reports(offset: number): Promise<LiveReport[]> {
    return this.get(`/organizer/reports?limit=50&offset=${offset}`);
  }

  async photo(id: string): Promise<string> {
    const result = await this.get<{ url: string }>(`/photos/${encodeURIComponent(id)}/access`);
    return result.url;
  }

  private async get<T>(path: string): Promise<T> {
    const token = await this.auth.token();
    if (!token) throw new AccessError("Please sign in again.");
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(60_000),
        redirect: "error",
      });
    } catch {
      throw new Error("Unable to reach WasteGrid. The service may be waking up; please retry.");
    }
    if (response.status === 401 || response.status === 403) throw new AccessError("Your session expired or access was denied. Please sign in again.");
    if (!response.ok) throw new Error("Unable to load reports. Please retry.");
    return response.json() as Promise<T>;
  }
}

export function createOrganizerApi(): OrganizerApi {
  const baseUrl = configuredUrl(import.meta.env.VITE_API_BASE_URL, "VITE_API_BASE_URL", ["http:", "https:"]);
  const supabaseUrl = configuredUrl(import.meta.env.VITE_SUPABASE_URL, "VITE_SUPABASE_URL", ["https:"]);
  const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (!key?.startsWith("sb_publishable_")) {
    throw new DashboardConfigurationError("Organiser sign-in has not been configured for this build.");
  }
  const client = createClient(supabaseUrl, key, {
    auth: { persistSession: false, autoRefreshToken: true, detectSessionInUrl: false },
  });
  return new OrganizerApi({
    async signIn(email, password) {
      const { error } = await client.auth.signInWithPassword({ email, password });
      if (error) throw new Error("Sign-in failed. Check your email and password and try again.");
    },
    async token() {
      const { data, error } = await client.auth.getSession();
      if (error) return undefined;
      return data.session?.access_token;
    },
    async signOut() {
      // Clears this tab's session even if the logout request cannot reach Auth.
      await client.auth.signOut({ scope: "local" });
    },
  }, baseUrl);
}

function configuredUrl(value: string | undefined, setting: string, protocols: string[]): string {
  if (!value) {
    throw new DashboardConfigurationError("Organiser sign-in has not been configured for this build.");
  }
  try {
    const url = new URL(value);
    if (!protocols.includes(url.protocol)) throw new Error();
    return url.toString().replace(/\/$/, "");
  } catch {
    const protocol = protocols.length === 1 ? protocols[0].replace(":", "").toUpperCase() : "HTTP or HTTPS";
    throw new DashboardConfigurationError(`${setting} must be a valid ${protocol} URL`);
  }
}
