/**
 * The legacy page-facing desktop API (`native()` in app/native.ts), kept for
 * the site admin's code (the sign-in, the theme, links) while it lives on.
 * It is built on the role's `window.desktop` (src/shared/desktop.ts); new
 * code reads `window.desktop` directly.
 */

export type ThemePreference = "system" | "light" | "dark";

/** A Google sign-in made in the browser, handed to the app: Firebase signs in with it (signInWithCredential). */
export interface GoogleCredential {
  idToken: string;
  accessToken: string | null;
}

/** How the browser's sign-in ended, as main answers it (a rejected IPC handler would be logged as an error: a cancel isn't one). */
export type SignInResult = { credential: GoogleCredential } | { cancelled: true } | { error: string };

export interface NativeApi {
  platform: string;
  version: string;
  /** The sign-in, in the system's browser — it settles once the account is picked there (or fails, or is cancelled). Home only. */
  signInWithGoogle(): Promise<GoogleCredential>;
  cancelSignIn(): void;
  /** An http(s) address, in the system's browser */
  openExternal(url: string): void;
  setTheme(theme: ThemePreference): void;
}
