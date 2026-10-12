/**
 * Multiple IdPs (docs/governance.md §2.9): the Governance+ gate, Admin's IdP routes, domain → IdP mapping and its
 * activity, SSO routing and the ACS by mapping (unmapped domains with one IdP and with several), `authMethod: "saml"`
 * only for members on mapped domains, a SCIM token per IdP, removal; and the idle timeout's quarter hours (§2.8).
 * node:sqlite, a test IdP in Node.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ORIGIN, identityWorld, type IdentityWorld } from "../testing/identityWorld";
import { buildResponse, idpMetadata, signAssertion, testKeys } from "../testing/samlIdp";
import { validateIdentitySettings } from "./settingsHooks";

let w: IdentityWorld;
beforeAll(() => void testKeys(), 30_000);
beforeEach(async () => {
  w = await identityWorld();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const ENTITY_B = "https://idp-b.example.test/metadata";
const base = () => `/orgs/${w.orgId}/admin/identity`;
const actions = async () => (await w.rows<{ action: string; details: string }>(`SELECT action, details FROM activity_log WHERE org_id = ?1 ORDER BY id`, w.orgId)).map((r) => ({ action: r.action, details: JSON.parse(r.details) }));
const plus = () => w.run(`UPDATE orgs SET governance_plus = 1 WHERE id = ?1`, w.orgId);
const map = (domain: string, tenantId: string | null) => w.call("PUT", `/orgs/${w.orgId}/admin/domains/${domain}/idp`, { token: w.admin.token, body: { tenantId } });

/** Two IdPs through the routes: A (the oldest) and B → their tenant ids */
async function twoIdps(): Promise<{ a: string; b: string }> {
  const a = await w.call("POST", `${base()}/idps`, { token: w.admin.token, body: { provider: "okta", name: "Okta", metadataXml: idpMetadata() } });
  expect(a.status, a.text).toBe(201);
  w.now.t += 1;
  const b = await w.call("POST", `${base()}/idps`, { token: w.admin.token, body: { provider: "entra", name: "Entra", metadataXml: idpMetadata({ entityId: ENTITY_B }) } });
  expect(b.status, b.text).toBe(201);
  return { a: a.body.idp.tenantId, b: b.body.idp.tenantId };
}

/** A whole SP-initiated SAML sign-in through `tenant` for this email → the ACS's answer */
async function samlSignIn(tenant: string, email: string, issuer?: string) {
  const s = await w.samlStart(tenant);
  const xml = signAssertion(buildResponse({ sp: `${ORIGIN}/saml/${tenant}`, inResponseTo: s.requestId, nameId: email, ...(issuer ? { issuer } : {}) }));
  return { res: await w.acs(tenant, xml, s.requestId), verifier: s.verifier };
}

describe("the Governance+ gate", () => {
  it("refuses the IdP and mapping routes without the add-on; round 4's single-IdP routes keep working", async () => {
    await w.verifiedDomain("acme.test");
    const t = w.admin.token;
    for (const [m, p] of [["GET", `${base()}/idps`], ["POST", `${base()}/idps`]] as const) {
      const r = await w.call(m, p, { token: t, body: m === "POST" ? { provider: "okta", metadataXml: idpMetadata() } : undefined });
      expect(r.status).toBe(403);
      expect(r.body.code).toBe("governance_plus_required");
    }
    expect((await map("acme.test", null)).body.code).toBe("governance_plus_required");
    const r4 = await w.call("PUT", `${base()}/saml`, { token: t, body: { provider: "okta", name: "Okta", metadataXml: idpMetadata() } });
    expect(r4.status).toBe(200);
    expect(r4.body.idp.name).toBe("Okta");
    expect((await w.call("POST", `${base()}/scim-token`, { token: t })).status).toBe(201);
  });
});

describe("several IdPs", () => {
  it("adds, lists (oldest first, with domains and SCIM), renames, refuses a second configuration of the same IdP", async () => {
    await plus();
    await w.verifiedDomain("acme.test");
    await w.verifiedDomain("beta.test");
    const { a, b } = await twoIdps();
    const t = w.admin.token;
    expect((await w.call("POST", `${base()}/idps`, { token: t, body: { provider: "okta", metadataXml: idpMetadata() } })).status).toBe(409);
    expect((await map("beta.test", b)).status).toBe(200);
    expect((await map("acme.test", a)).status).toBe(200);
    expect((await map("acme.test", "999999999999999999")).status).toBe(404);
    const list = await w.call("GET", `${base()}/idps`, { token: t });
    expect(list.body.idps.map((i: { tenantId: string; name: string; domains: string[] }) => [i.tenantId, i.name, i.domains])).toEqual([[a, "Okta", ["acme.test"]], [b, "Entra", ["beta.test"]]]);
    expect(list.body.idps[1].scim).toEqual({ baseUrl: `${ORIGIN}/scim/v2/${b}`, token: null });
    const renamed = await w.call("PUT", `${base()}/idps/${b}`, { token: t, body: { name: "Entra ID" } });
    expect(renamed.body.idp).toMatchObject({ tenantId: b, name: "Entra ID", domains: ["beta.test"] });
    const overview = await w.call("GET", base(), { token: t });
    expect(overview.body.idp.tenantId).toBe(a);
    expect(overview.body.idps).toHaveLength(2);
    const log = await actions();
    expect(log.filter((x) => x.action === "idp_config_create").map((x) => x.details.tenant_id)).toEqual([a, b]);
    expect(log.filter((x) => x.action === "org_domain_idp_mapping_change").map((x) => x.details)).toEqual([
      { domain: "beta.test", from: null, to: b },
      { domain: "acme.test", from: null, to: a },
    ]);
  });

  it("routes SSO and the ACS by the domain's IdP; unmapped domains can't use SSO when there are several", async () => {
    await plus();
    for (const d of ["acme.test", "beta.test", "gamma.test"]) await w.verifiedDomain(d);
    const { a, b } = await twoIdps();
    await map("acme.test", a);
    await map("beta.test", b);
    const sso = async (email: string) => w.call("POST", "/auth/sso", { body: { email } });
    expect((await sso("x@acme.test")).body.tenantId).toBe(a);
    expect((await sso("x@beta.test")).body.tenantId).toBe(b);
    expect((await sso("x@gamma.test")).status).toBe(404);
    // the ACS: B signs in beta.test, not acme.test (A's) nor gamma.test (unmapped)
    expect((await samlSignIn(b, "eve@acme.test", ENTITY_B)).res.location!.searchParams.get("error")).toBe("sso_domain");
    expect((await samlSignIn(b, "eve@gamma.test", ENTITY_B)).res.location!.searchParams.get("error")).toBe("sso_domain");
    const ok = await samlSignIn(b, "eve@beta.test", ENTITY_B);
    expect(ok.res.location!.searchParams.get("code")).toBeTruthy();
    // tested: B only
    const tested = await w.rows<{ tenant_id: string; tested_at: number | null }>(`SELECT tenant_id, tested_at FROM idp_configs ORDER BY created_at`);
    expect(tested.map((r) => r.tested_at !== null)).toEqual([false, true]);
    // one IdP left: its unmapped verified domains use it again
    await w.run(`DELETE FROM idp_configs WHERE tenant_id = ?1`, b);
    expect((await sso("x@gamma.test")).body.tenantId).toBe(a);
  });

  it("SAML required applies to members on mapped domains (every mapped IdP tested); the others may use Google", async () => {
    await plus();
    for (const d of ["acme.test", "beta.test", "gamma.test"]) await w.verifiedDomain(d);
    const { a, b } = await twoIdps();
    await map("acme.test", a);
    await map("beta.test", b);
    await w.run(`UPDATE idp_configs SET tested_at = 1 WHERE tenant_id = ?1`, a);
    await expect(w.settings({ authMethod: "saml" })).rejects.toMatchObject({ status: 409, message: "Test SAML SSO first" });
    await w.run(`UPDATE idp_configs SET tested_at = 1 WHERE tenant_id = ?1`, b);
    await w.settings({ authMethod: "saml" });
    // mapping a domain to an untested IdP is refused while SAML is required
    w.now.t += 1;
    const c = await w.call("POST", `${base()}/idps`, { token: w.admin.token, body: { provider: "custom", idpEntityId: "urn:c", ssoUrl: "https://c.test/sso", certificate: testKeys().idp.cert } });
    expect((await map("gamma.test", c.body.idp.tenantId)).status).toBe(409);
    // members: alice (acme.test) goes on to A; gina (gamma.test, unmapped) uses Google
    await w.run(`UPDATE users SET google_sub = 'g-alice' WHERE id = ?1`, w.admin.id);
    const alice = await w.googleFlow({ sub: "g-alice", email: "alice@acme.test" });
    expect(alice.res.location!.origin).toBe("https://idp.example.test");
    const gina = await w.dev("gina@gamma.test");
    await w.run(`INSERT INTO org_members (org_id, email, user_id, role, seat, created_at) VALUES (?1, 'gina@gamma.test', ?2, 'member', 'view', 1)`, w.orgId, gina.id);
    await w.run(`UPDATE users SET google_sub = 'g-gina' WHERE id = ?1`, gina.id);
    const g = await w.googleFlow({ sub: "g-gina", email: "gina@gamma.test" });
    expect(g.res.location!.searchParams.get("code")).toBeTruthy();
    // an IdP in use can't be changed or removed while SAML is required; an unused one can
    expect((await w.call("DELETE", `${base()}/idps/${b}`, { token: w.admin.token })).status).toBe(409);
    expect((await w.call("PUT", `${base()}/idps/${b}`, { token: w.admin.token, body: { provider: "entra", metadataXml: idpMetadata({ entityId: "https://idp-b2.test" }) } })).status).toBe(409);
    expect((await w.call("DELETE", `${base()}/idps/${c.body.idp.tenantId}`, { token: w.admin.token })).status).toBe(204);
    await w.settings({ authMethod: "any" });
    expect((await w.call("DELETE", `${base()}/idps/${b}`, { token: w.admin.token })).status).toBe(204);
    expect(await w.rows(`SELECT domain FROM org_domains WHERE idp_tenant_id IS NOT NULL`)).toEqual([{ domain: "acme.test" }]);
    const log = await actions();
    expect(log.filter((x) => x.action === "org_domain_idp_mapping_change").at(-1)!.details).toEqual({ domain: "beta.test", from: b, to: null });
    expect(log.filter((x) => x.action === "idp_config_delete").map((x) => x.details.tenant_id)).toEqual([c.body.idp.tenantId, b]);
  });

  it("gives each IdP its own SCIM token; round 4's token route is the oldest IdP's", async () => {
    await plus();
    const { a, b } = await twoIdps();
    const t = w.admin.token;
    const ta = await w.call("POST", `${base()}/scim-token`, { token: t });
    const tb = await w.call("POST", `${base()}/idps/${b}/scim-token`, { token: t });
    expect(tb.status).toBe(201);
    const users = (tenant: string, token: string) => w.call("GET", `/scim/v2/${tenant}/Users`, { token });
    expect((await users(a, ta.body.token)).status).toBe(200);
    expect((await users(b, ta.body.token)).status).toBe(401);
    expect((await users(b, tb.body.token)).status).toBe(200);
    expect((await users(a, tb.body.token)).status).toBe(401);
    // a new token for B leaves A's alone
    const tb2 = await w.call("POST", `${base()}/idps/${b}/scim-token`, { token: t });
    expect((await users(b, tb.body.token)).status).toBe(401);
    expect((await users(b, tb2.body.token)).status).toBe(200);
    expect((await users(a, ta.body.token)).status).toBe(200);
    const list = (await w.call("GET", `${base()}/idps`, { token: t })).body.idps;
    expect(list.map((i: { scim: { token: { id: string } } }) => i.scim.token.id)).toEqual([ta.body.info.id, tb2.body.info.id]);
    expect((await w.call("DELETE", `${base()}/idps/${b}/scim-token`, { token: t })).status).toBe(204);
    expect((await users(b, tb2.body.token)).status).toBe(401);
    expect((await users(a, ta.body.token)).status).toBe(200);
  });
});

describe("the idle session timeout in quarter hours (§2.8)", () => {
  it("takes 0.25…336 in quarter hours with Governance+, whole hours from 12 without", async () => {
    const check = (h: number | null) => validateIdentitySettings(w.deps, w.orgId, { idleSessionTimeoutHours: h });
    await expect(check(0.25)).rejects.toMatchObject({ status: 400 });
    await expect(check(12)).resolves.toBeUndefined();
    await expect(check(null)).resolves.toBeUndefined();
    await plus();
    await expect(check(0.25)).resolves.toBeUndefined();
    await expect(check(1.75)).resolves.toBeUndefined();
    await expect(check(0.3)).rejects.toMatchObject({ status: 400 });
    await expect(check(0.1)).rejects.toMatchObject({ status: 400 });
    await expect(check(337)).rejects.toMatchObject({ status: 400 });
  });
});
