import type { AdminSession } from "./adminSession";

const sessionKey = "wastegrid.demo.admin-session";

export function createDevelopmentAdminSession(
  storage: Storage,
  isDevelopment: boolean,
): BrowserAdminSession | undefined {
  return isDevelopment ? new BrowserAdminSession(storage) : undefined;
}

export class BrowserAdminSession implements AdminSession {
  public constructor(private readonly storage: Storage) {}

  public isSignedIn(): boolean {
    return this.storage.getItem(sessionKey) === "signed-in";
  }

  public signIn(): void {
    this.storage.setItem(sessionKey, "signed-in");
  }

  public signOut(): void {
    this.storage.removeItem(sessionKey);
  }
}
