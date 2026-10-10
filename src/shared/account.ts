/**
 * The signed-in account (docs/multiplayer.md §2): who the user is on the multiplayer server. Main holds the session
 * token (safeStorage) and never hands it to a view; views see this state only.
 */

export interface AccountUser {
  id: string;
  email: string;
  name: string | null;
  picture: string | null;
}

export interface AccountState {
  /** The server signed in to (or that sign-in would use) */
  server: string;
  user: AccountUser | null;
  /** A sign-in is waiting for the browser */
  signingIn: boolean;
}

export type SignInResult = { ok: true; state: AccountState } | { ok: false; error: "cancelled" | "timeout" | "failed"; message?: string; state: AccountState };

/** The production server; `DESIGNER_SERVER` overrides it (e.g. http://localhost:8787 for `npm --prefix server run dev`). */
export const DEFAULT_SERVER = "https://designer.burak-kc-sp.workers.dev";
