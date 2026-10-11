/**
 * Sign-in through the system browser (docs/multiplayer.md §2), without Electron so the tests drive it: a loopback
 * server on 127.0.0.1, the server's /auth/login opened in the browser with our state and PKCE challenge, the one-time
 * code that comes back traded (with the verifier) for a session token.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AccountUser } from "../../shared/account";

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
      page(res, 200, "Sign-in was cancelled. You can close this tab.");
      return settle({ error: new SignInError(error === "access_denied" ? "cancelled" : "failed", error ?? "no code") });
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
    login.search = new URLSearchParams({ port: String(port), state, challenge }).toString();
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
