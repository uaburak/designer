/**
 * The Worker's HTTP API (docs/multiplayer.md §2–3): sign-in, files, members, and the routes forwarded to a file's room.
 * A plain `Request → Response` function over injected dependencies, so Node's tests drive it without Cloudflare.
 */
import type { Role } from "../../src/shared/multiplayer/protocol";
import type { FilePolicy, RoomPolicy, SessionAuth } from "../../src/shared/org/identity";
import { deviceFromUserAgent } from "../../src/shared/account";
import { patAllows, personalToken, requestPlace, touchOrgActivity, type Caller } from "./account";
import { normalizeEmail, type Db, type User } from "./db";
import type { ActivityAction, EditorType } from "../../src/shared/org/types";
import { fileEntity, logActivity, logFileView, logForUserOrgs } from "./activity";
import { seatNeeded } from "../../src/shared/org/access";
import { Access, claimInvites, fileAccessOf, type FileRow } from "./org/db";
import { errorBody, HttpError, type Ctx } from "./org/http";
import { reauth } from "./org/reauth";
import { notificationsRoute, notifyEditRequest, notifyInvite, notifyOwnership, notifyRequestAnswered } from "./notifications";
import { isPreviewPath, previews, viewerPage } from "./previews";
import { checkPassword, hashPassword, sha256b64url, signToken, verifyToken } from "./tokens";

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

/** A file's room (the FileRoom Durable Object, in the file's jurisdiction — docs/multiplayer.md §15.10); `path` is one
 *  of `/room/…`. `policy`: the org's room policy, sent as `x-policy` with a socket upgrade (§15.9). */
export interface Rooms {
  fetch(fileKey: string, path: string, init: RequestInit & { identity?: { userId: string; name: string | null; role: Role }; policy?: RoomPolicy }, original?: Request): Promise<Response>;
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
  /** Work after the answer (the Worker's `ctx.waitUntil`); absent in tests, where it runs inline */
  waitUntil?(p: Promise<unknown>): void;
}

export const SESSION_DAYS = 30;
const MAX_SNAPSHOT_BYTES = 90 * 1024 * 1024;

interface SessionPayload {
  uid: string;
  tv: number;
  /** The session's row (Settings › Security › Sessions); absent in tokens issued before migration 0009 */
  sid?: string;
  exp: number;
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
    if (e instanceof HttpError) res = json(errorBody(e), e.status);
    else {
      console.error(e);
      res = json({ error: "internal error", code: "internal" }, 500);
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
  if (path === "/auth/callback" && m === "GET") return callback(url, deps, req);
  if (path === "/auth/token" && m === "POST") return token(req, deps);
  if (path === "/auth/dev" && m === "POST") return devSignIn(req, deps);
  // Identity (docs/multiplayer.md §15): SSO routing, the SAML SP of each org, SCIM — no session.
  if (path === "/auth/sso" && m === "POST") return (await import("./auth/sso")).ssoRoute(req, url, deps);
  if (path.startsWith("/saml/")) return (await import("./auth/saml/routes")).samlRoute(req, url, deps, path.split("/").filter(Boolean).map(decodeURIComponent));
  if (path === "/scim" || path.startsWith("/scim/")) return (await import("./auth/scim/routes")).scimRoute(req, url, deps, path.split("/").filter(Boolean).map(decodeURIComponent));
  const link = /^\/f\/([A-Za-z0-9_-]{6,64})$/.exec(path);
  if (link && m === "GET") return linkPage(link[1], url.searchParams);
  if (isPreviewPath(path)) return previews(req, url, deps, async () => sessionOnly(await authenticate(req, url, deps, false)));
  const embed = /^\/embed\/([A-Za-z0-9_-]{6,64})(?:\/(snapshot|frames|images\/[0-9a-f]{40}))?$/.exec(path);
  if (embed && m === "GET") return embedRoute(embed[1], embed[2], url, deps);

  const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  const isSocket = (parts[0] === "files" && parts[2] === "ws" && parts.length === 3) || (parts[0] === "notifications" && parts[1] === "ws" && parts.length === 2);
  const caller = await authenticate(req, url, deps, isSocket);
  const user = caller.user;
  if (parts[0] === "me" && parts[1] !== "fonts") return (await import("./account")).accountRoute(req, deps, caller, parts);
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
  // Organizations (docs/multiplayer.md §14.12): one dispatch line each.
  const orgCtx = (): Ctx => ({ req, url, deps, user, parts, m, acc: new Access(deps, user) });
  // Libraries in organizations, library analytics, shared fonts (docs/data.md §16–§17, docs/desktop.md §14.3).
  if (parts[0] === "me") return (await import("./fonts/routes")).meFontsRoute(orgCtx());
  if (parts[0] === "orgs" && parts[2] === "libraries") return (await import("./libraries/routes")).orgLibrariesRoute(orgCtx());
  if (parts[0] === "orgs" && parts[2] === "fonts") return (await import("./fonts/routes")).orgFontsRoute(orgCtx());
  if (parts[0] === "teams" && parts[2] === "libraries") return (await import("./libraries/routes")).teamLibrariesRoute(orgCtx());
  if (parts[0] === "libraries") return (await import("./libraries/routes")).librariesRoute(orgCtx());
  if (parts[0] === "analytics") return (await import("./analytics/ingest")).analyticsRoute(orgCtx());
  if (parts[0] === "fonts") return (await import("./fonts/routes")).fontFileRoute(orgCtx());
  if (parts[0] === "files" && parts[2] === "libraries") return (await import("./libraries/routes")).fileLibrariesRoute(orgCtx());
  if (parts[0] === "files" && parts[2] === "library-usage") return (await import("./analytics/ingest")).fileUsageRoute(orgCtx());
  if (parts[0] === "orgs" && parts[2] === "admin" && (parts[3] === "identity" || parts[3] === "domains")) return (await import("./auth/identityRoutes")).identityRoute(orgCtx());
  if (parts[0] === "orgs") return (await import("./org/orgs")).orgsRoute(orgCtx());
  if (parts[0] === "teams") return (await import("./org/teams")).teamsRoute(orgCtx());
  if (parts[0] === "projects") return (await import("./org/projects")).projectsRoute(orgCtx());
  if (parts[0] === "groups") return (await import("./org/groups")).groupsRoute(orgCtx());
  if (parts[0] === "branches") return (await import("./branches")).branchesRoute(orgCtx());
  if (parts[0] !== "files") throw new HttpError(404, "not found");
  if (parts.length === 1) {
    if (m === "GET") return json({ files: await sharedFiles(deps, user.id) });
    if (m === "POST") {
      const body = await readJson<{ key?: string; name?: string; orgId?: unknown; projectId?: unknown; editorType?: unknown }>(req);
      // In an org: a file in a folder (projectId) or the caller's draft (no projectId) — §14.12 "Files".
      if (typeof body.orgId === "string") {
        const file = await (await import("./org/orgs")).createOrgFile(orgCtx(), { key: body.key, name: body.name, orgId: body.orgId, projectId: typeof body.projectId === "string" ? body.projectId : null, editorType: body.editorType });
        return json({ key: file.key, name: file.name, role: "owner", file }, 201);
      }
      const key = body.key ?? "";
      if (!FILE_KEY.test(key)) throw new HttpError(400, "bad file key");
      // A member whose org restricts external content creates files there only (§15.6, §15.9).
      (await import("./policy/external")).requireInside(await new Access(deps, user).home(), null, "create files");
      const name = cleanName(body.name);
      if (!(await deps.db.createFile(key, user.id, name, deps.now()))) throw new HttpError(409, "file key taken");
      return json({ key, name, role: "owner" }, 201);
    }
    throw new HttpError(405, "method not allowed");
  }

  const key = parts[1];
  if (!FILE_KEY.test(key)) throw new HttpError(400, "bad file key");
  // Who the caller is to this file (resolveAccess, §14.4). Naming the file by its key is opening it by its link: the
  // key is what the link carries (ours — `viaLink` is true on every /files/:key route, false in listings).
  const acc = new Access(deps, user);
  const f = await acc.fileRow(key);
  if (!f) throw new HttpError(404, "no such file");
  const passOk = f.link_password !== null && (await validPass(req, url, deps, key, user.id, f.link_password_version));
  const access = await acc.file(f, { viaLink: true, passOk });
  // "Password required": someone in by the link alone shows a pass for the current password (POST …/unlock) — invited
  // people never need it. The file's name and the unlock route are open to them so the app can ask.
  const open = (parts.length === 2 && m === "GET") || (parts.length === 3 && parts[2] === "unlock" && m === "POST");
  if (!access.ok) {
    if (access.reason === "gone") throw new HttpError(410, "this link has expired", "gone");
    if (access.reason === "none") throw new HttpError(404, "no such file"); // also when it exists but isn't shared with the caller
    if (!open) throw new HttpError(403, "password required", "password_required");
  }
  const needsPassword = !access.ok;
  const a = access.ok ? access : null;
  const role: Role = a ? a.roomRole : "viewer";
  const identity = { userId: user.id, name: user.name, role };
  const inOrg = f.org_id !== null;
  const need = (ok: boolean | undefined, message: string) => {
    if (!ok) {
      if (a?.capped === "seat" && (a.role === "owner" || a.role === "editor") && /edit|view/.test(message)) throw new HttpError(403, "your seat can't edit this file", "seat_required", { seat: seatNeeded(f.editor_type) });
      throw new HttpError(403, message);
    }
  };
  const canChange = !!a && !a.trashed && (a.canEdit || a.canManage);
  const writer = !!a && (a.role === "owner" || a.role === "editor" || a.canManage);
  const log = (action: ActivityAction, details: Record<string, unknown> = {}, name = f.name) =>
    inOrg ? logActivity(deps, { orgId: f.org_id!, action, actor: user, entity: fileEntity({ ...f, name }), teamId: f.team_id, details, req }) : Promise.resolve();
  // The file's sharing policy (docs/multiplayer.md §15.6; null outside orgs)
  const policy = await acc.policy(f);

  if (parts.length === 2) {
    if (m === "GET") {
      const linkExpired = f.link_expires_at !== null && deps.now() >= f.link_expires_at;
      return json({
        key,
        name: f.name,
        role: a ? role : access.ok ? role : (access.role ?? "viewer"),
        linkAccess: linkExpired ? "none" : f.link_access,
        viewersCanCopy: f.viewers_can_copy !== 0,
        passwordProtected: f.link_password !== null,
        needsPassword,
        link: `${url.origin}/f/${key}`,
        editorType: f.editor_type,
        accessMode: f.access,
        orgLinkAccess: f.org_link_access,
        protoLinkAccess: f.proto_link_access,
        linkExpiresAt: f.link_expires_at,
        linkExpired,
        trashedAt: f.trashed_at,
        access: a ? fileAccessOf(a) : null,
        org: a ? await fileOrg(acc, f) : null,
        branch: (await acc.branch(key)) ? await (await import("./branches")).branchInfo(deps, key) : null,
        policy,
      });
    }
    if (m === "PATCH") {
      const body = await readJson<{ name?: string; linkAccess?: string; viewersCanCopy?: unknown; linkPassword?: unknown; access?: unknown; orgLinkAccess?: unknown; protoLinkAccess?: unknown; linkExpiresAt?: unknown }>(req);
      // The org's sharing policy refuses the whole patch before anything is written (§15.6).
      (await import("./policy/sharing")).checkFilePatch(policy, f, body, deps.now());
      if (body.linkPassword !== undefined) {
        // help.figma.com: anyone who can edit sets, changes or removes it; changing it makes link-only people enter it again.
        need(canChange, "you can only view this file");
        if (body.linkPassword !== null && (typeof body.linkPassword !== "string" || body.linkPassword.length < 1 || body.linkPassword.length > 128)) throw new HttpError(400, "linkPassword is 1–128 characters, or null");
        await deps.db.setLinkPassword(key, body.linkPassword === null ? null : await hashPassword(body.linkPassword), deps.now());
        await deps.rooms.fetch(key, "/room/revoke-link", { method: "POST" });
        await log(body.linkPassword === null ? "fig_file_unset_password" : "fig_file_set_password");
      }
      if (body.viewersCanCopy !== undefined) {
        need(canChange, "you can only view this file");
        await deps.db.setViewersCanCopy(key, body.viewersCanCopy === true, deps.now());
        await log("fig_file_viewer_access_change", { viewers_can_copy: body.viewersCanCopy === true });
      }
      if (body.linkAccess !== undefined) {
        need(a?.canManage, "only the owner can");
        if (body.linkAccess !== "none" && body.linkAccess !== "viewer" && body.linkAccess !== "editor") throw new HttpError(400, "linkAccess is none, viewer or editor");
        await deps.db.setLinkAccess(key, body.linkAccess, deps.now());
        // Someone in by the link alone loses it with "none": their sockets reconnect and are refused.
        if (body.linkAccess !== "editor") await deps.rooms.fetch(key, "/room/revoke-link", { method: "POST" });
        await log("fig_file_link_access_change", { link: "public", from: f.link_access, to: body.linkAccess });
      }
      if (body.orgLinkAccess !== undefined || body.access !== undefined || body.protoLinkAccess !== undefined || body.linkExpiresAt !== undefined) {
        need(a?.canManage, "only the owner and admins can");
        await patchOrgFileSettings(deps, acc, f, body, log, policy);
      }
      if (body.name !== undefined) {
        need(canChange, "you can only view this file");
        await deps.db.renameFile(key, cleanName(body.name), deps.now());
        await log("fig_file_rename", { old_name: f.name }, cleanName(body.name));
      }
      return json({ ok: true });
    }
    if (m === "DELETE") {
      need(a?.canManage, "only the owner can");
      // A main file deleted for good takes its branches (docs/data.md §15.7).
      if (!inOrg || a!.trashed) await (await import("./branches")).deleteBranchesOf(deps, key);
      if (inOrg) {
        // In an org, "Delete forever" — from the trash only (§14.12).
        if (!a!.trashed) throw new HttpError(409, "move the file to the trash first");
        await (await import("./libraries/db")).libraryFileStatus(deps, key, "delete");
        await (await import("./org/projects")).deleteFileForever(orgCtx(), key);
        await log("fig_file_permanent_delete");
        return json({ ok: true });
      }
      await deps.rooms.fetch(key, "/room", { method: "DELETE" });
      await deps.db.deleteFile(key);
      return json({ ok: true });
    }
    throw new HttpError(405, "method not allowed");
  }

  // Branches and version history (docs/data.md §15.7); inviting to a branch writes main's grant too.
  if (parts[2] === "branches" || parts[2] === "versions") return (await import("./branches")).fileBranchesRoute(orgCtx(), f, a);
  const branchRow = parts[2] === "members" && m !== "GET" ? await acc.branch(key) : null;
  if (branchRow) return (await import("./branches")).branchMembers(orgCtx(), branchRow);
  switch (parts[2]) {
    case "unlock": {
      if (parts.length !== 3 || m !== "POST") break;
      const { password } = await readJson<{ password?: unknown }>(req);
      if (!f.link_password) return json({ pass: null });
      if (typeof password !== "string" || !(await checkPassword(password, f.link_password))) throw new HttpError(403, "wrong password");
      const pass = await signToken({ k: key, u: user.id, v: f.link_password_version, exp: seconds(deps) + SESSION_DAYS * 86400 }, secret(deps));
      return json({ pass });
    }
    case "transfer": {
      // "Transfer ownership" (help.figma.com 360038512093): owner only, to someone already invited; can't be undone.
      if (parts.length !== 3 || m !== "POST") break;
      need(a?.role === "owner", "only the owner can");
      const { email } = await readJson<{ email?: unknown }>(req);
      if (typeof email !== "string") throw new HttpError(400, "email");
      const done = await deps.db.transferOwnership(key, email, user.id, deps.now());
      if (!done) throw new HttpError(400, "only someone invited who has logged in can own the file");
      for (const userId of [done.toId, user.id]) await deps.rooms.fetch(key, "/room/revoke", { method: "POST", body: JSON.stringify({ userId }) });
      await notifyOwnership(deps, { key, by: user, toId: done.toId });
      await log("fig_file_member_permission_change", { email: normalizeEmail(email), user_id: done.toId, role: "owner", previous_owner: user.id });
      return json({ ok: true });
    }
    case "members": {
      if (parts.length === 3 && m === "GET") return json({ members: await deps.db.members(key), groups: inOrg ? await (await import("./org/teams")).groupMembers(orgCtx(), "file", key) : [] });
      // Outside orgs the owner invites (§3); in an org, owners and editors of the file and admins (§14.2).
      const canInvite = inOrg ? !!a && !a.trashed && (a.canShare || a.canManage) : a?.canManage;
      if (parts.length === 3 && m === "PUT") {
        need(canInvite, inOrg ? "only people who can edit the file can share it" : "only the owner can");
        const body = await readJson<{ email?: string; groupId?: unknown; role?: string }>(req);
        if (body.role !== "editor" && body.role !== "viewer") throw new HttpError(400, "role is editor or viewer");
        if (inOrg && typeof body.groupId === "string") {
          const { grantGroup } = await import("./org/teams");
          const g = await grantGroup(orgCtx(), f.org_id!, "file", key, body.groupId, body.role);
          await log(g.was ? "fig_file_member_permission_change" : "fig_file_member_add", { group_id: body.groupId, group_name: g.name, role: body.role, from: g.was });
          if (g.was === "editor" && body.role === "viewer") await reauth(deps, [key]);
          return json({ ok: true });
        }
        const email = normalizeEmail(body.email ?? "");
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, "bad email");
        const ownerEmail = (await deps.db.user(f.owner_id))?.email;
        if (email === ownerEmail) throw new HttpError(400, email === user.email ? "you own this file" : "they own this file");
        const before = (await deps.db.members(key)).find((x) => x.email === email);
        if (inOrg && !before) {
          const outcome = await (await import("./org/orgs")).inviteEmail(orgCtx(), f.org_id!, email, { type: "file", id: key, name: f.name }, body.role);
          if (outcome.kind === "requested") return json({ ok: true, requested: true, requestId: outcome.requestId }, 202);
        }
        const memberId = await deps.db.putMember(key, email, body.role, user.id, deps.now());
        // A changed role takes effect on the member's open sockets: they reconnect with it.
        if (memberId) await deps.rooms.fetch(key, "/room/revoke", { method: "POST", body: JSON.stringify({ userId: memberId }) });
        if (memberId && !before) await notifyInvite(deps, { key, by: user, userId: memberId, role: body.role });
        await log(before ? "fig_file_member_permission_change" : "fig_file_member_add", { email, user_id: memberId, role: body.role, from: before?.role ?? null });
        return json({ ok: true });
      }
      if (parts.length === 4 && m === "DELETE") {
        need(canInvite, inOrg ? "only people who can edit the file can share it" : "only the owner can");
        if (inOrg && parts[3].startsWith("g:")) {
          const r = await deps.db.d1.prepare(`DELETE FROM group_grants WHERE group_id = ?1 AND resource_type = 'file' AND resource_id = ?2 RETURNING group_id`).bind(parts[3].slice(2), key).first();
          if (r) {
            await log("fig_file_member_remove", { group_id: parts[3].slice(2) });
            await reauth(deps, [key]);
          }
          return json({ ok: true });
        }
        const memberId = await deps.db.removeMember(key, parts[3]);
        if (memberId) await deps.rooms.fetch(key, "/room/revoke", { method: "POST", body: JSON.stringify({ userId: memberId }) });
        await log("fig_file_member_remove", { email: normalizeEmail(parts[3]), user_id: memberId });
        return json({ ok: true });
      }
      break;
    }
    case "snapshot": {
      if (parts.length !== 3) break;
      if (m === "GET") {
        // "Viewers can copy, save, and export" off (§14.12, R18 A-8): viewing still needs the snapshot; Save local copy
        // and Duplicate ask with ?purpose=export and are refused.
        if (url.searchParams.get("purpose") === "export" && !a?.canExport) throw new HttpError(403, "the owner turned off copying and exporting for viewers");
        return deps.rooms.fetch(key, "/room/snapshot", { method: "GET", identity });
      }
      if (m === "PUT") {
        need(a?.canEdit, "you can only view this file");
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
        if (a?.capped === "seat") throw new HttpError(403, "ask an admin to upgrade your seat", "seat_required", { seat: seatNeeded(f.editor_type) });
        if (a?.role !== "viewer") throw new HttpError(400, "you can already edit");
        await deps.db.addRequest(key, user.id, deps.now());
        await deps.rooms.fetch(key, "/room/notice", { method: "POST", body: JSON.stringify({ kind: "access-request", userId: user.id, name: user.name ?? user.email }) });
        await notifyEditRequest(deps, { key, by: user });
        return json({ ok: true });
      }
      if (parts.length === 3 && m === "GET") {
        need(writer, "you can only view this file");
        return json({ requests: await deps.db.requests(key) });
      }
      if (parts.length === 4 && m === "POST") {
        need(writer, "you can only view this file");
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
        need(a?.canEdit, "you can only view this file");
        const body = await req.arrayBuffer();
        if (body.byteLength > 40 * 1024 * 1024) throw new HttpError(413, "image too large");
        return deps.rooms.fetch(key, `/room/blobs/${parts[3]}`, { method: "PUT", body, identity });
      }
      break;
    }
    case "comments": {
      // External content controls stop comments too (§14.4, round 4); a trashed file is read-only.
      if (m !== "GET" && !a?.canComment) throw new HttpError(403, "you can't comment on this file");
      return (await import("./comments")).commentsRoute(req, deps, { key, role, user, parts });
    }
    case "move": {
      // Within the org: into a folder the caller can edit, or (projectId null) into the owner's drafts (§14.12).
      if (parts.length !== 3 || m !== "POST") break;
      if (!inOrg) throw new HttpError(400, "only files in an organization move between folders");
      need(writer && !a?.trashed, "only people who can edit the file can move it");
      const { projectId } = await readJson<{ projectId?: unknown }>(req);
      let teamId: string | null = null;
      if (projectId === null) {
        if (f.owner_id !== user.id) throw new HttpError(403, "only the owner can move a file to their drafts");
      } else if (typeof projectId === "string") {
        const p = await acc.project(projectId);
        const t = p ? await acc.team(p.team_id) : null;
        if (!p || !t || t.org_id !== f.org_id || t.deleted_at !== null) throw new HttpError(400, "no such folder");
        const to = await acc.container(t.id, p.id);
        if (!to.ok || to.trashed || (to.role !== "owner" && to.role !== "editor" && !to.canManage)) throw new HttpError(403, "you can't add files to that folder");
        teamId = t.id;
      } else throw new HttpError(400, "projectId is a folder id or null");
      await deps.db.d1.prepare(`UPDATE files SET project_id = ?2, team_id = ?3, updated_at = ?4 WHERE key = ?1`).bind(key, projectId, teamId, deps.now()).run();
      await logActivity(deps, { orgId: f.org_id!, action: "fig_file_move", actor: user, entity: fileEntity(f), teamId: teamId ?? f.team_id, details: { from: f.project_id, to: projectId }, req });
      await reauth(deps, [key]);
      return json({ ok: true });
    }
    case "trash":
    case "restore": {
      if (parts.length !== 3 || m !== "POST") break;
      if (!inOrg) throw new HttpError(400, "only files in an organization go to the trash; stop sharing instead");
      need(writer, "only people who can edit the file can do that");
      const trash = parts[2] === "trash";
      if (trash === (f.trashed_at !== null)) throw new HttpError(409, trash ? "the file is already in the trash" : "the file isn't in the trash");
      await deps.db.d1.prepare(`UPDATE files SET trashed_at = ?2, trashed_by = ?3, updated_at = ?4 WHERE key = ?1`).bind(key, trash ? deps.now() : null, trash ? user.id : null, deps.now()).run();
      await log(trash ? "fig_file_trash" : "fig_file_restore");
      await (await import("./libraries/db")).libraryFileStatus(deps, key, trash ? "trash" : "restore");
      await reauth(deps, [key]);
      return json({ ok: true });
    }
    case "activity": {
      // Events only the client sees (§14.10): a local export, Save local copy, Present.
      if (parts.length !== 3 || m !== "POST") break;
      const body = await readJson<{ action?: unknown; details?: unknown }>(req);
      if (body.action !== "fig_file_export" && body.action !== "fig_file_save_as" && body.action !== "fig_file_view_prototype") throw new HttpError(400, "action is fig_file_export, fig_file_save_as or fig_file_view_prototype");
      if ((body.action === "fig_file_export" || body.action === "fig_file_save_as") && !a?.canExport) throw new HttpError(403, "the owner turned off copying and exporting for viewers");
      const details = body.details && typeof body.details === "object" && !Array.isArray(body.details) ? (body.details as Record<string, unknown>) : {};
      if (JSON.stringify(details).length > 2000) throw new HttpError(400, "details too large");
      await log(body.action, { ...details, client_reported: true });
      return new Response(null, { status: 204 });
    }
    case "ws": {
      if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") throw new HttpError(426, "expected a WebSocket");
      // The file's org logs the view; the viewer's home org (captured, another org) its external twin (§15.9).
      if (inOrg && a) await logFileView(deps, { ...f, org_id: f.org_id! }, user, { prototype: url.searchParams.get("m") === "proto", req, home: await acc.home() });
      // The org's room policy rides with the upgrade (x-policy → welcome.policy); absent outside orgs.
      const roomPolicy = (await import("./policy/roomPolicy")).roomPolicyOf(policy);
      return deps.rooms.fetch(key, "/room/ws", { method: "GET", identity, ...(roomPolicy ? { policy: roomPolicy } : {}) }, req);
    }
  }
  throw new HttpError(404, "not found");
}

/** Home's Shared files (§3): what the caller owns or was invited to, with its org place; trashed org files left out. */
async function sharedFiles(deps: Deps, userId: string) {
  const files = await deps.db.files(userId);
  const { results } = await deps.db.d1
    .prepare(
      `SELECT f.key, f.org_id, f.team_id, f.project_id, f.editor_type, f.trashed_at, EXISTS (SELECT 1 FROM branches b WHERE b.key = f.key) AS is_branch
       FROM files f LEFT JOIN members m ON m.file_key = f.key AND m.user_id = ?1 WHERE f.owner_id = ?1 OR m.user_id = ?1`,
    )
    .bind(userId)
    .all<{ key: string; org_id: string | null; team_id: string | null; project_id: string | null; editor_type: string; trashed_at: number | null; is_branch: number }>();
  const place = new Map(results.map((r) => [r.key, r]));
  // Branches are listed under their main file (docs/data.md §15.7).
  return files.filter((x) => place.get(x.key)?.trashed_at == null && !place.get(x.key)?.is_branch).map((x) => {
    const p = place.get(x.key);
    return { ...x, orgId: p?.org_id ?? null, teamId: p?.team_id ?? null, projectId: p?.project_id ?? null, editorType: p?.editor_type ?? "design" };
  });
}

/** `org` of GET /files/:key: the org, team and folder path, or null outside any org. */
async function fileOrg(acc: Access, f: FileRow) {
  if (!f.org_id) return null;
  const org = await acc.org(f.org_id);
  const team = f.team_id ? await acc.team(f.team_id) : null;
  const chain = f.project_id ? await acc.chain(f.project_id) : [];
  return { id: f.org_id, orgId: f.org_id, name: org?.name ?? "", teamId: f.team_id, teamName: team?.name ?? null, projectId: f.project_id, path: chain.map((p) => ({ id: p.id, name: p.name })).reverse() };
}

/** PATCH /files/:key's org fields: Inherited / Limited, the org link, prototype link, link expiry (§14.12). */
async function patchOrgFileSettings(deps: Deps, acc: Access, f: FileRow, body: { access?: unknown; orgLinkAccess?: unknown; protoLinkAccess?: unknown; linkExpiresAt?: unknown; linkAccess?: unknown }, log: (action: ActivityAction, details?: Record<string, unknown>) => Promise<void>, policy: FilePolicy | null): Promise<void> {
  const d1 = deps.db.d1;
  const now = deps.now();
  let lowered = false;
  if (body.access !== undefined) {
    if (!f.org_id) throw new HttpError(400, "access applies to files in an organization");
    if (body.access !== "inherited" && body.access !== "limited") throw new HttpError(400, "access is inherited or limited");
    await d1.prepare(`UPDATE files SET access = ?2, updated_at = ?3 WHERE key = ?1`).bind(f.key, body.access, now).run();
    if (body.access === "limited") lowered = true;
  }
  if (body.orgLinkAccess !== undefined) {
    if (!f.org_id) throw new HttpError(400, "orgLinkAccess applies to files in an organization");
    if (body.orgLinkAccess !== "none" && body.orgLinkAccess !== "viewer" && body.orgLinkAccess !== "editor") throw new HttpError(400, "orgLinkAccess is none, viewer or editor");
    await d1.prepare(`UPDATE files SET org_link_access = ?2, updated_at = ?3 WHERE key = ?1`).bind(f.key, body.orgLinkAccess, now).run();
    await log("fig_file_link_access_change", { link: "org", from: f.org_link_access, to: body.orgLinkAccess });
    // A published library's scope is its org link (docs/data.md §16.2).
    await (await import("./libraries/db")).syncLibraryScope(deps, f.key, body.orgLinkAccess);
    if (body.orgLinkAccess !== "editor") lowered = true;
  }
  if (body.protoLinkAccess !== undefined) {
    if (body.protoLinkAccess !== "none" && body.protoLinkAccess !== "viewer") throw new HttpError(400, "protoLinkAccess is none or viewer");
    await d1.prepare(`UPDATE files SET proto_link_access = ?2, updated_at = ?3 WHERE key = ?1`).bind(f.key, body.protoLinkAccess, now).run();
    await log("fig_file_proto_link_access_change", { from: f.proto_link_access, to: body.protoLinkAccess });
  }
  if (body.linkExpiresAt !== undefined) {
    const at = body.linkExpiresAt;
    if (at !== null && (typeof at !== "number" || !Number.isFinite(at) || at <= now)) throw new HttpError(400, "linkExpiresAt is a future time (ms) or null");
    // The maximum is the file's policy's (its workspace's override, else the org's — §15.6), while its public link is on.
    if ((body.linkAccess ?? f.link_access) !== "none") (await import("./policy/sharing")).checkExpiry(policy, at as number | null, now);
    await d1.prepare(`UPDATE files SET link_expires_at = ?2, updated_at = ?3 WHERE key = ?1`).bind(f.key, at, now).run();
    await log("fig_file_link_expiration_change", { from: f.link_expires_at, to: at });
    lowered = true;
  }
  if (lowered) await reauth(deps, [f.key]);
}


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
  if (p.sid) {
    const s = await deps.db.touchSession(p.sid, user.id, deps.now());
    if (!s) throw new HttpError(401, "session expired");
    // The idle session timeout (§15.8): an idle session is deleted, logged and refused with `idle_timeout`.
    await (await import("./auth/idle")).enforceIdle(deps, s, user, req);
  }
  // Admin › People "Last active" (§14.11): moved on with the session, at most every 5 minutes.
  await touchOrgActivity(deps, user.id);
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
  const row = f ? await deps.db.d1.prepare(`SELECT link_expires_at, org_id, team_id, editor_type FROM files WHERE key = ?1`).bind(key).first<{ link_expires_at: number | null; org_id: string | null; team_id: string | null; editor_type: EditorType }>() : null;
  const expired = row?.link_expires_at != null && deps.now() >= row.link_expires_at;
  // An org's policy with public links off refuses embeds too (§15.6); passwords required means no embed without one,
  // and a file with a password is never embedded.
  const policy = row ? await (await import("./policy/sharing")).policyOfFile(deps.db.d1, row) : null;
  if (!f || f.linkAccess === "none" || f.passwordProtected || expired || (policy && (!policy.publicLinks || policy.passwordRequired))) {
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

/**
 * A new session: its row (what and where it signed in from, how — Google, SAML through an org, dev — and its idle
 * limit, §15.8) and a token naming it.
 */
async function issueSession(user: User, deps: Deps, req: Request, auth: { method: SessionAuth; orgId: string | null } = { method: "google", orgId: null }): Promise<Response> {
  const exp = seconds(deps) + SESSION_DAYS * 86400;
  // Invites to orgs, teams and folders waiting for this email become this user's (§14.5, as 0001's members).
  await claimInvites(deps.db.d1, user);
  await logForUserOrgs(deps, user, "user_sign_in", req, { method: auth.method, ...(auth.orgId ? { org_id: auth.orgId } : {}) });
  const sid = await deps.db.createSession(user.id, { ...deviceFromUserAgent(req.headers.get("user-agent")), ...requestPlace(req) }, deps.now(), auth);
  const token = await signToken({ uid: user.id, tv: user.tokenVersion, sid, exp }, secret(deps));
  return json({ token, expiresAt: exp * 1000, user: publicUser(user) });
}

/**
 * Step 2: the app's browser arrives here with its loopback port (or, the web app, its page), state and PKCE challenge
 * — Figma's login page (Continue with Google · Use single sign-on), or straight on with `method=google` / `tenant`
 * (docs/multiplayer.md §15.4; auth/sso.ts).
 */
async function login(url: URL, deps: Deps): Promise<Response> {
  return (await import("./auth/sso")).loginRoute(url, deps);
}

/** Step 3: Google sends the browser back; the app's loopback gets a one-time code — or, for a member of an org that
 *  requires SAML, the browser goes on to its IdP with the same app state (§15.4; auth/sso.ts). */
async function callback(url: URL, deps: Deps, req: Request): Promise<Response> {
  return (await import("./auth/sso")).googleCallback(url, deps, req);
}

/** Step 4: the app trades the code and its PKCE verifier for a session token (made the way the code was earned). */
async function token(req: Request, deps: Deps): Promise<Response> {
  const body = await readJson<{ code?: string; verifier?: string }>(req);
  if (typeof body.code !== "string" || typeof body.verifier !== "string") throw new HttpError(400, "code and verifier");
  const row = await deps.db.takeAuthCode(await sha256b64url(body.code), deps.now());
  if (!row || row.challenge !== (await sha256b64url(body.verifier))) throw new HttpError(400, "invalid or expired code");
  const user = await deps.db.user(row.userId);
  if (!user) throw new HttpError(400, "invalid or expired code");
  return issueSession(user, deps, req, { method: row.auth, orgId: row.orgId });
}

/** Local development only (DEV_AUTH=1 in server/.dev.vars): a session for any email, no Google; no policy applies. */
async function devSignIn(req: Request, deps: Deps): Promise<Response> {
  if (deps.env.DEV_AUTH !== "1") throw new HttpError(404, "not found");
  const body = await readJson<{ email?: string; name?: string }>(req);
  if (!body.email) throw new HttpError(400, "email");
  const user = await deps.db.upsertUser({ sub: `dev:${normalizeEmail(body.email)}`, email: body.email, name: body.name ?? null }, deps.now());
  return issueSession(user, deps, req, { method: "dev", orgId: null });
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
