/**
 * Governance+'s Admin routes (docs/governance.md §4; `/orgs/:org/admin/…`, dispatched by org/admin.ts):
 *
 *   GET  governance                       GovernanceOverview
 *   PUT  governance {governancePlus}      GovernanceOverview          Admin › Billing › Governance+ Add / Remove
 *   PUT  ip-allowlist {enabled, ranges}   IpAllowlist                 (ip.ts)
 *   GET|POST network-ranges · PATCH|DELETE network-ranges/:id         {ranges} · {range} (ip.ts)
 *   GET|POST policies · PATCH policies/:id {enabled}                  {policies} · {policy} (policies.ts)
 *   PUT  guests/expiration {userIds, expiresAt | null}   204          (guests.ts)
 *
 * Every route but `governance` answers 403 `governance_plus_required` without the add-on (§2.1). Org admins only,
 * except guests/expiration (workspace admins for their workspaces' guests).
 */
import type { EkmStatus, GovernanceOverview } from "../../../src/shared/org/governance";
import { validIdleHours } from "../../../src/shared/org/governance";
import type { OrgSettings } from "../../../src/shared/org/types";
import { logActivity, orgEntity } from "../activity";
import type { Deps } from "../api";
import { onIdentitySettingsChanged } from "../auth/settingsHooks";
import { settingsOf } from "../org/db";
import { body, HttpError, json, type Ctx } from "../org/http";
import { orgUserIds } from "../org/orgs";
import { orgNotice } from "../notifications";
import { broadcastRoomPolicy } from "../policy/roomPolicy";
import { setGuestExpiration } from "./guests";
import { callerIp, ipAllowlistOf, networkRangesOf, networkRangesRoute, setIpAllowlist } from "./ip";
import { adminPoliciesRoute, policiesOf } from "./policies";

export const GOVERNANCE_SECTIONS = new Set(["governance", "ip-allowlist", "network-ranges", "policies", "guests"]);

export function requireGovernancePlus(org: { governance_plus?: number } | null): void {
  if (!org?.governance_plus) throw new HttpError(403, "Requires Governance+", "governance_plus_required");
}

/** A placeholder of key management's status (14c owns its routes): from `org_keys` and `files.encrypted_at` */
async function ekmStatus(deps: Deps, orgId: string): Promise<EkmStatus> {
  const r = await deps.db.d1
    .prepare(
      `SELECT k.source, k.state, k.checked_at, (SELECT COUNT(*) FROM files WHERE org_id = ?1) AS total, (SELECT COUNT(encrypted_at) FROM files WHERE org_id = ?1) AS encrypted
       FROM orgs o LEFT JOIN org_keys k ON k.org_id = o.id WHERE o.id = ?1`,
    )
    .bind(orgId)
    .first<{ source: "managed" | null; state: "ok" | "unavailable" | null; checked_at: number | null; total: number; encrypted: number }>();
  return { enabled: !!r?.source, source: r?.source ?? null, state: r?.state ?? null, checkedAt: r?.checked_at ?? null, files: { total: r?.total ?? 0, encrypted: r?.encrypted ?? 0 }, encrypting: null };
}

export async function overviewOf(ctx: Ctx, orgId: string): Promise<GovernanceOverview> {
  const { deps } = ctx;
  const org = await deps.db.d1.prepare(`SELECT governance_plus FROM orgs WHERE id = ?1`).bind(orgId).first<{ governance_plus: number }>();
  const g = await deps.db.d1
    .prepare(`SELECT COUNT(*) AS n FROM org_members m WHERE m.org_id = ?1 AND m.role = 'guest' AND NOT EXISTS (SELECT 1 FROM user_two_factor t WHERE t.user_id = m.user_id AND t.enabled_at IS NOT NULL)`)
    .bind(orgId)
    .first<{ n: number }>();
  return {
    governancePlus: !!org?.governance_plus,
    ipAllowlist: await ipAllowlistOf(deps, orgId),
    callerIp: callerIp(ctx.req) ?? "",
    networkRanges: await networkRangesOf(deps, orgId),
    policies: await policiesOf(deps, orgId),
    ekm: await ekmStatus(deps, orgId),
    guestsWithout2fa: g?.n ?? 0,
  };
}

/** `PUT governance {governancePlus}`: the stored values stay; removing it clamps the idle timeout to ≥ 12 h and is
 *  refused (409) while key management is on (Figma doesn't support offboarding). */
async function setGovernancePlus(ctx: Ctx, orgId: string, on: boolean): Promise<void> {
  const { deps, user, acc } = ctx;
  const d1 = deps.db.d1;
  const org = (await acc.org(orgId))!;
  if (!!org.governance_plus === on) return;
  if (!on && (await d1.prepare(`SELECT 1 AS x FROM org_keys WHERE org_id = ?1`).bind(orgId).first())) throw new HttpError(409, "Key management can't be turned off, so Governance+ can't be removed", "conflict");
  const before = settingsOf(org);
  const next: OrgSettings = { ...before };
  const h = before.idleSessionTimeoutHours;
  if (!on && h !== null && !validIdleHours(h, false)) next.idleSessionTimeoutHours = Math.min(336, Math.max(12, Math.ceil(h)));
  await d1.prepare(`UPDATE orgs SET governance_plus = ?2, settings = ?3, updated_at = ?4 WHERE id = ?1`).bind(orgId, on ? 1 : 0, JSON.stringify(next), deps.now()).run();
  await logActivity(deps, { orgId, action: on ? "governance_plus_enable" : "governance_plus_disable", actor: user, entity: orgEntity(org), req: ctx.req });
  acc.reset();
  // The idle clamp resets the org's sessions and logs idle_timeout_setting_change (§15.8)
  if (next.idleSessionTimeoutHours !== before.idleSessionTimeoutHours) await onIdentitySettingsChanged(deps, orgId, before, next, user, ctx.req);
  // Discovery stops or starts with the add-on (the rooms' policy)
  if (before.discovery) await broadcastRoomPolicy(deps, orgId, { cursorChat: next.cursorChat, audio: next.audio, discovery: on });
  await orgNotice(deps, await orgUserIds(d1, orgId), { what: "org", orgId });
}

export async function governanceRoute(ctx: Ctx, orgId: string, section: string, rest: string[], scope: { org: boolean; workspaces: string[] }): Promise<Response> {
  const { m, acc } = ctx;
  const orgOnly = () => {
    if (!scope.org) throw new HttpError(403, "only organization admins can do that", "not_admin");
  };
  if (section === "governance") {
    orgOnly();
    if (rest.length) throw new HttpError(404, "not found");
    if (m === "GET") return json(await overviewOf(ctx, orgId));
    if (m === "PUT") {
      const b = await body<{ governancePlus?: unknown }>(ctx.req);
      if (typeof b.governancePlus !== "boolean") throw new HttpError(400, "governancePlus is true or false", "invalid", { field: "governancePlus" });
      await setGovernancePlus(ctx, orgId, b.governancePlus);
      return json(await overviewOf(ctx, orgId));
    }
    throw new HttpError(405, "method not allowed");
  }
  if (section === "guests") {
    if (!scope.org && !scope.workspaces.length) throw new HttpError(403, "only organization and workspace admins can do that", "not_admin");
    requireGovernancePlus(await acc.org(orgId));
    if (rest.length === 1 && rest[0] === "expiration" && m === "PUT") return setGuestExpiration(ctx, orgId, scope);
    throw new HttpError(404, "not found");
  }
  orgOnly();
  requireGovernancePlus(await acc.org(orgId));
  if (section === "ip-allowlist") {
    if (rest.length) throw new HttpError(404, "not found");
    if (m === "GET") return json(await ipAllowlistOf(ctx.deps, orgId));
    if (m === "PUT") return json(await setIpAllowlist(ctx, orgId, await body(ctx.req)));
    throw new HttpError(405, "method not allowed");
  }
  if (section === "network-ranges") return networkRangesRoute(ctx, orgId, rest);
  if (section === "policies") return adminPoliciesRoute(ctx, orgId, rest);
  throw new HttpError(404, "not found");
}
