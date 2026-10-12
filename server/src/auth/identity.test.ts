/**
 * Identity on the server (docs/multiplayer.md §15.3–§15.8): the login page and SSO routing, Google's callback with
 * account linking, capture and the login method, SAML JIT, the admin's SAML configuration and SCIM token, domains over
 * faked DNS-over-HTTPS answers, domain capture, the idle session timeout. node:sqlite, a test IdP in Node.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ORIGIN, WEB, identityWorld, type IdentityWorld } from "../testing/identityWorld";
import { IDP_ENTITY, buildResponse, idpMetadata, signAssertion, testKeys } from "../testing/samlIdp";
import { checkCertificate, parseIdpMetadata } from "./saml/config";
import { txtValue } from "./domains";

let w: IdentityWorld;
beforeAll(() => void testKeys(), 30_000);
beforeEach(async () => {
  w = await identityWorld();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const actions = async (orgId = w.orgId) => (await w.rows<{ action: string; details: string }>(`SELECT action, details FROM activity_log WHERE org_id = ?1 ORDER BY id`, orgId)).map((r) => ({ action: r.action, details: JSON.parse(r.details) }));
const member = async (email: string, orgId = w.orgId) => (await w.rows(`SELECT m.* FROM org_members m JOIN users u ON u.id = m.user_id WHERE m.org_id = ?1 AND u.email = ?2`, orgId, email))[0];

/** A whole SP-initiated SAML sign-in for this email → the ACS's answer (and the verifier) */
async function samlSignIn(tenant: string, email: string, attributes: Record<string, string> = {}) {
  const s = await w.samlStart(tenant);
  const xml = signAssertion(buildResponse({ sp: `${ORIGIN}/saml/${tenant}`, inResponseTo: s.requestId, nameId: email, attributes }));
  return { res: await w.acs(tenant, xml, s.requestId), verifier: s.verifier };
}

describe("the login page and SSO routing (§15.4)", () => {
  it("answers Figma's login page; method=google goes to Google, method=sso asks for the email, tenant goes to its SAML start", async () => {
    const { res } = await w.login();
    expect(res.status).toBe(200);
    expect(res.text).toContain("Log in to Designer");
    expect(res.text).toContain("Continue with Google");
    expect(res.text).toContain("Use single sign-on");
    const st = /st=([^&"]+)/.exec(res.text)![1];
    const google = await w.call("GET", `/auth/login?st=${st}&method=google`);
    expect(google.location!.origin).toBe("https://accounts.google.com");
    expect(google.location!.searchParams.get("state")).toBe(decodeURIComponent(st));
    const sso = await w.call("GET", `/auth/login?st=${st}&method=sso`);
    expect(sso.text).toContain('name="email"');
    expect(sso.text).toContain("Log in");
    const t = await w.call("GET", `/auth/login?st=${st}&tenant=123456789012345678`);
    expect(t.location!.pathname).toBe("/saml/123456789012345678/start");
    expect((await w.call("GET", `/auth/login?st=forged&method=google`)).status).toBe(400);
  });

  it("routes an email on a verified domain to its org's SAML; unverified domains and other emails are refused", async () => {
    const tenant = await w.addIdp();
    await w.verifiedDomain("acme.test");
    await w.run(`INSERT INTO org_domains (org_id, domain, token, created_at) VALUES (?1, 'unverified.test', 't', 1)`, w.orgId);
    const { res } = await w.login();
    const st = decodeURIComponent(/st=([^&"]+)/.exec(res.text)![1]);
    const ok = await w.call("POST", "/auth/sso", { form: { email: "Eve@Acme.test", st } });
    expect(ok.status).toBe(302);
    expect(ok.location!.pathname).toBe(`/saml/${tenant}/start`);
    expect(ok.location!.search).not.toContain("acme"); // the email never travels in a URL
    const no = await w.call("POST", "/auth/sso", { form: { email: "eve@unverified.test", st } });
    expect(no.text).toContain("Single sign-on isn&#39;t set up for this email.");
    expect((await w.call("POST", "/auth/sso", { body: { email: "bob@acme.test" } })).body).toEqual({ tenantId: tenant, orgName: "Acme" });
    const nf = await w.call("POST", "/auth/sso", { body: { email: "bob@unverified.test" } });
    expect(nf.status).toBe(404);
    expect(nf.body.code).toBe("sso_not_found");
  });

  it("a Google sign-in of a member of an org that requires SAML goes on to the IdP with the app's state; guests never", async () => {
    const tenant = await w.addIdp();
    await w.verifiedDomain("acme.test");
    await w.settings({ authMethod: "saml" });
    // alice (admin; her account a Google one) signs in with Google: no code; the IdP instead
    await w.run(`UPDATE users SET google_sub = 'g-alice' WHERE id = ?1`, w.admin.id);
    const g = await w.googleFlow({ sub: "g-alice", email: "alice@acme.test", name: "Alice" });
    expect(g.res.status).toBe(302);
    expect(g.res.location!.origin + g.res.location!.pathname).toBe("https://idp.example.test/sso");
    const requestId = g.res.location!.searchParams.get("RelayState")!;
    // …and the ACS completes the app's own loopback flow
    const xml = signAssertion(buildResponse({ sp: `${ORIGIN}/saml/${tenant}`, inResponseTo: requestId, nameId: "alice@acme.test" }));
    const done = await w.acs(tenant, xml, requestId);
    expect(done.location!.origin).toBe("http://127.0.0.1:50123");
    const s = await w.token(done.location!, g.verifier);
    expect(s.body.user.id).toBe(w.admin.id);
    // A guest of the org is never checked
    const gus = await w.dev("gus@elsewhere.test");
    await w.run(`INSERT INTO org_members (org_id, email, user_id, role, seat, created_at) VALUES (?1, 'gus@elsewhere.test', ?2, 'guest', 'view', 1)`, w.orgId, gus.id);
    await w.run(`UPDATE users SET google_sub = 'g-gus' WHERE id = ?1`, gus.id);
    const gg = await w.googleFlow({ sub: "g-gus", email: "gus@elsewhere.test" });
    expect(gg.res.location!.searchParams.get("code")).toBeTruthy();
  });

  it("SAML into an org that requires Google is refused (google_required); an unverified domain is sso_domain", async () => {
    const tenant = await w.addIdp();
    await w.verifiedDomain("acme.test");
    expect((await samlSignIn(tenant, "eve@other.test")).res.location!.searchParams.get("error")).toBe("sso_domain");
    await w.settings({ authMethod: "google" });
    expect((await samlSignIn(tenant, "eve@acme.test")).res.location!.searchParams.get("error")).toBe("google_required");
  });
});

describe("accounts linked across methods (decision 5) and JIT (§15.3.4 step 7)", () => {
  it("JIT makes a new member with the default seat, title and name; the configuration becomes tested; logs", async () => {
    const tenant = await w.addIdp(undefined, { tested: false });
    await w.verifiedDomain("acme.test");
    const { res, verifier } = await samlSignIn(tenant, "Eve@Acme.test", { displayName: "Eve Adams", title: "Design Manager" });
    const s = await w.token(res.location!, verifier);
    expect(s.status).toBe(200);
    const [u] = await w.rows(`SELECT * FROM users WHERE email = 'eve@acme.test'`);
    expect(u.google_sub).toBe(`none:${u.id}`);
    expect(u.name).toBe("Eve Adams");
    const m = await member("eve@acme.test");
    expect(m).toMatchObject({ role: "member", seat: "view", provisioned_by: "jit" });
    expect(JSON.parse(m.idp_attributes)).toMatchObject({ title: "Design Manager" });
    expect((await w.rows(`SELECT tested_at FROM idp_configs`))[0].tested_at).not.toBeNull();
    const log = await actions();
    expect(log.some((a) => a.action === "org_user_create" && a.details.jit === true && a.details.seat === "view")).toBe(true);
    expect(log.find((a) => a.action === "user_sign_in" && a.details.method === "saml")).toBeTruthy();
    const [sess] = await w.rows(`SELECT auth_method, auth_org_id FROM sessions WHERE user_id = ?1`, u.id);
    expect(sess).toEqual({ auth_method: "saml", auth_org_id: w.orgId });
  });

  it("a none: account is claimed by the Google sign-in with its email; SAML matches a Google account by email", async () => {
    const tenant = await w.addIdp();
    await w.verifiedDomain("acme.test");
    const a = await samlSignIn(tenant, "eve@acme.test");
    const eve = (await w.token(a.res.location!, a.verifier)).body.user.id;
    const g = await w.googleFlow({ sub: "g-eve", email: "eve@acme.test", name: "Eve G" });
    expect((await w.token(g.res.location!, g.verifier)).body.user.id).toBe(eve);
    expect((await w.rows(`SELECT google_sub FROM users WHERE id = ?1`, eve))[0].google_sub).toBe("g-eve");
    // the other way round: a Google account first, then SAML with the same email
    const g2 = await w.googleFlow({ sub: "g-bob", email: "bob@acme.test" });
    const bob = (await w.token(g2.res.location!, g2.verifier)).body.user.id;
    const b = await samlSignIn(tenant, "bob@acme.test");
    expect((await w.token(b.res.location!, b.verifier)).body.user.id).toBe(bob);
    expect(await w.rows(`SELECT id FROM users WHERE email = 'bob@acme.test'`)).toHaveLength(1);
  });

  it("a guest on a verified domain becomes a member; a person deactivated by SCIM is refused", async () => {
    const tenant = await w.addIdp();
    await w.verifiedDomain("acme.test");
    const gus = await w.dev("gus@acme.test");
    await w.run(`INSERT INTO org_members (org_id, email, user_id, role, seat, created_at) VALUES (?1, 'gus@acme.test', ?2, 'guest', 'view', 1)`, w.orgId, gus.id);
    expect((await samlSignIn(tenant, "gus@acme.test")).res.location!.searchParams.get("code")).toBeTruthy();
    expect((await member("gus@acme.test")).role).toBe("member");
    expect((await actions()).some((a) => a.action === "org_user_permission_change" && a.details.from === "guest")).toBe(true);
    await w.run(`INSERT INTO scim_users (org_id, user_id, user_name, active, created_at, updated_at) VALUES (?1, ?2, 'gus@acme.test', 0, 1, 1)`, w.orgId, gus.id);
    expect((await samlSignIn(tenant, "gus@acme.test")).res.location!.searchParams.get("error")).toBe("sso_failed");
  });
});

describe("Admin › SAML configuration and the SCIM token (§15.13)", () => {
  it("saves the metadata (URL or XML) or the three values, and refuses bad ones naming the field", async () => {
    const t = w.admin.token;
    const path = `/orgs/${w.orgId}/admin/identity/saml`;
    w.metadata.set("https://idp.example.test/app/metadata", idpMetadata({ wrap: true }));
    const r = await w.call("PUT", path, { token: t, body: { provider: "okta", metadataUrl: "https://idp.example.test/app/metadata" } });
    expect(r.status, r.text).toBe(200);
    const idp = r.body.idp;
    expect(idp.tenantId).toMatch(/^\d{18}$/);
    expect(idp).toMatchObject({ provider: "okta", idpEntityId: IDP_ENTITY, ssoUrl: "https://idp.example.test/sso", spEntityId: `${ORIGIN}/saml/${idp.tenantId}`, spAcsUrl: `${ORIGIN}/saml/${idp.tenantId}/consume`, startUrl: `${ORIGIN}/saml/${idp.tenantId}/start`, testedAt: null });
    expect(idp.certificates[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    // the XML, then by hand (base64 DER as IdPs show it); the tenant id never changes
    expect((await w.call("PUT", path, { token: t, body: { provider: "entra", metadataXml: idpMetadata({ certs: [testKeys().idp.cert, testKeys().rotated.cert] }) } })).body.idp.certificates).toHaveLength(2);
    const byHand = await w.call("PUT", path, { token: t, body: { provider: "custom", idpEntityId: "urn:adfs", ssoUrl: "https://adfs.test/adfs/ls", certificate: testKeys().idp.cert.replace(/-----[^-]+-----|\s+/g, ""), signing: "assertion_or_response" } });
    expect(byHand.body.idp).toMatchObject({ tenantId: idp.tenantId, idpEntityId: "urn:adfs", signing: "assertion_or_response" });
    const bad = async (body: unknown) => (await w.call("PUT", path, { token: t, body })).body;
    expect((await bad({ provider: "okta", metadataXml: idpMetadata({ certs: [testKeys().weak.cert] }) })).field).toBe("certificate");
    expect((await bad({ provider: "okta", metadataXml: idpMetadata({ certs: [testKeys().ec.cert] }) })).field).toBe("certificate");
    expect((await bad({ provider: "okta", metadataXml: idpMetadata({ redirect: false }) })).field).toBe("ssoUrl");
    expect((await bad({ provider: "okta", metadataXml: idpMetadata({ certs: [] }) })).field).toBe("certificate");
    expect((await bad({ provider: "okta", metadataUrl: "http://idp.example.test/x" })).field).toBe("metadataUrl");
    expect((await bad({ provider: "okta", metadataUrl: "https://unreachable.test/x" })).field).toBe("metadataUrl");
    expect((await bad({ provider: "okta", metadataXml: `<!DOCTYPE x>${idpMetadata()}` })).field).toBe("metadata");
    expect((await bad({ provider: "x" })).field).toBe("provider");
    expect((await actions()).filter((a) => a.action.startsWith("idp_config")).map((a) => a.action)).toEqual(["idp_config_create", "idp_config_update", "idp_config_update"]);
  });

  it("refuses expired certificates and parses Okta-style metadata", () => {
    expect(() => checkCertificate(testKeys().idp.cert, Date.now() + 400 * 86_400_000)).toThrow(/expired/);
    expect(parseIdpMetadata(idpMetadata()).idpEntityId).toBe(IDP_ENTITY);
  });

  it("requires SAML only once tested; can't remove or change the IdP while required; the SCIM token is one at a time", async () => {
    const t = w.admin.token;
    const base = `/orgs/${w.orgId}/admin/identity`;
    expect((await w.call("POST", `${base}/scim-token`, { token: t })).status).toBe(409);
    await w.call("PUT", `${base}/saml`, { token: t, body: { provider: "okta", metadataXml: idpMetadata() } });
    await expect(w.settings({ authMethod: "saml" })).rejects.toMatchObject({ status: 409, message: "Test SAML SSO first" });
    await w.run(`UPDATE idp_configs SET tested_at = 1`);
    await w.settings({ authMethod: "saml" });
    expect((await actions()).some((a) => a.action === "saml_sso_auth_change" && a.details.to === "saml")).toBe(true);
    expect((await w.call("DELETE", `${base}/saml`, { token: t })).status).toBe(409);
    expect((await w.call("PUT", `${base}/saml`, { token: t, body: { provider: "okta", metadataXml: idpMetadata({ entityId: "https://other.test" }) } })).status).toBe(409);
    const first = await w.call("POST", `${base}/scim-token`, { token: t });
    expect(first.status).toBe(201);
    expect(first.body.token).toMatch(/^dsgn_scim_/);
    const second = await w.call("POST", `${base}/scim-token`, { token: t });
    const overview = await w.call("GET", base, { token: t });
    expect(overview.body).toMatchObject({ authMethod: "saml", domainCapture: false, domains: [] });
    expect(overview.body.scim.baseUrl).toBe(`${ORIGIN}/scim/v2/${overview.body.idp.tenantId}`);
    expect(overview.body.scim.token.id).toBe(second.body.info.id);
    const tenant = overview.body.idp.tenantId;
    expect((await w.call("GET", `/scim/v2/${tenant}/Users`, { token: first.body.token })).status).toBe(401);
    expect((await w.call("GET", `/scim/v2/${tenant}/Users`, { token: second.body.token })).status).toBe(200);
    await w.settings({ authMethod: "any" });
    expect((await w.call("DELETE", `${base}/saml`, { token: t })).status).toBe(204);
    expect((await w.call("GET", `/scim/v2/${tenant}/Users`, { token: second.body.token })).status).toBe(401);
    expect((await actions()).filter((a) => a.action.startsWith("scim_token")).map((a) => a.action)).toEqual(["scim_token_generate", "scim_token_revoke", "scim_token_generate", "scim_token_revoke"]);
  });

  it("is for org admins only", async () => {
    const bob = await w.dev("bob@acme.test");
    await w.run(`INSERT INTO org_members (org_id, email, user_id, role, seat, created_at) VALUES (?1, 'bob@acme.test', ?2, 'member', 'full', 1)`, w.orgId, bob.id);
    const r = await w.call("GET", `/orgs/${w.orgId}/admin/identity`, { token: bob.token });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("not_admin");
    expect((await w.call("POST", `/orgs/${w.orgId}/admin/domains`, { token: bob.token, body: { domain: "acme.test" } })).status).toBe(403);
  });
});

describe("domains over DNS-over-HTTPS (§15.7; answers faked)", () => {
  const base = () => `/orgs/${w.orgId}/admin/domains`;
  it("adds, verifies (found, split strings, absent, NXDOMAIN, resolver down), and refuses a domain taken elsewhere", async () => {
    const t = w.admin.token;
    expect((await w.call("POST", base(), { token: t, body: { domain: "https://Acme.TEST/" } })).body.domain).toMatchObject({ domain: "acme.test", verified: false });
    expect((await w.call("POST", base(), { token: t, body: { domain: "not a domain" } })).status).toBe(400);
    const d = (await w.call("GET", base(), { token: t })).body.domains[0];
    expect(d.txtRecord).toMatch(/^designerv2-domain-verification=[0-9a-f]{32}$/);
    // absent: the values seen come back
    w.dns.set("acme.test", { Status: 0, Answer: [{ name: "acme.test", type: 16, data: '"v=spf1 -all"' }] });
    const absent = await w.call("POST", `${base()}/acme.test/verify`, { token: t });
    expect(absent.status).toBe(409);
    expect(absent.body).toMatchObject({ code: "domain_unverified", found: ["v=spf1 -all"] });
    w.dns.set("acme.test", { Status: 3 });
    expect((await w.call("POST", `${base()}/acme.test/verify`, { token: t })).body.found).toEqual([]);
    w.dns.set("acme.test", 502);
    expect((await w.call("POST", `${base()}/acme.test/verify`, { token: t })).status).toBe(503);
    // found, split into two quoted strings
    const half = d.txtRecord.length >> 1;
    w.dns.set("acme.test", { Status: 0, Answer: [{ type: 5, data: "cname.test." }, { type: 16, data: `"${d.txtRecord.slice(0, half)}" "${d.txtRecord.slice(half)}"` }] });
    const ok = await w.call("POST", `${base()}/acme.test/verify`, { token: t });
    expect(ok.body.domain).toMatchObject({ verified: true });
    // another org can add it but never verify it, and can't add it at all once verified here
    const other = await w.dev("olga@other.test");
    const org2 = (await w.call("POST", "/orgs", { token: other.token, body: { name: "Other" } })).body.org.id;
    const taken = await w.call("POST", `/orgs/${org2}/admin/domains`, { token: other.token, body: { domain: "acme.test" } });
    expect(taken.status).toBe(409);
    expect(taken.body.code).toBe("domain_taken");
    expect((await actions()).filter((a) => a.action.startsWith("org_domain")).map((a) => a.action)).toEqual(["org_domain_add", "org_domain_verify"]);
    expect(txtValue('"a" "b\\"c"')).toBe('ab"c');
  });

  it("removing a domain makes its members guests; the admin's own domain can't be removed; accounts outside are listed", async () => {
    const t = w.admin.token;
    await w.verifiedDomain("acme.test");
    await w.verifiedDomain("acme.dev");
    const bob = await w.dev("bob@acme.dev");
    await w.run(`INSERT INTO org_members (org_id, email, user_id, role, seat, created_at) VALUES (?1, 'bob@acme.dev', ?2, 'member', 'full', 1)`, w.orgId, bob.id);
    await w.dev("carl@acme.dev");
    expect((await w.call("GET", `${base()}/acme.dev/accounts`, { token: t })).body.people.map((p: { email: string }) => p.email)).toEqual(["carl@acme.dev"]);
    expect((await w.call("DELETE", `${base()}/acme.test`, { token: t })).status).toBe(409);
    expect((await w.call("DELETE", `${base()}/acme.dev`, { token: t })).status).toBe(204);
    expect((await member("bob@acme.dev")).role).toBe("guest");
  });
});

describe("domain capture (§15.7)", () => {
  it("needs every domain verified; on, existing accounts join as View members (guests too); sign-ins are captured after", async () => {
    await w.run(`INSERT INTO org_domains (org_id, domain, token, created_at) VALUES (?1, 'acme.test', 't', 1)`, w.orgId);
    await expect(w.settings({ domainCapture: true })).rejects.toMatchObject({ status: 409, code: "domain_unverified" });
    await w.run(`UPDATE org_domains SET verified_at = 1`);
    const carl = await w.dev("carl@acme.test");
    const gus = await w.dev("gus@acme.test");
    await w.run(`INSERT INTO org_members (org_id, email, user_id, role, seat, created_at) VALUES (?1, 'gus@acme.test', ?2, 'guest', 'view', 1)`, w.orgId, gus.id);
    await w.dev("olga@else.test");
    await w.settings({ domainCapture: true });
    expect(await member("carl@acme.test")).toMatchObject({ role: "member", seat: "view" });
    expect((await member("gus@acme.test")).role).toBe("member");
    expect(await member("olga@else.test")).toBeUndefined();
    expect((await actions()).filter((a) => a.action === "org_user_create" && a.details.domain_capture)).toHaveLength(1); // carl (gus was promoted)
    expect((await actions()).some((a) => a.action === "org_domain_capture_change")).toBe(true);
    const n = await w.rows(`SELECT kind FROM notifications WHERE user_id = ?1`, carl.id);
    expect(n.map((r) => r.kind)).toContain("org_domain_captured");
    // a new account signing in with Google on the domain
    const g = await w.googleFlow({ sub: "g-new", email: "new@acme.test" });
    expect(g.res.location!.searchParams.get("code")).toBeTruthy();
    expect(await member("new@acme.test")).toMatchObject({ role: "member", seat: "view" });
  });
});

describe("the idle session timeout (§15.8)", () => {
  const H = 3_600_000;
  it("computes the limit (21 days by default, the shortest over member orgs, none for guests or no org)", async () => {
    const lone = await w.dev("lone@x.test");
    expect((await w.call("GET", "/me", { token: lone.token })).body.session).toMatchObject({ auth: "dev", idleLimitMs: null });
    // alice's session predates her org: the 5-minute touch brings its limit
    w.now.t += 6 * 60_000;
    const me = await w.call("GET", "/me", { token: w.admin.token });
    expect(me.body.session.idleLimitMs).toBe(504 * H);
    await w.settings({ idleSessionTimeoutHours: 12 });
    expect((await w.call("GET", "/me", { token: w.admin.token })).body.session.idleLimitMs).toBe(12 * H);
    await expect(w.settings({ idleSessionTimeoutHours: 11 })).rejects.toMatchObject({ status: 400 });
    await expect(w.settings({ idleSessionTimeoutHours: 337 })).rejects.toMatchObject({ status: 400 });
    // a guest of that org has no limit from it; joining as a member reaches the session within 5 minutes
    await w.run(`INSERT INTO org_members (org_id, email, user_id, role, seat, created_at) VALUES (?1, 'lone@x.test', ?2, 'guest', 'view', 1)`, w.orgId, lone.id);
    w.now.t += 6 * 60_000;
    expect((await w.call("GET", "/me", { token: lone.token })).body.session.idleLimitMs).toBeNull();
    await w.run(`UPDATE org_members SET role = 'member' WHERE user_id = ?1`, lone.id);
    w.now.t += 6 * 60_000;
    expect((await w.call("GET", "/me", { token: lone.token })).body.session.idleLimitMs).toBe(12 * H);
  });

  it("ends an idle session with 401 idle_timeout and logs it; background requests don't count, activity does", async () => {
    await w.settings({ idleSessionTimeoutHours: 12 });
    const bob = await w.dev("bob@acme.test");
    await w.run(`INSERT INTO org_members (org_id, email, user_id, role, seat, created_at) VALUES (?1, 'bob@acme.test', ?2, 'member', 'full', 1)`, w.orgId, bob.id);
    w.now.t += 6 * 60_000;
    await w.call("GET", "/me", { token: bob.token }); // the touch picks up the membership
    // background requests every hour for 11 hours: active_at doesn't move
    for (let i = 0; i < 11; i++) {
      w.now.t += H;
      expect((await w.call("GET", "/files", { token: bob.token })).status).toBe(200);
    }
    const act = await w.call("POST", "/me/sessions/active", { token: bob.token });
    expect(act.body).toEqual({ activeAt: w.now.t, idleLimitMs: 12 * H });
    w.now.t += 12 * H - 1000;
    expect((await w.call("GET", "/files", { token: bob.token })).status).toBe(200);
    w.now.t += 2000;
    const out = await w.call("GET", "/files", { token: bob.token });
    expect(out.status).toBe(401);
    expect(out.body.code).toBe("idle_timeout");
    // the row is gone, the reason remembered: later calls say idle_timeout too (a socket upgrade may have been first)
    const later = await w.call("GET", "/files", { token: bob.token });
    expect([later.status, later.body.code]).toEqual([401, "idle_timeout"]);
    expect((await actions()).filter((a) => a.action === "user_idle_session_timeout")).toHaveLength(1);
    // a plain sign-out of another session isn't one
    const other = await w.dev("bob@acme.test");
    expect((await w.call("DELETE", "/me/sessions/current", { token: other.token })).status).toBe(204);
    expect((await w.call("GET", "/files", { token: other.token })).body.code).toBe("unauthorized");
    expect((await actions()).find((a) => a.action === "user_idle_session_timeout")?.details).toEqual({ logged_on: "request" });
  });

  it("a change of the setting resets everyone's inactivity; the app's own timeout logs at once", async () => {
    await w.settings({ idleSessionTimeoutHours: 12 });
    w.now.t += 11 * H;
    await w.settings({ idleSessionTimeoutHours: 24 });
    expect((await actions()).filter((a) => a.action === "idle_timeout_setting_change").map((a) => a.details)).toEqual([{ from: null, to: 12 }, { from: 12, to: 24 }]);
    w.now.t += 23 * H;
    const me = await w.call("GET", "/me", { token: w.admin.token });
    expect(me.status).toBe(200);
    expect(me.body.session.activeAt).toBe(w.now.t - 23 * H);
    expect((await w.call("DELETE", "/me/sessions/current?reason=idle", { token: w.admin.token })).status).toBe(204);
    expect((await w.call("GET", "/me", { token: w.admin.token })).status).toBe(401);
    expect((await actions()).find((a) => a.action === "user_idle_session_timeout")?.details).toEqual({ logged_on: "client" });
    // a plain Log out of this session
    const again = await w.dev("alice@acme.test");
    expect((await w.call("DELETE", "/me/sessions/current", { token: again.token })).status).toBe(204);
    expect((await actions()).filter((a) => a.action === "user_sign_out")).toHaveLength(1);
  });
});

describe("the web app", () => {
  it("bounces an IdP-initiated sign-in to the web app too", async () => {
    const tenant = await w.addIdp();
    await w.verifiedDomain("acme.test");
    const r = await w.acs(tenant, signAssertion(buildResponse({ sp: `${ORIGIN}/saml/${tenant}`, inResponseTo: null })));
    expect(r.text).toContain(`${WEB}/?sso=${tenant}`);
    const page = await w.call("GET", `/saml/${tenant}/start`);
    expect(page.text).toContain("Log in from the Designer app");
  });
});
