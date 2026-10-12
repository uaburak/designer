/**
 * Network access restrictions, the sign-in side (docs/governance.md §1, §2.2, §2.5): "Restrict external account access
 * on this network". An org with Governance+ lists IP ranges (`org_ip_ranges`, kind 'network'); on those networks only
 * the org's accounts may be used — people on its verified domains, and its members and guests. Everyone else gets 403
 * `network_restricted` on every authenticated route (except `GET /me`, sign-out and `/me/sessions/current`, so the app
 * can say why and log out) and `error=network_restricted` at sign-in.
 *
 * A range in state 'testing' blocks no one: it records the account it would have blocked in `network_shadow_hits`
 * (once per account and day), which Admin counts as "‹N› accounts would have been blocked in the last 7 days".
 *
 * This runs on every authenticated request, so it is cheap (free plan, performance first): the live ranges of all
 * Governance+ orgs are one indexed D1 query (`org_ip_ranges_kind`) kept per isolate for RANGES_TTL_MS; an address
 * outside every range costs nothing more. Only a request from inside a range asks who the account is to the org (one
 * query, also remembered briefly).
 */
import { emailDomain } from "../../../src/shared/org/identity";
import { ipInCidr } from "../../../src/shared/org/governance";
import type { Deps } from "../api";
import type { D1Like, User } from "../db";

/** How long an isolate trusts its copy of the ranges (a range change reaches every isolate within this) */
export const RANGES_TTL_MS = 60_000;
const ALLOWED_TTL_MS = 60_000;
const DAY_MS = 86_400_000;
const MAX_REMEMBERED = 5_000;

interface LiveRange {
  id: string;
  org_id: string;
  cidr: string;
  state: "testing" | "enforced";
}

interface Cache {
  at: number;
  ranges: LiveRange[] | Promise<LiveRange[]>;
  /** `${orgId} ${userId}` → is the account the org's? (and when it was asked) */
  allowed: Map<string, { at: number; ok: boolean }>;
  /** `${rangeId} ${userId} ${day}` already written */
  shadowed: Set<string>;
}

// Per D1 binding (stable within an isolate; each test world has its own)
const caches = new WeakMap<D1Like, Cache>();

/** Forget the cached ranges (the admin routes call it after a change, so this isolate sees it at once) */
export function forgetNetworkRanges(d1?: D1Like): void {
  if (d1) caches.delete(d1);
}

function cacheOf(d1: D1Like): Cache {
  let c = caches.get(d1);
  if (!c) caches.set(d1, (c = { at: -Infinity, ranges: [], allowed: new Map(), shadowed: new Set() }));
  return c;
}

async function liveRanges(deps: Deps): Promise<LiveRange[]> {
  const c = cacheOf(deps.db.d1);
  const now = deps.now();
  if (now - c.at < RANGES_TTL_MS) return c.ranges;
  c.at = now;
  c.ranges = deps.db.d1
    .prepare(
      `SELECT r.id, r.org_id, r.cidr, r.state FROM org_ip_ranges r JOIN orgs o ON o.id = r.org_id
       WHERE r.kind = 'network' AND r.state IN ('testing', 'enforced') AND o.governance_plus = 1`,
    )
    .all<LiveRange>()
    .then((r) => r.results)
    .catch((e) => {
      // A failing read lets everyone through (the restriction is a policy, not the session's validity); retried soon
      console.error("network: ranges not read", e);
      c.at = -Infinity;
      return [] as LiveRange[];
    });
  c.ranges = await c.ranges;
  return c.ranges;
}

/** The caller's address as the Worker sees it */
export const requestIp = (req: Request): string | null => req.headers.get("cf-connecting-ip");

/** Is this account the org's on its network: an account on a verified domain of the org, or a member or guest of it? */
async function accountOfOrg(deps: Deps, c: Cache, orgId: string, user: Pick<User, "id" | "email">): Promise<boolean> {
  const key = `${orgId} ${user.id}`;
  const now = deps.now();
  const hit = c.allowed.get(key);
  if (hit && now - hit.at < ALLOWED_TTL_MS) return hit.ok;
  const r = await deps.db.d1
    .prepare(
      `SELECT EXISTS (SELECT 1 FROM org_members WHERE org_id = ?1 AND user_id = ?2)
           OR EXISTS (SELECT 1 FROM org_domains WHERE org_id = ?1 AND domain = ?3 AND verified_at IS NOT NULL) AS ok`,
    )
    .bind(orgId, user.id, emailDomain(user.email) ?? "")
    .first<{ ok: number }>();
  const ok = !!r?.ok;
  if (c.allowed.size >= MAX_REMEMBERED) c.allowed.clear();
  c.allowed.set(key, { at: now, ok });
  return ok;
}

/**
 * True when a network access restriction blocks this account on the request's network (403 `network_restricted`; at
 * sign-in `error=network_restricted`). Ranges in testing record a shadow hit instead.
 */
export async function networkCheck(deps: Deps, user: Pick<User, "id" | "email">, req: Request): Promise<boolean> {
  const ip = requestIp(req);
  if (!ip) return false;
  const ranges = await liveRanges(deps);
  if (!ranges.length) return false;
  const hits = ranges.filter((r) => ipInCidr(ip, r.cidr));
  if (!hits.length) return false;
  const c = cacheOf(deps.db.d1);
  let blocked = false;
  const shadow: LiveRange[] = [];
  for (const orgId of new Set(hits.map((h) => h.org_id))) {
    if (await accountOfOrg(deps, c, orgId, user)) continue;
    for (const h of hits.filter((x) => x.org_id === orgId)) {
      if (h.state === "enforced") blocked = true;
      else shadow.push(h);
    }
  }
  if (shadow.length) {
    const day = Math.floor(deps.now() / DAY_MS);
    const fresh = shadow.filter((h) => !c.shadowed.has(`${h.id} ${user.id} ${day}`));
    if (fresh.length) {
      if (c.shadowed.size >= MAX_REMEMBERED) c.shadowed.clear();
      for (const h of fresh) c.shadowed.add(`${h.id} ${user.id} ${day}`);
      const write = Promise.all(
        fresh.map((h) => deps.db.d1.prepare(`INSERT INTO network_shadow_hits (range_id, user_id, day) VALUES (?1, ?2, ?3) ON CONFLICT DO NOTHING`).bind(h.id, user.id, day).run()),
      ).catch((e) => console.error("network: shadow hit not recorded", e));
      if (deps.waitUntil) deps.waitUntil(write);
      else await write;
    }
  }
  return blocked;
}

/** Routes the network restriction leaves open, so the app can show why and log out (§2.5) */
export function networkExempt(method: string, path: string): boolean {
  const p = path.replace(/\/+$/, "");
  return (p === "/me" && method === "GET") || p === "/me/sessions/current" || (p === "/me/sessions" && method === "DELETE") || (p === "/auth/signout-everywhere" && method === "POST");
}
