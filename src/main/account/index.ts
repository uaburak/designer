/**
 * The account in main (docs/multiplayer.md §2): Sign in with Google through the browser (signIn.ts), the session token
 * kept with safeStorage in userData/account/session.json (mode 0600), every view told on `account:changed`. The token
 * never reaches a view; the store gets it from here when shared files arrive (docs/multiplayer.md §5).
 */
import { app, safeStorage, shell, webContents } from "electron";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_SERVER, type AccountState, type AccountUser, type SignInResult } from "../../shared/account";
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
  return { server: serverUrl(), user: session?.user ?? null, signingIn: pending !== null };
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
    const s = await signInWithBrowser({ server: serverUrl(), signal: ac.signal, openBrowser: (url) => shell.openExternal(url) });
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
