/**
 * Guest expiration (docs/governance.md §1, §2.13): `org_members.expires_at`, set when a guest joins (now +
 * `guestExpiryDays`), changed per guest or in bulk by admins, enforced lazily (an expired guest isn't a member:
 * `Access.membership`, `GET /orgs`) and removed by the daily cron (`org_user_delete {reason: "guest_expired"}`).
 * Only with the add-on: without it the dates are kept and nothing expires.
 */
import { GUEST_EXPIRY_MAX_DAYS } from "../../../src/shared/org/governance";
import { logActivity, userEntity } from "../activity";
import type { Deps } from "../api";
import type { D1Like } from "../db";
import { settingsOf } from "../org/db";
import { body, HttpError, noContent, placeholders, type Ctx } from "../org/http";
import { removeFromOrg } from "../org/orgs";
import { orgNotice } from "../notifications";

/** `expires_at` for a guest joining now: null without the add-on or a default duration */
export async function guestExpiryOnJoin(d1: D1Like, orgId: string, now: number): Promise<number | null> {
  const o = await d1.prepare(`SELECT governance_plus, settings FROM orgs WHERE id = ?1`).bind(orgId).first<{ governance_plus: number; settings: string }>();
  if (!o?.governance_plus) return null;
  const days = settingsOf(o).guestExpiryDays;
  return typeof days === "number" && days >= 1 && days <= GUEST_EXPIRY_MAX_DAYS ? now + days * 86_400_000 : null;
}

/**
 * `PUT admin/guests/expiration {userIds, expiresAt | null}` (People › Guest access expiration date › Change, Remove
 * expiration date, the bulk "Set guest expiration date"): guests only; org admins, and workspace admins for guests in
 * their workspaces. Each change logs `org_user_guest_expiration_change`.
 */
export async function setGuestExpiration(ctx: Ctx, orgId: string, scope: { org: boolean; workspaces: string[] }): Promise<Response> {
  const { deps, user } = ctx;
  const d1 = deps.db.d1;
  const b = await body<{ userIds?: unknown; expiresAt?: unknown }>(ctx.req);
  const ids = Array.isArray(b.userIds) ? [...new Set(b.userIds.filter((x): x is string => typeof x === "string"))].slice(0, 500) : [];
  if (!ids.length) throw new HttpError(400, "userIds", "invalid", { field: "userIds" });
  const at = b.expiresAt;
  const now = deps.now();
  if (at !== null && (typeof at !== "number" || !Number.isFinite(at) || at <= now || at > now + GUEST_EXPIRY_MAX_DAYS * 86_400_000)) throw new HttpError(400, "expiresAt is a future time (ms) or null", "invalid", { field: "expiresAt" });
  const { results } = await d1
    .prepare(`SELECT m.email, m.user_id, m.role, m.workspace_id, m.expires_at, u.name FROM org_members m LEFT JOIN users u ON u.id = m.user_id WHERE m.org_id = ?1 AND (m.user_id IN (${placeholders(ids.length, 2)}) OR (m.user_id IS NULL AND m.email IN (${placeholders(ids.length, 2 + ids.length)})))`)
    .bind(orgId, ...ids, ...ids)
    .all<{ email: string; user_id: string | null; role: string; workspace_id: string | null; expires_at: number | null; name: string | null }>();
  if (results.length !== ids.length) throw new HttpError(404, "someone isn't in the organization");
  for (const r of results) {
    if (r.role !== "guest") throw new HttpError(400, `${r.email} isn't a guest`, "invalid", { field: "userIds" });
    if (!scope.org && !(r.workspace_id && scope.workspaces.includes(r.workspace_id))) throw new HttpError(403, "outside your admin reach", "not_admin");
  }
  for (const r of results) {
    if (r.expires_at === at) continue;
    await d1.prepare(`UPDATE org_members SET expires_at = ?3 WHERE org_id = ?1 AND email = ?2`).bind(orgId, r.email, at).run();
    await logActivity(deps, { orgId, action: "org_user_guest_expiration_change", actor: user, entity: userEntity({ id: r.user_id ?? r.email, email: r.email, name: r.name }), details: { from: r.expires_at, to: at }, req: ctx.req });
  }
  const told = results.map((r) => r.user_id).filter((x): x is string => !!x);
  if (told.length) await orgNotice(deps, told, { what: "orgs" });
  return noContent();
}

/** The daily cron (index.ts): guests whose access ended are removed (§14.7) — with the add-on only. */
export async function sweepExpiredGuests(deps: Deps): Promise<number> {
  const d1 = deps.db.d1;
  const now = deps.now();
  const { results } = await d1
    .prepare(
      `SELECT m.org_id, m.user_id, m.email FROM org_members m JOIN orgs o ON o.id = m.org_id
       WHERE m.expires_at IS NOT NULL AND m.expires_at <= ?1 AND m.role = 'guest' AND o.governance_plus = 1 LIMIT 500`,
    )
    .bind(now)
    .all<{ org_id: string; user_id: string | null; email: string }>();
  let n = 0;
  for (const r of results) {
    try {
      if (r.user_id) {
        if (await removeFromOrg(deps, r.org_id, r.user_id, null, null, { reason: "guest_expired" })) n++;
      } else {
        // A pending invite (no account yet): its row goes, logged the same way.
        await d1.prepare(`DELETE FROM org_members WHERE org_id = ?1 AND email = ?2 AND user_id IS NULL`).bind(r.org_id, r.email).run();
        await logActivity(deps, { orgId: r.org_id, action: "org_user_delete", actor: null, entity: userEntity({ id: r.email, email: r.email, name: null }), details: { role: "guest", reason: "guest_expired" } });
        n++;
      }
    } catch (e) {
      console.error("guest expiry: not removed", r.org_id, r.user_id ?? r.email, e);
    }
  }
  return n;
}
