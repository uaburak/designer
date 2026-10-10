/**
 * The Worker's HTTP API (docs/multiplayer.md §2–3): sign-in, files, members, and the routes forwarded to a file's room.
 * A plain `Request → Response` function over injected dependencies, so Node's tests drive it without Cloudflare.
 */
import type { Role } from "../../src/shared/multiplayer/protocol";
import { normalizeEmail, type Db, type User } from "./db";
import { authorizeUrl, exchangeCode, GoogleError } from "./google";
import { isPreviewPath, previews } from "./previews";
import { randomToken, sha256b64url, signToken, verifyToken } from "./tokens";

export interface Env {
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** HMAC key of session tokens and OAuth state (`wrangler secret put SESSION_SECRET`) */
  SESSION_SECRET?: string;
  /** "1" in server/.dev.vars only: enables POST /auth/dev */
  DEV_AUTH?: string;
  /** Comma-separated origins of the web app allowed to sign in and call the API (CORS), e.g. "http://localhost:5199" */
  WEB_ORIGINS?: string;
}

/** A file's room (the FileRoom Durable Object); `path` is one of `/room/…`. */
export interface Rooms {
  fetch(fileKey: string, path: string, init: RequestInit & { identity?: { userId: string; name: string | null; role: Role } }, original?: Request): Promise<Response>;
}

export interface Deps {
  db: Db;
  env: Env;
  rooms: Rooms;
  fetch: typeof fetch;
  /** Milliseconds */
  now(): number;
}

export const SESSION_DAYS = 30;
const STATE_SECONDS = 600;
const CODE_MS = 120_000;
const MAX_SNAPSHOT_BYTES = 90 * 1024 * 1024;

interface SessionPayload {
  uid: string;
  tv: number;
  exp: number;
}

interface StatePayload {
  /** The desktop app's loopback port (0 for the web app), the app's own state, its PKCE challenge */
  p: number;
  /** The web app's page to come back to (instead of a loopback) */
  r?: string;
  s: string;
  c: string;
  exp: number;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
const publicUser = (u: User) => ({ id: u.id, email: u.email, name: u.name, picture: u.picture });
const FILE_KEY = /^[A-Za-z0-9_-]{6,64}$/;

export async function handle(req: Request, deps: Deps): Promise<Response> {
  const origin = req.headers.get("origin");
  const allowed = origin !== null && webOrigins(deps).includes(origin);
  if (req.method === "OPTIONS") {
    if (!allowed) return new Response(null, { status: 403 });
    return new Response(null, { status: 204, headers: cors(origin, { "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE", "access-control-allow-headers": "authorization, content-type", "access-control-max-age": "86400" }) });
  }
  let res: Response;
  try {
    res = await route(req, deps);
  } catch (e) {
    if (e instanceof HttpError) res = json({ error: e.message }, e.status);
    else {
      console.error(e);
      res = json({ error: "internal error" }, 500);
    }
  }
  if (!allowed || res.status === 101 || (res as { webSocket?: unknown }).webSocket) return res;
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(cors(origin, { "access-control-expose-headers": "x-seq, x-last-seq" }))) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

const webOrigins = (deps: Deps) => (deps.env.WEB_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const cors = (origin: string, extra: Record<string, string>) => ({ "access-control-allow-origin": origin, vary: "Origin", ...extra });

async function route(req: Request, deps: Deps): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const m = req.method;

  if (path === "/") return json({ name: "designer", ok: true });
  if (path === "/auth/login" && m === "GET") return login(url, deps);
  if (path === "/auth/callback" && m === "GET") return callback(url, deps);
  if (path === "/auth/token" && m === "POST") return token(req, deps);
  if (path === "/auth/dev" && m === "POST") return devSignIn(req, deps);
  const link = /^\/f\/([A-Za-z0-9_-]{6,64})$/.exec(path);
  if (link && m === "GET") return linkPage(link[1]);
  if (isPreviewPath(path)) return previews(req, url, deps, () => authenticate(req, url, deps, false));

  const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  const isSocket = parts[0] === "files" && parts[2] === "ws" && parts.length === 3;
  const user = await authenticate(req, url, deps, isSocket);

  if (path === "/me" && m === "GET") return json(publicUser(user));
  if (path === "/devices" && m === "POST") {
    const { installationId } = await readJson<{ installationId?: string }>(req);
    if (typeof installationId !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(installationId)) throw new HttpError(400, "bad installation id");
    const ordinal = await deps.db.deviceOrdinal(installationId, user.id, deps.now());
    if (ordinal === null) throw new HttpError(507, "no device ordinals left");
    return json({ ordinal });
  }
  if (path === "/auth/signout-everywhere" && m === "POST") {
    await deps.db.bumpTokenVersion(user.id);
    return json({ ok: true });
  }

  if (parts[0] !== "files") throw new HttpError(404, "not found");
  if (parts.length === 1) {
    if (m === "GET") return json({ files: await deps.db.files(user.id) });
    if (m === "POST") {
      const body = await readJson<{ key?: string; name?: string }>(req);
      const key = body.key ?? "";
      if (!FILE_KEY.test(key)) throw new HttpError(400, "bad file key");
      const name = cleanName(body.name);
      if (!(await deps.db.createFile(key, user.id, name, deps.now()))) throw new HttpError(409, "file key taken");
      return json({ key, name, role: "owner" }, 201);
    }
    throw new HttpError(405, "method not allowed");
  }

  const key = parts[1];
  if (!FILE_KEY.test(key)) throw new HttpError(400, "bad file key");
  const role = await deps.db.roleOf(key, user.id);
  if (!role) throw new HttpError(404, "no such file"); // also when it exists but isn't shared with the caller
  const identity = { userId: user.id, name: user.name, role };
  const atLeast = (r: Role) => {
    if (rank[role] < rank[r]) throw new HttpError(403, r === "owner" ? "only the owner can" : "you can only view this file");
  };

  if (parts.length === 2) {
    if (m === "GET") {
      const f = await deps.db.file(key);
      return json({ key, name: f?.name ?? "Untitled", role, linkAccess: f?.linkAccess ?? "none", viewersCanCopy: f?.viewersCanCopy ?? true, link: `${url.origin}/f/${key}` });
    }
    if (m === "PATCH") {
      const body = await readJson<{ name?: string; linkAccess?: string; viewersCanCopy?: unknown }>(req);
      if (body.viewersCanCopy !== undefined) {
        atLeast("editor");
        await deps.db.setViewersCanCopy(key, body.viewersCanCopy === true, deps.now());
      }
      if (body.linkAccess !== undefined) {
        atLeast("owner");
        if (body.linkAccess !== "none" && body.linkAccess !== "viewer" && body.linkAccess !== "editor") throw new HttpError(400, "linkAccess is none, viewer or editor");
        await deps.db.setLinkAccess(key, body.linkAccess, deps.now());
        // Someone in by the link alone loses it with "none": their sockets reconnect and are refused.
        if (body.linkAccess !== "editor") await deps.rooms.fetch(key, "/room/revoke-link", { method: "POST" });
      }
      if (body.name !== undefined) {
        atLeast("editor");
        await deps.db.renameFile(key, cleanName(body.name), deps.now());
      }
      return json({ ok: true });
    }
    if (m === "DELETE") {
      atLeast("owner");
      await deps.rooms.fetch(key, "/room", { method: "DELETE" });
      await deps.db.deleteFile(key);
      return json({ ok: true });
    }
    throw new HttpError(405, "method not allowed");
  }

  switch (parts[2]) {
    case "members": {
      if (parts.length === 3 && m === "GET") return json({ members: await deps.db.members(key) });
      if (parts.length === 3 && m === "PUT") {
        atLeast("owner");
        const body = await readJson<{ email?: string; role?: string }>(req);
        const email = normalizeEmail(body.email ?? "");
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, "bad email");
        if (body.role !== "editor" && body.role !== "viewer") throw new HttpError(400, "role is editor or viewer");
        if (email === user.email) throw new HttpError(400, "you own this file");
        const memberId = await deps.db.putMember(key, email, body.role, user.id, deps.now());
        // A changed role takes effect on the member's open sockets: they reconnect with it.
        if (memberId) await deps.rooms.fetch(key, "/room/revoke", { method: "POST", body: JSON.stringify({ userId: memberId }) });
        return json({ ok: true });
      }
      if (parts.length === 4 && m === "DELETE") {
        atLeast("owner");
        const memberId = await deps.db.removeMember(key, parts[3]);
        if (memberId) await deps.rooms.fetch(key, "/room/revoke", { method: "POST", body: JSON.stringify({ userId: memberId }) });
        return json({ ok: true });
      }
      break;
    }
    case "snapshot": {
      if (parts.length !== 3) break;
      if (m === "GET") return deps.rooms.fetch(key, "/room/snapshot", { method: "GET", identity });
      if (m === "PUT") {
        atLeast("editor");
        const seq = Number(url.searchParams.get("seq"));
        if (!Number.isInteger(seq) || seq < 0) throw new HttpError(400, "bad seq");
        const length = Number(req.headers.get("content-length") ?? "0");
        if (length > MAX_SNAPSHOT_BYTES) throw new HttpError(413, "snapshot too large");
        const body = await req.arrayBuffer();
        if (body.byteLength > MAX_SNAPSHOT_BYTES) throw new HttpError(413, "snapshot too large");
        return deps.rooms.fetch(key, `/room/snapshot?seq=${seq}`, { method: "PUT", body, identity });
      }
      break;
    }
    case "requests": {
      // "Ask to edit": a viewer asks; editors see the requests (live, through the room) and approve or deny.
      if (parts.length === 3 && m === "POST") {
        if (role !== "viewer") throw new HttpError(400, "you can already edit");
        await deps.db.addRequest(key, user.id, deps.now());
        await deps.rooms.fetch(key, "/room/notice", { method: "POST", body: JSON.stringify({ kind: "access-request", userId: user.id, name: user.name ?? user.email }) });
        return json({ ok: true });
      }
      if (parts.length === 3 && m === "GET") {
        atLeast("editor");
        return json({ requests: await deps.db.requests(key) });
      }
      if (parts.length === 4 && m === "POST") {
        atLeast("editor");
        const { approve } = await readJson<{ approve?: unknown }>(req);
        const r = await deps.db.takeRequest(key, parts[3]);
        if (!r) throw new HttpError(404, "no such request");
        // The answer reaches them first, on the socket they have now…
        await deps.rooms.fetch(key, "/room/notice", { method: "POST", body: JSON.stringify({ kind: approve === true ? "access-granted" : "access-denied", userId: parts[3] }) });
        if (approve === true) {
          await deps.db.putMember(key, r.email, "editor", user.id, deps.now());
          // …which then reconnects as an editor.
          await deps.rooms.fetch(key, "/room/revoke", { method: "POST", body: JSON.stringify({ userId: parts[3] }) });
        }
        return json({ ok: true });
      }
      break;
    }
    case "blobs": {
      // Images a shared file uses, by SHA-1, kept by its room (docs/multiplayer.md §4).
      if (parts.length === 4 && parts[3] === "missing" && m === "POST") {
        const { sha1s } = await readJson<{ sha1s?: unknown }>(req);
        if (!Array.isArray(sha1s) || sha1s.length > 1000 || !sha1s.every((s) => typeof s === "string" && /^[0-9a-f]{40}$/.test(s))) throw new HttpError(400, "sha1s");
        return deps.rooms.fetch(key, "/room/blobs/missing", { method: "POST", body: JSON.stringify({ sha1s }), identity });
      }
      if (parts.length !== 4 || !/^[0-9a-f]{40}$/.test(parts[3])) break;
      if (m === "GET") return deps.rooms.fetch(key, `/room/blobs/${parts[3]}`, { method: "GET", identity });
      if (m === "PUT") {
        atLeast("editor");
        const body = await req.arrayBuffer();
        if (body.byteLength > 40 * 1024 * 1024) throw new HttpError(413, "image too large");
        return deps.rooms.fetch(key, `/room/blobs/${parts[3]}`, { method: "PUT", body, identity });
      }
      break;
    }
    case "ws": {
      if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") throw new HttpError(426, "expected a WebSocket");
      return deps.rooms.fetch(key, "/room/ws", { method: "GET", identity }, req);
    }
  }
  throw new HttpError(404, "not found");
}

const rank: Record<Role, number> = { viewer: 0, editor: 1, owner: 2 };

function cleanName(name: unknown): string {
  const n = typeof name === "string" ? name.trim().slice(0, 200) : "";
  return n || "Untitled";
}

async function readJson<T>(req: Request): Promise<T> {
  try {
    const v = (await req.json()) as T;
    if (v && typeof v === "object") return v;
  } catch {
    // fall through
  }
  throw new HttpError(400, "expected a JSON object");
}

function secret(deps: Deps): string {
  const s = deps.env.SESSION_SECRET;
  if (!s || s.length < 32) throw new HttpError(500, "SESSION_SECRET is not set");
  return s;
}

const seconds = (deps: Deps) => Math.floor(deps.now() / 1000);

async function authenticate(req: Request, url: URL, deps: Deps, allowQuery: boolean): Promise<User> {
  const header = req.headers.get("authorization");
  const raw = header?.startsWith("Bearer ") ? header.slice(7) : allowQuery ? url.searchParams.get("token") : null;
  if (!raw) throw new HttpError(401, "sign in first");
  const p = await verifyToken<SessionPayload>(raw, secret(deps), seconds(deps));
  const user = p && (await deps.db.user(p.uid));
  if (!p || !user || user.tokenVersion !== p.tv) throw new HttpError(401, "session expired");
  return user;
}

async function issueSession(user: User, deps: Deps): Promise<Response> {
  const exp = seconds(deps) + SESSION_DAYS * 86400;
  const token = await signToken({ uid: user.id, tv: user.tokenVersion, exp }, secret(deps));
  return json({ token, expiresAt: exp * 1000, user: publicUser(user) });
}

function googleConfig(url: URL, deps: Deps) {
  const { GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret } = deps.env;
  if (!clientId || !clientSecret) throw new HttpError(503, "Google sign-in is not configured");
  return { clientId, clientSecret, redirectUri: `${url.origin}/auth/callback` };
}

/** Step 2: the app's browser arrives here with its loopback port (or, the web app, its page), state and PKCE challenge. */
async function login(url: URL, deps: Deps): Promise<Response> {
  const ret = url.searchParams.get("return");
  const p = ret === null ? Number(url.searchParams.get("port")) : 0;
  const s = url.searchParams.get("state") ?? "";
  const c = url.searchParams.get("challenge") ?? "";
  if (ret !== null) {
    let back: URL | null = null;
    try {
      back = new URL(ret);
    } catch {
      // refused below
    }
    if (!back || !webOrigins(deps).includes(back.origin)) throw new HttpError(400, "return page not allowed");
  } else if (!Number.isInteger(p) || p < 1024 || p > 65535) throw new HttpError(400, "bad port");
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(s)) throw new HttpError(400, "bad state");
  if (!/^[A-Za-z0-9_-]{43}$/.test(c)) throw new HttpError(400, "bad challenge");
  const cfg = googleConfig(url, deps);
  const state = await signToken({ p, s, c, ...(ret !== null ? { r: ret } : {}), exp: seconds(deps) + STATE_SECONDS } satisfies StatePayload, secret(deps));
  return Response.redirect(authorizeUrl(cfg, state), 302);
}

/** Step 3: Google sends the browser back; the app's loopback gets a one-time code. */
async function callback(url: URL, deps: Deps): Promise<Response> {
  const st = await verifyToken<StatePayload>(url.searchParams.get("state") ?? "", secret(deps), seconds(deps));
  if (!st) return page(400, "This sign-in link has expired. Start again from the app.");
  // The web app reads auth_* parameters (its own page may use state / code / error for something else).
  const web = typeof st.r === "string";
  const back = web ? new URL(st.r!) : new URL(`http://127.0.0.1:${st.p}/callback`);
  const param = (k: string) => (web ? `auth_${k}` : k);
  back.searchParams.set(param("state"), st.s);
  const code = url.searchParams.get("code");
  if (!code) {
    back.searchParams.set(param("error"), url.searchParams.get("error") ?? "access_denied");
    return Response.redirect(back.toString(), 302);
  }
  let profile;
  try {
    profile = await exchangeCode(code, googleConfig(url, deps), deps.fetch, seconds(deps));
  } catch (e) {
    if (!(e instanceof GoogleError)) throw e;
    back.searchParams.set(param("error"), "google_failed");
    return Response.redirect(back.toString(), 302);
  }
  const user = await deps.db.upsertUser(profile, deps.now());
  const appCode = randomToken();
  await deps.db.putAuthCode(await sha256b64url(appCode), user.id, st.c, deps.now() + CODE_MS);
  back.searchParams.set(param("code"), appCode);
  return Response.redirect(back.toString(), 302);
}

/** Step 4: the app trades the code and its PKCE verifier for a session token. */
async function token(req: Request, deps: Deps): Promise<Response> {
  const body = await readJson<{ code?: string; verifier?: string }>(req);
  if (typeof body.code !== "string" || typeof body.verifier !== "string") throw new HttpError(400, "code and verifier");
  const row = await deps.db.takeAuthCode(await sha256b64url(body.code), deps.now());
  if (!row || row.challenge !== (await sha256b64url(body.verifier))) throw new HttpError(400, "invalid or expired code");
  const user = await deps.db.user(row.userId);
  if (!user) throw new HttpError(400, "invalid or expired code");
  return issueSession(user, deps);
}

/** Local development only (DEV_AUTH=1 in server/.dev.vars): a session for any email, no Google. */
async function devSignIn(req: Request, deps: Deps): Promise<Response> {
  if (deps.env.DEV_AUTH !== "1") throw new HttpError(404, "not found");
  const body = await readJson<{ email?: string; name?: string }>(req);
  if (!body.email) throw new HttpError(400, "email");
  const user = await deps.db.upsertUser({ sub: `dev:${normalizeEmail(body.email)}`, email: body.email, name: body.name ?? null }, deps.now());
  return issueSession(user, deps);
}

/** A file's link opened in a browser: a page that hands it to the desktop app (designer://open?key=…). */
function linkPage(key: string): Response {
  const app = `designer://open?key=${encodeURIComponent(key)}`;
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Open in DesignerV2</title>
<body style="font:14px -apple-system,system-ui;margin:0;display:grid;place-items:center;min-height:100vh;background:#f5f5f5;color:#1e1e1e">
<div style="text-align:center;max-width:360px;padding:24px"><h1 style="font-size:18px;font-weight:600;margin:0 0 8px">Open this file in DesignerV2</h1>
<p style="margin:0 0 20px;color:#666">You need the desktop app and to be logged in with an account that has access.</p>
<a href="${app}" style="display:inline-block;padding:8px 16px;border-radius:6px;background:#0d99ff;color:#fff;text-decoration:none;font-weight:500">Open in the app</a>
<p style="margin:20px 0 0;color:#888;font-size:12px">Or in DesignerV2: Home › Shared with me › paste this link.</p></div>
<script>location.href=${JSON.stringify(app)}</script>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

function page(status: number, text: string): Response {
  const html = `<!doctype html><meta charset="utf-8"><title>DesignerV2</title><body style="font:14px system-ui;margin:40px">${text.replace(/[<>&]/g, "")}</body>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}
