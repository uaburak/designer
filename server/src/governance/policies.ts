/**
 * Internal policies (docs/governance.md §1, §2.6): created by org admins (ours: self-serve; Figma through Support),
 * enabled or disabled, never edited — editing is disabling and creating a new one, so people agree again. Everyone the
 * audience names agrees once, or once a year (365 days after their last agreement), before they open anything in the
 * org (the `policy` gate, gate.ts).
 */
import { POLICY_AUDIENCE_LABEL, POLICY_CADENCE_LABEL, POLICY_TEXT_MAX, POLICY_TITLE_MAX, policyApplies, type InternalPolicy, type PolicyAudience, type PolicyCadence, type PolicyPrompt } from "../../../src/shared/org/governance";
import type { OrgRole } from "../../../src/shared/org/types";
import { logActivity, policyEntity } from "../activity";
import type { Deps } from "../api";
import type { User } from "../db";
import { personRef } from "../org/db";
import { body, HttpError, json, noContent, randomId, type Ctx } from "../org/http";
import { gateCols, pendingPolicyIds, policyPrompts, type GateRow } from "./gate";

interface PolicyRow {
  id: string;
  title: string;
  text: string;
  audience: PolicyAudience;
  cadence: PolicyCadence;
  enabled_at: number | null;
  disabled_at: number | null;
  created_by: string | null;
  created_at: number;
  u_email: string | null;
  u_name: string | null;
  u_picture: string | null;
  u_role: OrgRole | null;
  acks: number;
}

const toPolicy = (r: PolicyRow): InternalPolicy => ({
  id: r.id,
  title: r.title,
  text: r.text,
  audience: r.audience,
  cadence: r.cadence,
  enabledAt: r.enabled_at,
  disabledAt: r.disabled_at,
  createdBy: r.created_by && r.u_email ? personRef({ id: r.created_by, email: r.u_email, name: r.u_name, picture: r.u_picture, role: r.u_role }) : null,
  createdAt: r.created_at,
  acknowledgedCount: r.acks ?? 0,
});

export async function policiesOf(deps: Deps, orgId: string, id?: string): Promise<InternalPolicy[]> {
  const { results } = await deps.db.d1
    .prepare(
      `SELECT p.*, u.email AS u_email, u.name AS u_name, u.picture AS u_picture, m.role AS u_role, (SELECT COUNT(*) FROM policy_acknowledgements a WHERE a.policy_id = p.id) AS acks
       FROM org_policies p LEFT JOIN users u ON u.id = p.created_by LEFT JOIN org_members m ON m.org_id = p.org_id AND m.user_id = p.created_by
       WHERE p.org_id = ?1 ${id ? "AND p.id = ?2" : ""} ORDER BY p.created_at DESC, p.id`,
    )
    .bind(orgId, ...(id ? [id] : []))
    .all<PolicyRow>();
  return results.map(toPolicy);
}

/** `GET|POST admin/policies`, `PATCH admin/policies/:id {enabled}` (org admins, with the add-on) */
export async function adminPoliciesRoute(ctx: Ctx, orgId: string, rest: string[]): Promise<Response> {
  const { deps, user, m } = ctx;
  const d1 = deps.db.d1;
  if (!rest.length && m === "GET") return json({ policies: await policiesOf(deps, orgId) });
  if (!rest.length && m === "POST") {
    const b = await body<{ title?: unknown; text?: unknown; audience?: unknown; cadence?: unknown }>(ctx.req);
    const title = typeof b.title === "string" ? b.title.trim() : "";
    const text = typeof b.text === "string" ? b.text.trim() : "";
    if (!title || title.length > POLICY_TITLE_MAX) throw new HttpError(400, `the title is 1–${POLICY_TITLE_MAX} characters`, "invalid", { field: "title" });
    if (!text || text.length > POLICY_TEXT_MAX) throw new HttpError(400, `the text is 1–${POLICY_TEXT_MAX} characters`, "invalid", { field: "text" });
    if (typeof b.audience !== "string" || !(b.audience in POLICY_AUDIENCE_LABEL)) throw new HttpError(400, "audience is members, guests or everyone", "invalid", { field: "audience" });
    if (typeof b.cadence !== "string" || !(b.cadence in POLICY_CADENCE_LABEL)) throw new HttpError(400, "cadence is yearly or once", "invalid", { field: "cadence" });
    const id = randomId();
    const now = deps.now();
    // Created enabled (Figma enables a policy when it is set up)
    await d1
      .prepare(`INSERT INTO org_policies (id, org_id, title, text, audience, cadence, enabled_at, created_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?7)`)
      .bind(id, orgId, title, text, b.audience, b.cadence, now, user.id)
      .run();
    const row = { id, title, audience: b.audience, cadence: b.cadence, enabled_at: now, disabled_at: null };
    await logActivity(deps, { orgId, action: "policy_create", actor: user, entity: policyEntity(row), req: ctx.req });
    return json({ policy: (await policiesOf(deps, orgId, id))[0] }, 201);
  }
  const p = rest.length === 1 ? await d1.prepare(`SELECT * FROM org_policies WHERE id = ?1 AND org_id = ?2`).bind(rest[0], orgId).first<PolicyRow>() : null;
  if (!p) throw new HttpError(404, "no such policy");
  if (m === "PATCH") {
    const b = await body<{ enabled?: unknown; title?: unknown; text?: unknown; audience?: unknown; cadence?: unknown }>(ctx.req);
    if (b.title !== undefined || b.text !== undefined || b.audience !== undefined || b.cadence !== undefined) throw new HttpError(400, "a policy can't be edited: turn it off and create a new one", "invalid");
    if (typeof b.enabled !== "boolean") throw new HttpError(400, "enabled is true or false", "invalid", { field: "enabled" });
    const on = p.enabled_at !== null && p.disabled_at === null;
    if (b.enabled !== on) {
      const now = deps.now();
      if (b.enabled) await d1.prepare(`UPDATE org_policies SET enabled_at = ?2, disabled_at = NULL WHERE id = ?1`).bind(p.id, now).run();
      else await d1.prepare(`UPDATE org_policies SET disabled_at = ?2 WHERE id = ?1`).bind(p.id, now).run();
      const after = b.enabled ? { ...p, enabled_at: now, disabled_at: null } : { ...p, disabled_at: now };
      await logActivity(deps, { orgId, action: "policy_update", actor: user, entity: policyEntity(after), details: { enabled: b.enabled }, req: ctx.req });
    }
    return json({ policy: (await policiesOf(deps, orgId, p.id))[0] });
  }
  throw new HttpError(405, "method not allowed");
}

/** The caller's policies to agree to in the org (none without the add-on) */
export async function pendingFor(deps: Deps, orgId: string, user: Pick<User, "id">, role: OrgRole): Promise<PolicyPrompt[]> {
  const row = await deps.db.d1.prepare(`SELECT ${gateCols("?2")} FROM orgs o WHERE o.id = ?1`).bind(orgId, user.id).first<GateRow>();
  if (!row?.g_plus) return [];
  return policyPrompts(deps, pendingPolicyIds(row, role, deps.now()));
}

/**
 * The members' routes (`GET /orgs/:org/policies/pending` → `{policies}`, `POST /orgs/:org/policies/:id/acknowledge` →
 * 204, logged `policy_acknowledge`). They are open while the caller is gated (the modal calls them).
 */
export async function memberPoliciesRoute(ctx: Ctx, orgId: string): Promise<Response> {
  const { deps, user, m, parts, acc } = ctx;
  const me = await acc.requireMember(orgId, { guests: true, gate: false });
  if (parts.length === 4 && parts[3] === "pending" && m === "GET") return json({ policies: await pendingFor(deps, orgId, user, me.role) });
  if (parts.length === 5 && parts[4] === "acknowledge" && m === "POST") {
    const org = await acc.org(orgId);
    if (!org?.governance_plus) throw new HttpError(403, "Requires Governance+", "governance_plus_required");
    const p = await deps.db.d1.prepare(`SELECT * FROM org_policies WHERE id = ?1 AND org_id = ?2`).bind(parts[3], orgId).first<PolicyRow>();
    if (!p || p.enabled_at === null || p.disabled_at !== null || !policyApplies(p, me.role)) throw new HttpError(404, "no such policy");
    await deps.db.d1
      .prepare(`INSERT INTO policy_acknowledgements (policy_id, user_id, at) VALUES (?1, ?2, ?3) ON CONFLICT (policy_id, user_id) DO UPDATE SET at = excluded.at`)
      .bind(p.id, user.id, deps.now())
      .run();
    await logActivity(deps, { orgId, action: "policy_acknowledge", actor: user, entity: policyEntity(p), req: ctx.req });
    acc.reset();
    return noContent();
  }
  throw new HttpError(404, "not found");
}
