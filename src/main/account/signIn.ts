/**
 * Sign-in through the system browser (docs/multiplayer.md §2), without Electron so the tests drive it: a loopback
 * server on 127.0.0.1, the server's /auth/login opened in the browser with our state and PKCE challenge, the one-time
 * code that comes back traded (with the verifier) for a session token.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AccountUser } from "../../shared/account";
import { SIGN_IN_ERROR_TEXT, type SignInError as SignInErrorCode } from "../../shared/org/identity";

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
}

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

export async function signInWithBrowser(opts: SignInOptions): Promise<Session> {
  const doFetch = opts.fetch ?? fetch;
  const state = b64url(randomBytes(24));
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash("sha256").update(verifier).digest());

  let settle!: (r: { code: string } | { error: SignInError }) => void;
  const answered = new Promise<{ code: string } | { error: SignInError }>((res) => (settle = res));
  const http = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") return void res.writeHead(404).end();
    const got = Buffer.from(url.searchParams.get("state") ?? "");
    const want = Buffer.from(state);
    if (got.length !== want.length || !timingSafeEqual(got, want)) {
      // Not our sign-in (a stale tab): leave the real one waiting.
      return void page(res, 400, "This sign-in link is out of date. Start again from DesignerV2.");
    }
    const error = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    if (error || !code) {
      const err = loopbackError(error);
      // An SSO refusal says why (its text is ours, no markup); anything else reads as a cancel.
      page(res, 200, err.code === "failed" && error && Object.hasOwn(SIGN_IN_ERROR_TEXT, error) ? `${err.message} You can close this tab.` : "Sign-in was cancelled. You can close this tab.");
      return settle({ error: err });
    }
    page(res, 200, "You're signed in. You can close this tab and go back to DesignerV2.");
    settle({ code });
  });
  await new Promise<void>((res, rej) => http.once("error", rej).listen(0, "127.0.0.1", () => res()));
  const port = (http.address() as { port: number }).port;

  const timer = setTimeout(() => settle({ error: new SignInError("timeout", "the browser didn't come back") }), opts.timeoutMs ?? 10 * 60_000);
  const onAbort = () => settle({ error: new SignInError("cancelled", "sign-in cancelled") });
  opts.signal?.addEventListener("abort", onAbort);
  try {
    const login = new URL("/auth/login", opts.server);
    const params = new URLSearchParams({ port: String(port), state, challenge });
    if (opts.tenant !== undefined) {
      if (!TENANT_ID.test(opts.tenant)) throw new SignInError("failed", "not a tenant id");
      params.set("tenant", opts.tenant);
    }
    login.search = params.toString();
    await opts.openBrowser(login.toString());
    const r = await answered;
    if ("error" in r) throw r.error;
    const res = await doFetch(new URL("/auth/token", opts.server), { method: "POST", headers: { "content-type": "application/json", ...(opts.userAgent ? { "user-agent": opts.userAgent } : {}) }, body: JSON.stringify({ code: r.code, verifier }) });
    if (!res.ok) throw new SignInError("failed", `token exchange ${res.status}`);
    const body = (await res.json()) as { token: string; expiresAt: number; user: AccountUser };
    return { server: opts.server, token: body.token, expiresAt: body.expiresAt, user: body.user };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
    http.closeAllConnections();
    http.close();
  }
}

function page(res: ServerResponse, status: number, text: string) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", connection: "close" });
  res.end(`<!doctype html><meta charset="utf-8"><title>DesignerV2</title><body style="font:14px -apple-system,system-ui;margin:48px;color:#222">${text}</body>`);
}
