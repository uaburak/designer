/**
 * The account in main (docs/multiplayer.md §2, docs/desktop.md §18.7): Sign in with Google through the sign-in sheet or
 * the browser (signIn.ts); up to 10 accounts signed in at once, one current (accounts.ts), their session tokens kept
 * with safeStorage in userData/account/sessions.json (mode 0600), every view told on `account:changed`. A token never
 * reaches a view; the store gets the current one from here (docs/multiplayer.md §5).
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
import { AccountList, accountAdded, accountDropped, decodeAccounts, logOut, logOutAll, MAX_ACCOUNTS, switchAccount, type AccountFlowDeps } from "./accounts";
import { SheetUnavailable, signInFlow, signInWithBrowser, signInWithSheet, SignInError, TENANT_ID, type Session, type SignInMethod, type SignInOptions } from "./signIn";

/** DESIGNER_SERVER (development) unless the deployment keys' AllowedOriginHosts leave it out (docs/desktop.md §12.5) */
export const serverUrl = (): string =>
  desktopPolicy().allowedOriginHosts.length ? allowedServer(process.env.DESIGNER_SERVER, desktopPolicy()).server : (process.env.DESIGNER_SERVER || DEFAULT_SERVER).replace(/\/+$/, "");

const dir = () => join(app.getPath("userData"), "account");
const file = () => join(dir(), "sessions.json");
/** Before several accounts: the one session (read once, then replaced by sessions.json) */
const legacyFile = () => join(dir(), "session.json");

const FULL_TEXT = `You can be logged in to a maximum of ${MAX_ACCOUNTS} accounts at a time.`;

let list = new AccountList();
/** The current account's session */
const current = (): Session | null => list.current;
let loaded = false;
let loading: Promise<void> | null = null;
let pending: AbortController | null = null;

/** The kept sessions, for the sync callers: they come through the keychain off main's thread (sealed.ts) and are
 *  announced when they land. Never `decryptString` here: on a Mac a keychain prompt holds it, and this runs first thing
 *  at launch (checkSession) — main frozen before the store even starts. */
function load(): void {
  if (!loaded) void loadSession();
}

/** Reads userData/account/sessions.json (or the single session.json of before) once; resolves when the sessions are in. */
export function loadSession(): Promise<void> {
  if (loaded) return Promise.resolve();
  if (loading) return loading;
  let raw: unknown = null;
  let legacy = false;
  try {
    raw = JSON.parse(readFileSync(file(), "utf8"));
  } catch {
    try {
      raw = JSON.parse(readFileSync(legacyFile(), "utf8"));
      legacy = true;
    } catch {
      loaded = true;
      return Promise.resolve();
    }
  }
  loading = decodeAccounts(raw, { server: serverUrl(), now: Date.now(), unseal: (t) => unsealAsync(t, { warn: (m) => console.warn(`[account] ${m}`) }) })
    .catch(() => new AccountList())
    .then((l) => {
      loading = null;
      // Signed in or out meanwhile: that answer stands.
      if (loaded) return;
      loaded = true;
      list = l;
      if (legacy) save();
      // Known now (signed in or not): the welcome window leaves its splash, or gives way to the app.
      void announce(list.current !== null);
    });
  return loading;
}

let saving: Promise<void> = Promise.resolve();
let saves = 0;
/** Each token sealed once (the keychain isn't asked again for the same one) */
const sealedTokens = new Map<string, string>();
/** In order (sealing is async), the last save having the last word; the file is 0600. */
function save(): void {
  const gen = ++saves;
  const snapshot = new AccountList(list.all(), list.current?.user.id ?? null);
  saving = saving
    .then(async () => {
      if (!snapshot.size) {
        rmSync(file(), { force: true });
        rmSync(legacyFile(), { force: true });
        return;
      }
      const stored = await snapshot.encode(async (token) => {
        const known = sealedTokens.get(token);
        if (known) return known;
        const sealed = await sealAsync(token);
        sealedTokens.set(token, sealed);
        return sealed;
      });
      // Changed again while the keychain answered: the later save writes.
      if (gen !== saves) return;
      mkdirSync(dir(), { recursive: true });
      const tmp = `${file()}.tmp`;
      writeFileSync(tmp, JSON.stringify(stored, null, 1), { mode: 0o600 });
      renameSync(tmp, file());
      chmodSync(file(), 0o600);
      rmSync(legacyFile(), { force: true });
    })
    .catch((e: unknown) => console.warn("[account] the sessions weren't kept:", e instanceof Error ? e.message : e));
}

const viewUser = (user: AccountUser): AccountUser => ({ ...user, picture: viewPicture(user.picture) });

export function accountState(): AccountState {
  load();
  const user = current()?.user ?? null;
  return {
    server: serverUrl(),
    user: user && viewUser(user),
    accounts: list.all().map((s) => viewUser(s.user)),
    signingIn: pending !== null,
    ...(loaded ? {} : { loading: true }),
  };
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
 * current session. A refused session is dropped; after Delete account that account is logged out; a changed name or
 * photo is every view's at once.
 */
export async function accountRequest(r: { method: AccountMethod; path: string; body?: unknown }): Promise<AccountResponse> {
  if (!["GET", "POST", "PATCH", "DELETE"].includes(r?.method) || typeof r.path !== "string" || !ACCOUNT_PATH.test(r.path)) throw new Error("account:request: not an account path");
  const token = sessionToken();
  const s = current();
  if (!token || !s) return { status: 401, body: { error: "Log in first" } };
  let res: Response;
  try {
    res = await mainFetch(`${s.server}${r.path}`, {
      method: r.method,
      headers: { authorization: `Bearer ${token}`, "user-agent": desktopUserAgent(), ...(r.body !== undefined ? { "content-type": "application/json" } : {}) },
      body: r.body === undefined ? undefined : JSON.stringify(r.body),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return { status: 0, body: { error: "You're offline" } };
  }
  const body = (await res.json().catch(() => null)) as unknown;
  if (res.status === 401) dropSession(body, s.user.id);
  else if (res.ok && r.method === "DELETE" && r.path === "/me") void flow((d) => accountDropped(d, s.user.id));
  else if (res.ok && r.path === "/me/profile" && r.method === "PATCH" && body && typeof body === "object") {
    const p = body as AccountUser;
    updateUser(s.token, { id: p.id, email: p.email, name: p.name, picture: p.picture });
  }
  return { status: res.status, body };
}

/** The account's name or photo changed (Settings, GET /me): kept and shown — while that session is still kept. */
function updateUser(token: string, user: AccountUser): void {
  const s = list.all().find((a) => a.token === token);
  if (!s || s.user.id !== user.id || JSON.stringify(user) === JSON.stringify(s.user)) return;
  list.put({ ...s, user });
  save();
  broadcast();
}

/** The current session's token for the server, or null (signed out / expired) — main and the store only. */
export function sessionToken(): string | null {
  load();
  const s = current();
  if (s && s.expiresAt <= Date.now()) {
    void flow((d) => accountDropped(d, s.user.id));
    return null;
  }
  return s?.token ?? null;
}

function broadcast(): void {
  const state = accountState();
  for (const c of webContents.getAllWebContents()) if (!c.isDestroyed() && viewOf(c)) c.send("account:changed", state);
}

const sessionListeners = new Set<() => void>();
/** Main's own listeners for a sign-in, a sign-out, a switch to another account or a dropped session (the shared fonts
 *  refresh on it; the gate opens or closes the app window). */
export function onSessionChanged(listener: () => void): () => void {
  sessionListeners.add(listener);
  return () => sessionListeners.delete(listener);
}

/** Every view, main's listeners (when the current token changed) and the store learn the session; resolves when the
 *  store has it. */
function announce(changed: boolean): Promise<void> {
  broadcast();
  if (changed) for (const l of [...sessionListeners]) l();
  const c = storeClient();
  return c ? pushSession(c) : Promise.resolve();
}

/** The store joins shared files' rooms with the current session (docs/multiplayer.md §5); null leaves them. */
function pushSession(client: StoreClient): Promise<void> {
  // Not read yet (the keychain): the store hears when it is — a "none" now would be a wrong first word.
  load();
  if (!loaded) return Promise.resolve();
  const token = sessionToken();
  const s = current();
  return client.multiplayer.setSession(token && s ? { server: s.server, token } : null).then(
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

// ---- moving between accounts (docs/desktop.md §18.7) ---------------------------------------------------------------

/** The windows' part of leaving one account for another; set by the gate (src/main/gate.ts). */
export interface AccountWindows {
  /** Every open file settled (a failed save asks) — false: the person stays with the account */
  settle(): Promise<boolean>;
  /** The account's file tabs closed, its files flushed — another account comes next */
  leave(): Promise<void>;
  /** Another account is current (the store has its session): Home again */
  arrived(): void;
}
let windows: AccountWindows | null = null;
export function setAccountWindows(w: AccountWindows | null): void {
  windows = w;
}

/** The list changed: kept, announced; a new current session restarts the idle timeout with its own limit. */
function commit(before: string | null): Promise<void> {
  loaded = true;
  save();
  const s = current();
  const changed = before !== (s?.token ?? null);
  if (changed) {
    idle.stop();
    if (s) {
      // The new session's idle limit (GET /me's session).
      idle.start(null);
      void fetchMe().then((me) => me && idle.start(me.session));
    }
  }
  return announce(changed);
}

/** One flow at a time (a switch waits for a log out's questions, and so on) */
let flows: Promise<unknown> = Promise.resolve();
function flow<T>(run: (d: AccountFlowDeps) => Promise<T>): Promise<T> {
  const deps = (): AccountFlowDeps => {
    let before = current()?.token ?? null;
    return {
      list,
      settle: async () => (windows ? windows.settle() : true),
      leave: async () => {
        await windows?.leave();
      },
      commit: () => {
        const b = before;
        before = current()?.token ?? null;
        return commit(b);
      },
      arrived: () => windows?.arrived(),
    };
  };
  const next = flows.then(() => run(deps()));
  flows = next.catch(() => {});
  return next;
}

/** The window the sign-in sheet hangs on: the focused one, else the first */
const sheetWindow = (): BaseWindow | null => BaseWindow.getFocusedWindow() ?? BaseWindow.getAllWindows().find((w) => !w.isDestroyed() && w.isVisible()) ?? null;

/**
 * Signs in (docs/desktop.md §18.6): on a Mac in the sign-in sheet over the window (only the server's, Google's or the
 * IdP's pages), else — and when the sheet can't start — in the system browser; a second call replaces a sign-in still
 * waiting. `tenant`: an org's SAML (Admin's Test, the `designer://sign-in?tenant=` link) — straight to its IdP;
 * `method`: the welcome page's Log in with Google ("google") or Log in with SSO ("sso"). Signed in already, this is
 * the account menu's **Add account** (§18.7): the current account stays until the new one is in, then the app
 * switches to it.
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
    const r = await flow((d) => accountAdded(d, s));
    if (r === "full") throw new SignInError("failed", FULL_TEXT);
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

/** The account menu's account rows: the app moves to that account (files settled and closed, Home reloaded). */
export async function switchTo(userId: string): Promise<AccountState> {
  pending?.abort();
  if (typeof userId === "string") await flow((d) => switchAccount(d, userId));
  return accountState();
}

/** Log out (the account menu): the current account only — its files settled first (Cancel keeps it). Another account
 *  signed in becomes current; none left, the gate closes the window and shows the welcome page. The idle timeout and a
 *  refused session drop an account without asking (dropSession). */
export async function signOut(): Promise<AccountState> {
  pending?.abort();
  await flow((d) => logOut(d));
  return accountState();
}

/** Log out of all accounts (the account menu, with more than one): the files settled once, then the welcome page. */
export async function signOutAll(): Promise<AccountState> {
  pending?.abort();
  await flow((d) => logOutAll(d));
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
  if (!token || !current()) return;
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
  updateUser(res.token, user);
  const s = body.session;
  return { user, session: s && typeof s.activeAt === "number" ? { activeAt: s.activeAt, idleLimitMs: typeof s.idleLimitMs === "number" ? s.idleLimitMs : null } : null };
}

/** Main's own request to the server with the session; a refused session is dropped (an idle one with the toast).
 *  null when signed out or not answered. */
async function api(method: "GET" | "POST" | "DELETE", path: string, timeoutMs: number): Promise<(Response & { token: string }) | null> {
  const token = sessionToken();
  const s = current();
  if (!token || !s) return null;
  try {
    const res = await mainFetch(`${s.server}${path}`, { method, headers: { authorization: `Bearer ${token}`, "user-agent": desktopUserAgent() }, signal: AbortSignal.timeout(timeoutMs) });
    if (res.status === 401 && list.all().some((a) => a.token === token)) dropSession(await res.clone().json().catch(() => null), s.user.id);
    return Object.assign(res, { token });
  } catch {
    return null;
  }
}

/** A 401: that account's session is gone — only that account (docs/desktop.md §18.7); `idle_timeout` (the computer
 *  slept past the deadline) also says why (docs/desktop.md §18.2). */
function dropSession(body: unknown, userId: string): void {
  const idleOut = !!body && typeof body === "object" && (body as { code?: unknown }).code === "idle_timeout";
  void flow((d) => accountDropped(d, userId));
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
  // The idle timeout logs out the current account without asking: its files are still flushed (the window's tabs
  // when another account takes over, else the gate's closing window).
  signOut: () => {
    pending?.abort();
    const s = current();
    if (s) void flow((d) => accountDropped(d, s.user.id));
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
 *  the local server's /auth/dev) — the gate's sign-in path without Google; signed in already, an added account. */
export async function signInForTest(s: Session): Promise<AccountState> {
  if (process.env.DESIGNER_TEST !== "1") throw new Error("test only");
  pending?.abort();
  pending = null;
  await flow((d) => accountAdded(d, s));
  return accountState();
}
