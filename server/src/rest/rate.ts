/**
 * REST rate limits (docs/multiplayer.md §16.2 decision 4, §16.4): Figma's tiers per person per minute (high: Full / Dev
 * seats and people outside orgs; low: View / Collab seats, whose Tier 1 is 20 a day), a daily cap of 5,000 calls, all
 * counted in D1 `rest_rate` with one statement per call (a multi-row upsert). Over a limit: 429 with Figma's headers.
 */
import { RATE_LIMITS, type RestTier } from "../../../src/shared/rest/types";
import type { Deps } from "../api";
import { RestError, type RestCaller } from "./http";

export type RateType = "high" | "low";

const MINUTE = 60_000;
const DAY = 86_400_000;

/**
 * The caller's rate type: their best seat in the org of what they call (`orgId`), or in any of their orgs when the
 * route names no org; `high` outside orgs and for plan tokens.
 */
export async function rateType(deps: Deps, caller: RestCaller, orgId: string | null): Promise<RateType> {
  if (caller.kind === "plan") return "high";
  const d1 = deps.db.d1;
  const { results } = orgId
    ? await d1.prepare(`SELECT seat FROM org_members WHERE user_id = ?1 AND org_id = ?2`).bind(caller.user.id, orgId).all<{ seat: string }>()
    : await d1.prepare(`SELECT seat FROM org_members WHERE user_id = ?1`).bind(caller.user.id).all<{ seat: string }>();
  if (!results.length) return "high";
  return results.some((r) => r.seat === "full" || r.seat === "dev") ? "high" : "low";
}

/** One call of `tier`: counted, then refused with 429 when a limit is passed. Returns the headers to send. */
export async function charge(deps: Deps, caller: RestCaller, tier: RestTier, type: RateType, inOrg: boolean): Promise<Record<string, string>> {
  const now = deps.now();
  const subject = caller.kind === "plan" ? `org:${caller.orgId}` : caller.user.id;
  const minute = Math.floor(now / MINUTE);
  const day = Math.floor(now / DAY);
  const buckets: { bucket: string; window: number; limit: number; resetAt: number }[] = [{ bucket: "day", window: day, limit: RATE_LIMITS.dailyCap, resetAt: (day + 1) * DAY }];
  if (type === "low" && tier === 1 && RATE_LIMITS.lowTier1PerDay) buckets.push({ bucket: "t1day", window: day, limit: RATE_LIMITS.low[1], resetAt: (day + 1) * DAY });
  else buckets.push({ bucket: `t${tier}`, window: minute, limit: RATE_LIMITS[type][tier], resetAt: (minute + 1) * MINUTE });
  const values = buckets.map((_, i) => `(?1, ?${i * 2 + 2}, ?${i * 2 + 3}, 1)`).join(", ");
  const { results } = await deps.db.d1
    .prepare(`INSERT INTO rest_rate (subject, bucket, window, count) VALUES ${values} ON CONFLICT (subject, bucket, window) DO UPDATE SET count = count + 1 RETURNING bucket, count`)
    .bind(subject, ...buckets.flatMap((b) => [b.bucket, b.window]))
    .all<{ bucket: string; count: number }>();
  const headers = { "x-figma-plan-tier": inOrg ? "enterprise" : "starter", "x-figma-rate-limit-type": type };
  for (const b of buckets) {
    const count = results.find((r) => r.bucket === b.bucket)?.count ?? 0;
    if (count > b.limit) throw new RestError(429, "Rate limit exceeded", {}, { ...headers, "retry-after": String(Math.max(1, Math.ceil((b.resetAt - now) / 1000))) });
  }
  return headers;
}

/** The daily cron: counters older than two days go */
export async function sweepRate(d1: Deps["db"]["d1"], now: number): Promise<void> {
  const day = Math.floor(now / DAY);
  await d1.prepare(`DELETE FROM rest_rate WHERE (bucket IN ('day', 't1day') AND window < ?1) OR (bucket NOT IN ('day', 't1day') AND window < ?2)`).bind(day - 2, (day - 2) * 1440).run();
}
