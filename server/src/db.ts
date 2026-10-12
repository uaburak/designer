/**
 * The D1 queries (docs/multiplayer.md §3, §15.8; tables in migrations/0001_init.sql). Written against the narrow
 * `D1Like` that both Cloudflare's D1 and the tests' node:sqlite stand-in satisfy. Times are milliseconds.
 */
import type { Role } from "../../src/shared/multiplayer/protocol";
import type { SessionAuth } from "../../src/shared/org/identity";
import { idleLimitSql, type SessionTouch } from "./auth/idle";
import { randomToken } from "./tokens";

export interface D1Stmt {
  bind(...values: unknown[]): D1Stmt;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}

export interface D1Like {
  prepare(sql: string): D1Stmt;
  /** D1's batch: the statements in one transaction (all or none). Optional for narrow stand-ins. */
  batch?(stmts: D1Stmt[]): Promise<unknown[]>;
}

export interface User {
  id: string;
  email: string;
  name: string | null;
  picture: string | null;
  tokenVersion: number;
}

/** Where a session signed in from (docs/multiplayer.md §13): the desktop app or a browser, its OS, its IP's place. */
export interface SessionDevice {
  kind: "app" | "login";
  os: string | null;
  browser: string | null;
  ip: string | null;
  city: string | null;
  country: string | null;
}

export interface SharedFile {
  key: string;
  name: string;
  ownerId: string;
  /** "From <name>" on Home's Shared files cards: who shared it with the caller (the owner) */
  ownerName: string | null;
  /** When it was shared with the caller (their membership), or created for the owner */
  sharedAt: number;
  role: Role;
  createdAt: number;
  updatedAt: number;
}

export interface Member {
  email: string;
  userId: string | null;
  name: string | null;
  picture: string | null;
  role: Role;
  /** Invited by email; no account signed in with it yet */
  pending: boolean;
}

interface UserRow {
  id: string;
  email: string;
  name: string | null;
  picture: string | null;
  token_version: number;
}

const toUser = (r: UserRow): User => ({ id: r.id, email: r.email, name: r.name, picture: r.picture, tokenVersion: r.token_version });

export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

export class Db {
  constructor(readonly d1: D1Like) {}

  /**
   * Sign-in: the user for this Google account, created or refreshed; invites waiting for its email become theirs. An
   * unknown `sub` first claims the most recently seen account made by SAML JIT or SCIM (`google_sub = 'none:…'`) with
   * the same verified email (docs/multiplayer.md §15.2 decision 5).
   */
  async upsertUser(p: { sub: string; email: string; name?: string | null; picture?: string | null }, now: number): Promise<User> {
    const email = normalizeEmail(p.email);
    const refresh = `email = ?2, name = CASE WHEN name_locked = 1 THEN name ELSE ?3 END, picture = CASE WHEN picture_locked = 1 THEN picture ELSE ?4 END, last_seen_at = ?5`;
    const cols = `id, email, name, picture, token_version`;
    const args = [p.sub, email, p.name ?? null, p.picture ?? null, now];
    let row = await this.d1.prepare(`UPDATE users SET ${refresh} WHERE google_sub = ?1 RETURNING ${cols}`).bind(...args).first<UserRow>();
    if (!row)
      row = await this.d1
        .prepare(`UPDATE users SET google_sub = ?1, ${refresh} WHERE id = (SELECT id FROM users WHERE email = ?2 AND google_sub LIKE 'none:%' ORDER BY last_seen_at DESC LIMIT 1) RETURNING ${cols}`)
        .bind(...args)
        .first<UserRow>();
    if (!row)
      row = await this.d1
        .prepare(`INSERT INTO users (id, google_sub, email, name, picture, created_at, last_seen_at) VALUES (?6, ?1, ?2, ?3, ?4, ?5, ?5) ON CONFLICT (google_sub) DO UPDATE SET ${refresh} RETURNING ${cols}`)
        .bind(...args, `u_${randomToken(12)}`)
        .first<UserRow>();
    if (!row) throw new Error("upsertUser: no row");
    await this.d1.prepare(`UPDATE members SET user_id = ?1 WHERE email = ?2 AND user_id IS NULL`).bind(row.id, email).run();
    return toUser(row);
  }

  /**
   * Sign-in: one session row (Settings › Security › Sessions); its id goes into the session token as `sid`. How it was
   * signed in, its activity and its idle limit (§15.8) start with it.
   */
  async createSession(userId: string, d: SessionDevice, now: number, auth: { method: SessionAuth; orgId?: string | null } = { method: "google" }): Promise<string> {
    const id = `s_${randomToken(12)}`;
    await this.d1
      .prepare(
        `INSERT INTO sessions (id, user_id, kind, os, browser, ip, city, country, created_at, last_seen_at, auth_method, auth_org_id, active_at, idle_limit_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, ?10, ?11, ?9, ${idleLimitSql("?2")})`,
      )
      .bind(id, userId, d.kind, d.os, d.browser, d.ip, d.city, d.country, now, auth.method, auth.orgId ?? null)
      .run();
    return id;
  }

  /**
   * A request with a session token: its row while it is there (not signed out), "Last accessed" moved on — at most once
   * every 5 minutes, so most requests write nothing — and with it the idle limit recomputed (membership changes reach
   * it within 5 minutes). `active_at` is not moved here (§15.8: background requests don't count).
   */
  async touchSession(id: string, userId: string, now: number): Promise<SessionTouch | null> {
    return this.d1
      .prepare(
        `UPDATE sessions SET last_seen_at = CASE WHEN last_seen_at < ?3 - 300000 THEN ?3 ELSE last_seen_at END,
           idle_limit_ms = CASE WHEN last_seen_at < ?3 - 300000 THEN ${idleLimitSql("?2")} ELSE idle_limit_ms END
         WHERE id = ?1 AND user_id = ?2 RETURNING id, auth_method, active_at, last_seen_at, idle_limit_ms`,
      )
      .bind(id, userId, now)
      .first<SessionTouch>();
  }

  async user(id: string): Promise<User | null> {
    const r = await this.d1.prepare(`SELECT id, email, name, picture, token_version FROM users WHERE id = ?1`).bind(id).first<UserRow>();
    return r ? toUser(r) : null;
  }

  /** Sign out everywhere: every session token issued before stops working. */
  async bumpTokenVersion(id: string): Promise<void> {
    await this.d1.prepare(`UPDATE users SET token_version = token_version + 1 WHERE id = ?1`).bind(id).run();
    await this.d1.prepare(`DELETE FROM sessions WHERE user_id = ?1`).bind(id).run();
  }

  /** The installation's device ordinal (2…4095), allocated once; null when every ordinal is taken. */
  async deviceOrdinal(installationId: string, userId: string, now: number): Promise<number | null> {
    const had = await this.d1.prepare(`UPDATE devices SET last_seen_at = ?2, user_id = ?3 WHERE installation_id = ?1 RETURNING ordinal`).bind(installationId, now, userId).first<{ ordinal: number }>();
    if (had) return had.ordinal;
    const r = await this.d1
      .prepare(
        `INSERT INTO devices (ordinal, installation_id, user_id, created_at, last_seen_at)
         SELECT COALESCE(MAX(ordinal), 1) + 1, ?1, ?2, ?3, ?3 FROM devices WHERE (SELECT COALESCE(MAX(ordinal), 1) FROM devices) < 4095
         ON CONFLICT (installation_id) DO UPDATE SET last_seen_at = ?3
         RETURNING ordinal`,
      )
      .bind(installationId, userId, now)
      .first<{ ordinal: number }>();
    return r?.ordinal ?? null;
  }

  /** A sign-in code (hashed), bound to the app's PKCE challenge; `auth` / `orgId`: how it was earned (SAML: the org) */
  /** `mfaPending`: the person has two-factor authentication on; `/auth/token` refuses the code until `/auth/2fa` passes
   *  (docs/governance.md §2.4), which trades it for a fresh one (`takePendingAuthCode`). */
  async putAuthCode(codeHash: string, userId: string, challenge: string, expiresAt: number, auth: SessionAuth = "google", orgId: string | null = null, mfaPending = false): Promise<void> {
    await this.d1
      .prepare(`INSERT INTO auth_codes (code_hash, user_id, challenge, expires_at, auth, org_id, mfa_pending) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`)
      .bind(codeHash, userId, challenge, expiresAt, auth, orgId, mfaPending ? 1 : 0)
      .run();
  }

  /** The code's row, deleted as it is read (single use); expired codes are swept on the way. A code still waiting for
   *  its second factor is never taken. */
  async takeAuthCode(codeHash: string, now: number): Promise<{ userId: string; challenge: string; auth: SessionAuth; orgId: string | null } | null> {
    await this.d1.prepare(`DELETE FROM auth_codes WHERE expires_at <= ?1`).bind(now).run();
    const r = await this.d1
      .prepare(`DELETE FROM auth_codes WHERE code_hash = ?1 AND mfa_pending = 0 RETURNING user_id, challenge, expires_at, auth, org_id`)
      .bind(codeHash)
      .first<{ user_id: string; challenge: string; expires_at: number; auth: SessionAuth; org_id: string | null }>();
    return r && r.expires_at > now ? { userId: r.user_id, challenge: r.challenge, auth: r.auth, orgId: r.org_id } : null;
  }

  /** A code waiting for its second factor (read, not taken), or null when it is unknown, expired or already passed */
  async pendingAuthCode(codeHash: string, now: number): Promise<{ userId: string } | null> {
    const r = await this.d1.prepare(`SELECT user_id FROM auth_codes WHERE code_hash = ?1 AND mfa_pending = 1 AND expires_at > ?2`).bind(codeHash, now).first<{ user_id: string }>();
    return r ? { userId: r.user_id } : null;
  }

  /** The second factor passed: the pending row is taken (atomically: one of two concurrent posts wins) */
  async takePendingAuthCode(codeHash: string, now: number): Promise<{ userId: string; challenge: string; auth: SessionAuth; orgId: string | null } | null> {
    const r = await this.d1
      .prepare(`DELETE FROM auth_codes WHERE code_hash = ?1 AND mfa_pending = 1 AND expires_at > ?2 RETURNING user_id, challenge, auth, org_id`)
      .bind(codeHash, now)
      .first<{ user_id: string; challenge: string; auth: SessionAuth; org_id: string | null }>();
    return r ? { userId: r.user_id, challenge: r.challenge, auth: r.auth, orgId: r.org_id } : null;
  }

  /** Registers a file as shared; false when the key is already someone else's. Re-sharing one's own file is a no-op. */
  async createFile(key: string, ownerId: string, name: string, now: number): Promise<boolean> {
    await this.d1
      .prepare(`INSERT INTO files (key, owner_id, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4) ON CONFLICT (key) DO NOTHING`)
      .bind(key, ownerId, name, now)
      .run();
    const r = await this.d1.prepare(`SELECT owner_id FROM files WHERE key = ?1`).bind(key).first<{ owner_id: string }>();
    return r?.owner_id === ownerId;
  }

  /** The caller's role and how they have it: `invited` = owner or member (no password asked), else by the link alone. */
  async access(key: string, userId: string): Promise<{ role: Role; invited: boolean; password: string | null; passwordVersion: number } | null> {
    const r = await this.d1
      .prepare(
        `SELECT CASE WHEN f.owner_id = ?2 THEN 'owner'
                     WHEN m.role = 'editor' OR f.link_access = 'editor' THEN 'editor'
                     WHEN m.role = 'viewer' OR f.link_access = 'viewer' THEN 'viewer' END AS role,
                (f.owner_id = ?2 OR m.role IS NOT NULL) AS invited, f.link_password, f.link_password_version
         FROM files f LEFT JOIN members m ON m.file_key = f.key AND m.user_id = ?2
         WHERE f.key = ?1`,
      )
      .bind(key, userId)
      .first<{ role: Role | null; invited: number; link_password: string | null; link_password_version: number }>();
    return r?.role ? { role: r.role, invited: r.invited === 1, password: r.link_password, passwordVersion: r.link_password_version } : null;
  }

  /** "Password required": a hash, or null to turn it off; bumps the version either way. */
  async setLinkPassword(key: string, hash: string | null, now: number): Promise<void> {
    await this.d1.prepare(`UPDATE files SET link_password = ?2, link_password_version = link_password_version + 1, updated_at = ?3 WHERE key = ?1`).bind(key, hash, now).run();
  }

  /** "Transfer ownership" to a member with an account: they become the owner, the old owner a "can edit" member. */
  async transferOwnership(key: string, toEmail: string, fromId: string, now: number): Promise<{ toId: string } | null> {
    const e = normalizeEmail(toEmail);
    const to = await this.d1.prepare(`SELECT user_id FROM members WHERE file_key = ?1 AND email = ?2 AND user_id IS NOT NULL`).bind(key, e).first<{ user_id: string }>();
    const from = await this.d1.prepare(`SELECT email FROM users WHERE id = ?1`).bind(fromId).first<{ email: string }>();
    if (!to || !from) return null;
    await this.d1.prepare(`UPDATE files SET owner_id = ?2, updated_at = ?3 WHERE key = ?1`).bind(key, to.user_id, now).run();
    await this.d1.prepare(`DELETE FROM members WHERE file_key = ?1 AND email = ?2`).bind(key, e).run();
    await this.d1
      .prepare(
        `INSERT INTO members (file_key, email, user_id, role, invited_by, created_at) VALUES (?1, ?2, ?3, 'editor', ?4, ?5)
         ON CONFLICT (file_key, email) DO UPDATE SET role = 'editor', user_id = ?3`,
      )
      .bind(key, from.email, fromId, to.user_id, now)
      .run();
    return { toId: to.user_id };
  }

  async roleOf(key: string, userId: string): Promise<Role | null> {
    const r = await this.d1
      .prepare(
        `SELECT CASE WHEN f.owner_id = ?2 THEN 'owner'
                     WHEN m.role = 'editor' OR f.link_access = 'editor' THEN 'editor'
                     WHEN m.role = 'viewer' OR f.link_access = 'viewer' THEN 'viewer' END AS role
         FROM files f LEFT JOIN members m ON m.file_key = f.key AND m.user_id = ?2
         WHERE f.key = ?1`,
      )
      .bind(key, userId)
      .first<{ role: Role | null }>();
    return r?.role ?? null;
  }

  async files(userId: string): Promise<SharedFile[]> {
    const { results } = await this.d1
      .prepare(
        `SELECT f.key, f.name, f.owner_id, f.created_at, f.updated_at, CASE WHEN f.owner_id = ?1 THEN 'owner' ELSE m.role END AS role,
                u.name AS owner_name, u.email AS owner_email, COALESCE(m.created_at, f.created_at) AS shared_at
         FROM files f LEFT JOIN members m ON m.file_key = f.key AND m.user_id = ?1 LEFT JOIN users u ON u.id = f.owner_id
         WHERE f.owner_id = ?1 OR m.user_id = ?1
         ORDER BY shared_at DESC`,
      )
      .bind(userId)
      .all<{ key: string; name: string; owner_id: string; created_at: number; updated_at: number; role: Role; owner_name: string | null; owner_email: string | null; shared_at: number }>();
    return results.map((r) => ({ key: r.key, name: r.name, ownerId: r.owner_id, ownerName: r.owner_name || r.owner_email, sharedAt: r.shared_at, role: r.role, createdAt: r.created_at, updatedAt: r.updated_at }));
  }

  /** A file's name and its link setting */
  async file(key: string): Promise<{ key: string; name: string; ownerId: string; linkAccess: "none" | "viewer" | "editor"; viewersCanCopy: boolean; passwordProtected: boolean } | null> {
    const r = await this.d1
      .prepare(`SELECT key, name, owner_id, link_access, viewers_can_copy, link_password FROM files WHERE key = ?1`)
      .bind(key)
      .first<{ key: string; name: string; owner_id: string; link_access: "none" | "viewer" | "editor"; viewers_can_copy: number; link_password: string | null }>();
    return r ? { key: r.key, name: r.name, ownerId: r.owner_id, linkAccess: r.link_access, viewersCanCopy: r.viewers_can_copy !== 0, passwordProtected: r.link_password !== null } : null;
  }

  async setViewersCanCopy(key: string, on: boolean, now: number): Promise<void> {
    await this.d1.prepare(`UPDATE files SET viewers_can_copy = ?2, updated_at = ?3 WHERE key = ?1`).bind(key, on ? 1 : 0, now).run();
  }

  /** "Ask to edit": one request per person per file */
  async addRequest(key: string, userId: string, now: number): Promise<void> {
    await this.d1.prepare(`INSERT INTO access_requests (file_key, user_id, created_at) VALUES (?1, ?2, ?3) ON CONFLICT DO NOTHING`).bind(key, userId, now).run();
  }

  async requests(key: string): Promise<{ userId: string; email: string; name: string | null; createdAt: number }[]> {
    const { results } = await this.d1
      .prepare(`SELECT r.user_id, u.email, u.name, r.created_at FROM access_requests r JOIN users u ON u.id = r.user_id WHERE r.file_key = ?1 ORDER BY r.created_at`)
      .bind(key)
      .all<{ user_id: string; email: string; name: string | null; created_at: number }>();
    return results.map((r) => ({ userId: r.user_id, email: r.email, name: r.name, createdAt: r.created_at }));
  }

  /** The request, removed as it is answered; null when there was none */
  async takeRequest(key: string, userId: string): Promise<{ email: string } | null> {
    const r = await this.d1
      .prepare(`SELECT u.email FROM access_requests r JOIN users u ON u.id = r.user_id WHERE r.file_key = ?1 AND r.user_id = ?2`)
      .bind(key, userId)
      .first<{ email: string }>();
    if (!r) return null;
    await this.d1.prepare(`DELETE FROM access_requests WHERE file_key = ?1 AND user_id = ?2`).bind(key, userId).run();
    return r;
  }

  async setLinkAccess(key: string, access: "none" | "viewer" | "editor", now: number): Promise<void> {
    await this.d1.prepare(`UPDATE files SET link_access = ?2, updated_at = ?3 WHERE key = ?1`).bind(key, access, now).run();
  }

  async renameFile(key: string, name: string, now: number): Promise<void> {
    await this.d1.prepare(`UPDATE files SET name = ?2, updated_at = ?3 WHERE key = ?1`).bind(key, name, now).run();
  }

  async deleteFile(key: string): Promise<void> {
    await this.d1.prepare(`DELETE FROM access_requests WHERE file_key = ?1`).bind(key).run();
    await this.d1.prepare(`DELETE FROM members WHERE file_key = ?1`).bind(key).run();
    await this.d1.prepare(`DELETE FROM files WHERE key = ?1`).bind(key).run();
  }

  /** The owner first, then members by email. */
  async members(key: string): Promise<Member[]> {
    const owner = await this.d1
      .prepare(`SELECT u.id, u.email, u.name, u.picture FROM files f JOIN users u ON u.id = f.owner_id WHERE f.key = ?1`)
      .bind(key)
      .first<{ id: string; email: string; name: string | null; picture: string | null }>();
    const { results } = await this.d1
      .prepare(
        `SELECT m.email, m.user_id, m.role, u.name, u.picture FROM members m LEFT JOIN users u ON u.id = m.user_id
         WHERE m.file_key = ?1 ORDER BY m.email`,
      )
      .bind(key)
      .all<{ email: string; user_id: string | null; role: Role; name: string | null; picture: string | null }>();
    const out: Member[] = owner ? [{ email: owner.email, userId: owner.id, name: owner.name, picture: owner.picture, role: "owner", pending: false }] : [];
    for (const r of results) out.push({ email: r.email, userId: r.user_id, name: r.name, picture: r.picture, role: r.role, pending: !r.user_id });
    return out;
  }

  /** Invites `email` or changes its role; returns the member's user id when the email already has an account. */
  async putMember(key: string, email: string, role: "editor" | "viewer", invitedBy: string, now: number): Promise<string | null> {
    const e = normalizeEmail(email);
    const u = await this.d1.prepare(`SELECT id FROM users WHERE email = ?1 ORDER BY created_at LIMIT 1`).bind(e).first<{ id: string }>();
    await this.d1
      .prepare(
        `INSERT INTO members (file_key, email, user_id, role, invited_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT (file_key, email) DO UPDATE SET role = ?4`,
      )
      .bind(key, e, u?.id ?? null, role, invitedBy, now)
      .run();
    return u?.id ?? null;
  }

  /** Removes a member; returns their user id (to close their sockets), if they had an account. */
  async removeMember(key: string, email: string): Promise<string | null> {
    const r = await this.d1
      .prepare(`DELETE FROM members WHERE file_key = ?1 AND email = ?2 RETURNING user_id`)
      .bind(key, normalizeEmail(email))
      .first<{ user_id: string | null }>();
    return r?.user_id ?? null;
  }
}
