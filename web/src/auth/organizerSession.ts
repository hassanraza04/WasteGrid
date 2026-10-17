import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export interface OrganizerSession {
  signIn(email: string, password: string): Promise<void>;
  getAccessToken(): Promise<string | undefined>;
  signOut(): Promise<void>;
}

export class SupabaseOrganizerSession implements OrganizerSession {
  public constructor(private readonly client: SupabaseClient) {}

  public async signIn(email: string, password: string): Promise<void> {
    const { error } = await this.client.auth.signInWithPassword({ email, password });
    if (error) {
      throw error;
    }
  }

  public async getAccessToken(): Promise<string | undefined> {
    const { data, error } = await this.client.auth.getSession();
    if (error) {
      throw error;
    }
    return data.session?.access_token;
  }

  public async signOut(): Promise<void> {
    const { error } = await this.client.auth.signOut();
    if (error) {
      throw error;
    }
  }
}

export function createOrganizerSession(
  url: string,
  publishableKey: string,
): OrganizerSession {
  return new SupabaseOrganizerSession(createClient(url, publishableKey));
}
