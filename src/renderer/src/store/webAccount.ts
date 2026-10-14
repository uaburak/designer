/**
 * The account in a plain browser (`npm run web`; docs/multiplayer.md §2): the same Log in with Google as the desktop
 * app, but the Worker sends the browser back to this page (with `auth_code` / `auth_state`) instead of a loopback, and
 * the page trades the code (with its PKCE verifier) for the session itself. The session lives in localStorage, shared
 * by the page's tabs, and goes to the page's own dev store — whose rooms a tab joins only for the file it edits (Home
 * tabs none: several tabs share one storage, and one file's frames must be written by one tab).
 */
import { ACCOUNT_PATH, DEFAULT_SERVER, sameServer, type AccountMethod, type AccountResponse, type AccountState, type AccountUser, type SignInMethod, type SignInResult } from "@shared/account";
import { IdleTimer, type IdleState } from "@shared/idleTimer";
import type { IdleNotice } from "@shared/ipc";
import { SIGN_IN_ERROR_TEXT, type SignInError } from "@shared/org/identity";
import type { MemoryStore } from "./memory/memoryStore";
import { isWebApp } from "../app/webApp";
import { t } from "@/i18n";

interface WebSession {
  server: string;
  token: string;
  expiresAt: number;
  user: AccountUser;
}

const SESSION_KEY = "designer.web.session";
const PENDING_KEY = "designer.web.signin";

/** The server the page signs in to: VITE_DESIGNER_SERVER, else the web app's own origin (wecra.app serves both), else wecra.app */
export const webServer = (): string => ((import.meta.env.VITE_DESIGNER_SERVER as string | undefined) || (isWebApp() && typeof location !== "undefined" ? location.origin : DEFAULT_SERVER)).replace(/\/+$/, "");

function readSession(): WebSession | null {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY) ?? "null") as WebSession | null;
    // A session kept for the server's former address (FORMER_SERVERS) is the current server's
    return s && sameServer(s.server, webServer()) && s.expiresAt > Date.now() && typeof s.token === "string" ? { ...s, server: webServer() } : null;
  } catch {
    return null;
  }
}

/** The page's session now (the server and its bearer token), or null signed out — for the page's own server calls */
export function currentWebSession(): { server: string; token: string; userId: string } | null {
  const s = readSession();
  return s ? { server: s.server, token: s.token, userId: s.user.id } : null;
}

const listeners = new Set<(s: AccountState) => void>();
const state = (signingIn = false): AccountState => ({ server: webServer(), user: readSession()?.user ?? null, signingIn });
function changed(): void {
  const s = state();
  for (const l of listeners) l(s);
}

if (typeof window !== "undefined") window.addEventListener("storage", (e) => e.key === SESSION_KEY && changed());

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const random = (n: number) => b64url(crypto.getRandomValues(new Uint8Array(n)));
const sha256 = async (text: string) => b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))));

/** An org's SAML tenant id (docs/multiplayer.md §15.2: 18 digits) */
const TENANT = /^\d{18}$/;

// ---- the idle session timeout (docs/desktop.md §18.2 "The web app"): main's timer on the page's own input ----------

const idleListeners = new Set<(n: IdleNotice) => void>();
let idleTimer: IdleTimer | null = null;
/** The session the timer runs for (a sign-in in another tab is another session) */
let idleFor: string | null = null;

/** One of the session's own requests (`/me…`) with its token; null when not answered */
async function sessionCall(s: WebSession, method: string, path: string): Promise<Response | null> {
  try {
    return await fetch(new URL(path, s.server), { method, headers: { authorization: `Bearer ${s.token}` } });
  } catch {
    return null;
  }
}

/** The page's session ended under it: signed out here and in the page's other tabs (`storage`) */
function dropSession(): void {
  const uid = readSession()?.user.id ?? null;
  localStorage.removeItem(SESSION_KEY);
  changed();
  if (uid) for (const l of dropListeners) l(uid);
}

const dropListeners = new Set<(uid: string) => void>();

/** The page's session ended (Log out, the idle timeout, a refused session): `uid` is the account that was signed in —
 *  the web app deletes that account's cache (docs/cloud.md §7) */
export function onWebSessionDropped(listener: (uid: string) => void): () => void {
  dropListeners.add(listener);
  return () => void dropListeners.delete(listener);
}

const notifyIdle = (n: IdleNotice) => {
  for (const l of idleListeners) l(n);
};

/** A 401 with `idle_timeout` from any of the page's account calls: signed out, the views told why */
function idleLoggedOut(): void {
  idleTimer?.stop();
  dropSession();
  notifyIdle({ state: "logged-out" });
}

const asIdleState = (v: unknown): IdleState | null => {
  const o = v as { activeAt?: unknown; idleLimitMs?: unknown } | null;
  return o && typeof o.activeAt === "number" && (o.idleLimitMs === null || typeof o.idleLimitMs === "number") ? { activeAt: o.activeAt, idleLimitMs: o.idleLimitMs } : null;
};

/** Starts (or stops) the timer for the session the page has now; `GET /me`'s `session` gives the limit. */
function syncIdle(): void {
  if (!idleTimer || typeof window === "undefined") return;
  const s = readSession();
  const key = s ? s.token : null;
  if (key === idleFor) return;
  idleFor = key;
  if (!s) return idleTimer.stop();
  idleTimer.start(null);
  void sessionCall(s, "GET", "/me").then(async (res) => {
    if (idleFor !== key || !res) return;
    if (res.status === 401) return void (((await res.json().catch(() => null)) as { code?: string } | null)?.code === "idle_timeout" ? idleLoggedOut() : dropSession());
    const me = (await res.json().catch(() => null)) as { session?: unknown } | null;
    idleTimer?.start(asIdleState(me?.session));
  });
}

/** The timer, made when a view first listens for its notices (IdleWarning in Home and the editor). */
function ensureIdle(): void {
  if (idleTimer || typeof window === "undefined") return;
  idleTimer = new IdleTimer({
    now: () => Date.now(),
    setTimer: (fn, ms) => window.setTimeout(fn, ms),
    clearTimer: (t) => window.clearTimeout(t as number),
    postActive: async () => {
      const s = readSession();
      const res = s ? await sessionCall(s, "POST", "/me/sessions/active") : null;
      if (res?.status === 401) {
        idleLoggedOut();
        return null;
      }
      return res?.ok ? asIdleState(await res.json().catch(() => null)) : null;
    },
    fetchSession: async () => {
      const s = readSession();
      const res = s ? await sessionCall(s, "GET", "/me") : null;
      if (!res || !res.ok) return undefined;
      const me = (await res.json().catch(() => null)) as { session?: unknown } | null;
      return me?.session === null ? null : (asIdleState(me?.session) ?? undefined);
    },
    endSession: async () => {
      const s = readSession();
      if (s) await sessionCall(s, "DELETE", "/me/sessions/current?reason=idle");
    },
    signOut: dropSession,
    notify: notifyIdle,
  });
  // Activity: the page's own input (main counts the same kinds: a press, a key, the wheel).
  const input = () => idleTimer?.input();
  for (const type of ["pointerdown", "keydown", "wheel"] as const) window.addEventListener(type, input, { capture: true, passive: true });
  listeners.add(syncIdle);
  syncIdle();
}

/** The preload's account API, for a page without one. */
export const webAccount = {
  get: async (): Promise<AccountState> => state(),
  /**
   * Leaves the page to log in; the result arrives when the browser comes back (completeWebSignIn). Without `tenant`
   * it is Log in with Google (`method=google`: straight to Google — a member of an org that requires SAML goes on to
   * its IdP, multiplayer.md §15.4); `tenant` goes straight to that org's IdP (SSO, Admin's Test, the IdP's bounce).
   */
  signIn: async (opts?: { tenant?: string; method?: SignInMethod }): Promise<SignInResult> => {
    if (opts?.tenant !== undefined && !TENANT.test(opts.tenant)) return { ok: false, error: "failed", message: "not a tenant id", state: state() };
    const st = random(24);
    const verifier = random(48);
    sessionStorage.setItem(PENDING_KEY, JSON.stringify({ state: st, verifier }));
    const back = new URL(location.href);
    for (const k of ["auth_code", "auth_state", "auth_error", "sso"]) back.searchParams.delete(k);
    const login = new URL("/auth/login", webServer());
    const params = new URLSearchParams({ return: back.toString(), state: st, challenge: await sha256(verifier) });
    if (opts?.tenant !== undefined) params.set("tenant", opts.tenant);
    // The welcome page's Log in with SSO: the server's single sign-on page (email → the org's IdP); else Google.
    else params.set("method", opts?.method === "sso" ? "sso" : "google");
    login.search = params.toString();
    location.assign(login.toString());
    return new Promise<SignInResult>(() => {});
  },
  cancelSignIn: async (): Promise<AccountState> => state(),
  signOut: async (): Promise<AccountState> => {
    dropSession();
    return state();
  },
  onChanged: (cb: (s: AccountState) => void) => {
    listeners.add(cb);
    return () => void listeners.delete(cb);
  },
  /** The idle prompt's Stay logged in: activity posted, the prompt cleared (docs/desktop.md §18.2) */
  staySignedIn: async (): Promise<AccountState> => {
    ensureIdle();
    await idleTimer?.stay();
    return state();
  },
  /** The idle timeout's notices: "warning" (logoutAt), "cleared", "logged-out" — the timer starts with the first listener */
  onIdle: (cb: (n: IdleNotice) => void) => {
    idleListeners.add(cb);
    ensureIdle();
    return () => void idleListeners.delete(cb);
  },
  /** Settings: the caller's own account (`/me…`), as main does it on the desktop (src/main/account accountRequest). */
  request: async (r: { method: AccountMethod; path: string; body?: unknown }): Promise<AccountResponse> => {
    if (!ACCOUNT_PATH.test(r.path)) throw new Error("not an account path");
    const s = readSession();
    if (!s) return { status: 401, body: { error: t("Log in first") } };
    let res: Response;
    try {
      res = await fetch(new URL(r.path, s.server), { method: r.method, headers: { authorization: `Bearer ${s.token}`, ...(r.body !== undefined ? { "content-type": "application/json" } : {}) }, body: r.body === undefined ? undefined : JSON.stringify(r.body) });
    } catch {
      return { status: 0, body: { error: t("You're offline") } };
    }
    const body = (await res.json().catch(() => null)) as unknown;
    const drop = res.status === 401 || (res.ok && r.method === "DELETE" && r.path === "/me");
    if (res.status === 401 && (body as { code?: unknown } | null)?.code === "idle_timeout") idleLoggedOut();
    else if (drop) {
      dropSession();
    } else if (res.ok && r.method === "PATCH" && r.path === "/me/profile" && body && typeof body === "object") {
      const p = body as AccountUser;
      localStorage.setItem(SESSION_KEY, JSON.stringify({ ...s, user: { id: p.id, email: p.email, name: p.name, picture: p.picture } } satisfies WebSession));
      changed();
    }
    return { status: res.status, body };
  },
};

let completed: Promise<SignInResult | null> | null = null;

/** The page load's sign-in result (Home shows a failure — SSO's texts among them — as a toast); null: none came back */
export function webSignInResult(): Promise<SignInResult | null> {
  return completed ?? Promise.resolve(null);
}

/** On load: the browser came back from Google — trade the code for a session, then clean the address. */
export function completeWebSignIn(): Promise<SignInResult | null> {
  return (completed ??= completeOnce());
}

async function completeOnce(): Promise<SignInResult | null> {
  if (typeof location === "undefined") return null;
  const url = new URL(location.href);
  // The IdP-initiated bounce (an Okta tile → the ACS's "Continue to Wecra", multiplayer.md §15.2 decision 3 and
  // §15.17): `/?sso=<tenant>` starts a normal SP-initiated sign-in with this page's own state and challenge.
  const sso = url.searchParams.get("sso");
  if (sso !== null) {
    url.searchParams.delete("sso");
    history.replaceState(history.state, "", url.toString());
    if (TENANT.test(sso)) return webAccount.signIn({ tenant: sso });
  }
  const code = url.searchParams.get("auth_code");
  const error = url.searchParams.get("auth_error");
  const st = url.searchParams.get("auth_state");
  if (!code && !error) return null;
  for (const k of ["auth_code", "auth_state", "auth_error"]) url.searchParams.delete(k);
  history.replaceState(history.state, "", url.toString());
  const pending = JSON.parse(sessionStorage.getItem(PENDING_KEY) ?? "null") as { state: string; verifier: string } | null;
  sessionStorage.removeItem(PENDING_KEY);
  if (error || !code || !pending || pending.state !== st) {
    const known = error !== null && error in SIGN_IN_ERROR_TEXT ? SIGN_IN_ERROR_TEXT[error as SignInError] : null;
    return { ok: false, error: error === "access_denied" ? "cancelled" : "failed", message: known ?? error ?? "state mismatch", state: state() };
  }
  try {
    const res = await fetch(new URL("/auth/token", webServer()), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, verifier: pending.verifier }) });
    if (!res.ok) throw new Error(`token exchange ${res.status}`);
    const body = (await res.json()) as { token: string; expiresAt: number; user: AccountUser };
    localStorage.setItem(SESSION_KEY, JSON.stringify({ server: webServer(), token: body.token, expiresAt: body.expiresAt, user: body.user } satisfies WebSession));
    changed();
    return { ok: true, state: state() };
  } catch (e) {
    return { ok: false, error: "failed", message: e instanceof Error ? e.message : String(e), state: state() };
  }
}

/** Hands the session to the page's dev store, now and whenever it changes: a tab editing `fileKey` joins its room. */
export function connectWebSession(store: MemoryStore, fileKey: string | null): void {
  const apply = () => {
    const s = readSession();
    // The rooms, then the personal Drafts (the web app's store follows the account, docs/cloud.md §2)
    void store.setSession(s ? { server: s.server, token: s.token } : null, { only: fileKey ? [fileKey] : [] }).catch((e) => console.warn("[multiplayer]", e));
  };
  apply();
  listeners.add(apply);
}
