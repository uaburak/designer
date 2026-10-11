/**
 * The account's own settings (docs/multiplayer.md §13; Figma's Settings modal): the profile, sessions, personal access
 * tokens and Delete account. Every route is the caller's own; a personal access token can't reach any of them.
 *
 *   GET    /me                      the user (as signed in) and `session`: SessionIdle | null (§15.8)
 *   DELETE /me {confirm: email}     Delete account: owned files unshared, memberships, comments, previews, sessions, tokens
 *   GET    /me/profile              AccountProfile
 *   PATCH  /me/profile              ProfilePatch → AccountProfile (name, photo, role, Community profile, prefs)
 *   GET    /me/sessions             {sessions: SessionInfo[]}, the caller's marked `current`
 *   DELETE /me/sessions              "Sign out everywhere": every session token stops working, this one too
 *   DELETE /me/sessions/:id         "Sign out": that session's token stops working
 *   POST   /me/sessions/active      the app reports activity (once a minute): active_at, "Last active" → {activeAt, idleLimitMs}
 *   DELETE /me/sessions/current     Log out of this session (?reason=idle: the idle timeout, logged)
 *   GET    /me/tokens               {tokens: AccessTokenInfo[]}
 *   POST   /me/tokens               {description, expiresInDays, scopes} → {token (shown once), info}
 *   DELETE /me/tokens/:id           "Revoke access"
 *
 * Personal access tokens (`dsgn_…`) are Bearer tokens for the API's reads (`patAllows`): kept as their SHA-256 only.
 */
import { HANDLE_RE, MAX_BIO, MAX_PICTURE_CHARS, ROLES, TOKEN_EXPIRATIONS, TOKEN_PREFIX, isTokenScope, type AccessTokenInfo, type AccountPrefs, type AccountProfile, type CommunityProfile, type SessionInfo, type TokenScope } from "../../src/shared/account";
import type { SessionAuth, SessionIdle } from "../../src/shared/org/identity";
import { logForUserOrgs } from "./activity";
import type { Deps } from "./api";
import type { User } from "./db";
import { deletePreviewsOf } from "./previews";
import { randomToken, sha256b64url } from "./tokens";

/** Who is calling: the user, the session their token belongs to (null: an older token or a PAT), a PAT's scopes. */
export interface Caller {
  user: User;
  sid: string | null;
  scopes: TokenScope[] | null;
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
const fail = (status: number, error: string) => json({ error }, status);
const MAX_TOKENS = 50;

export async function accountRoute(req: Request, deps: Deps, caller: Caller, parts: string[]): Promise<Response> {
  const { user, sid } = caller;
  const m = req.method;
  const d1 = deps.db.d1;
  const now = deps.now();
  if (caller.scopes) {
    // A personal access token reads the user ("current_user:read") and nothing else of the account.
    if (parts.length === 1 && m === "GET" && caller.scopes.includes("current_user:read")) return json({ id: user.id, email: user.email, name: user.name, picture: user.picture });
    return fail(403, "a personal access token can't do that");
  }

  if (parts.length === 1) {
    if (m === "GET") return json({ id: user.id, email: user.email, name: user.name, picture: user.picture, session: await sessionIdle(deps, sid, user.id) });
    if (m === "DELETE") {
      const body = await readJson<{ confirm?: unknown }>(req);
      if (typeof body?.confirm !== "string" || body.confirm.trim().toLowerCase() !== user.email) return fail(400, "type your email to confirm");
      const blocked = await soleAdminOf(deps, user.id);
      if (blocked) return json({ error: `make someone else an admin of ${blocked} first`, code: "conflict" }, 409);
      await deleteAccount(deps, user);
      return json({ ok: true });
    }
    return fail(405, "method not allowed");
  }

  switch (parts[1]) {
    case "profile": {
      if (parts.length !== 2) break;
      if (m === "GET") return json(await profile(deps, user.id));
      if (m === "PATCH") {
        const body = await readJson<Record<string, unknown>>(req);
        if (!body) return fail(400, "expected a JSON object");
        const err = await patchProfile(deps, user.id, body);
        if (err) return fail(400, err);
        return json(await profile(deps, user.id));
      }
      break;
    }
    case "sessions": {
      if (parts.length === 2 && m === "GET") {
        const { results } = await d1
          .prepare(`SELECT id, kind, os, browser, ip, city, country, created_at, last_seen_at FROM sessions WHERE user_id = ?1 ORDER BY last_seen_at DESC`)
          .bind(user.id)
          .all<{ id: string; kind: "app" | "login"; os: string | null; browser: string | null; ip: string | null; city: string | null; country: string | null; created_at: number; last_seen_at: number }>();
        const sessions: SessionInfo[] = results.map((r) => ({ id: r.id, kind: r.kind, os: r.os, browser: r.browser, ip: r.ip, city: r.city, country: r.country, createdAt: r.created_at, lastSeenAt: r.last_seen_at, current: r.id === sid }));
        // The current one first, as Figma lists it.
        sessions.sort((a, b) => Number(b.current) - Number(a.current));
        return json({ sessions });
      }
      if (parts.length === 2 && m === "DELETE") {
        // Settings › Security › Sign out everywhere (as POST /auth/signout-everywhere, reachable as an account path)
        await deps.db.bumpTokenVersion(user.id);
        await logForUserOrgs(deps, user, "user_sign_out", req, { everywhere: true });
        return json({ ok: true });
      }
      if (parts.length === 3 && parts[2] === "active" && m === "POST") {
        // The person used the app (at most once a minute): the only thing that moves active_at (§15.8).
        const r = sid
          ? await d1.prepare(`UPDATE sessions SET last_seen_at = ?3, active_at = ?3 WHERE id = ?1 AND user_id = ?2 RETURNING active_at, idle_limit_ms`).bind(sid, user.id, now).first<{ active_at: number; idle_limit_ms: number | null }>()
          : null;
        await touchOrgActivity(deps, user.id, true);
        return json({ activeAt: r?.active_at ?? now, idleLimitMs: r?.idle_limit_ms ?? null });
      }
      if (parts.length === 3 && parts[2] === "current" && m === "DELETE") {
        // Log out of this session; `?reason=idle`: the app's idle timer ran out (logged at once, [F-idle]).
        const gone = sid ? await d1.prepare(`DELETE FROM sessions WHERE id = ?1 AND user_id = ?2 RETURNING id`).bind(sid, user.id).first() : null;
        const idle = new URL(req.url).searchParams.get("reason") === "idle";
        if (idle) {
          const { logIdleTimeout, rememberIdleEnded } = await import("./auth/idle");
          if (gone && sid) await rememberIdleEnded(deps, sid, user.id);
          await logIdleTimeout(deps, user, req, "client");
        }
        else if (gone) await logForUserOrgs(deps, user, "user_sign_out", req, { session_id: sid });
        return new Response(null, { status: 204 });
      }
      if (parts.length === 3 && m === "DELETE") {
        if (parts[2] === sid) return fail(400, "log out to end this session");
        const gone = await d1.prepare(`DELETE FROM sessions WHERE id = ?1 AND user_id = ?2 RETURNING id`).bind(parts[2], user.id).first();
        if (gone) await logForUserOrgs(deps, user, "user_sign_out", req, { session_id: parts[2] });
        return json({ ok: true });
      }
      break;
    }
    case "tokens": {
      if (parts.length === 2 && m === "GET") return json({ tokens: await listTokens(deps, user.id) });
      if (parts.length === 2 && m === "POST") {
        const body = await readJson<{ description?: unknown; expiresInDays?: unknown; scopes?: unknown }>(req);
        const description = typeof body?.description === "string" ? body.description.trim().slice(0, 100) : "";
        if (!description) return fail(400, "give the token a name");
        if (!TOKEN_EXPIRATIONS.some((e) => e.days === body?.expiresInDays)) return fail(400, "expiresInDays is 1, 7, 30 or 90");
        const scopes = Array.isArray(body?.scopes) ? [...new Set(body.scopes)] : [];
        if (!scopes.length || !scopes.every(isTokenScope)) return fail(400, "choose at least one scope");
        const n = await d1.prepare(`SELECT COUNT(*) AS n FROM access_tokens WHERE user_id = ?1 AND kind = 'personal'`).bind(user.id).first<{ n: number }>();
        if ((n?.n ?? 0) >= MAX_TOKENS) return fail(400, `at most ${MAX_TOKENS} tokens`);
        const id = `t_${randomToken(9)}`;
        const token = `${TOKEN_PREFIX}${randomToken(32)}`;
        const expiresAt = now + (body!.expiresInDays as number) * 86_400_000;
        await d1
          .prepare(`INSERT INTO access_tokens (id, user_id, description, token_hash, scopes, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`)
          .bind(id, user.id, description, await sha256b64url(token), JSON.stringify(scopes), now, expiresAt)
          .run();
        const info: AccessTokenInfo = { id, description, scopes: scopes as TokenScope[], kind: "personal", orgId: null, createdAt: now, expiresAt, lastUsedAt: null };
        await logForUserOrgs(deps, user, "personal_access_token_create", req, { token_id: id, description, scopes });
        return json({ token, info }, 201);
      }
      if (parts.length === 3 && m === "DELETE") {
        const gone = await d1.prepare(`DELETE FROM access_tokens WHERE id = ?1 AND user_id = ?2 AND kind = 'personal' RETURNING id`).bind(parts[2], user.id).first();
        if (gone) await logForUserOrgs(deps, user, "personal_access_token_delete", req, { token_id: parts[2] });
        return json({ ok: true });
      }
      break;
    }
  }
  return fail(404, "not found");
}

/** `GET /me`'s `session` (§15.8): how this session signed in, its last activity and idle limit; null for a PAT or an
 *  older token without a session row */
async function sessionIdle(deps: Deps, sid: string | null, userId: string): Promise<SessionIdle | null> {
  if (!sid) return null;
  const r = await deps.db.d1
    .prepare(`SELECT id, auth_method, active_at, last_seen_at, idle_limit_ms FROM sessions WHERE id = ?1 AND user_id = ?2`)
    .bind(sid, userId)
    .first<{ id: string; auth_method: SessionAuth; active_at: number | null; last_seen_at: number; idle_limit_ms: number | null }>();
  return r ? { id: r.id, auth: r.auth_method, activeAt: r.active_at ?? r.last_seen_at, idleLimitMs: r.idle_limit_ms } : null;
}

/** A `dsgn_…` Bearer: its user and scopes, or null (unknown, expired, or a plan access token). "Last used" moves on, at
 *  most once a minute. */
export async function personalToken(deps: Deps, raw: string): Promise<{ userId: string; scopes: TokenScope[] } | null> {
  const t = await accessToken(deps, raw);
  return t && t.kind === "personal" ? { userId: t.userId, scopes: t.scopes } : null;
}

/** Plan access tokens' prefix (docs/multiplayer.md §16.3; ours) */
export const PLAN_TOKEN_PREFIX = `${TOKEN_PREFIX}plan_`;

/**
 * Any access token (§13 personal, §16.3 plan): its id, user (a plan token's: the admin who made it), kind, org and
 * scopes; null when unknown or expired. "Last used" moves on, at most once a minute.
 */
export async function accessToken(deps: Deps, raw: string): Promise<{ id: string; userId: string; kind: "personal" | "plan"; orgId: string | null; scopes: TokenScope[] } | null> {
  if (!raw.startsWith(TOKEN_PREFIX)) return null;
  const now = deps.now();
  const r = await deps.db.d1
    .prepare(`SELECT id, user_id, scopes, expires_at, last_used_at, kind, org_id FROM access_tokens WHERE token_hash = ?1`)
    .bind(await sha256b64url(raw))
    .first<{ id: string; user_id: string; scopes: string; expires_at: number | null; last_used_at: number | null; kind: "personal" | "plan"; org_id: string | null }>();
  if (!r || (r.expires_at !== null && r.expires_at <= now)) return null;
  // A plan token is the org's: it stops with the org (ON DELETE CASCADE) and never acts outside it.
  if (r.kind === "plan" && !r.org_id) return null;
  if (r.last_used_at === null || r.last_used_at < now - 60_000) await deps.db.d1.prepare(`UPDATE access_tokens SET last_used_at = ?2 WHERE id = ?1`).bind(r.id, now).run();
  let scopes: TokenScope[] = [];
  try {
    scopes = (JSON.parse(r.scopes) as unknown[]).filter(isTokenScope);
  } catch {
    // none
  }
  return { id: r.id, userId: r.user_id, kind: r.kind === "plan" ? "plan" : "personal", orgId: r.org_id, scopes };
}

/**
 * What a personal access token may do outside /me: read files it has access to (the list and names — metadata —, the
 * snapshot and images — content), read and write comments. Never sharing, members, sockets, snapshots' writes,
 * previews or the account.
 */
export function patAllows(scopes: readonly TokenScope[], method: string, parts: readonly string[]): boolean {
  if (parts[0] !== "files") return false;
  const has = (s: TokenScope) => scopes.includes(s);
  if (parts[2] === "comments") return method === "GET" ? has("file_comments:read") : has("file_comments:write");
  if (method !== "GET") return false;
  if (parts.length <= 2) return has("file_metadata:read") || has("file_content:read");
  if (parts[2] === "snapshot" || parts[2] === "blobs") return has("file_content:read");
  return false;
}

async function listTokens(deps: Deps, userId: string): Promise<AccessTokenInfo[]> {
  const { results } = await deps.db.d1
    .prepare(`SELECT id, description, scopes, created_at, expires_at, last_used_at FROM access_tokens WHERE user_id = ?1 AND kind = 'personal' ORDER BY created_at DESC`)
    .bind(userId)
    .all<{ id: string; description: string; scopes: string; created_at: number; expires_at: number | null; last_used_at: number | null }>();
  return results.map((r) => ({ id: r.id, description: r.description, scopes: safeParse<unknown[]>(r.scopes, []).filter(isTokenScope), kind: "personal", orgId: null, createdAt: r.created_at, expiresAt: r.expires_at, lastUsedAt: r.last_used_at }));
}

async function profile(deps: Deps, userId: string): Promise<AccountProfile> {
  const r = await deps.db.d1
    .prepare(`SELECT id, google_sub, email, name, picture, job_role, community, prefs FROM users WHERE id = ?1`)
    .bind(userId)
    .first<{ id: string; google_sub: string; email: string; name: string | null; picture: string | null; job_role: string | null; community: string; prefs: string }>();
  if (!r) throw new Error("profile: no user");
  return { id: r.id, email: r.email, name: r.name, picture: r.picture, role: r.job_role, community: safeParse<CommunityProfile>(r.community, {}), prefs: safeParse<AccountPrefs>(r.prefs, {}), provider: r.google_sub.startsWith("dev:") ? "dev" : "google" };
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : undefined);

/** Checks and writes a ProfilePatch; an error message, or null. */
async function patchProfile(deps: Deps, userId: string, body: Record<string, unknown>): Promise<string | null> {
  const d1 = deps.db.d1;
  if (body.name !== undefined) {
    const name = str(body.name, 100);
    if (!name) return "a name";
    await d1.prepare(`UPDATE users SET name = ?2, name_locked = 1 WHERE id = ?1`).bind(userId, name).run();
  }
  if (body.picture !== undefined) {
    const p = body.picture;
    if (p !== null && (typeof p !== "string" || p.length > MAX_PICTURE_CHARS || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(p))) return "a PNG, JPEG or WebP photo under 300 kB";
    // null: back to the Google account's photo at the next sign-in.
    await d1.prepare(`UPDATE users SET picture = ?2, picture_locked = ?3 WHERE id = ?1`).bind(userId, p, p === null ? 0 : 1).run();
  }
  if (body.role !== undefined) {
    if (body.role !== null && !ROLES.includes(body.role as (typeof ROLES)[number])) return "an unknown role";
    await d1.prepare(`UPDATE users SET job_role = ?2 WHERE id = ?1`).bind(userId, body.role).run();
  }
  if (body.community !== undefined) {
    const c = body.community as Record<string, unknown> | null;
    if (!c || typeof c !== "object") return "community is an object";
    const next: CommunityProfile = {};
    const handle = str(c.handle, 15);
    if (handle) {
      if (!HANDLE_RE.test(handle)) return "a handle is 15 letters, numbers or underscores at most";
      const taken = await d1.prepare(`SELECT id FROM users WHERE lower(json_extract(community, '$.handle')) = lower(?1) AND id <> ?2`).bind(handle, userId).first();
      if (taken) return "That handle is taken";
      next.handle = handle;
    }
    const bio = str(c.bio, 1000);
    if (bio && bio.length > MAX_BIO) return `a bio is ${MAX_BIO} characters at most`;
    if (bio) next.bio = bio;
    for (const k of ["location", "website", "x", "instagram"] as const) {
      const v = str(c[k], 200);
      if (v) next[k] = v;
    }
    if (next.website && !/^https?:\/\/\S+$/.test(next.website)) next.website = `https://${next.website}`;
    await d1.prepare(`UPDATE users SET community = ?2 WHERE id = ?1`).bind(userId, JSON.stringify(next)).run();
  }
  if (body.prefs !== undefined) {
    const p = body.prefs as Record<string, unknown> | null;
    if (!p || typeof p !== "object") return "prefs is an object";
    const cur = (await profile(deps, userId)).prefs;
    const next: AccountPrefs = { ...cur };
    if (typeof p.language === "string") {
      if (p.language !== "en") return "only English is available";
      next.language = p.language;
    }
    if (typeof p.closedCaptions === "boolean") next.closedCaptions = p.closedCaptions;
    if (typeof p.viewHistory === "boolean") next.viewHistory = p.viewHistory;
    await d1.prepare(`UPDATE users SET prefs = ?2 WHERE id = ?1`).bind(userId, JSON.stringify(next)).run();
  }
  return null;
}

/**
 * Delete account (help.figma.com 360039826814): permanent. Files the person owns stop being shared (their rooms are
 * dropped — everyone's local copies stay theirs), their memberships, requests, comments and reactions, devices,
 * previews, sessions and tokens go, then the user. Their own local files stay on their computers.
 */
async function deleteAccount(deps: Deps, user: User): Promise<void> {
  const d1 = deps.db.d1;
  // Organizations first (docs/multiplayer.md §14.7): removed from each the way Admin removes someone; their drafts and
  // files there stay — the org owns them (Unassigned drafts).
  const { removeFromOrg } = await import("./org/orgs");
  const { results: orgs } = await d1.prepare(`SELECT org_id FROM org_members WHERE user_id = ?1`).bind(user.id).all<{ org_id: string }>();
  for (const { org_id } of orgs) await removeFromOrg(deps, org_id, user.id, user, null);
  await d1.prepare(`DELETE FROM org_members WHERE email = ?1 AND user_id IS NULL`).bind(user.email).run();
  const { results: owned } = await d1.prepare(`SELECT key FROM files WHERE owner_id = ?1 AND org_id IS NULL`).bind(user.id).all<{ key: string }>();
  for (const { key } of owned) {
    await deps.rooms.fetch(key, "/room", { method: "DELETE" });
    await d1.prepare(`DELETE FROM comments WHERE file_key = ?1`).bind(key).run();
    await deps.db.deleteFile(key);
  }
  // Their sockets in others' files close (the room checks membership again on reconnect).
  const { results: joined } = await d1.prepare(`SELECT file_key FROM members WHERE user_id = ?1 OR email = ?2`).bind(user.id, user.email).all<{ file_key: string }>();
  await d1.prepare(`DELETE FROM members WHERE user_id = ?1 OR email = ?2`).bind(user.id, user.email).run();
  for (const { file_key } of joined) await deps.rooms.fetch(file_key, "/room/revoke", { method: "POST", body: JSON.stringify({ userId: user.id }) });
  await d1.prepare(`DELETE FROM access_requests WHERE user_id = ?1`).bind(user.id).run();
  await d1.prepare(`DELETE FROM comment_reactions WHERE user_id = ?1`).bind(user.id).run();
  await d1.prepare(`DELETE FROM comment_reads WHERE user_id = ?1`).bind(user.id).run();
  await d1.prepare(`UPDATE comments SET resolved_by = NULL WHERE resolved_by = ?1`).bind(user.id).run();
  await d1.prepare(`DELETE FROM comments WHERE user_id = ?1`).bind(user.id).run();
  await d1.prepare(`DELETE FROM auth_codes WHERE user_id = ?1`).bind(user.id).run();
  // Notifications they caused in others' inboxes (their own go with them: ON DELETE CASCADE).
  await d1.prepare(`DELETE FROM notifications WHERE actor_id = ?1`).bind(user.id).run();
  await d1.prepare(`DELETE FROM devices WHERE user_id = ?1`).bind(user.id).run();
  await deletePreviewsOf(deps, user.id);
  await d1.prepare(`DELETE FROM sessions WHERE user_id = ?1`).bind(user.id).run();
  await d1.prepare(`DELETE FROM access_tokens WHERE user_id = ?1`).bind(user.id).run();
  if (await keptByOrgs(deps, user.id)) {
    // Org content still names them (drafts, teams, folders, groups, invites): the row stays as a tombstone — no email,
    // no Google account, no sign-in; their name reads "Deleted user".
    await d1
      .prepare(`UPDATE users SET google_sub = ?2, email = ?3, name = 'Deleted user', picture = NULL, token_version = token_version + 1, name_locked = 1, picture_locked = 1 WHERE id = ?1`)
      .bind(user.id, `deleted:${user.id}`, `deleted+${user.id}@invalid`)
      .run();
    return;
  }
  await d1.prepare(`DELETE FROM users WHERE id = ?1`).bind(user.id).run();
}

/** An org where they are the only admin and others remain: the account can't go before someone else is admin. */
async function soleAdminOf(deps: Deps, userId: string): Promise<string | null> {
  const r = await deps.db.d1
    .prepare(
      `SELECT o.name FROM org_members m JOIN orgs o ON o.id = m.org_id WHERE m.user_id = ?1 AND m.role = 'admin'
       AND NOT EXISTS (SELECT 1 FROM org_members x WHERE x.org_id = m.org_id AND x.role = 'admin' AND x.user_id <> ?1 AND x.user_id IS NOT NULL)
       AND EXISTS (SELECT 1 FROM org_members y WHERE y.org_id = m.org_id AND (y.user_id IS NULL OR y.user_id <> ?1)) LIMIT 1`,
    )
    .bind(userId)
    .first<{ name: string }>();
  return r?.name ?? null;
}

/** Does anything of an org still refer to this user (so the row can't be deleted under its foreign keys)? */
async function keptByOrgs(deps: Deps, userId: string): Promise<boolean> {
  const r = await deps.db.d1
    .prepare(
      `SELECT (EXISTS (SELECT 1 FROM files WHERE owner_id = ?1 OR trashed_by = ?1) OR EXISTS (SELECT 1 FROM orgs WHERE created_by = ?1)
         OR EXISTS (SELECT 1 FROM teams WHERE owner_id = ?1 OR deleted_by = ?1) OR EXISTS (SELECT 1 FROM projects WHERE owner_id = ?1 OR trashed_by = ?1)
         OR EXISTS (SELECT 1 FROM user_groups WHERE created_by = ?1) OR EXISTS (SELECT 1 FROM org_members WHERE invited_by = ?1)
         OR EXISTS (SELECT 1 FROM team_members WHERE invited_by = ?1) OR EXISTS (SELECT 1 FROM project_members WHERE invited_by = ?1)
         OR EXISTS (SELECT 1 FROM user_group_members WHERE added_by = ?1) OR EXISTS (SELECT 1 FROM group_grants WHERE granted_by = ?1)
         OR EXISTS (SELECT 1 FROM seat_requests WHERE answered_by = ?1) OR EXISTS (SELECT 1 FROM guest_requests WHERE invited_by = ?1 OR answered_by = ?1)) AS kept`,
    )
    .bind(userId)
    .first<{ kept: number }>();
  return (r?.kept ?? 0) === 1;
}

/**
 * Admin › People "Last active" (docs/multiplayer.md §14.11): every org of the user, moved on at most every 5 minutes
 * (`force`: the app's activity report, itself once a minute).
 */
export async function touchOrgActivity(deps: Deps, userId: string, force = false): Promise<void> {
  const now = deps.now();
  await deps.db.d1
    .prepare(`UPDATE org_members SET last_active_at = ?2 WHERE user_id = ?1 AND (last_active_at IS NULL OR last_active_at < ?3)`)
    .bind(userId, now, force ? now - 60_000 : now - 300_000)
    .run();
}

function safeParse<T>(text: string, fallback: T): T {
  try {
    const v = JSON.parse(text) as T;
    return v && typeof v === "object" ? v : fallback;
  } catch {
    return fallback;
  }
}

async function readJson<T>(req: Request): Promise<T | null> {
  try {
    const v = (await req.json()) as T;
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

/** Sessions' "Location & IP": Cloudflare's view of the request (`request.cf`: city, country) and the client's IP. */
export function requestPlace(req: Request): { ip: string | null; city: string | null; country: string | null } {
  const cf = (req as { cf?: { city?: unknown; country?: unknown } }).cf;
  const code = typeof cf?.country === "string" && /^[A-Z]{2}$/.test(cf.country) ? cf.country : null;
  let country: string | null = code;
  if (code) {
    try {
      country = new Intl.DisplayNames(["en"], { type: "region" }).of(code) ?? code;
    } catch {
      // the code
    }
  }
  return { ip: req.headers.get("cf-connecting-ip"), city: typeof cf?.city === "string" ? cf.city : null, country };
}
