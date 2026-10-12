/** `GET /me/usage` (docs/multiplayer.md §17): what the account uses of its quotas, its limits, and whether it operates the server */
import { ACCOUNT_QUOTA_KINDS, type AccountQuotaKind, type AccountUsage } from "../../../src/shared/quota";
import type { Deps } from "../api";
import type { User } from "../db";
import { isOperatorEmail, limitOf } from "./quota";

export async function accountUsage(deps: Deps, user: User): Promise<AccountUsage> {
  const r = await deps.db.d1
    .prepare(
      `SELECT u.stored_bytes, (SELECT COUNT(*) FROM files f WHERE f.owner_id = u.id) AS files,
         (SELECT COUNT(*) FROM previews p WHERE p.owner_id = u.id AND (p.expires_at IS NULL OR p.expires_at > ?2)) AS previews,
         (SELECT COUNT(*) FROM orgs o WHERE o.created_by = u.id) AS orgs
       FROM users u WHERE u.id = ?1`,
    )
    .bind(user.id, deps.now())
    .first<{ stored_bytes: number; files: number; previews: number; orgs: number }>();
  const limits = Object.fromEntries(ACCOUNT_QUOTA_KINDS.map((k) => [k, limitOf(user.quotas, k)])) as Record<AccountQuotaKind, number>;
  return {
    usage: { sharedFiles: r?.files ?? 0, storageBytes: r?.stored_bytes ?? 0, previews: r?.previews ?? 0, orgsCreated: r?.orgs ?? 0 },
    limits,
    operator: isOperatorEmail(deps, user.email),
  };
}
