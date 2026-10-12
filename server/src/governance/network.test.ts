/**
 * Network access restrictions, the sign-in side (docs/governance.md §2.2, §2.5): enforced ranges refuse other accounts
 * with 403 `network_restricted` (but `GET /me` and sign-out) and `error=network_restricted` at sign-in; the org's
 * accounts pass (members, guests, people on its verified domains); ranges in testing record shadow hits once per
 * account and day; nothing without Governance+; the per-isolate cache. node:sqlite.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { identityWorld, type IdentityWorld } from "../testing/identityWorld";
import { forgetNetworkRanges, RANGES_TTL_MS } from "./network";

let w: IdentityWorld;
const ON = { "cf-connecting-ip": "203.0.113.7" };
const ON_V6 = { "cf-connecting-ip": "2001:db8:1:2::9" };
const OFF = { "cf-connecting-ip": "198.51.100.7" };

beforeEach(async () => {
  w = await identityWorld();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await w.run(`UPDATE orgs SET governance_plus = 1 WHERE id = ?1`, w.orgId);
});
afterEach(() => {
  forgetNetworkRanges(w.d1);
  vi.restoreAllMocks();
});

async function range(cidr: string, state: "testing" | "enforced" | "disabled", orgId = w.orgId): Promise<string> {
  const id = `r_${cidr.replace(/\W/g, "")}`;
  await w.run(`INSERT INTO org_ip_ranges (id, org_id, kind, cidr, state, created_at, updated_at) VALUES (?1, ?2, 'network', ?3, ?4, 1, 1)`, id, orgId, cidr, state);
  forgetNetworkRanges(w.d1);
  return id;
}

const orgs = (token: string, headers: Record<string, string>) => w.call("GET", "/orgs", { token, headers });

describe("enforced ranges", () => {
  it("refuse other accounts on the network on every route but GET /me and sign-out; the org's accounts pass", async () => {
    await range("203.0.113.0/24", "enforced");
    await range("2001:db8::/32", "enforced");
    await w.verifiedDomain("acme.test");
    const bob = await w.dev("bob@gmail.test");
    const carol = await w.dev("carol@acme.test"); // on the verified domain, not a member
    const gus = await w.dev("gus@elsewhere.test"); // a guest
    await w.run(`INSERT INTO org_members (org_id, email, user_id, role, seat, created_at) VALUES (?1, 'gus@elsewhere.test', ?2, 'guest', 'view', 1)`, w.orgId, gus.id);

    const r = await orgs(bob.token, ON);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("network_restricted");
    expect((await orgs(bob.token, ON_V6)).status).toBe(403);
    expect((await w.call("GET", "/me/profile", { token: bob.token, headers: ON })).status).toBe(403);
    // the app can still say why, and log out
    expect((await w.call("GET", "/me", { token: bob.token, headers: ON })).status).toBe(200);
    // off the network: as before
    expect((await orgs(bob.token, OFF)).status).toBe(200);
    expect((await orgs(bob.token, {})).status).toBe(200);
    // the org's accounts
    for (const t of [w.admin.token, carol.token, gus.token]) expect((await orgs(t, ON)).status).toBe(200);
    // a personal access token is refused too
    const pat = await w.call("POST", "/me/tokens", { token: bob.token, body: { description: "x", expiresInDays: 30, scopes: ["file_content:read"] } });
    expect((await w.call("GET", "/files/abcdefgh", { token: pat.body.token, headers: ON })).body.code).toBe("network_restricted");
    // sign-out works
    expect((await w.call("DELETE", "/me/sessions/current", { token: bob.token, headers: ON })).status).toBe(204);
  });

  it("answers the sign-in with error=network_restricted", async () => {
    await range("203.0.113.0/24", "enforced");
    const { res } = await w.login("&method=google");
    const state = res.location!.searchParams.get("state")!;
    Object.assign(w.google, { sub: "g-bob", email: "bob@gmail.test" });
    const cb = await w.call("GET", `/auth/callback?code=good&state=${encodeURIComponent(state)}`, { headers: ON });
    expect(cb.status).toBe(302);
    expect(cb.location!.searchParams.get("error")).toBe("network_restricted");
    expect(cb.location!.searchParams.has("code")).toBe(false);
    // from elsewhere the same account signs in
    const again = await w.login("&method=google");
    const cb2 = await w.call("GET", `/auth/callback?code=good&state=${encodeURIComponent(again.res.location!.searchParams.get("state")!)}`, { headers: OFF });
    expect(cb2.location!.searchParams.get("code")).toBeTruthy();
  });

  it("does nothing without Governance+, or for a disabled range; a change reaches the cache within its lifetime", async () => {
    const bob = await w.dev("bob@gmail.test");
    await range("203.0.113.0/24", "disabled");
    expect((await orgs(bob.token, ON)).status).toBe(200);
    await w.run(`UPDATE org_ip_ranges SET state = 'enforced'`);
    // cached: still open until the cache's lifetime passes
    expect((await orgs(bob.token, ON)).status).toBe(200);
    w.now.t += RANGES_TTL_MS + 1;
    expect((await orgs(bob.token, ON)).status).toBe(403);
    await w.run(`UPDATE orgs SET governance_plus = 0 WHERE id = ?1`, w.orgId);
    forgetNetworkRanges(w.d1);
    expect((await orgs(bob.token, ON)).status).toBe(200);
  });
});

describe("ranges in testing (shadow mode)", () => {
  it("block no one and record each would-be-blocked account once a day", async () => {
    const id = await range("203.0.113.0/24", "testing");
    const bob = await w.dev("bob@gmail.test");
    for (let i = 0; i < 3; i++) expect((await orgs(bob.token, ON)).status).toBe(200);
    expect((await orgs(w.admin.token, ON)).status).toBe(200);
    expect(await w.rows(`SELECT range_id, user_id FROM network_shadow_hits`)).toEqual([{ range_id: id, user_id: bob.id }]);
    w.now.t += 86_400_000;
    await orgs(bob.token, ON);
    expect(await w.rows(`SELECT * FROM network_shadow_hits`)).toHaveLength(2);
  });
});
