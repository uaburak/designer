/**
 * The account in a plain browser (`npm run web`; docs/multiplayer.md §2): the same Log in with Google as the desktop
 * app, but the Worker sends the browser back to this page (with `auth_code` / `auth_state`) instead of a loopback, and
 * the page trades the code (with its PKCE verifier) for the session itself. The session lives in localStorage, shared
 * by the page's tabs, and goes to the page's own dev store — whose rooms a tab joins only for the file it edits (Home
 * tabs none: several tabs share one storage, and one file's frames must be written by one tab).
 */
import { ACCOUNT_PATH, DEFAULT_SERVER, type AccountMethod, type AccountResponse, type AccountState, type AccountUser, type SignInResult } from "@shared/account";
import type { MemoryStore } from "./memory/memoryStore";

interface WebSession {
  server: string;
  token: string;
  expiresAt: number;
  user: AccountUser;
}

const SESSION_KEY = "designer.web.session";
const PENDING_KEY = "designer.web.signin";

export const webServer = (): string => ((import.meta.env.VITE_DESIGNER_SERVER as string | undefined) || DEFAULT_SERVER).replace(/\/+$/, "");

function readSession(): WebSession | null {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY) ?? "null") as WebSession | null;
    return s && s.server === webServer() && s.expiresAt > Date.now() && typeof s.token === "string" ? s : null;
  } catch {
    return null;
  }
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

/** The preload's account API, for a page without one. */
export const webAccount = {
  get: async (): Promise<AccountState> => state(),
  /** Leaves the page for Google; the result arrives when the browser comes back (completeWebSignIn). */
  signIn: async (): Promise<SignInResult> => {
    const st = random(24);
    const verifier = random(48);
    sessionStorage.setItem(PENDING_KEY, JSON.stringify({ state: st, verifier }));
    const back = new URL(location.href);
    for (const k of ["auth_code", "auth_state", "auth_error"]) back.searchParams.delete(k);
    const login = new URL("/auth/login", webServer());
    login.search = new URLSearchParams({ return: back.toString(), state: st, challenge: await sha256(verifier) }).toString();
    location.assign(login.toString());
    return new Promise<SignInResult>(() => {});
  },
  cancelSignIn: async (): Promise<AccountState> => state(),
  signOut: async (): Promise<AccountState> => {
    localStorage.removeItem(SESSION_KEY);
    changed();
    return state();
  },
  onChanged: (cb: (s: AccountState) => void) => {
    listeners.add(cb);
    return () => void listeners.delete(cb);
  },
  /** Settings: the caller's own account (`/me…`), as main does it on the desktop (src/main/account accountRequest). */
  request: async (r: { method: AccountMethod; path: string; body?: unknown }): Promise<AccountResponse> => {
    if (!ACCOUNT_PATH.test(r.path)) throw new Error("not an account path");
    const s = readSession();
    if (!s) return { status: 401, body: { error: "Log in first" } };
    let res: Response;
    try {
      res = await fetch(new URL(r.path, s.server), { method: r.method, headers: { authorization: `Bearer ${s.token}`, ...(r.body !== undefined ? { "content-type": "application/json" } : {}) }, body: r.body === undefined ? undefined : JSON.stringify(r.body) });
    } catch {
      return { status: 0, body: { error: "You're offline" } };
    }
    const body = (await res.json().catch(() => null)) as unknown;
    const drop = res.status === 401 || (res.ok && r.method === "DELETE" && r.path === "/me");
    if (drop) {
      localStorage.removeItem(SESSION_KEY);
      changed();
    } else if (res.ok && r.method === "PATCH" && r.path === "/me/profile" && body && typeof body === "object") {
      const p = body as AccountUser;
      localStorage.setItem(SESSION_KEY, JSON.stringify({ ...s, user: { id: p.id, email: p.email, name: p.name, picture: p.picture } } satisfies WebSession));
      changed();
    }
    return { status: res.status, body };
  },
};

/** On load: the browser came back from Google — trade the code for a session, then clean the address. */
export async function completeWebSignIn(): Promise<SignInResult | null> {
  if (typeof location === "undefined") return null;
  const url = new URL(location.href);
  const code = url.searchParams.get("auth_code");
  const error = url.searchParams.get("auth_error");
  const st = url.searchParams.get("auth_state");
  if (!code && !error) return null;
  for (const k of ["auth_code", "auth_state", "auth_error"]) url.searchParams.delete(k);
  history.replaceState(history.state, "", url.toString());
  const pending = JSON.parse(sessionStorage.getItem(PENDING_KEY) ?? "null") as { state: string; verifier: string } | null;
  sessionStorage.removeItem(PENDING_KEY);
  if (error || !code || !pending || pending.state !== st) return { ok: false, error: error === "access_denied" ? "cancelled" : "failed", message: error ?? "state mismatch", state: state() };
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
    void store.multiplayer.setSession(s ? { server: s.server, token: s.token } : null, { only: fileKey ? [fileKey] : [] }).catch((e) => console.warn("[multiplayer]", e));
  };
  apply();
  listeners.add(apply);
}
