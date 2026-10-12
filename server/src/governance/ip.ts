/**
 * The IP allowlist (docs/governance.md §1, §2.3) and network access restrictions' ranges (§2.2; the check itself is
 * 14a's `network.ts`). Both live in `org_ip_ranges` (`kind`). The allowlist has no switch of its own: it is on when its
 * ranges are `enforced`, off (kept) when they are `disabled`.
 */
import { forgetNetworkRanges } from "./network";
import { ipInCidr, normalizeCidr, NETWORK_TESTING_MIN_MS, type IpAllowlist, type IpRange, type NetworkRange, type NetworkRangeState } from "../../../src/shared/org/governance";
import type { Deps } from "../api";
import type { User } from "../db";
import { logActivity, logOncePer, orgEntity, userEntity } from "../activity";
import { body, HttpError, json, noContent, randomId, type Ctx } from "../org/http";
import { personRef } from "../org/db";
import type { OrgRole } from "../../../src/shared/org/types";

/** The caller's address as the Worker sees it (Cloudflare's `CF-Connecting-IP`), or null */
export const callerIp = (req: Request | null | undefined): string | null => req?.headers.get("cf-connecting-ip")?.trim() || null;

export const inAllowlist = (ip: string, cidrs: string[]): boolean => cidrs.some((c) => ipInCidr(ip, c));

/** `ip_allowlist_rejected` [F-log], at most once per person per hour (§3) */
export const IP_REJECTED_EVERY_MS = 3_600_000;
export async function logIpRejected(deps: Deps, orgId: string, user: Pick<User, "id" | "email" | "name">, ip: string, req: Request | null): Promise<void> {
  await logOncePer(deps, IP_REJECTED_EVERY_MS, { orgId, action: "ip_allowlist_rejected", actor: user, entity: userEntity(user), details: { ip_address: ip }, req });
}

/** At most this many ranges per list (ours) */
export const MAX_RANGES = 200;

interface RangeRow {
  id: string;
  cidr: string;
  state: NetworkRangeState;
  created_at: number;
  created_by: string | null;
  u_email: string | null;
  u_name: string | null;
  u_picture: string | null;
  u_role: OrgRole | null;
  would_block: number;
}

const RANGE_SELECT = `SELECT r.id, r.cidr, r.state, r.created_at, r.created_by, u.email AS u_email, u.name AS u_name, u.picture AS u_picture, m.role AS u_role`;
const RANGE_FROM = `FROM org_ip_ranges r LEFT JOIN users u ON u.id = r.created_by LEFT JOIN org_members m ON m.org_id = r.org_id AND m.user_id = r.created_by`;

const toRange = (r: RangeRow): IpRange => ({
  id: r.id,
  cidr: r.cidr,
  createdAt: r.created_at,
  createdBy: r.created_by && r.u_email ? personRef({ id: r.created_by, email: r.u_email, name: r.u_name, picture: r.u_picture, role: r.u_role }) : null,
});

export async function ipAllowlistOf(deps: Deps, orgId: string): Promise<IpAllowlist> {
  const { results } = await deps.db.d1.prepare(`${RANGE_SELECT}, 0 AS would_block ${RANGE_FROM} WHERE r.org_id = ?1 AND r.kind = 'allowlist' ORDER BY r.created_at, r.rowid`).bind(orgId).all<RangeRow>();
  return { enabled: results.some((r) => r.state === "enforced"), ranges: results.map(toRange) };
}

/** The day number of `network_shadow_hits.day` */
export const dayOf = (ms: number): number => Math.floor(ms / 86_400_000);

export async function networkRangesOf(deps: Deps, orgId: string, id?: string): Promise<NetworkRange[]> {
  const { results } = await deps.db.d1
    .prepare(
      `${RANGE_SELECT}, (SELECT COUNT(DISTINCT h.user_id) FROM network_shadow_hits h WHERE h.range_id = r.id AND h.day > ?2) AS would_block
       ${RANGE_FROM} WHERE r.org_id = ?1 AND r.kind = 'network' ${id ? "AND r.id = ?3" : ""} ORDER BY r.created_at, r.rowid`,
    )
    .bind(orgId, dayOf(deps.now()) - 7, ...(id ? [id] : []))
    .all<RangeRow>();
  return results.map((r) => ({ ...toRange(r), state: r.state, wouldBlock7d: r.would_block ?? 0 }));
}

/** `PUT admin/ip-allowlist {enabled, ranges}`: the list replaced, diffed into one log per range (§4) */
export async function setIpAllowlist(ctx: Ctx, orgId: string, input: { enabled?: unknown; ranges?: unknown }): Promise<IpAllowlist> {
  const { deps, user } = ctx;
  const d1 = deps.db.d1;
  if (typeof input.enabled !== "boolean") throw new HttpError(400, "enabled is true or false", "invalid", { field: "enabled" });
  if (!Array.isArray(input.ranges)) throw new HttpError(400, "ranges is a list of IP addresses and CIDR blocks", "invalid", { field: "ranges" });
  if (input.ranges.length > MAX_RANGES) throw new HttpError(400, `at most ${MAX_RANGES} ranges`, "invalid", { field: "ranges" });
  const wanted: string[] = [];
  for (const v of input.ranges) {
    const c = typeof v === "string" ? normalizeCidr(v, "allowlist") : null;
    if (!c) throw new HttpError(400, `${String(v)} isn't an IP address or CIDR block`, "invalid", { field: "ranges", value: v });
    if (!wanted.includes(c)) wanted.push(c);
  }
  if (input.enabled && !wanted.length) throw new HttpError(400, "add at least one IP address or range", "invalid", { field: "ranges" });
  // Figma's prerequisite: the org's domains are verified [G+]
  if (input.enabled) {
    const d = await d1.prepare(`SELECT COUNT(*) AS n, COUNT(verified_at) AS v FROM org_domains WHERE org_id = ?1`).bind(orgId).first<{ n: number; v: number }>();
    if (d && d.v !== d.n) throw new HttpError(409, "Verify every domain before turning on the IP allowlist", "domain_unverified", { field: "enabled" });
  }
  const before = await ipAllowlistOf(deps, orgId);
  const had = new Set(before.ranges.map((r) => r.cidr));
  const now = deps.now();
  const state = input.enabled ? "enforced" : "disabled";
  const org = await d1.prepare(`SELECT id, name FROM orgs WHERE id = ?1`).bind(orgId).first<{ id: string; name: string }>();
  const entity = orgEntity(org ?? { id: orgId, name: "" });
  for (const r of before.ranges) {
    if (wanted.includes(r.cidr)) continue;
    await d1.prepare(`DELETE FROM org_ip_ranges WHERE id = ?1`).bind(r.id).run();
    await logActivity(deps, { orgId, action: "ip_allowlist_range_delete", actor: user, entity, details: { range: r.cidr }, req: ctx.req });
  }
  for (const c of wanted) {
    if (had.has(c)) continue;
    await d1.prepare(`INSERT INTO org_ip_ranges (id, org_id, kind, cidr, state, created_by, created_at, updated_at) VALUES (?1, ?2, 'allowlist', ?3, ?4, ?5, ?6, ?6)`).bind(randomId(), orgId, c, state, user.id, now).run();
    await logActivity(deps, { orgId, action: "ip_allowlist_range_create", actor: user, entity, details: { range: c }, req: ctx.req });
  }
  await d1.prepare(`UPDATE org_ip_ranges SET state = ?2, updated_at = ?3 WHERE org_id = ?1 AND kind = 'allowlist' AND state <> ?2`).bind(orgId, state, now).run();
  if (before.enabled !== input.enabled) await logActivity(deps, { orgId, action: "ip_allowlist_setting_change", actor: user, entity, details: { from: before.enabled, to: input.enabled }, req: ctx.req });
  return ipAllowlistOf(deps, orgId);
}

const STATES: readonly NetworkRangeState[] = ["testing", "enforced", "disabled"];

async function enforcedNetworkRanges(deps: Deps, orgId: string): Promise<number> {
  return (await deps.db.d1.prepare(`SELECT COUNT(*) AS n FROM org_ip_ranges WHERE org_id = ?1 AND kind = 'network' AND state = 'enforced'`).bind(orgId).first<{ n: number }>())?.n ?? 0;
}

/**
 * Network ranges (§2.2): created in `testing` (Figma's shadow test; ours: self-serve), then `enforced` or `disabled`.
 * "Restrict external account access on this network" is on while any range is enforced: `ip_restriction_change` when
 * that flips.
 */
export async function networkRangesRoute(ctx: Ctx, orgId: string, rest: string[]): Promise<Response> {
  const { deps, user, m } = ctx;
  const d1 = deps.db.d1;
  const org = await d1.prepare(`SELECT id, name FROM orgs WHERE id = ?1`).bind(orgId).first<{ id: string; name: string }>();
  const entity = orgEntity(org ?? { id: orgId, name: "" });
  const restriction = async (before: number) => {
    const after = await enforcedNetworkRanges(deps, orgId);
    if ((before > 0) !== (after > 0)) await logActivity(deps, { orgId, action: "ip_restriction_change", actor: user, entity, details: { from: before > 0, to: after > 0 }, req: ctx.req });
  };
  if (!rest.length && m === "GET") return json({ ranges: await networkRangesOf(deps, orgId) });
  if (!rest.length && m === "POST") {
    const b = await body<{ cidr?: unknown }>(ctx.req);
    const cidr = typeof b.cidr === "string" ? normalizeCidr(b.cidr, "network") : null;
    if (!cidr) throw new HttpError(400, "cidr is an IPv4 range of /16 or narrower, or an IPv6 range of /32 or narrower", "invalid", { field: "cidr" });
    if ((await d1.prepare(`SELECT COUNT(*) AS n FROM org_ip_ranges WHERE org_id = ?1 AND kind = 'network'`).bind(orgId).first<{ n: number }>())!.n >= MAX_RANGES) throw new HttpError(400, `at most ${MAX_RANGES} ranges`, "invalid", { field: "cidr" });
    if (await d1.prepare(`SELECT 1 AS x FROM org_ip_ranges WHERE org_id = ?1 AND kind = 'network' AND cidr = ?2`).bind(orgId, cidr).first()) throw new HttpError(409, `${cidr} is already in the list`, "conflict", { field: "cidr" });
    const id = randomId();
    const now = deps.now();
    await d1.prepare(`INSERT INTO org_ip_ranges (id, org_id, kind, cidr, state, created_by, created_at, updated_at) VALUES (?1, ?2, 'network', ?3, 'testing', ?4, ?5, ?5)`).bind(id, orgId, cidr, user.id, now).run();
    forgetNetworkRanges(d1);
    await logActivity(deps, { orgId, action: "network_access_restriction_range_create", actor: user, entity, details: { range: cidr, state: "testing" }, req: ctx.req });
    return json({ range: (await networkRangesOf(deps, orgId, id))[0] }, 201);
  }
  const range = rest.length === 1 ? (await networkRangesOf(deps, orgId, rest[0]))[0] : undefined;
  if (!range) throw new HttpError(404, "no such range");
  if (m === "PATCH") {
    const b = await body<{ state?: unknown }>(ctx.req);
    const state = b.state as NetworkRangeState;
    if (!STATES.includes(state)) throw new HttpError(400, "state is testing, enforced or disabled", "invalid", { field: "state" });
    // Enforced only from testing, after NETWORK_TESTING_MIN_MS there (`updated_at` is when it entered testing): the
    // admin sees who it would block first (§2.2; ours)
    if (state === "enforced" && range.state !== "enforced") {
      const row = await d1.prepare(`SELECT updated_at FROM org_ip_ranges WHERE id = ?1`).bind(range.id).first<{ updated_at: number }>();
      const since = range.state === "testing" && row ? row.updated_at : null;
      if (since === null || deps.now() - since < NETWORK_TESTING_MIN_MS)
        throw new HttpError(409, "a range is enforced after at least 24 hours in testing", "conflict", { field: "state", enforceableAt: since === null ? null : since + NETWORK_TESTING_MIN_MS });
    }
    if (state !== range.state) {
      const before = await enforcedNetworkRanges(deps, orgId);
      await d1.prepare(`UPDATE org_ip_ranges SET state = ?2, updated_at = ?3 WHERE id = ?1`).bind(range.id, state, deps.now()).run();
    forgetNetworkRanges(d1);
      await logActivity(deps, { orgId, action: "network_access_restriction_range_update", actor: user, entity, details: { range: range.cidr, from: range.state, to: state }, req: ctx.req });
      await restriction(before);
    }
    return json({ range: (await networkRangesOf(deps, orgId, range.id))[0] });
  }
  if (m === "DELETE") {
    const before = await enforcedNetworkRanges(deps, orgId);
    await d1.prepare(`DELETE FROM org_ip_ranges WHERE id = ?1`).bind(range.id).run();
    forgetNetworkRanges(d1);
    await logActivity(deps, { orgId, action: "network_access_restriction_range_delete", actor: user, entity, details: { range: range.cidr, state: range.state }, req: ctx.req });
    await restriction(before);
    return noContent();
  }
  throw new HttpError(405, "method not allowed");
}
