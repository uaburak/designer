/**
 * People made or found by SAML JIT, SCIM and domain capture (docs/multiplayer.md §15.2 decision 5, §15.3.4 step 7,
 * §15.5, §15.7): one account per email — a new one gets the `none:<id>` placeholder for `google_sub` until a Google
 * sign-in with that verified email claims it — and their membership of an org.
 */
import type { OrgRole, Seat } from "../../../src/shared/org/types";
import { logActivity, userEntity } from "../activity";
import type { Deps } from "../api";
import { normalizeEmail, type User } from "../db";
import { orgNotice } from "../notifications";
import type { MemberRow } from "../org/db";
import { orgFileKeys, reauth } from "../org/reauth";
import { randomToken } from "../tokens";

interface UserRow {
  id: string;
  email: string;
  name: string | null;
  picture: string | null;
  token_version: number;
}
const toUser = (r: UserRow): User => ({ id: r.id, email: r.email, name: r.name, picture: r.picture, tokenVersion: r.token_version });

/** The account with this email (the most recently seen, decision 5), or null */
export async function accountByEmail(deps: Deps, email: string): Promise<User | null> {
  const r = await deps.db.d1
    .prepare(`SELECT id, email, name, picture, token_version FROM users WHERE email = ?1 AND google_sub NOT LIKE 'deleted:%' ORDER BY last_seen_at DESC LIMIT 1`)
    .bind(normalizeEmail(email))
    .first<UserRow>();
  return r ? toUser(r) : null;
}

/** The account with this email, or a new one (`google_sub = 'none:' || id`) */
export async function accountForEmail(deps: Deps, email: string, name: string | null): Promise<{ user: User; created: boolean }> {
  const had = await accountByEmail(deps, email);
  if (had) return { user: had, created: false };
  const id = `u_${randomToken(12)}`;
  const r = await deps.db.d1
    .prepare(`INSERT INTO users (id, google_sub, email, name, created_at, last_seen_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5) RETURNING id, email, name, picture, token_version`)
    .bind(id, `none:${id}`, normalizeEmail(email), name, deps.now())
    .first<UserRow>();
  return { user: toUser(r!), created: true };
}

/** A new name from the IdP, unless the person set their own (`name_locked`) */
export async function setNameFromIdp(deps: Deps, userId: string, name: string | null): Promise<void> {
  if (name) await deps.db.d1.prepare(`UPDATE users SET name = ?2 WHERE id = ?1 AND name_locked = 0`).bind(userId, name).run();
}

/** The person's row in the org: theirs, or a pending invite to their email (claimed) */
export async function memberRow(deps: Deps, orgId: string, user: Pick<User, "id" | "email">): Promise<MemberRow | null> {
  const d1 = deps.db.d1;
  const own = await d1.prepare(`SELECT * FROM org_members WHERE org_id = ?1 AND user_id = ?2`).bind(orgId, user.id).first<MemberRow>();
  if (own) return own;
  const pending = await d1.prepare(`SELECT * FROM org_members WHERE org_id = ?1 AND email = ?2 AND user_id IS NULL`).bind(orgId, user.email).first<MemberRow>();
  if (!pending) return null;
  await d1.prepare(`UPDATE org_members SET user_id = ?3 WHERE org_id = ?1 AND email = ?2`).bind(orgId, pending.email, user.id).run();
  return { ...pending, user_id: user.id };
}

export interface EnsureMember {
  /** The role a new or guest person gets ("member" unless SCIM's figmaAdmin) */
  role: Exclude<OrgRole, "guest">;
  seat: Seat;
  provisionedBy?: "scim" | "jit" | null;
  /** org_members.idp_attributes (merged) */
  attrs?: Record<string, unknown>;
  actor: User | null;
  req: Request | null;
  /** Extra details of the org_user_create event (`jit`, `domain_capture`, `scim`) */
  details?: Record<string, unknown>;
}

/**
 * Makes the account a member (or admin) of the org: added when not in it (logged `org_user_create`), a guest turned
 * member (logged `org_user_permission_change`). An existing member keeps their role and seat. Returns what happened.
 */
export async function ensureMember(deps: Deps, orgId: string, user: User, o: EnsureMember): Promise<"added" | "promoted" | "kept"> {
  const d1 = deps.db.d1;
  const now = deps.now();
  const row = await memberRow(deps, orgId, user);
  const attrs = o.attrs ? JSON.stringify(o.attrs) : null;
  if (!row) {
    await d1
      .prepare(`INSERT INTO org_members (org_id, email, user_id, role, seat, created_at, seat_changed_at, provisioned_by, idp_attributes) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7, COALESCE(?8, '{}'))`)
      .bind(orgId, normalizeEmail(user.email), user.id, o.role, o.seat, now, o.provisionedBy ?? null, attrs)
      .run();
    await logActivity(deps, { orgId, action: "org_user_create", actor: o.actor, entity: userEntity(user), details: { role: o.role, seat: o.seat, ...(o.details ?? {}) }, req: o.req });
    await orgNotice(deps, [user.id], { what: "orgs" });
    return "added";
  }
  if (o.provisionedBy !== undefined || attrs)
    await d1
      .prepare(`UPDATE org_members SET provisioned_by = COALESCE(?3, provisioned_by), idp_attributes = CASE WHEN ?4 IS NULL THEN idp_attributes ELSE json_patch(idp_attributes, ?4) END WHERE org_id = ?1 AND user_id = ?2`)
      .bind(orgId, user.id, o.provisionedBy ?? null, attrs)
      .run();
  if (row.role !== "guest") return "kept";
  await d1.prepare(`UPDATE org_members SET role = ?3 WHERE org_id = ?1 AND user_id = ?2`).bind(orgId, user.id, o.role).run();
  await logActivity(deps, { orgId, action: "org_user_permission_change", actor: o.actor, entity: userEntity(user), details: { from: "guest", to: o.role, ...(o.details ?? {}) }, req: o.req });
  await reauth(deps, await orgFileKeys(d1, orgId), [user.id]);
  await orgNotice(deps, [user.id], { what: "orgs" });
  return "promoted";
}

/** The org whose **verified** domain this is (a verified domain belongs to one org, decision 9) */
export async function verifiedDomainOrg(deps: Deps, domain: string): Promise<{ orgId: string; capture: boolean } | null> {
  const r = await deps.db.d1
    .prepare(`SELECT d.org_id, o.settings FROM org_domains d JOIN orgs o ON o.id = d.org_id WHERE d.domain = ?1 AND d.verified_at IS NOT NULL`)
    .bind(domain)
    .first<{ org_id: string; settings: string }>();
  if (!r) return null;
  let capture = false;
  try {
    capture = (JSON.parse(r.settings) as { domainCapture?: boolean }).domainCapture === true;
  } catch {
    // off
  }
  return { orgId: r.org_id, capture };
}
