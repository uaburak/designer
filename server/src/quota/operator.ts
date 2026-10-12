/**
 * The server's operator (docs/multiplayer.md §17; ours): the people in `OPERATOR_EMAILS` (default the owner's) see
 * every account with its usage, suspend and unsuspend accounts, override an account's quotas and set who may sign up.
 * Sessions only (no personal access tokens); everyone else gets 403.
 *
 *   GET   /operator/accounts?text=&cursor=          {accounts: OperatorAccount[], cursor}
 *   POST  /operator/accounts/:id/suspend {reason?}  {account}: sessions and sign-in codes end, open sockets close
 *   POST  /operator/accounts/:id/unsuspend          {account}
 *   PUT   /operator/accounts/:id/quota {kind, limit: number | null}   {account}: null goes back to the default (POST too:
 *                                                   the apps' account channel has no PUT)
 *   GET   /operator/settings                        OperatorSettings
 *   PATCH /operator/settings {signupMode?, allow?: email, disallow?: email}   OperatorSettings
 *   GET | PATCH /operator/spend-guard, POST /operator/spend-guard/check   the spend guard (guard/check.ts, §17.1)
 *   GET /operator/storage, POST /operator/storage/migrate-next   old rows to R2 (storage/migrate.ts, docs/cloud.md §1)
 */
import { ACCOUNT_QUOTA_KINDS, MAX_QUOTA_OVERRIDE, QUOTA_LIMITS, SIGNUP_MODES, isAccountQuotaKind, type OperatorAccount, type OperatorSettings, type SignupMode } from "../../../src/shared/quota";
import type { Deps } from "../api";
import { normalizeEmail, parseOverrides, type User } from "../db";
import { body, EMAIL, HttpError, json, nextCursor, paging } from "../org/http";
import { isOperatorEmail, serverStoredBytes, signupMode } from "./quota";

interface AccountRow {
  id: string;
  email: string;
  name: string | null;
  created_at: number;
  last_seen_at: number;
  suspended_at: number | null;
  suspended_reason: string | null;
  quota_overrides: string;
  stored_bytes: number;
  files: number;
  previews: number;
  orgs: number;
}

const ACCOUNT_SQL = `SELECT u.id, u.email, u.name, u.created_at, u.last_seen_at, u.suspended_at, u.suspended_reason, u.quota_overrides, u.stored_bytes,
  (SELECT COUNT(*) FROM files f WHERE f.owner_id = u.id) AS files,
  (SELECT COUNT(*) FROM previews p WHERE p.owner_id = u.id AND (p.expires_at IS NULL OR p.expires_at > ?1)) AS previews,
  (SELECT COUNT(*) FROM orgs o WHERE o.created_by = u.id) AS orgs
  FROM users u`;

export async function operatorRoute(req: Request, url: URL, deps: Deps, user: User, parts: string[]): Promise<Response> {
  if (!isOperatorEmail(deps, user.email)) throw new HttpError(403, "Only the operator of this server can do this.", "forbidden");
  // The spend guard (docs/multiplayer.md §17.1): usage, mode, thresholds, the server's storage cap
  if (parts[1] === "spend-guard") return (await import("../guard/check")).spendGuardRoute(req, deps, user, parts);
  // Moving old rows to R2 (docs/cloud.md §1): progress and the operator's loop
  if (parts[1] === "storage") return (await import("../storage/migrate")).storageRoute(req, deps, user, parts);
  const d1 = deps.db.d1;
  const m = req.method;
  const toAccount = (r: AccountRow): OperatorAccount => ({
    id: r.id,
    email: r.email,
    name: r.name,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
    suspendedAt: r.suspended_at,
    suspendedReason: r.suspended_reason,
    operator: isOperatorEmail(deps, r.email),
    sharedFiles: r.files,
    storageBytes: r.stored_bytes,
    previews: r.previews,
    orgsCreated: r.orgs,
    overrides: parseOverrides(r.quota_overrides),
  });
  const account = async (id: string) => {
    const r = await d1.prepare(`${ACCOUNT_SQL} WHERE u.id = ?2 AND u.google_sub NOT LIKE 'deleted:%'`).bind(deps.now(), id).first<AccountRow>();
    if (!r) throw new HttpError(404, "no such account");
    return r;
  };

  if (parts[1] === "accounts") {
    if (parts.length === 2 && m === "GET") {
      const { offset, limit } = paging(url);
      const text = (url.searchParams.get("text") ?? "").trim().toLowerCase().slice(0, 200);
      const where = `WHERE u.google_sub NOT LIKE 'deleted:%' AND (?2 = '' OR instr(lower(u.email), ?2) > 0 OR instr(lower(COALESCE(u.name, '')), ?2) > 0)`;
      const total = (await d1.prepare(`SELECT COUNT(*) AS n FROM users u ${where.replace(/\?2/g, "?1")}`).bind(text).first<{ n: number }>())?.n ?? 0;
      const { results } = await d1.prepare(`${ACCOUNT_SQL} ${where} ORDER BY u.created_at DESC, u.id LIMIT ?3 OFFSET ?4`).bind(deps.now(), text, limit, offset).all<AccountRow>();
      return json({ accounts: results.map(toAccount), cursor: nextCursor(offset, limit, total) });
    }
    if (parts.length === 4 && m === "POST" && (parts[3] === "suspend" || parts[3] === "unsuspend")) {
      const target = await account(parts[2]);
      if (parts[3] === "suspend") {
        if (isOperatorEmail(deps, target.email)) throw new HttpError(400, "An operator's account can't be suspended.");
        const b = await body<{ reason?: unknown }>(req).catch(() => ({}) as { reason?: unknown });
        const reason = typeof b.reason === "string" ? b.reason.trim().slice(0, 500) || null : null;
        await suspend(deps, target.id, reason);
      } else await d1.prepare(`UPDATE users SET suspended_at = NULL, suspended_reason = NULL WHERE id = ?1`).bind(target.id).run();
      return json({ account: toAccount(await account(target.id)) });
    }
    if (parts.length === 4 && parts[3] === "quota" && (m === "PUT" || m === "POST")) {
      const target = await account(parts[2]);
      const b = await body<{ kind?: unknown; limit?: unknown }>(req);
      if (!isAccountQuotaKind(b.kind)) throw new HttpError(400, `kind is one of ${ACCOUNT_QUOTA_KINDS.join(", ")}`);
      const limit = b.limit;
      if (limit !== null && (typeof limit !== "number" || !Number.isInteger(limit) || limit < 0 || limit > MAX_QUOTA_OVERRIDE)) throw new HttpError(400, "limit is a whole number of 0 or more, or null for the default");
      const overrides = parseOverrides(target.quota_overrides);
      if (limit === null) delete overrides[b.kind];
      else overrides[b.kind] = limit;
      await d1.prepare(`UPDATE users SET quota_overrides = ?2 WHERE id = ?1`).bind(target.id, JSON.stringify(overrides)).run();
      return json({ account: toAccount(await account(target.id)) });
    }
    throw new HttpError(404, "not found");
  }

  if (parts[1] === "settings" && parts.length === 2) {
    if (m === "PATCH") {
      const b = await body<{ signupMode?: unknown; allow?: unknown; disallow?: unknown }>(req);
      if (b.signupMode !== undefined) {
        if (!SIGNUP_MODES.includes(b.signupMode as SignupMode)) throw new HttpError(400, "signupMode is open, invite or closed");
        await d1
          .prepare(`INSERT INTO server_settings (k, v, updated_at, updated_by) VALUES ('signup_mode', ?1, ?2, ?3) ON CONFLICT (k) DO UPDATE SET v = ?1, updated_at = ?2, updated_by = ?3`)
          .bind(b.signupMode, deps.now(), user.id)
          .run();
      }
      for (const [key, add] of [["allow", true], ["disallow", false]] as const) {
        const v = b[key];
        if (v === undefined) continue;
        const email = typeof v === "string" ? normalizeEmail(v) : "";
        if (!EMAIL.test(email) || email.length > 254) throw new HttpError(400, `${key} is an email`);
        if (add) await d1.prepare(`INSERT INTO signup_allowlist (email, added_by, created_at) VALUES (?1, ?2, ?3) ON CONFLICT (email) DO NOTHING`).bind(email, user.id, deps.now()).run();
        else await d1.prepare(`DELETE FROM signup_allowlist WHERE email = ?1`).bind(email).run();
      }
    } else if (m !== "GET") throw new HttpError(405, "method not allowed");
    const { results } = await d1.prepare(`SELECT email FROM signup_allowlist ORDER BY email LIMIT 1000`).all<{ email: string }>();
    const accounts = (await d1.prepare(`SELECT COUNT(*) AS n FROM users WHERE google_sub NOT LIKE 'deleted:%'`).first<{ n: number }>())?.n ?? 0;
    const settings: OperatorSettings = { signupMode: await signupMode(d1), allowlist: results.map((r) => r.email), defaults: { ...QUOTA_LIMITS }, serverStorageBytes: await serverStoredBytes(d1), accounts };
    return json(settings);
  }
  throw new HttpError(404, "not found");
}

/**
 * Suspends an account: every route refuses it from now on (403 `account_suspended`), its sessions and pending sign-in
 * codes end, its open sockets in the files it owns or was invited to close (they don't come back: the upgrade is
 * refused). Its data stays; its previews and embeds stop being served.
 */
export async function suspend(deps: Deps, userId: string, reason: string | null): Promise<void> {
  const d1 = deps.db.d1;
  await d1.prepare(`UPDATE users SET suspended_at = ?2, suspended_reason = ?3 WHERE id = ?1`).bind(userId, deps.now(), reason).run();
  await deps.db.bumpTokenVersion(userId);
  await d1.prepare(`DELETE FROM auth_codes WHERE user_id = ?1`).bind(userId).run();
  const { results } = await d1
    .prepare(`SELECT key FROM files WHERE owner_id = ?1 UNION SELECT file_key AS key FROM members WHERE user_id = ?1 LIMIT 1000`)
    .bind(userId)
    .all<{ key: string }>();
  for (const { key } of results) await deps.rooms.fetch(key, "/room/revoke", { method: "POST", body: JSON.stringify({ userId }) });
}
