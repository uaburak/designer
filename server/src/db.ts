/**
 * The D1 queries (docs/multiplayer.md §3; tables in migrations/0001_init.sql). Written against the narrow `D1Like`
 * that both Cloudflare's D1 and the tests' node:sqlite stand-in satisfy. Times are milliseconds.
 */
import type { Role } from "../../src/shared/multiplayer/protocol";
import { randomToken } from "./tokens";

export interface D1Stmt {
  bind(...values: unknown[]): D1Stmt;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}

export interface D1Like {
  prepare(sql: string): D1Stmt;
}

export interface User {
  id: string;
  email: string;
  name: string | null;
  picture: string | null;
  tokenVersion: number;
}

export interface SharedFile {
  key: string;
  name: string;
  ownerId: string;
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
  constructor(private d1: D1Like) {}

  /** Sign-in: the user for this Google account, created or refreshed; invites waiting for its email become theirs. */
  async upsertUser(p: { sub: string; email: string; name?: string | null; picture?: string | null }, now: number): Promise<User> {
    const email = normalizeEmail(p.email);
    const row = await this.d1
      .prepare(
        `INSERT INTO users (id, google_sub, email, name, picture, created_at, last_seen_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
         ON CONFLICT (google_sub) DO UPDATE SET email = ?3, name = ?4, picture = ?5, last_seen_at = ?6
         RETURNING id, email, name, picture, token_version`,
      )
      .bind(`u_${randomToken(12)}`, p.sub, email, p.name ?? null, p.picture ?? null, now)
      .first<UserRow>();
    if (!row) throw new Error("upsertUser: no row");
    await this.d1.prepare(`UPDATE members SET user_id = ?1 WHERE email = ?2 AND user_id IS NULL`).bind(row.id, email).run();
    return toUser(row);
  }

  async user(id: string): Promise<User | null> {
    const r = await this.d1.prepare(`SELECT id, email, name, picture, token_version FROM users WHERE id = ?1`).bind(id).first<UserRow>();
    return r ? toUser(r) : null;
  }

  /** Sign out everywhere: every session token issued before stops working. */
  async bumpTokenVersion(id: string): Promise<void> {
    await this.d1.prepare(`UPDATE users SET token_version = token_version + 1 WHERE id = ?1`).bind(id).run();
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

  async putAuthCode(codeHash: string, userId: string, challenge: string, expiresAt: number): Promise<void> {
    await this.d1.prepare(`INSERT INTO auth_codes (code_hash, user_id, challenge, expires_at) VALUES (?1, ?2, ?3, ?4)`).bind(codeHash, userId, challenge, expiresAt).run();
  }

  /** The code's row, deleted as it is read (single use); expired codes are swept on the way. */
  async takeAuthCode(codeHash: string, now: number): Promise<{ userId: string; challenge: string } | null> {
    await this.d1.prepare(`DELETE FROM auth_codes WHERE expires_at <= ?1`).bind(now).run();
    const r = await this.d1
      .prepare(`DELETE FROM auth_codes WHERE code_hash = ?1 RETURNING user_id, challenge, expires_at`)
      .bind(codeHash)
      .first<{ user_id: string; challenge: string; expires_at: number }>();
    return r && r.expires_at > now ? { userId: r.user_id, challenge: r.challenge } : null;
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
        `SELECT f.key, f.name, f.owner_id, f.created_at, f.updated_at, CASE WHEN f.owner_id = ?1 THEN 'owner' ELSE m.role END AS role
         FROM files f LEFT JOIN members m ON m.file_key = f.key AND m.user_id = ?1
         WHERE f.owner_id = ?1 OR m.user_id = ?1
         ORDER BY f.updated_at DESC`,
      )
      .bind(userId)
      .all<{ key: string; name: string; owner_id: string; created_at: number; updated_at: number; role: Role }>();
    return results.map((r) => ({ key: r.key, name: r.name, ownerId: r.owner_id, role: r.role, createdAt: r.created_at, updatedAt: r.updated_at }));
  }

  /** A file's name and its link setting */
  async file(key: string): Promise<{ key: string; name: string; ownerId: string; linkAccess: "none" | "viewer" | "editor" } | null> {
    const r = await this.d1.prepare(`SELECT key, name, owner_id, link_access FROM files WHERE key = ?1`).bind(key).first<{ key: string; name: string; owner_id: string; link_access: "none" | "viewer" | "editor" }>();
    return r ? { key: r.key, name: r.name, ownerId: r.owner_id, linkAccess: r.link_access } : null;
  }

  async setLinkAccess(key: string, access: "none" | "viewer" | "editor", now: number): Promise<void> {
    await this.d1.prepare(`UPDATE files SET link_access = ?2, updated_at = ?3 WHERE key = ?1`).bind(key, access, now).run();
  }

  async renameFile(key: string, name: string, now: number): Promise<void> {
    await this.d1.prepare(`UPDATE files SET name = ?2, updated_at = ?3 WHERE key = ?1`).bind(key, name, now).run();
  }

  async deleteFile(key: string): Promise<void> {
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
