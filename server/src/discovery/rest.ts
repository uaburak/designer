/**
 * Discovery over REST (docs/governance.md §1 "Discovery API", §2.11):
 *
 *   GET /v1/discovery?start_date&end_date&file_ttl_in_seconds[&org_id]
 *       Tier 2, scope `org:discovery_read`; a plan access token (its org) or an org admin's personal access token
 *       (`org_id` when they administer several — ours; Figma takes OAuth, which we don't build). Governance+ only.
 *       Figma's validation: `start_date` at least 1 h in the past, at most 24 h per call, link lifetime 60–86400 s
 *       (default 86400). Dates are Unix seconds (ISO 8601 also taken). `end_date` defaults to `start_date` + 24 h.
 *       → {error: false, status: 200, meta: {urls: {"YYYY/MM/DD/HH": [url]}}, i18n: null}: the complete hours in the
 *       range that hold events, each one signed URL per 5,000 rows (ours: Figma doesn't say how it splits an hour).
 *   GET /v1/discovery/files/:org/:YYYY/:MM/:DD/:HH.json?exp&sig   (and `:HH-1.json`, … for an hour's later parts)
 *       no token: the signature is the permission. Generated now from D1 — a JSON array of Figma's flat objects.
 */
import { DISCOVERY_FILE_TTL_S, DISCOVERY_MAX_RANGE_S, DISCOVERY_MIN_AGE_S, discoveryHourKey, type DiscoveryEvent, type DiscoveryResponse } from "../../../src/shared/org/governance";
import type { Deps } from "../api";
import { RestError, restJson, type RestCtx } from "../rest/http";
import { signPathFor } from "../rest/signedUrl";

/** Rows per hourly file (ours) */
export const DISCOVERY_FILE_ROWS = 5_000;

/** The org a non-plan caller reads: one they administer (`org_id` when several) */
export async function adminOrgOf(ctx: RestCtx, what: string): Promise<string> {
  const asked = ctx.url.searchParams.get("org_id");
  if (ctx.caller.kind === "plan") {
    if (asked && asked !== ctx.caller.orgId) throw new RestError(403, "This token belongs to another organization");
    return ctx.caller.orgId!;
  }
  const { results } = await ctx.deps.db.d1.prepare(`SELECT org_id FROM org_members WHERE user_id = ?1 AND role = 'admin'`).bind(ctx.caller.user.id).all<{ org_id: string }>();
  const orgs = results.map((r) => r.org_id);
  if (asked) {
    if (!orgs.includes(asked)) throw new RestError(403, `Only organization admins can read ${what}`);
    return asked;
  }
  if (!orgs.length) throw new RestError(403, `Only organization admins can read ${what}`);
  if (orgs.length > 1) throw new RestError(400, "org_id is required: you administer more than one organization");
  return orgs[0];
}

export async function requireGovernancePlusRest(deps: Deps, orgId: string): Promise<void> {
  const o = await deps.db.d1.prepare(`SELECT governance_plus FROM orgs WHERE id = ?1`).bind(orgId).first<{ governance_plus: number }>();
  if (!o?.governance_plus) throw new RestError(403, "This endpoint requires Governance+");
}

/** Unix seconds from `v` (seconds, or an ISO date); undefined when absent */
function seconds(v: string | null, name: string): number | undefined {
  if (v === null || v === "") return undefined;
  if (/^\d{1,12}$/.test(v)) return Number(v);
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw new RestError(400, `Invalid ${name}: expected a Unix timestamp in seconds`);
  return Math.floor(t / 1000);
}

/** `/v1/discovery/files/…` of an hour's part */
export function discoveryFilePath(orgId: string, hour: number, part: number): string {
  return `/v1/discovery/files/${encodeURIComponent(orgId)}/${discoveryHourKey(hour * 3_600_000)}${part ? `-${part}` : ""}.json`;
}

export async function discoveryRestRoute(ctx: RestCtx): Promise<Response> {
  const { deps, url } = ctx;
  const q = url.searchParams;
  const orgId = await adminOrgOf(ctx, "discovery data");
  await requireGovernancePlusRest(deps, orgId);
  const nowS = Math.floor(deps.now() / 1000);
  const start = seconds(q.get("start_date"), "start_date");
  if (start === undefined) throw new RestError(400, "start_date is required");
  if (start > nowS - DISCOVERY_MIN_AGE_S) throw new RestError(400, "start_date must be at least 1 hour in the past");
  const end = seconds(q.get("end_date"), "end_date") ?? start + DISCOVERY_MAX_RANGE_S;
  if (end <= start) throw new RestError(400, "end_date must be after start_date");
  if (end - start > DISCOVERY_MAX_RANGE_S) throw new RestError(400, "The range from start_date to end_date is at most 24 hours");
  const ttlRaw = q.get("file_ttl_in_seconds");
  const ttl = ttlRaw === null || ttlRaw === "" ? DISCOVERY_FILE_TTL_S.default : Number(ttlRaw);
  if (!Number.isInteger(ttl) || ttl < DISCOVERY_FILE_TTL_S.min || ttl > DISCOVERY_FILE_TTL_S.max) throw new RestError(400, `file_ttl_in_seconds is between ${DISCOVERY_FILE_TTL_S.min} and ${DISCOVERY_FILE_TTL_S.max}`);

  // Complete hours only: an hour still running may take more events (late jobs land in the hour they ran).
  const lo = Math.floor(start / 3600);
  const hi = Math.min(Math.ceil(end / 3600), Math.floor(nowS / 3600));
  const { results } = await deps.db.d1
    .prepare(`SELECT hour, COUNT(*) AS n FROM discovery_events WHERE org_id = ?1 AND hour >= ?2 AND hour < ?3 GROUP BY hour ORDER BY hour`)
    .bind(orgId, lo, hi)
    .all<{ hour: number; n: number }>();
  const urls: Record<string, string[]> = {};
  for (const r of results) {
    const list: string[] = [];
    for (let p = 0; p * DISCOVERY_FILE_ROWS < r.n; p++) list.push(await signPathFor(deps, url.origin, discoveryFilePath(orgId, r.hour, p), ttl));
    urls[discoveryHourKey(r.hour * 3_600_000)] = list;
  }
  return restJson({ error: false, status: 200, meta: { urls }, i18n: null } satisfies DiscoveryResponse);
}

/** A signed hourly file (signedRoute verified the signature): parts ["discovery", "files", org, YYYY, MM, DD, "HH[-p].json"] */
export async function discoveryFile(deps: Deps, parts: string[]): Promise<Response> {
  const [, , orgId, y, mo, d, file] = parts;
  const m = /^(\d{2})(?:-(\d{1,4}))?\.json$/.exec(file ?? "");
  if (!m || !/^\d{4}$/.test(y) || !/^\d{2}$/.test(mo) || !/^\d{2}$/.test(d)) throw new RestError(404, "Not found");
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(m[1]));
  if (`${y}/${mo}/${d}/${m[1]}` !== discoveryHourKey(ms)) throw new RestError(404, "Not found");
  const hour = ms / 3_600_000;
  const part = Number(m[2] ?? 0);
  const { results } = await deps.db.d1
    .prepare(
      `SELECT file_key, text, timestamp, action_type, file_name, file_workspace_id, node_id, text_type, resource_id, parent_comment_id, user_id, user_email,
         user_billing_group_id, feature_entrypoint, moderation_failure_flags
       FROM discovery_events WHERE org_id = ?1 AND hour = ?2 ORDER BY id LIMIT ?3 OFFSET ?4`,
    )
    .bind(orgId, hour, DISCOVERY_FILE_ROWS, part * DISCOVERY_FILE_ROWS)
    .all<DiscoveryEvent>();
  return new Response(JSON.stringify(results), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "private, max-age=3600", "access-control-allow-origin": "*" } });
}
