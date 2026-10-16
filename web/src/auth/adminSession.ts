export interface AdminSession {
  isSignedIn(): boolean;
  signIn(): void;
  signOut(): void;
}
