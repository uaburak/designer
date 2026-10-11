/**
 * The account's own settings (docs/multiplayer.md §13; Figma's Settings modal): the profile, sessions, personal access
 * tokens and Delete account. Every route is the caller's own; a personal access token can't reach any of them.
 *
 *   GET    /me                      the user (as signed in)
 *   DELETE /me {confirm: email}     Delete account: owned files unshared, memberships, comments, previews, sessions, tokens
 *   GET    /me/profile              AccountProfile
 *   PATCH  /me/profile              ProfilePatch → AccountProfile (name, photo, role, Community profile, prefs)
 *   GET    /me/sessions             {sessions: SessionInfo[]}, the caller's marked `current`
 *   DELETE /me/sessions/:id         "Sign out": that session's token stops working
 *   GET    /me/tokens               {tokens: AccessTokenInfo[]}
 *   POST   /me/tokens               {description, expiresInDays, scopes} → {token (shown once), info}
 *   DELETE /me/tokens/:id           "Revoke access"
 *
 * Personal access tokens (`dsgn_…`) are Bearer tokens for the API's reads (`patAllows`): kept as their SHA-256 only.
 */
import { HANDLE_RE, MAX_BIO, MAX_PICTURE_CHARS, ROLES, TOKEN_EXPIRATIONS, TOKEN_PREFIX, isTokenScope, type AccessTokenInfo, type AccountPrefs, type AccountProfile, type CommunityProfile, type SessionInfo, type TokenScope } from "../../src/shared/account";
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
    if (m === "GET") return json({ id: user.id, email: user.email, name: user.name, picture: user.picture });
    if (m === "DELETE") {
      const body = await readJson<{ confirm?: unknown }>(req);
      if (typeof body?.confirm !== "string" || body.confirm.trim().toLowerCase() !== user.email) return fail(400, "type your email to confirm");
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
      if (parts.length === 3 && m === "DELETE") {
        if (parts[2] === sid) return fail(400, "log out to end this session");
        await d1.prepare(`DELETE FROM sessions WHERE id = ?1 AND user_id = ?2`).bind(parts[2], user.id).run();
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
        const n = await d1.prepare(`SELECT COUNT(*) AS n FROM access_tokens WHERE user_id = ?1`).bind(user.id).first<{ n: number }>();
        if ((n?.n ?? 0) >= MAX_TOKENS) return fail(400, `at most ${MAX_TOKENS} tokens`);
        const id = `t_${randomToken(9)}`;
        const token = `${TOKEN_PREFIX}${randomToken(32)}`;
        const expiresAt = now + (body!.expiresInDays as number) * 86_400_000;
        await d1
          .prepare(`INSERT INTO access_tokens (id, user_id, description, token_hash, scopes, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`)
          .bind(id, user.id, description, await sha256b64url(token), JSON.stringify(scopes), now, expiresAt)
          .run();
        const info: AccessTokenInfo = { id, description, scopes: scopes as TokenScope[], createdAt: now, expiresAt, lastUsedAt: null };
        return json({ token, info }, 201);
      }
      if (parts.length === 3 && m === "DELETE") {
        await d1.prepare(`DELETE FROM access_tokens WHERE id = ?1 AND user_id = ?2`).bind(parts[2], user.id).run();
        return json({ ok: true });
      }
      break;
    }
  }
  return fail(404, "not found");
}

/** A `dsgn_…` Bearer: its user and scopes, or null (unknown, expired). "Last used" moves on, at most once a minute. */
export async function personalToken(deps: Deps, raw: string): Promise<{ userId: string; scopes: TokenScope[] } | null> {
  if (!raw.startsWith(TOKEN_PREFIX)) return null;
  const now = deps.now();
  const r = await deps.db.d1
    .prepare(`SELECT id, user_id, scopes, expires_at, last_used_at FROM access_tokens WHERE token_hash = ?1`)
    .bind(await sha256b64url(raw))
    .first<{ id: string; user_id: string; scopes: string; expires_at: number | null; last_used_at: number | null }>();
  if (!r || (r.expires_at !== null && r.expires_at <= now)) return null;
  if (r.last_used_at === null || r.last_used_at < now - 60_000) await deps.db.d1.prepare(`UPDATE access_tokens SET last_used_at = ?2 WHERE id = ?1`).bind(r.id, now).run();
  let scopes: TokenScope[] = [];
  try {
    scopes = (JSON.parse(r.scopes) as unknown[]).filter(isTokenScope);
  } catch {
    // none
  }
  return { userId: r.user_id, scopes };
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
    .prepare(`SELECT id, description, scopes, created_at, expires_at, last_used_at FROM access_tokens WHERE user_id = ?1 ORDER BY created_at DESC`)
    .bind(userId)
    .all<{ id: string; description: string; scopes: string; created_at: number; expires_at: number | null; last_used_at: number | null }>();
  return results.map((r) => ({ id: r.id, description: r.description, scopes: safeParse<unknown[]>(r.scopes, []).filter(isTokenScope), createdAt: r.created_at, expiresAt: r.expires_at, lastUsedAt: r.last_used_at }));
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
  const { results: owned } = await d1.prepare(`SELECT key FROM files WHERE owner_id = ?1`).bind(user.id).all<{ key: string }>();
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
  await d1.prepare(`DELETE FROM users WHERE id = ?1`).bind(user.id).run();
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
