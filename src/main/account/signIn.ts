/**
 * Sign-in (docs/multiplayer.md §2, docs/desktop.md §18.6), without Electron so the tests drive it. On a Mac, the
 * sign-in sheet (ASWebAuthenticationSession through native/authsheet): the server's /auth/login with our state and
 * PKCE challenge shown in a system sheet over the window, the one-time code coming back on `designer://auth/callback`.
 * Elsewhere (and when the sheet can't start), the system browser: a loopback server on 127.0.0.1 gets the code. Either
 * way the code is traded (with the verifier) for a session token.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AccountUser, SignInMethod } from "../../shared/account";
import { SIGN_IN_ERROR_TEXT, type SignInError as SignInErrorCode } from "../../shared/org/identity";
import { t } from "../../shared/i18n";

export interface Session {
  server: string;
  token: string;
  /** Milliseconds */
  expiresAt: number;
  user: AccountUser;
}

export class SignInError extends Error {
  constructor(
    readonly code: "cancelled" | "timeout" | "failed",
    message: string,
  ) {
    super(message);
  }
}

export interface SignInOptions {
  server: string;
  openBrowser(url: string): unknown;
  fetch?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Sent with the code exchange: the server names the session by it (Settings › Security › Sessions — "App") */
  userAgent?: string;
  /** An org's SAML tenant (18 digits): the server goes straight to its IdP (docs/desktop.md §18.1, the deep link) */
  tenant?: string;
  /** The welcome page's buttons (docs/desktop.md §18.6): "google" straight to Google, "sso" the server's single
   *  sign-on page (email → the org's IdP); absent: the server's login page with both */
  method?: SignInMethod;
}

export type { SignInMethod };

/** The sheet's sign-in: the same options, the sheet instead of a browser */
export type SheetOptions = Omit<SignInOptions, "openBrowser"> & { sheet: AuthSheet };

/** A tenant id as the server makes them (docs/multiplayer.md §15.2 decision 2) */
export const TENANT_ID = /^\d{18}$/;

/**
 * `designer://sign-in?tenant=<18 digits>` → the tenant, else null. An IdP-initiated login (an Okta tile) bounced by
 * the server's ACS page starts an ordinary sign-in through that org's SSO (docs/desktop.md §18.1). The contract wrote
 * `designerv2:`; the scheme the app registers (index.ts) is `designer:`, and the server's bounce links to it.
 */
export function signInTenant(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "designer:" || (u.hostname || u.pathname.replace(/^\/+/, "")) !== "sign-in") return null;
  const tenant = u.searchParams.get("tenant") ?? "";
  return TENANT_ID.test(tenant) ? tenant : null;
}

/** The loopback's `error=`: Google's refusal is a cancel, the server's SSO errors carry their text (identity.ts) */
export function loopbackError(error: string | null): SignInError {
  if (error === "access_denied") return new SignInError("cancelled", SIGN_IN_ERROR_TEXT.access_denied);
  if (error && Object.hasOwn(SIGN_IN_ERROR_TEXT, error)) return new SignInError("failed", SIGN_IN_ERROR_TEXT[error as SignInErrorCode]);
  return new SignInError("failed", error ?? "no code");
}

const b64url = (b: Buffer) => b.toString("base64url");

/** A sign-in's own state and PKCE pair */
function pkce() {
  const state = b64url(randomBytes(24));
  const verifier = b64url(randomBytes(48));
  return { state, verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
}

/** `/auth/login` with the app's side (`where`: the loopback's port, or the sheet's `callback=designer`), the method and
 *  the tenant; a tenant that isn't 18 digits is refused before anything opens. */
function loginUrl(opts: SheetOptions | SignInOptions, where: Record<string, string>, state: string, challenge: string): string {
  const login = new URL("/auth/login", opts.server);
  const params = new URLSearchParams({ ...where, state, challenge });
  if (opts.tenant !== undefined) {
    if (!TENANT_ID.test(opts.tenant)) throw new SignInError("failed", "not a tenant id");
    params.set("tenant", opts.tenant);
  } else if (opts.method === "google" || opts.method === "sso") params.set("method", opts.method);
  login.search = params.toString();
  return login.toString();
}

/** The one-time code and the verifier traded for a session (`/auth/token`) */
async function exchange(opts: SheetOptions | SignInOptions, code: string, verifier: string): Promise<Session> {
  const res = await (opts.fetch ?? fetch)(new URL("/auth/token", opts.server), { method: "POST", headers: { "content-type": "application/json", ...(opts.userAgent ? { "user-agent": opts.userAgent } : {}) }, body: JSON.stringify({ code, verifier }) });
  if (!res.ok) throw new SignInError("failed", `token exchange ${res.status}`);
  const body = (await res.json()) as { token: string; expiresAt: number; user: AccountUser };
  return { server: opts.server, token: body.token, expiresAt: body.expiresAt, user: body.user };
}

const sameState = (got: string, want: string) => {
  const a = Buffer.from(got);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
};

// ---- the sign-in sheet (macOS: ASWebAuthenticationSession; docs/desktop.md §18.6) ----------------------------------

/** Where the server sends the sheet's sign-in back (server/src/auth/sso.ts SHEET_CALLBACK); the sheet catches the
 *  scheme itself, nothing is registered for it */
export const SHEET_SCHEME = "designer";

/**
 * The native sheet (native/authsheet): a system sheet over our window showing only the server's and Google's (or the
 * IdP's) pages, Safari's cookies kept (not ephemeral), so Google remembers the person. `start` is false when it can't
 * be shown (then the system browser is used); `done` gets the callback URL, or an error: "cancelled" (the sheet's
 * Cancel, or `cancel()`), anything else a failure.
 */
export interface AuthSheet {
  start(url: string, callbackScheme: string, done: (error: string | null, url: string | null) => void): boolean;
  cancel(): void;
}

/** The sheet couldn't be shown: the caller falls back to the system browser. */
export class SheetUnavailable extends Error {}

/** `designer://auth/callback?state&code|error` → the code, or the error (Google's refusal a cancel; SSO's texts kept). A
 *  callback for another state (a stale sheet) or anything else is a failure. */
export function sheetCallback(url: string, state: string): { code: string } | { error: SignInError } {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { error: new SignInError("failed", "not a callback") };
  }
  if (u.protocol !== `${SHEET_SCHEME}:` || u.host !== "auth" || u.pathname !== "/callback") return { error: new SignInError("failed", "not a callback") };
  if (!sameState(u.searchParams.get("state") ?? "", state)) return { error: new SignInError("failed", "This sign-in is out of date. Start again.") };
  const error = u.searchParams.get("error");
  const code = u.searchParams.get("code");
  if (error || !code) return { error: loopbackError(error) };
  return { code };
}

/** Signs in through the sheet: `/auth/login?callback=designer…` shown in it, the code from its callback traded with the
 *  verifier. Throws SheetUnavailable when the sheet didn't start (nothing was shown). */
export async function signInWithSheet(opts: SheetOptions): Promise<Session> {
  const { state, verifier, challenge } = pkce();
  const url = loginUrl(opts, { callback: SHEET_SCHEME }, state, challenge);
  let settle!: (r: { code: string } | { error: SignInError }) => void;
  const answered = new Promise<{ code: string } | { error: SignInError }>((res) => (settle = res));
  const started = opts.sheet.start(url, SHEET_SCHEME, (error, back) => {
    if (error === "cancelled") return settle({ error: new SignInError("cancelled", SIGN_IN_ERROR_TEXT.access_denied) });
    if (error || !back) return settle({ error: new SignInError("failed", error ?? "no callback") });
    settle(sheetCallback(back, state));
  });
  if (!started) throw new SheetUnavailable("the sign-in sheet didn't start");
  // Settled first: the sheet's own "cancelled" (cancel() may answer at once) comes second and changes nothing.
  const timer = setTimeout(() => {
    settle({ error: new SignInError("timeout", "the sign-in didn't finish") });
    opts.sheet.cancel();
  }, opts.timeoutMs ?? 10 * 60_000);
  const onAbort = () => {
    settle({ error: new SignInError("cancelled", "sign-in cancelled") });
    opts.sheet.cancel();
  };
  if (opts.signal?.aborted) onAbort();
  opts.signal?.addEventListener("abort", onAbort);
  try {
    const r = await answered;
    if ("error" in r) throw r.error;
    return await exchange(opts, r.code, verifier);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

/** Which way a sign-in goes (docs/desktop.md §18.6): the sheet on a Mac whose addon loaded and a window to hang it on;
 *  the system browser otherwise (Windows, Linux, no addon, macOS before 10.15 — the addon says unavailable). */
export function signInFlow(o: { platform: NodeJS.Platform; sheet: AuthSheet | null; window: boolean }): "sheet" | "browser" {
  return o.platform === "darwin" && o.sheet !== null && o.window ? "sheet" : "browser";
}

// ---- the system browser and the loopback ----------------------------------------------------------------------------

export async function signInWithBrowser(opts: SignInOptions): Promise<Session> {
  const { state, verifier, challenge } = pkce();

  let settle!: (r: { code: string } | { error: SignInError }) => void;
  const answered = new Promise<{ code: string } | { error: SignInError }>((res) => (settle = res));
  const http = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") return void res.writeHead(404).end();
    if (!sameState(url.searchParams.get("state") ?? "", state)) {
      // Not our sign-in (a stale tab): leave the real one waiting.
      return void page(res, 400, t("This sign-in link is out of date. Start again from Wecra."));
    }
    const error = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    if (error || !code) {
      const err = loopbackError(error);
      // An SSO refusal says why (its text is ours, no markup); anything else reads as a cancel.
      page(res, 200, err.code === "failed" && error && Object.hasOwn(SIGN_IN_ERROR_TEXT, error) ? `${t(err.message)} ${t("You can close this tab.")}` : t("Sign-in was cancelled. You can close this tab."));
      return settle({ error: err });
    }
    page(res, 200, t("You're signed in. You can close this tab and go back to Wecra."));
    settle({ code });
  });
  await new Promise<void>((res, rej) => http.once("error", rej).listen(0, "127.0.0.1", () => res()));
  const port = (http.address() as { port: number }).port;

  const timer = setTimeout(() => settle({ error: new SignInError("timeout", "the browser didn't come back") }), opts.timeoutMs ?? 10 * 60_000);
  const onAbort = () => settle({ error: new SignInError("cancelled", "sign-in cancelled") });
  opts.signal?.addEventListener("abort", onAbort);
  try {
    await opts.openBrowser(loginUrl(opts, { port: String(port) }, state, challenge));
    const r = await answered;
    if ("error" in r) throw r.error;
    return await exchange(opts, r.code, verifier);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
    http.closeAllConnections();
    http.close();
  }
}

function page(res: ServerResponse, status: number, text: string) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", connection: "close" });
  res.end(`<!doctype html><meta charset="utf-8"><title>Wecra</title><body style="font:14px -apple-system,system-ui;margin:48px;color:#222">${text}</body>`);
}
