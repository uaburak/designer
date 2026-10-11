/**
 * Home's account (docs/multiplayer.md §2): the sidebar's account row shows who is signed in to the multiplayer server
 * and opens Figma's account menu — Log in / Log out. Main does the sign-in in the system browser; Home only asks.
 */
import { useEffect, useState } from "react";
import type { AccountMethod, AccountResponse, AccountState, SignInResult } from "@shared/account";
import type { IdleNotice } from "@shared/ipc";
import { SIGN_IN_ERROR_TEXT } from "@shared/org/identity";
import type { MenuEntry } from "@/ds";
import { storeMode } from "../store";
import { webAccount } from "../store/webAccount";

/** The part of the preload API used here (absent in a plain browser: no account there). */
export interface AccountBridge {
  get(): Promise<AccountState>;
  /** `tenant`: an org's SAML SSO, straight to its IdP (docs/desktop.md §18.1) */
  signIn(opts?: { tenant?: string }): Promise<SignInResult>;
  cancelSignIn(): Promise<AccountState>;
  signOut(): Promise<AccountState>;
  onChanged(cb: (s: AccountState) => void): () => void;
  /** The idle prompt's Stay logged in (docs/desktop.md §18.2); absent on an older preload */
  staySignedIn?(): Promise<AccountState>;
  /** The idle timeout's notices; absent on an older preload */
  onIdle?(cb: (n: IdleNotice) => void): () => void;
  /** Settings: the caller's own account on the server (`/me…`) */
  request(r: { method: AccountMethod; path: string; body?: unknown }): Promise<AccountResponse>;
}

/** The desktop app's preload, or the page's own sign-in in a plain browser (docs/multiplayer.md §2). */
export const accountBridge = (): AccountBridge | null => {
  if (typeof window === "undefined") return null;
  const desktop = (window as unknown as { designer?: { account?: AccountBridge } }).designer?.account;
  if (desktop) return desktop;
  return storeMode() === "dev" && typeof crypto !== "undefined" && !!crypto.subtle ? webAccount : null;
};

/** The account as last heard, for code outside React (the editor's Log out command's enabled state). */
let last: AccountState | null = null;
let watching = false;
export function accountSignedIn(): boolean {
  const b = accountBridge();
  if (b && !watching) {
    watching = true;
    void b.get().then((s) => (last = s), () => {});
    b.onChanged((s) => (last = s));
  }
  return !!last?.user;
}

export type AccountMenuId = "log-in" | "cancel-log-in" | "log-out" | "settings";

/**
 * Figma's account menu: the email, "Settings" (help.figma.com 1500006061462 — the Settings modal), Log out; signed
 * out, Log in (a waiting sign-in can be cancelled) and Settings (the machine's own: theme, fonts, agents).
 */
export function accountMenu(state: AccountState | null): MenuEntry[] {
  const settings: MenuEntry = { id: "settings", label: "Settings" };
  if (!state) return [settings];
  if (state.user) return [{ header: state.user.email }, settings, "-", { id: "log-out", label: "Log out" }];
  if (state.signingIn) return [{ id: "waiting", label: "Waiting for the browser…", disabled: true }, { id: "cancel-log-in", label: "Cancel" }, "-", settings];
  return [{ id: "log-in", label: "Log in with Google…" }, "-", settings];
}

const SSO_TEXTS = new Set<string>(Object.values(SIGN_IN_ERROR_TEXT));

/** Sign-in failures worth a toast (a cancel isn't one); single sign-on's own refusals say why (docs/desktop.md §18.1). */
export function signInFailure(r: SignInResult): string | null {
  if (r.ok || r.error === "cancelled") return null;
  if (r.error === "failed" && r.message && SSO_TEXTS.has(r.message)) return r.message;
  return r.error === "timeout" ? "Log in timed out. Try again." : "Couldn’t log in. Try again.";
}

export function useAccount() {
  const [state, setState] = useState<AccountState | null>(null);
  useEffect(() => {
    const b = accountBridge();
    if (!b) return;
    let live = true;
    void b.get().then((s) => live && setState(s));
    const off = b.onChanged((s) => setState(s));
    return () => {
      live = false;
      off();
    };
  }, []);
  return {
    state,
    available: accountBridge() !== null,
    /** Runs a menu choice; resolves to a failure message for a toast, if any */
    async run(id: string): Promise<string | null> {
      const b = accountBridge();
      if (!b) return null;
      if (id === "log-in") return signInFailure(await b.signIn());
      if (id === "cancel-log-in") await b.cancelSignIn();
      if (id === "log-out") await b.signOut();
      return null;
    },
  };
}
