/**
 * Governance+ org gates (docs/governance.md §2.5): a guest without 2FA when "2FA for Guests" is on, an internal policy
 * to agree to, an IP outside the allowlist — in that order. Only with the add-on; null otherwise. The network
 * restriction (account-wide) is 14a's, in `network.ts`.
 *
 * Performance (hot path): the gate's rows come in **one** D1 query — `gateCols` are scalar subqueries behind
 * `CASE WHEN o.governance_plus = 1`, so SQLite skips them for orgs without the add-on, and the same columns ride in
 * `GET /orgs`'s summaries query (one query for all orgs). `Access.gate` (org/db.ts) runs nothing when the org row it
 * already read says the add-on is off. A second query runs only when a gate actually blocks (the policies' texts, the
 * hourly `ip_allowlist_rejected`).
 *
 * Call sites: `Access.requireMember` / `requireTeam` (every org route, the admin routes), the folder and group routes,
 * `/files/:key/…` of an org file and its socket upgrade (api.ts), `GET /orgs` (`OrgSummary.gate`).
 */
import type { Deps } from "../api";
import type { User } from "../db";
import { needsAcknowledgement, policyApplies, type OrgGate, type PolicyAudience, type PolicyCadence, type PolicyPrompt } from "../../../src/shared/org/governance";
import type { OrgRole } from "../../../src/shared/org/types";
import { HttpError, placeholders } from "../org/http";
import { callerIp, inAllowlist, logIpRejected } from "./ip";

/** The gate's columns over `orgs o` for the user bound at `uid` (e.g. "?2"): NULL when the org has no add-on */
export const gateCols = (uid: string): string => `o.governance_plus AS g_plus,
  CASE WHEN o.governance_plus = 1 THEN (SELECT t.enabled_at FROM user_two_factor t WHERE t.user_id = ${uid} AND t.enabled_at IS NOT NULL) END AS g_tf,
  CASE WHEN o.governance_plus = 1 THEN (SELECT json_group_array(r.cidr) FROM org_ip_ranges r WHERE r.org_id = o.id AND r.kind = 'allowlist' AND r.state = 'enforced') END AS g_ranges,
  CASE WHEN o.governance_plus = 1 THEN (SELECT json_group_array(json_array(p.id, p.cadence, p.audience, (SELECT a.at FROM policy_acknowledgements a WHERE a.policy_id = p.id AND a.user_id = ${uid})))
    FROM org_policies p WHERE p.org_id = o.id AND p.enabled_at IS NOT NULL AND p.disabled_at IS NULL) END AS g_policies`;

export interface GateRow {
  g_plus: number;
  g_tf: number | null;
  g_ranges: string | null;
  g_policies: string | null;
}

export interface GateInput {
  orgId: string;
  /** `orgs.settings` (JSON) */
  settings: string;
  role: OrgRole;
  user: Pick<User, "id" | "email" | "name">;
  /** null: no request (an internal call) — the IP allowlist isn't checked */
  req: Request | null;
  row: GateRow;
}

const parse = <T>(s: string | null): T[] => {
  if (!s) return [];
  try {
    const v = JSON.parse(s) as unknown;
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
};

const twoFactorForGuests = (settings: string): boolean => {
  try {
    return (JSON.parse(settings) as { twoFactorForGuests?: unknown }).twoFactorForGuests === true;
  } catch {
    return false;
  }
};

/** The ids of enabled policies this role must agree to now (from `g_policies`) */
export function pendingPolicyIds(row: Pick<GateRow, "g_policies">, role: OrgRole, now: number): string[] {
  return parse<[string, PolicyCadence, PolicyAudience, number | null]>(row.g_policies)
    .filter(([, cadence, audience, at]) => policyApplies({ audience }, role) && needsAcknowledgement({ cadence }, at ?? null, now))
    .map(([id]) => id);
}

/** What the modal shows, oldest enabled first */
export async function policyPrompts(deps: Deps, ids: string[]): Promise<PolicyPrompt[]> {
  if (!ids.length) return [];
  const { results } = await deps.db.d1.prepare(`SELECT id, title, text FROM org_policies WHERE id IN (${placeholders(ids.length)}) ORDER BY enabled_at, id`).bind(...ids).all<PolicyPrompt>();
  return results.map((r) => ({ id: r.id, title: r.title, text: r.text }));
}

/** The gate from its row (§2.5's order: 2FA for guests, policies, the IP allowlist). */
export async function gateFor(deps: Deps, g: GateInput): Promise<OrgGate | null> {
  if (!g.row.g_plus) return null;
  if (g.role === "guest" && g.row.g_tf === null && twoFactorForGuests(g.settings)) return { kind: "two_factor" };
  const pending = pendingPolicyIds(g.row, g.role, deps.now());
  if (pending.length) return { kind: "policy", policies: await policyPrompts(deps, pending) };
  // Members only: admins and guests are exempt (Figma) [G+]
  if (g.role === "member") {
    const ip = callerIp(g.req);
    const ranges = parse<string>(g.row.g_ranges);
    if (ip && ranges.length && !inAllowlist(ip, ranges)) {
      await logIpRejected(deps, g.orgId, g.user, ip, g.req);
      return { kind: "ip", ip };
    }
  }
  return null;
}

/** The block on `user` in `orgId` for this request, or null. Null whenever the org hasn't Governance+, or the user isn't
 *  in it (people reaching a file by its link from outside aren't gated). One D1 query. */
export async function orgGate(deps: Deps, user: User, orgId: string, req: Request | null): Promise<OrgGate | null> {
  const row = await deps.db.d1
    .prepare(
      `SELECT o.settings, m.role, ${gateCols("?2")} FROM orgs o JOIN org_members m ON m.org_id = o.id AND m.user_id = ?2
       WHERE o.id = ?1 AND (m.expires_at IS NULL OR o.governance_plus = 0 OR m.expires_at > ?3)`,
    )
    .bind(orgId, user.id, deps.now())
    .first<GateRow & { settings: string; role: OrgRole }>();
  if (!row) return null;
  return gateFor(deps, { orgId, settings: row.settings, role: row.role, user, req, row });
}

/** 403 `{error, code, gate}` (§2.5) */
export function gateError(gate: OrgGate, orgName: string): HttpError {
  const name = orgName || "This organization";
  if (gate.kind === "two_factor") return new HttpError(403, `${name} requires two-factor authentication for guests.`, "two_factor_required", { gate });
  if (gate.kind === "policy") return new HttpError(403, `Agree to ${name}'s policies to continue.`, "policy_acknowledgement_required", { gate });
  return new HttpError(403, `${name} only allows access from approved networks.`, "ip_not_allowed", { gate });
}
