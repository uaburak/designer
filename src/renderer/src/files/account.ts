/**
 * Home's account (docs/multiplayer.md §2, docs/desktop.md §18.7): the sidebar's account row shows who is signed in to the
 * multiplayer server and opens Figma's account menu. Main does the sign-ins, keeps the accounts and switches between
 * them; Home only asks.
 */
import { useEffect, useState } from "react";
import type { AccountMethod, AccountResponse, AccountState, SignInMethod, SignInResult } from "@shared/account";
import type { IdleNotice } from "@shared/ipc";
import { SIGN_IN_ERROR_TEXT } from "@shared/org/identity";
import { setThemePreference, type MenuEntry, type ThemePreference } from "@/ds";
import { storeMode } from "../store";
import { webAccount } from "../store/webAccount";

/** The part of the preload API used here (absent in a plain browser: no account there). */
export interface AccountBridge {
  get(): Promise<AccountState>;
  /** `tenant`: an org's SAML SSO, straight to its IdP (docs/desktop.md §18.1) */
  signIn(opts?: { tenant?: string; method?: SignInMethod }): Promise<SignInResult>;
  cancelSignIn(): Promise<AccountState>;
  signOut(): Promise<AccountState>;
  /** Several accounts (docs/desktop.md §18.7): the app moves to another signed-in one; absent in a browser */
  switchTo?(userId: string): Promise<AccountState>;
  /** Log out of all accounts; absent in a browser */
  signOutAll?(): Promise<AccountState>;
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

export type AccountMenuId = "log-in" | "cancel-log-in" | "profile" | "settings" | "add-account" | "log-out" | "log-out-all" | `theme:${ThemePreference}` | `account:${string}`;

/** Figma's theme choices (the editor's Preferences › Theme, `theme.*` commands): Light, Dark, Use system setting */
const THEMES: { id: ThemePreference; label: string }[] = [
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
  { id: "system", label: "Use system setting" },
];

/**
 * Figma's account menu on Home (the owner's screenshot of live Figma, 2026-10-12; help.figma.com 360041064554 for the
 * accounts): a header — the photo, the name underlined (Figma's link to the profile; here Settings › Account), the
 * email — then **Change theme ›** (a window glyph) and **Settings** (sliders), then the accounts (when more than one
 * is signed in: each with its photo, the current one checked at the row's end), **Add account** and **Log out** (and
 * **Log out of all accounts** with more than one). Every row keeps the glyph column, so all text starts at one edge. Figma's
 * Community section (View Community profile, Saved from Community) is left out. Signed out (no gate: a browser,
 * development): Log in (a waiting sign-in can be cancelled), Change theme and Settings.
 * `multi`: several accounts can be signed in (the desktop app).
 */
export function accountMenu(state: AccountState | null, o: { theme: ThemePreference; multi?: boolean } = { theme: "system" }): MenuEntry[] {
  const theme: MenuEntry = { id: "theme", label: "Change theme", icon: "24.window.layout", items: THEMES.map((t) => ({ id: `theme:${t.id}`, label: t.label, checked: o.theme === t.id })) };
  const settings: MenuEntry = { id: "settings", label: "Settings", icon: "24.sliders" };
  if (!state) return [theme, settings];
  const user = state.user;
  if (!user) {
    if (state.signingIn) return [{ id: "waiting", label: "Waiting for the browser…", disabled: true }, { id: "cancel-log-in", label: "Cancel" }, "-", theme, settings];
    return [{ id: "log-in", label: "Log in with Google…" }, "-", theme, settings];
  }
  const accounts = (state.accounts ?? []).length ? state.accounts! : [user];
  const several = !!o.multi && accounts.length > 1;
  return [
    { id: "profile", label: user.name || user.email, profile: { email: user.email, ...(user.picture ? { picture: user.picture } : {}) } },
    "-",
    theme,
    settings,
    "-",
    ...(several
      ? accounts.map((a): MenuEntry => ({ id: `account:${a.id}`, label: a.name || a.email, ...(a.name ? { hint: a.email } : {}), avatar: { name: a.name || a.email, ...(a.picture ? { picture: a.picture } : {}) }, checked: a.id === user.id, checkEnd: true }))
      : []),
    ...(o.multi ? [{ id: "add-account", label: "Add account", icon: "24.plus" } as const] : []),
    { id: "log-out", label: "Log out", icon: "24.log-out" },
    ...(several ? [{ id: "log-out-all", label: "Log out of all accounts" }] : []),
  ];
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
    /** Several accounts can be signed in (the desktop app) */
    multi: !!accountBridge()?.switchTo,
    /** Runs a menu choice; resolves to a failure message for a toast, if any */
    async run(id: string): Promise<string | null> {
      const b = accountBridge();
      if (!b) return null;
      if (id === "log-in") return signInFailure(await b.signIn());
      if (id === "cancel-log-in") await b.cancelSignIn();
      if (id === "log-out") await b.signOut();
      if (id === "log-out-all") await b.signOutAll?.();
      // Add account: the usual sign-in, the current account kept until the new one is in (main switches then).
      if (id === "add-account") return signInFailure(await b.signIn());
      if (id.startsWith("account:")) await b.switchTo?.(id.slice("account:".length));
      if (id.startsWith("theme:")) setThemePreference(id.slice("theme:".length) as ThemePreference);
      return null;
    },
  };
}
