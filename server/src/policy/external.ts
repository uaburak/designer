/**
 * Access to external content (docs/multiplayer.md §15.6 `externalContent`, §15.9) [F-external]: a person's **home
 * org** is the org whose verified domain matches their email, with domain capture on and the person a member or admin
 * there. When that org restricts external content, the person can't create or join anything outside it (403
 * `external_restricted`), and `resolveAccess` caps what they open elsewhere to view-only (`capped: "external"`).
 *
 * The "external" activity events [F-log] are written here too: in the home org, when a captured member views or joins
 * another org's content.
 */
import { emailDomain } from "../../../src/shared/org/identity";
import type { ActivityAction } from "../../../src/shared/org/types";
import { logActivity, type Entity } from "../activity";
import type { Deps } from "../api";
import type { D1Like, User } from "../db";
import type { Query } from "../requestD1";
import { settingsOf } from "../org/db";
import { HttpError } from "../org/http";

export interface HomeOrg {
  orgId: string;
  name: string;
  /** The home org's `externalContent` is "restricted" */
  restricted: boolean;
}

/** `homeOrgOf`'s read (null: an email without a domain needs none) — prefetched by Access.prefetchFile */
export function homeOrgQ(user: { id: string; email: string }): Query | null {
  const domain = emailDomain(user.email);
  if (!domain) return null;
  return {
    sql: `SELECT o.id, o.name, o.settings FROM org_domains d JOIN orgs o ON o.id = d.org_id
       JOIN org_members m ON m.org_id = o.id AND m.user_id = ?1 AND m.role IN ('admin', 'member')
       WHERE d.domain = ?2 AND d.verified_at IS NOT NULL AND o.deleted_at IS NULL`,
    args: [user.id, domain],
  };
}

/** The person's home org (null: none — no verified domain of theirs with capture on, or not a member there) */
export async function homeOrgOf(d1: D1Like, user: { id: string; email: string }): Promise<HomeOrg | null> {
  const q = homeOrgQ(user);
  if (!q) return null;
  const { results } = await d1
    .prepare(q.sql)
    .bind(...q.args)
    .all<{ id: string; name: string; settings: string }>();
  for (const r of results) {
    const s = settingsOf(r);
    if (s.domainCapture) return { orgId: r.id, name: r.name, restricted: s.externalContent === "restricted" };
  }
  return null;
}

/** Refuses an action that would put the person into (or create) content outside their restricting home org. */
export function requireInside(home: HomeOrg | null, orgId: string | null, what = "do that"): void {
  if (home?.restricted && orgId !== home.orgId) throw new HttpError(403, `${home.name} only allows you to ${what} in ${home.name}`, "external_restricted", { homeOrgId: home.orgId });
}

/**
 * An external event in the person's home org (when captured and different from the content's org): Figma's
 * `fig_file_view_external`, `org_user_create_external`, `team_member_add_external`… — "Only logged for Enterprise
 * organizations with Domain Capture enabled" [F-log].
 */
export async function logExternal(deps: Deps, person: { id: string; email: string; name: string | null }, contentOrgId: string, action: ActivityAction, entity: Entity, opts: { actor?: Pick<User, "id" | "email" | "name"> | null; details?: Record<string, unknown>; req?: Request | null; home?: HomeOrg | null } = {}): Promise<void> {
  try {
    const home = opts.home !== undefined ? opts.home : await homeOrgOf(deps.db.d1, person);
    if (!home || home.orgId === contentOrgId) return;
    await logActivity(deps, { orgId: home.orgId, action, actor: opts.actor === undefined ? person : opts.actor, entity, details: { ...(opts.details ?? {}), external_org_id: contentOrgId }, req: opts.req });
  } catch (e) {
    console.error("activity: external event not logged", action, e);
  }
}

/** A person by id (for `logExternal` when only the id is known) */
export async function personById(d1: D1Like, id: string | null): Promise<{ id: string; email: string; name: string | null } | null> {
  if (!id) return null;
  return d1.prepare(`SELECT id, email, name FROM users WHERE id = ?1`).bind(id).first();
}
