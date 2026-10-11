/**
 * The Worker's HTTP API (docs/multiplayer.md §2–3): sign-in, files, members, and the routes forwarded to a file's room.
 * A plain `Request → Response` function over injected dependencies, so Node's tests drive it without Cloudflare.
 */
import type { Role } from "../../src/shared/multiplayer/protocol";
import { deviceFromUserAgent } from "../../src/shared/account";
import { patAllows, personalToken, requestPlace, type Caller } from "./account";
import { normalizeEmail, type Db, type User } from "./db";
import { authorizeUrl, exchangeCode, GoogleError } from "./google";
import { notificationsRoute, notifyEditRequest, notifyInvite, notifyOwnership, notifyRequestAnswered } from "./notifications";
import { isPreviewPath, previews, viewerPage } from "./previews";
import { checkPassword, hashPassword, randomToken, sha256b64url, signToken, verifyToken } from "./tokens";

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

/** Each person's inbox (the Inbox Durable Object, docs/multiplayer.md §12): live notifications to their open apps. */
export interface Inboxes {
  notify(userId: string, message: unknown): Promise<void>;
  /** The inbox's WebSocket for this (authenticated) person */
  connect(userId: string, original: Request): Promise<Response>;
}

export interface Deps {
  db: Db;
  env: Env;
  rooms: Rooms;
  /** Absent where there are none (tests that don't look): notifications are still stored */
  inboxes?: Inboxes;
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
  /** The session's row (Settings › Security › Sessions); absent in tokens issued before migration 0009 */
  sid?: string;
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
    return new Response(null, { status: 204, headers: cors(origin, { "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE", "access-control-allow-headers": "authorization, content-type, x-file-pass", "access-control-max-age": "86400" }) });
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
  if (link && m === "GET") return linkPage(link[1], url.searchParams);
  if (isPreviewPath(path)) return previews(req, url, deps, async () => sessionOnly(await authenticate(req, url, deps, false)));
  const embed = /^\/embed\/([A-Za-z0-9_-]{6,64})(?:\/(snapshot|frames|images\/[0-9a-f]{40}))?$/.exec(path);
  if (embed && m === "GET") return embedRoute(embed[1], embed[2], url, deps);

  const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  const isSocket = (parts[0] === "files" && parts[2] === "ws" && parts.length === 3) || (parts[0] === "notifications" && parts[1] === "ws" && parts.length === 2);
  const caller = await authenticate(req, url, deps, isSocket);
  const user = caller.user;
  if (parts[0] === "me") return (await import("./account")).accountRoute(req, deps, caller, parts);
  // A personal access token reads files and comments, nothing else (account.ts patAllows).
  if (caller.scopes && !patAllows(caller.scopes, m, parts)) throw new HttpError(403, "a personal access token can't do that");
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

  if (parts[0] === "notifications") return notificationsRoute(req, deps, user, parts, (key, requesterId, approve) => answerEditRequest(deps, key, user, requesterId, approve));
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
  const access = await deps.db.access(key, user.id);
  if (!access) throw new HttpError(404, "no such file"); // also when it exists but isn't shared with the caller
  const role = access.role;
  // "Password required": someone in by the link alone shows a pass for the current password (POST …/unlock) — invited
  // people never need it. The file's name and the unlock route are open to them so the app can ask.
  const needsPassword = !access.invited && access.password !== null && !(await validPass(req, url, deps, key, user.id, access.passwordVersion));
  const open = (parts.length === 2 && m === "GET") || (parts.length === 3 && parts[2] === "unlock" && m === "POST");
  if (needsPassword && !open) throw new HttpError(403, "password required");
  const identity = { userId: user.id, name: user.name, role };
  const atLeast = (r: Role) => {
    if (rank[role] < rank[r]) throw new HttpError(403, r === "owner" ? "only the owner can" : "you can only view this file");
  };

  if (parts.length === 2) {
    if (m === "GET") {
      const f = await deps.db.file(key);
      return json({ key, name: f?.name ?? "Untitled", role, linkAccess: f?.linkAccess ?? "none", viewersCanCopy: f?.viewersCanCopy ?? true, passwordProtected: f?.passwordProtected ?? false, needsPassword, link: `${url.origin}/f/${key}` });
    }
    if (m === "PATCH") {
      const body = await readJson<{ name?: string; linkAccess?: string; viewersCanCopy?: unknown; linkPassword?: unknown }>(req);
      if (body.linkPassword !== undefined) {
        // help.figma.com: anyone who can edit sets, changes or removes it; changing it makes link-only people enter it again.
        atLeast("editor");
        if (body.linkPassword !== null && (typeof body.linkPassword !== "string" || body.linkPassword.length < 1 || body.linkPassword.length > 128)) throw new HttpError(400, "linkPassword is 1–128 characters, or null");
        await deps.db.setLinkPassword(key, body.linkPassword === null ? null : await hashPassword(body.linkPassword), deps.now());
        await deps.rooms.fetch(key, "/room/revoke-link", { method: "POST" });
      }
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
    case "unlock": {
      if (parts.length !== 3 || m !== "POST") break;
      const { password } = await readJson<{ password?: unknown }>(req);
      if (!access.password) return json({ pass: null });
      if (typeof password !== "string" || !(await checkPassword(password, access.password))) throw new HttpError(403, "wrong password");
      const pass = await signToken({ k: key, u: user.id, v: access.passwordVersion, exp: seconds(deps) + SESSION_DAYS * 86400 }, secret(deps));
      return json({ pass });
    }
    case "transfer": {
      // "Transfer ownership" (help.figma.com 360038512093): owner only, to someone already invited; can't be undone.
      if (parts.length !== 3 || m !== "POST") break;
      atLeast("owner");
      const { email } = await readJson<{ email?: unknown }>(req);
      if (typeof email !== "string") throw new HttpError(400, "email");
      const done = await deps.db.transferOwnership(key, email, user.id, deps.now());
      if (!done) throw new HttpError(400, "only someone invited who has logged in can own the file");
      for (const userId of [done.toId, user.id]) await deps.rooms.fetch(key, "/room/revoke", { method: "POST", body: JSON.stringify({ userId }) });
      await notifyOwnership(deps, { key, by: user, toId: done.toId });
      return json({ ok: true });
    }
    case "members": {
      if (parts.length === 3 && m === "GET") return json({ members: await deps.db.members(key) });
      if (parts.length === 3 && m === "PUT") {
        atLeast("owner");
        const body = await readJson<{ email?: string; role?: string }>(req);
        const email = normalizeEmail(body.email ?? "");
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, "bad email");
        if (body.role !== "editor" && body.role !== "viewer") throw new HttpError(400, "role is editor or viewer");
        if (email === user.email) throw new HttpError(400, "you own this file");
        const invited = !(await deps.db.members(key)).some((x) => x.email === email);
        const memberId = await deps.db.putMember(key, email, body.role, user.id, deps.now());
        // A changed role takes effect on the member's open sockets: they reconnect with it.
        if (memberId) await deps.rooms.fetch(key, "/room/revoke", { method: "POST", body: JSON.stringify({ userId: memberId }) });
        if (memberId && invited) await notifyInvite(deps, { key, by: user, userId: memberId, role: body.role });
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
        await notifyEditRequest(deps, { key, by: user });
        return json({ ok: true });
      }
      if (parts.length === 3 && m === "GET") {
        atLeast("editor");
        return json({ requests: await deps.db.requests(key) });
      }
      if (parts.length === 4 && m === "POST") {
        atLeast("editor");
        const { approve } = await readJson<{ approve?: unknown }>(req);
        if (!(await answerEditRequest(deps, key, user, parts[3], approve === true))) throw new HttpError(404, "no such request");
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
    case "comments": return (await import("./comments")).commentsRoute(req, deps, { key, role, user, parts });
    case "ws": {
      if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") throw new HttpError(426, "expected a WebSocket");
      return deps.rooms.fetch(key, "/room/ws", { method: "GET", identity }, req);
    }
  }
  throw new HttpError(404, "not found");
}

const rank: Record<Role, number> = { viewer: 0, editor: 1, owner: 2 };

/** "Ask to edit" answered by `by` (an editor or the owner — the caller checks): false when there was no such request.
 *  From the Share dialog and from the notifications' Requests tab. */
async function answerEditRequest(deps: Deps, key: string, by: User, requesterId: string, approve: boolean): Promise<boolean> {
  const r = await deps.db.takeRequest(key, requesterId);
  if (!r) return false;
  // The answer reaches them first, on the socket they have now…
  await deps.rooms.fetch(key, "/room/notice", { method: "POST", body: JSON.stringify({ kind: approve ? "access-granted" : "access-denied", userId: requesterId }) });
  if (approve) {
    await deps.db.putMember(key, r.email, "editor", by.id, deps.now());
    // …which then reconnects as an editor.
    await deps.rooms.fetch(key, "/room/revoke", { method: "POST", body: JSON.stringify({ userId: requesterId }) });
  }
  await notifyRequestAnswered(deps, { key, by, requesterId, approve });
  return true;
}

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

/**
 * The caller: a session token (`v1.…`, its session row still there — "Sign out" on a row deletes it) or a personal
 * access token (`dsgn_…`, docs/multiplayer.md §13) with its scopes.
 */
async function authenticate(req: Request, url: URL, deps: Deps, allowQuery: boolean): Promise<Caller> {
  const header = req.headers.get("authorization");
  const raw = header?.startsWith("Bearer ") ? header.slice(7) : allowQuery ? url.searchParams.get("token") : null;
  if (!raw) throw new HttpError(401, "sign in first");
  const pat = await personalToken(deps, raw);
  if (pat) {
    const user = await deps.db.user(pat.userId);
    if (!user) throw new HttpError(401, "token expired");
    return { user, sid: null, scopes: pat.scopes };
  }
  const p = await verifyToken<SessionPayload>(raw, secret(deps), seconds(deps));
  const user = p && (await deps.db.user(p.uid));
  if (!p || !user || user.tokenVersion !== p.tv) throw new HttpError(401, "session expired");
  if (p.sid && !(await deps.db.touchSession(p.sid, user.id, deps.now()))) throw new HttpError(401, "session expired");
  return { user, sid: p.sid ?? null, scopes: null };
}

/** Routes for a person, not a token (previews). */
function sessionOnly(c: Caller): User {
  if (c.scopes) throw new HttpError(403, "a personal access token can't do that");
  return c.user;
}

/**
 * "Get embed code" (docs/multiplayer.md §3): `/embed/<key>` is the viewer on the file as it is now — the room's snapshot
 * and the frames after it, merged by the viewer. Only files anyone with the link can view, without a password (Figma:
 * password-protected files can't be embedded); no sign-in, CORS open.
 */
async function embedRoute(key: string, part: string | undefined, url: URL, deps: Deps): Promise<Response> {
  const f = await deps.db.file(key);
  if (!f || f.linkAccess === "none" || f.passwordProtected) {
    if (!part) return page(404, "This file isn't available to embed. Its owner can share it with anyone who has the link, without a password.");
    throw new HttpError(404, "not available");
  }
  if (!part) return viewerPage(url, deps.env as Parameters<typeof viewerPage>[1]);
  const identity = { userId: "embed", name: null, role: "viewer" as Role };
  const res =
    part === "snapshot" ? await deps.rooms.fetch(key, "/room/snapshot", { method: "GET", identity }) : part === "frames" ? await deps.rooms.fetch(key, `/room/frames?since=${Number(url.searchParams.get("since")) || 0}`, { method: "GET", identity }) : await deps.rooms.fetch(key, `/room/${part.replace("images/", "blobs/")}`, { method: "GET", identity });
  const headers = new Headers(res.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-expose-headers", "x-seq, x-file-name");
  headers.set("x-file-name", encodeURIComponent(f.name));
  headers.set("cache-control", "no-cache");
  return new Response(res.body, { status: res.status, headers });
}

interface PassPayload {
  k: string;
  u: string;
  v: number;
  exp: number;
}

/** A link password's pass (header `x-file-pass`, or `pass` on a WebSocket's URL) for this file, user and password. */
async function validPass(req: Request, url: URL, deps: Deps, key: string, userId: string, version: number): Promise<boolean> {
  const raw = req.headers.get("x-file-pass") ?? url.searchParams.get("pass");
  if (!raw) return false;
  const p = await verifyToken<PassPayload>(raw, secret(deps), seconds(deps));
  return !!p && p.k === key && p.u === userId && p.v === version;
}

/** A new session: its row (what and where it signed in from) and a token naming it. */
async function issueSession(user: User, deps: Deps, req: Request): Promise<Response> {
  const exp = seconds(deps) + SESSION_DAYS * 86400;
  const sid = await deps.db.createSession(user.id, { ...deviceFromUserAgent(req.headers.get("user-agent")), ...requestPlace(req) }, deps.now());
  const token = await signToken({ uid: user.id, tv: user.tokenVersion, sid, exp }, secret(deps));
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
  return issueSession(user, deps, req);
}

/** Local development only (DEV_AUTH=1 in server/.dev.vars): a session for any email, no Google. */
async function devSignIn(req: Request, deps: Deps): Promise<Response> {
  if (deps.env.DEV_AUTH !== "1") throw new HttpError(404, "not found");
  const body = await readJson<{ email?: string; name?: string }>(req);
  if (!body.email) throw new HttpError(400, "email");
  const user = await deps.db.upsertUser({ sub: `dev:${normalizeEmail(body.email)}`, email: body.email, name: body.name ?? null }, deps.now());
  return issueSession(user, deps, req);
}

/** A file's link opened in a browser: a page that hands it to the desktop app (designer://open?key=…), with the frame
 *  (`node-id`, Figma's "1-2") and the mode (`m=dev` Dev Mode, `m=proto` the prototype) the link carries. */
function linkPage(key: string, params: URLSearchParams): Response {
  const app = new URL("designer://open");
  app.searchParams.set("key", key);
  const node = params.get("node-id");
  if (node && /^[0-9]+[-:][0-9]+$/.test(node)) app.searchParams.set("node-id", node.replace(":", "-"));
  const mode = params.get("m");
  if (mode === "dev" || mode === "proto") app.searchParams.set("m", mode);
  return linkHtml(app.toString());
}

function linkHtml(app: string): Response {
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Open in DesignerV2</title>
<body style="font:14px -apple-system,system-ui;margin:0;display:grid;place-items:center;min-height:100vh;background:#f5f5f5;color:#1e1e1e">
<div style="text-align:center;max-width:360px;padding:24px"><h1 style="font-size:18px;font-weight:600;margin:0 0 8px">Open this file in DesignerV2</h1>
<p style="margin:0 0 20px;color:#666">You need the desktop app and to be logged in with an account that has access.</p>
<a href="${app.replace(/&/g, "&amp;")}" style="display:inline-block;padding:8px 16px;border-radius:6px;background:#0d99ff;color:#fff;text-decoration:none;font-weight:500">Open in the app</a>
<p style="margin:20px 0 0;color:#888;font-size:12px">Or in DesignerV2: Home › Recents › Shared files › Open link…, and paste this link.</p></div>
<script>location.href=${JSON.stringify(app)}</script>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

function page(status: number, text: string): Response {
  const html = `<!doctype html><meta charset="utf-8"><title>DesignerV2</title><body style="font:14px system-ui;margin:40px">${text.replace(/[<>&]/g, "")}</body>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}
