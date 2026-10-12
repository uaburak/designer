/**
 * The account in main (docs/multiplayer.md §2): Sign in with Google through the browser (signIn.ts), the session token
 * kept with safeStorage in userData/account/session.json (mode 0600), every view told on `account:changed`. The token
 * never reaches a view; the store gets it from here when shared files arrive (docs/multiplayer.md §5).
 */
import { app, BaseWindow, Notification, powerMonitor, shell, webContents, type WebContents } from "electron";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ACCOUNT_PATH, DEFAULT_SERVER, type AccountMethod, type AccountResponse, type AccountState, type AccountUser, type SignInResult } from "../../shared/account";
import type { IdleNotice } from "../../shared/ipc";
import type { SessionIdle } from "../../shared/org/identity";
import { mainFetch } from "../net";
import { allowedServer, desktopPolicy } from "../policy";
import { sealAsync, unsealAsync } from "../sealed";
import { onStoreReady, storeClient } from "../storeHost";
import type { StoreClient } from "../../shared/store/client";
import { viewOf } from "../views";
import { IdleTimer, type IdleState } from "./idle";
import { authSheet } from "./authSheet";
import { SheetUnavailable, signInFlow, signInWithBrowser, signInWithSheet, SignInError, TENANT_ID, type Session, type SignInMethod, type SignInOptions } from "./signIn";

interface StoredSession {
  server: string;
  /** "enc:<base64>" (safeStorage) or "raw:<token>" when the OS offers no encryption */
  token: string;
  expiresAt: number;
  user: AccountUser;
}

/** DESIGNER_SERVER (development) unless the deployment keys' AllowedOriginHosts leave it out (docs/desktop.md §12.5) */
export const serverUrl = (): string =>
  desktopPolicy().allowedOriginHosts.length ? allowedServer(process.env.DESIGNER_SERVER, desktopPolicy()).server : (process.env.DESIGNER_SERVER || DEFAULT_SERVER).replace(/\/+$/, "");

const dir = () => join(app.getPath("userData"), "account");
const file = () => join(dir(), "session.json");

let session: Session | null = null;
let loaded = false;
let loading: Promise<void> | null = null;
let pending: AbortController | null = null;

/** The kept session, for the sync callers: a "raw:" one is in at once; a sealed one comes through the keychain off
 *  main's thread (sealed.ts) and is announced when it lands. Never `decryptString` here: on a Mac a keychain prompt
 *  holds it, and this runs first thing at launch (checkSession) — main frozen before the store even starts. */
function load(): void {
  if (!loaded) void loadSession();
}

/** Reads userData/account/session.json once; resolves when the session (if any) is in. */
export function loadSession(): Promise<void> {
  if (loaded) return Promise.resolve();
  if (loading) return loading;
  let s: StoredSession;
  try {
    s = JSON.parse(readFileSync(file(), "utf8")) as StoredSession;
  } catch {
    loaded = true;
    return Promise.resolve();
  }
  const accept = (token: string | null) => {
    // A session for another server (DESIGNER_SERVER changed) or past its end is no session.
    if (token && s?.server === serverUrl() && s.expiresAt > Date.now()) session = { server: s.server, token, expiresAt: s.expiresAt, user: s.user };
  };
  if (typeof s?.token !== "string" || !s.token.startsWith("enc:")) {
    loaded = true;
    accept(typeof s?.token === "string" && s.token.startsWith("raw:") ? s.token.slice(4) : null);
    return Promise.resolve();
  }
  loading = unsealAsync(s.token, { warn: (m) => console.warn(`[account] ${m}`) }).then((token) => {
    loading = null;
    // Signed in or out meanwhile: that answer stands.
    if (loaded) return;
    loaded = true;
    accept(token);
    // Known now (signed in or not): the welcome window leaves its splash, or gives way to the app.
    announce(session !== null);
  });
  return loading;
}

let saving: Promise<void> = Promise.resolve();
/** In order (sealing is async); the file is 0600. */
function save(s: Session | null): void {
  saving = saving
    .then(async () => {
      if (!s) return void rmSync(file(), { force: true });
      const stored: StoredSession = { server: s.server, token: await sealAsync(s.token), expiresAt: s.expiresAt, user: s.user };
      // Signed out (or in again) while the keychain answered: the later save has the last word.
      if (session?.token !== s.token) return;
      mkdirSync(dir(), { recursive: true });
      const tmp = `${file()}.tmp`;
      writeFileSync(tmp, JSON.stringify(stored, null, 1), { mode: 0o600 });
      renameSync(tmp, file());
      chmodSync(file(), 0o600);
    })
    .catch((e: unknown) => console.warn("[account] the session wasn't kept:", e instanceof Error ? e.message : e));
}

export function accountState(): AccountState {
  load();
  const user = session?.user ?? null;
  return { server: serverUrl(), user: user && { ...user, picture: viewPicture(user.picture) }, signingIn: pending !== null, ...(loaded ? {} : { loading: true }) };
}

/** What the server learns the desktop app by (Sessions: "App", "Designer Desktop", the OS). */
export function desktopUserAgent(): string {
  const os = process.platform === "darwin" ? "macOS" : process.platform === "win32" ? "Windows" : "Linux";
  // The token stays "DesignerV2-Desktop": servers already deployed (src/shared/account.ts, server/src/activity.ts) parse it.
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
      const res = await mainFetch(picture, { signal: AbortSignal.timeout(10_000) });
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
    res = await mainFetch(`${session.server}${r.path}`, {
      method: r.method,
      headers: { authorization: `Bearer ${token}`, "user-agent": desktopUserAgent(), ...(r.body !== undefined ? { "content-type": "application/json" } : {}) },
      body: r.body === undefined ? undefined : JSON.stringify(r.body),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return { status: 0, body: { error: "You're offline" } };
  }
  const body = (await res.json().catch(() => null)) as unknown;
  if (res.status === 401) dropSession(body);
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

const sessionListeners = new Set<() => void>();
/** Main's own listeners for a sign-in, a sign-out or a dropped session (the shared fonts refresh on it). */
export function onSessionChanged(listener: () => void): () => void {
  sessionListeners.add(listener);
  return () => sessionListeners.delete(listener);
}

function setSession(s: Session | null): void {
  const changed = (s?.token ?? null) !== (session?.token ?? null);
  session = s;
  loaded = true;
  if (!s) idle.stop();
  save(s);
  announce(changed);
}

/** Every view, main's listeners (when the token changed) and the store learn the session. */
function announce(changed: boolean): void {
  broadcast();
  if (changed) for (const l of [...sessionListeners]) l();
  const c = storeClient();
  if (c) void pushSession(c);
}

/** The store joins shared files' rooms with the session (docs/multiplayer.md §5); null leaves them. */
function pushSession(client: StoreClient): Promise<void> {
  // Not read yet (the keychain): the store hears when it is — a "none" now would be a wrong first word.
  load();
  if (!loaded) return Promise.resolve();
  const token = sessionToken();
  return client.multiplayer.setSession(token && session ? { server: session.server, token } : null).then(
    () => {},
    (e: unknown) => console.warn("[account] the store didn't take the session", e),
  );
}

/** The store has the session now (the gate waits for it before Home opens: the store refuses files without one). */
export function sessionToStore(): Promise<void> {
  const c = storeClient();
  return c ? pushSession(c) : Promise.resolve();
}

/** Every store start (and restart) gets the session. */
export function initAccount(): void {
  onStoreReady((c) => void pushSession(c));
}

/** The window the sign-in sheet hangs on: the focused one, else the first */
const sheetWindow = (): BaseWindow | null => BaseWindow.getFocusedWindow() ?? BaseWindow.getAllWindows().find((w) => !w.isDestroyed() && w.isVisible()) ?? null;

/**
 * Signs in (docs/desktop.md §18.6): on a Mac in the sign-in sheet over the window (only the server's, Google's or the
 * IdP's pages), else — and when the sheet can't start — in the system browser; a second call replaces a sign-in still
 * waiting. `tenant`: an org's SAML (Admin's Test, the `designer://sign-in?tenant=` link) — straight to its IdP;
 * `method`: the welcome page's Log in with Google ("google") or Log in with SSO ("sso").
 */
export async function signIn(opts?: { tenant?: string; method?: SignInMethod }): Promise<SignInResult> {
  const tenant = typeof opts?.tenant === "string" ? opts.tenant : undefined;
  const method = opts?.method === "google" || opts?.method === "sso" ? opts.method : undefined;
  if (tenant !== undefined && !TENANT_ID.test(tenant)) return { ok: false, error: "failed", message: "Not an organization's single sign-on.", state: accountState() };
  pending?.abort();
  const ac = new AbortController();
  pending = ac;
  broadcast();
  try {
    const base: SignInOptions = { server: serverUrl(), signal: ac.signal, openBrowser: (url) => shell.openExternal(url), userAgent: desktopUserAgent(), fetch: mainFetch, tenant, method };
    const win = sheetWindow();
    const sheet = authSheet(win);
    let s: Session;
    if (signInFlow({ platform: process.platform, sheet, window: win !== null }) === "sheet" && sheet) {
      try {
        s = await signInWithSheet({ ...base, sheet });
      } catch (e) {
        if (!(e instanceof SheetUnavailable)) throw e;
        console.warn("[account] the sign-in sheet didn't start: the browser instead");
        s = await signInWithBrowser(base);
      }
    } else s = await signInWithBrowser(base);
    if (pending === ac) pending = null;
    setSession(s);
    // The new session's idle limit (GET /me's session).
    idle.start(null);
    void fetchMe().then((me) => me && idle.start(me.session));
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

let signOutGuard: (() => Promise<boolean>) | null = null;
/** Before Log out drops the session (docs/desktop.md §18.6): the open files flushed — false keeps the person signed
 *  in (they chose to stay with a file that didn't save). Set by the window gate (src/main/gate.ts). */
export function setSignOutGuard(guard: (() => Promise<boolean>) | null): void {
  signOutGuard = guard;
}

/** Log out (the account menu): the files settled first, then the session dropped — the gate then closes the windows
 *  and shows the welcome page. The idle timeout and a refused session drop it without asking (dropSession). */
export async function signOut(): Promise<AccountState> {
  pending?.abort();
  if (session && signOutGuard && !(await signOutGuard())) return accountState();
  setSession(null);
  return accountState();
}

/** Signed in now (a kept session counts offline): the gate's question */
export const signedIn = (): boolean => sessionToken() !== null;
/** The kept session has been read (signed in or not) */
export const sessionKnown = (): boolean => loaded;

/** At launch, in the background: a session the server no longer accepts (signed out everywhere, user gone) is dropped.
 *  Offline or a server error keeps it — local work never waits on the network. */
export async function checkSession(): Promise<void> {
  await loadSession();
  const token = sessionToken();
  if (!token || !session) return;
  // Signed in (maybe offline): activity counts from now; the limit comes with /me.
  idle.start(null);
  const me = await fetchMe();
  if (me) idle.start(me.session);
}

/** `GET /me`: the user (a change reaches the views) and the session's idle data; undefined offline or signed out. */
async function fetchMe(): Promise<{ user: AccountUser; session: IdleState | null } | undefined> {
  const res = await api("GET", "/me", 10_000);
  if (!res || !res.ok) return undefined;
  const body = (await res.json().catch(() => null)) as (AccountUser & { session?: SessionIdle | null }) | null;
  if (!body || typeof body !== "object") return undefined;
  const user: AccountUser = { id: body.id, email: body.email, name: body.name, picture: body.picture };
  if (session && JSON.stringify(user) !== JSON.stringify(session.user)) setSession({ ...session, user });
  const s = body.session;
  return { user, session: s && typeof s.activeAt === "number" ? { activeAt: s.activeAt, idleLimitMs: typeof s.idleLimitMs === "number" ? s.idleLimitMs : null } : null };
}

/** Main's own request to the server with the session; a refused session is dropped (an idle one with the toast).
 *  null when signed out or not answered. */
async function api(method: "GET" | "POST" | "DELETE", path: string, timeoutMs: number): Promise<Response | null> {
  const token = sessionToken();
  if (!token || !session) return null;
  try {
    const res = await mainFetch(`${session.server}${path}`, { method, headers: { authorization: `Bearer ${token}`, "user-agent": desktopUserAgent() }, signal: AbortSignal.timeout(timeoutMs) });
    if (res.status === 401 && session?.token === token) dropSession(await res.clone().json().catch(() => null));
    return res;
  } catch {
    return null;
  }
}

/** A 401: the session is gone; `idle_timeout` (the computer slept past the deadline) also says why (docs/desktop.md §18.2). */
function dropSession(body: unknown): void {
  const idleOut = !!body && typeof body === "object" && (body as { code?: unknown }).code === "idle_timeout";
  setSession(null);
  if (idleOut) notifyIdle({ state: "logged-out" });
}

// ---- the idle timeout (docs/desktop.md §18.2) ----------------------------------------------------------------------

const idle = new IdleTimer({
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  postActive: async () => {
    const res = await api("POST", "/me/sessions/active", 15_000);
    if (!res?.ok) return null;
    const b = (await res.json().catch(() => null)) as { activeAt?: unknown; idleLimitMs?: unknown } | null;
    return b && typeof b.activeAt === "number" ? { activeAt: b.activeAt, idleLimitMs: typeof b.idleLimitMs === "number" ? b.idleLimitMs : null } : null;
  },
  fetchSession: async () => (await fetchMe())?.session,
  endSession: async () => {
    await api("DELETE", "/me/sessions/current?reason=idle", 5_000);
  },
  // The idle timeout logs out without asking: the gate still flushes every file before the window closes.
  signOut: () => {
    pending?.abort();
    setSession(null);
  },
  notify: (n) => notifyIdle(n),
});

/** What counts as someone using the app (Electron's input-event types; a key press arrives as rawKeyDown) */
const ACTIVITY = new Set(["mouseDown", "rawKeyDown", "keyDown", "mouseWheel", "gestureScrollBegin"]);
const shownNotices = new Set<Notification>();

/** Stay logged in (the prompt's button): activity posted, the prompt cleared everywhere */
export async function staySignedIn(): Promise<AccountState> {
  await idle.stay();
  return accountState();
}

const viewContents = (v: unknown): WebContents | null => (v && typeof v === "object" && "webContents" in v ? (v as { webContents: WebContents }).webContents : null);

/** The warning goes to the view in front of the focused window (else the first window), with a system notification
 *  and a Dock bounce when the app isn't in front; cleared and logged-out go to every Home and editor. */
function notifyIdle(n: IdleNotice): void {
  const views = webContents.getAllWebContents().filter((c) => !c.isDestroyed() && (viewOf(c)?.role === "home" || viewOf(c)?.role === "editor"));
  if (n.state !== "warning") {
    for (const c of views) c.send("account:idle", n);
    return;
  }
  const focused = BaseWindow.getFocusedWindow();
  const win = focused ?? BaseWindow.getAllWindows()[0];
  const visible = win ? win.contentView.children.filter((v) => v.getVisible()).map(viewContents) : [];
  const target = views.find((c) => visible.includes(c)) ?? views[0];
  target?.send("account:idle", n);
  if (focused) return;
  if (Notification.isSupported()) {
    const note = new Notification({ title: "You'll be logged out soon", body: "For your security, you'll be logged out because you've been inactive." });
    shownNotices.add(note);
    note.on("close", () => shownNotices.delete(note));
    note.on("click", () => {
      shownNotices.delete(note);
      if (win && !win.isDestroyed()) {
        if (win.isMinimized()) win.restore();
        win.focus();
      }
      app.focus({ steal: true });
    });
    note.show();
  }
  if (process.platform === "darwin") app.dock?.bounce("critical");
}

/** Input in any view counts as activity (no preload involved); the computer waking re-checks the timer. */
export function initIdle(): void {
  app.on("web-contents-created", (_e, wc) => {
    wc.on("input-event", (_ev, input) => {
      if (ACTIVITY.has(input.type)) idle.input();
    });
  });
  powerMonitor.on("resume", () => idle.resume());
}

/** Under test (DESIGNER_TEST): the timer's state */
export const idleDebug = () => idle.debug();

/** Under test (DESIGNER_TEST, scripts/drive.mjs): a session handed in as a finished sign-in would (a dev session from
 *  the local server's /auth/dev) — the gate's sign-in path without Google. */
export function signInForTest(s: Session): AccountState {
  if (process.env.DESIGNER_TEST !== "1") throw new Error("test only");
  pending?.abort();
  pending = null;
  setSession(s);
  return accountState();
}
