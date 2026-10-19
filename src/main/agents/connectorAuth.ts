import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { t as tr } from "../../shared/i18n";

/**
 * Connectors that sign in (docs/ai.md §2.11; Figma's connectors are added with OAuth): MCP's authorization (2025-06-18).
 * The server's 401 names its protected-resource metadata (RFC 9728), which names the authorization server; that one's
 * metadata (RFC 8414, else OpenID's) gives the endpoints. Wecra registers itself there (dynamic client registration,
 * RFC 7591: a public client, no secret), then the owner signs in in his browser — the authorization code with PKCE
 * (S256), the `resource` parameter (RFC 8707) naming the MCP server — and the code comes back to a loopback address of
 * this computer (RFC 8252: 127.0.0.1, a port of the sign-in's own, /callback, the state checked, once). The tokens are
 * kept sealed with the connector's other secrets and are only ever an Authorization header to that server; an expired
 * one is refreshed before a call. Electron-free: fetch and the browser are injected (host.ts opens the system's).
 */

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  /** ms since the epoch */
  expiresAt?: number;
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  /** The MCP server the tokens are for (RFC 8707) */
  resource: string;
}

/** The server wants its user signed in (a 401 without a key of ours, or tokens that can't be refreshed). */
export class SignInNeeded extends Error {
  constructor(readonly wwwAuthenticate: string | null) {
    super(tr("Sign in to use this connector."));
  }
}

export interface AuthServer {
  resource: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  scope?: string;
}

const SIGN_IN_MS = 5 * 60_000;
const REQUEST_MS = 20_000;

/** A `WWW-Authenticate: Bearer …` header's parameters (resource_metadata, scope, error). */
export function bearerParams(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  const m = /Bearer\s+(.*)$/i.exec(header ?? "");
  if (!m) return out;
  for (const p of m[1].matchAll(/([\w-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g)) out[p[1].toLowerCase()] = (p[2] ?? p[3] ?? "").replace(/\\(.)/g, "$1");
  return out;
}

/** Endpoints are https — or http to this computer only (a local server under development). */
export function safeEndpoint(raw: unknown): string {
  const url = new URL(String(raw ?? ""));
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new Error(tr("The connector's sign-in isn't on a secure address ({url}).", { url: `${url.protocol}//${url.host}` }));
  if (url.username || url.password) throw new Error(tr("The connector's sign-in isn't on a secure address ({url}).", { url: url.host }));
  return url.toString();
}

/** The MCP server's URL as a resource (RFC 8707): no fragment; scheme and host lower case. */
export const canonicalResource = (serverUrl: string) => {
  const u = new URL(serverUrl);
  u.hash = "";
  return u.toString();
};

async function getJson(f: typeof fetch, url: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await f(url, { headers: { Accept: "application/json", "MCP-Protocol-Version": "2025-06-18" }, signal: AbortSignal.timeout(REQUEST_MS) });
    if (!res.ok) return null;
    const v = (await res.json()) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** `/.well-known/<name>` for a URL: inserted before its path (RFC 8414 §3, RFC 9728 §3), then at the root. */
function wellKnown(url: string, name: string): string[] {
  const u = new URL(url);
  const path = u.pathname.replace(/\/+$/, "");
  return [...new Set([...(path ? [`${u.origin}/.well-known/${name}${path}`] : []), `${u.origin}/.well-known/${name}`])];
}

/** From the server's 401 to the authorization server's endpoints (MCP 2025-06-18; 2025-03-26's defaults as the last resort). */
export async function discover(serverUrl: string, wwwAuthenticate: string | null, f: typeof fetch = fetch): Promise<AuthServer> {
  const params = bearerParams(wwwAuthenticate);
  const resourceUrls = [...(params.resource_metadata ? [safeEndpoint(params.resource_metadata)] : []), ...wellKnown(serverUrl, "oauth-protected-resource")];
  let prm: Record<string, unknown> | null = null;
  for (const u of resourceUrls) if ((prm = await getJson(f, u))) break;
  const servers = Array.isArray(prm?.authorization_servers) ? (prm!.authorization_servers as unknown[]).filter((s): s is string => typeof s === "string") : [];
  const issuer = servers[0] ?? new URL(serverUrl).origin;
  const scope = params.scope ?? (Array.isArray(prm?.scopes_supported) ? (prm!.scopes_supported as unknown[]).filter((s) => typeof s === "string").join(" ") : "");
  const resource = typeof prm?.resource === "string" ? prm.resource : canonicalResource(serverUrl);
  const u = new URL(issuer);
  const path = u.pathname.replace(/\/+$/, "");
  const metaUrls = [...wellKnown(issuer, "oauth-authorization-server"), ...wellKnown(issuer, "openid-configuration"), ...(path ? [`${u.origin}${path}/.well-known/openid-configuration`] : [])];
  let meta: Record<string, unknown> | null = null;
  for (const m of [...new Set(metaUrls)]) if ((meta = await getJson(f, m))) break;
  if (!meta) {
    // No metadata anywhere: the 2025-03-26 defaults on the server's own origin, when it named no authorization server.
    if (servers.length) throw new Error(tr("The connector's sign-in server doesn't describe itself."));
    const origin = new URL(serverUrl).origin;
    return { resource, authorizationEndpoint: `${origin}/authorize`, tokenEndpoint: `${origin}/token`, registrationEndpoint: `${origin}/register`, ...(scope ? { scope } : {}) };
  }
  const methods = meta.code_challenge_methods_supported;
  if (Array.isArray(methods) && !methods.includes("S256")) throw new Error(tr("The connector's sign-in doesn't support PKCE (S256)."));
  return {
    resource,
    authorizationEndpoint: safeEndpoint(meta.authorization_endpoint),
    tokenEndpoint: safeEndpoint(meta.token_endpoint),
    ...(typeof meta.registration_endpoint === "string" ? { registrationEndpoint: safeEndpoint(meta.registration_endpoint) } : {}),
    ...(scope ? { scope } : {}),
  };
}

/** Wecra registered as a public client for this sign-in's redirect (RFC 7591). */
export async function register(as: AuthServer, redirectUri: string, f: typeof fetch = fetch): Promise<{ clientId: string; clientSecret?: string }> {
  if (!as.registrationEndpoint) throw new Error(tr("The connector's server doesn't let apps register: it can't be signed in from Wecra."));
  const res = await f(as.registrationEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ client_name: "Wecra", redirect_uris: [redirectUri], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", ...(as.scope ? { scope: as.scope } : {}) }),
    signal: AbortSignal.timeout(REQUEST_MS),
  });
  const body = (await res.json().catch(() => ({}))) as { client_id?: unknown; client_secret?: unknown; error_description?: unknown; error?: unknown };
  if (!res.ok || typeof body.client_id !== "string") throw new Error(tr("The connector's server didn't register Wecra ({why}).", { why: String(body.error_description ?? body.error ?? res.status) }));
  return { clientId: body.client_id, ...(typeof body.client_secret === "string" ? { clientSecret: body.client_secret } : {}) };
}

const base64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** PKCE (RFC 7636): a 43-character verifier and its S256 challenge. */
export function pkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  return { verifier, challenge: base64url(createHash("sha256").update(verifier).digest()) };
}

async function tokenRequest(endpoint: string, form: Record<string, string>, f: typeof fetch): Promise<Omit<OAuthTokens, "tokenEndpoint" | "clientId" | "clientSecret" | "resource">> {
  const res = await f(endpoint, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: new URLSearchParams(form).toString(), signal: AbortSignal.timeout(REQUEST_MS) });
  const body = (await res.json().catch(() => ({}))) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; error?: unknown; error_description?: unknown };
  // Never the answer itself in an error: it may hold a token.
  if (!res.ok || typeof body.access_token !== "string") throw new Error(tr("The connector's sign-in was refused ({why}).", { why: String(typeof body.error === "string" ? body.error : res.status) }));
  return { accessToken: body.access_token, ...(typeof body.refresh_token === "string" ? { refreshToken: body.refresh_token } : {}), ...(typeof body.expires_in === "number" && body.expires_in > 0 ? { expiresAt: Date.now() + body.expires_in * 1000 } : {}) };
}

/** New tokens from the refresh token (the refresh token kept when the server sends none); null when there is none. */
export async function refreshTokens(tokens: OAuthTokens, f: typeof fetch = fetch): Promise<OAuthTokens | null> {
  if (!tokens.refreshToken) return null;
  const next = await tokenRequest(tokens.tokenEndpoint, { grant_type: "refresh_token", refresh_token: tokens.refreshToken, client_id: tokens.clientId, ...(tokens.clientSecret ? { client_secret: tokens.clientSecret } : {}), resource: tokens.resource }, f);
  return { ...tokens, ...next, refreshToken: next.refreshToken ?? tokens.refreshToken };
}

/** Tokens that run out within a minute are refreshed before they are used. */
export const expiresSoon = (t: OAuthTokens, now = Date.now()) => t.expiresAt !== undefined && t.expiresAt - now < 60_000;

const PAGE = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font: 14px system-ui, sans-serif; display: grid; place-items: center; height: 90vh; margin: 0"><div><h1 style="font-size: 18px">${title}</h1><p>${body}</p></div>`;

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** The loopback address the browser comes back to: 127.0.0.1, a port of its own, /callback; one answer, state checked. */
async function loopback(state: string, ms: number): Promise<{ redirectUri: string; code: Promise<string>; close(): void }> {
  let settle!: { ok: (code: string) => void; fail: (e: Error) => void };
  const code = new Promise<string>((ok, fail) => (settle = { ok, fail }));
  // Its failure is read once the browser is open; never an unhandled rejection before that.
  code.catch(() => undefined);
  let done = false;
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback" || done) return res.writeHead(404).end();
    const error = url.searchParams.get("error");
    const got = url.searchParams.get("code");
    const ok = !error && !!got && url.searchParams.get("state") === state;
    res.writeHead(ok ? 200 : 400, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(ok ? PAGE(tr("You’re signed in"), tr("You can close this tab and go back to Wecra.")) : PAGE(tr("Not signed in"), escapeHtml(error ? (url.searchParams.get("error_description") ?? error) : tr("This sign-in isn't the one Wecra started."))));
    // A wrong state is a stray request, not the answer: keep waiting for the real one.
    if (!ok && !error) return;
    done = true;
    if (ok) settle.ok(got!);
    else settle.fail(new Error(tr("The sign-in was cancelled ({why}).", { why: error! })));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const timer = setTimeout(() => settle.fail(new Error(tr("The sign-in took too long."))), ms);
  timer.unref?.();
  const close = () => {
    clearTimeout(timer);
    server.close();
  };
  return { redirectUri: `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`, code, close };
}

/**
 * The whole sign-in: discovery from the server's 401, registration for this sign-in's redirect, the browser opened on
 * the authorization page, the code from the loopback exchanged with the PKCE verifier. Resolves with the tokens.
 */
export async function signIn(o: { serverUrl: string; wwwAuthenticate: string | null; fetch?: typeof fetch; openBrowser(url: string): void | Promise<void>; timeoutMs?: number }): Promise<OAuthTokens> {
  const f = o.fetch ?? fetch;
  const as = await discover(o.serverUrl, o.wwwAuthenticate, f);
  const state = base64url(randomBytes(16));
  const back = await loopback(state, o.timeoutMs ?? SIGN_IN_MS);
  try {
    const client = await register(as, back.redirectUri, f);
    const { verifier, challenge } = pkce();
    const url = new URL(as.authorizationEndpoint);
    for (const [k, v] of Object.entries({ response_type: "code", client_id: client.clientId, redirect_uri: back.redirectUri, code_challenge: challenge, code_challenge_method: "S256", state, resource: as.resource, ...(as.scope ? { scope: as.scope } : {}) })) url.searchParams.set(k, v);
    await o.openBrowser(url.toString());
    const code = await back.code;
    const tokens = await tokenRequest(as.tokenEndpoint, { grant_type: "authorization_code", code, redirect_uri: back.redirectUri, client_id: client.clientId, code_verifier: verifier, resource: as.resource, ...(client.clientSecret ? { client_secret: client.clientSecret } : {}) }, f);
    return { ...tokens, tokenEndpoint: as.tokenEndpoint, clientId: client.clientId, ...(client.clientSecret ? { clientSecret: client.clientSecret } : {}), resource: as.resource };
  } finally {
    back.close();
  }
}
