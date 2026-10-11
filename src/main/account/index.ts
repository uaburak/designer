/**
 * The account in main (docs/multiplayer.md §2): Sign in with Google through the browser (signIn.ts), the session token
 * kept with safeStorage in userData/account/session.json (mode 0600), every view told on `account:changed`. The token
 * never reaches a view; the store gets it from here when shared files arrive (docs/multiplayer.md §5).
 */
import { app, safeStorage, shell, webContents } from "electron";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ACCOUNT_PATH, DEFAULT_SERVER, type AccountMethod, type AccountResponse, type AccountState, type AccountUser, type SignInResult } from "../../shared/account";
import { onStoreReady, storeClient } from "../storeHost";
import type { StoreClient } from "../../shared/store/client";
import { viewOf } from "../views";
import { signInWithBrowser, SignInError, type Session } from "./signIn";

interface StoredSession {
  server: string;
  /** "enc:<base64>" (safeStorage) or "raw:<token>" when the OS offers no encryption */
  token: string;
  expiresAt: number;
  user: AccountUser;
}

export const serverUrl = (): string => (process.env.DESIGNER_SERVER || DEFAULT_SERVER).replace(/\/+$/, "");

const dir = () => join(app.getPath("userData"), "account");
const file = () => join(dir(), "session.json");

let session: Session | null = null;
let loaded = false;
let pending: AbortController | null = null;

const canEncrypt = () => {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
};

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    const s = JSON.parse(readFileSync(file(), "utf8")) as StoredSession;
    const token = s.token.startsWith("enc:") ? safeStorage.decryptString(Buffer.from(s.token.slice(4), "base64")) : s.token.startsWith("raw:") ? s.token.slice(4) : null;
    // A session for another server (DESIGNER_SERVER changed) or past its end is no session.
    if (token && s.server === serverUrl() && s.expiresAt > Date.now()) session = { server: s.server, token, expiresAt: s.expiresAt, user: s.user };
  } catch {
    session = null;
  }
}

function save(s: Session | null): void {
  if (!s) return void rmSync(file(), { force: true });
  mkdirSync(dir(), { recursive: true });
  const stored: StoredSession = { server: s.server, token: canEncrypt() ? `enc:${safeStorage.encryptString(s.token).toString("base64")}` : `raw:${s.token}`, expiresAt: s.expiresAt, user: s.user };
  const tmp = `${file()}.tmp`;
  writeFileSync(tmp, JSON.stringify(stored, null, 1), { mode: 0o600 });
  renameSync(tmp, file());
  chmodSync(file(), 0o600);
}

export function accountState(): AccountState {
  load();
  const user = session?.user ?? null;
  return { server: serverUrl(), user: user && { ...user, picture: viewPicture(user.picture) }, signingIn: pending !== null };
}

/** What the server learns the desktop app by (Sessions: "App", "DesignerV2 Desktop", the OS). */
export function desktopUserAgent(): string {
  const os = process.platform === "darwin" ? "macOS" : process.platform === "win32" ? "Windows" : "Linux";
  return `DesignerV2-Desktop/${app.getVersion()} (${os})`;
}

/**
 * The account photo as a view can show it: the views' CSP allows no outside images, so Google's photo (a URL) is
 * fetched once here and handed over as a data: URL; an uploaded photo already is one.
 */
const pictures = new Map<string, string | null>();
function viewPicture(picture: string | null): string | null {
  if (!picture || picture.startsWith("data:")) return picture;
  if (pictures.has(picture)) return pictures.get(picture) ?? null;
  pictures.set(picture, null);
  void (async () => {
    try {
      const res = await fetch(picture, { signal: AbortSignal.timeout(10_000) });
      const type = res.headers.get("content-type") ?? "";
      if (!res.ok || !/^image\/(png|jpeg|webp|gif)/.test(type)) return;
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length > 512 * 1024) return;
      pictures.set(picture, `data:${type.split(";")[0]};base64,${bytes.toString("base64")}`);
      broadcast();
    } catch {
      // offline: initials
    }
  })();
  return null;
}

/**
 * Settings (docs/multiplayer.md §13): a view's request for the caller's own account (`/me…` only), sent with the
 * session. A refused session is dropped; after Delete account the app is logged out; a changed name or photo is
 * every view's at once.
 */
export async function accountRequest(r: { method: AccountMethod; path: string; body?: unknown }): Promise<AccountResponse> {
  if (!["GET", "POST", "PATCH", "DELETE"].includes(r?.method) || typeof r.path !== "string" || !ACCOUNT_PATH.test(r.path)) throw new Error("account:request: not an account path");
  const token = sessionToken();
  if (!token || !session) return { status: 401, body: { error: "Log in first" } };
  let res: Response;
  try {
    res = await fetch(`${session.server}${r.path}`, {
      method: r.method,
      headers: { authorization: `Bearer ${token}`, "user-agent": desktopUserAgent(), ...(r.body !== undefined ? { "content-type": "application/json" } : {}) },
      body: r.body === undefined ? undefined : JSON.stringify(r.body),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return { status: 0, body: { error: "You're offline" } };
  }
  const body = (await res.json().catch(() => null)) as unknown;
  if (res.status === 401) setSession(null);
  else if (res.ok && r.method === "DELETE" && r.path === "/me") setSession(null);
  else if (res.ok && r.path === "/me/profile" && r.method === "PATCH" && session && body && typeof body === "object") {
    const p = body as AccountUser;
    const user: AccountUser = { id: p.id, email: p.email, name: p.name, picture: p.picture };
    if (JSON.stringify(user) !== JSON.stringify(session.user)) setSession({ ...session, user });
  }
  return { status: res.status, body };
}

/** The session token for the server, or null (signed out / expired) — main and the store only. */
export function sessionToken(): string | null {
  load();
  if (session && session.expiresAt <= Date.now()) setSession(null);
  return session?.token ?? null;
}

function broadcast(): void {
  const state = accountState();
  for (const c of webContents.getAllWebContents()) if (!c.isDestroyed() && viewOf(c)) c.send("account:changed", state);
}

function setSession(s: Session | null): void {
  session = s;
  save(s);
  broadcast();
  const c = storeClient();
  if (c) pushSession(c);
}

/** The store joins shared files' rooms with the session (docs/multiplayer.md §5); null leaves them. */
function pushSession(client: StoreClient): void {
  const token = sessionToken();
  void client.multiplayer.setSession(token && session ? { server: session.server, token } : null).catch((e) => console.warn("[account] the store didn't take the session", e));
}

/** Every store start (and restart) gets the session. */
export function initAccount(): void {
  onStoreReady(pushSession);
}

/** Opens the browser and waits for it; a second call replaces a sign-in still waiting. */
export async function signIn(): Promise<SignInResult> {
  pending?.abort();
  const ac = new AbortController();
  pending = ac;
  broadcast();
  try {
    const s = await signInWithBrowser({ server: serverUrl(), signal: ac.signal, openBrowser: (url) => shell.openExternal(url), userAgent: desktopUserAgent() });
    if (pending === ac) pending = null;
    setSession(s);
    app.focus({ steal: true });
    return { ok: true, state: accountState() };
  } catch (e) {
    if (pending === ac) pending = null;
    broadcast();
    const err = e instanceof SignInError ? e : new SignInError("failed", e instanceof Error ? e.message : String(e));
    return { ok: false, error: err.code, message: err.message, state: accountState() };
  }
}

export function cancelSignIn(): AccountState {
  pending?.abort();
  return accountState();
}

export function signOut(): AccountState {
  pending?.abort();
  setSession(null);
  return accountState();
}

/** At launch, in the background: a session the server no longer accepts (signed out everywhere, user gone) is dropped.
 *  Offline or a server error keeps it — local work never waits on the network. */
export async function checkSession(): Promise<void> {
  const token = sessionToken();
  if (!token || !session) return;
  try {
    const res = await fetch(`${session.server}/me`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
    if (res.status === 401) return setSession(null);
    if (res.ok) {
      const user = (await res.json()) as AccountUser;
      if (session && JSON.stringify(user) !== JSON.stringify(session.user)) setSession({ ...session, user });
    }
  } catch {
    // offline
  }
}
