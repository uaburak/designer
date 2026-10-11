/**
 * The SAML SP (docs/multiplayer.md §15.3): the round 1e spike's 29 cases (server/spikes/saml/README.md) moved onto the
 * real routes — GET /saml/:t (metadata), the SP-initiated flow from the app's /auth/login?tenant= to the IdP, the ACS
 * — plus SHA-1 refused, encrypted assertions refused, the unsolicited bounce, two concurrent posts of one Response, the
 * per-tenant signing policy and certificate rotation. Responses are built and signed by a test IdP in Node
 * (testing/samlIdp.ts). The gate for every bump of @node-saml/node-saml, @xmldom/xmldom or xml-crypto.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ORIGIN, identityWorld, type Answer, type IdentityWorld } from "../../testing/identityWorld";
import { EVIL, appendForgedAssertion, buildResponse, injectComment, newId, signAssertion, signBoth, signResponse, tamperNameId, testKeys, xsw, type ResponseOptions, type SignOptions } from "../../testing/samlIdp";

let w: IdentityWorld;
let tenant: string;
let sp: string;
const reasons: string[] = [];

beforeAll(() => void testKeys(), 30_000);
beforeEach(async () => {
  w = await identityWorld();
  tenant = await w.addIdp();
  sp = `${ORIGIN}/saml/${tenant}`;
  await w.verifiedDomain("acme.test");
  reasons.length = 0;
  vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => void reasons.push(a.map(String).join(" ")));
});
afterEach(() => vi.restoreAllMocks());

/** A Response for a fresh SP-initiated request (or `inResponseTo` as given) */
async function signedFor(sign: (xml: string, o?: SignOptions) => string, o: Partial<ResponseOptions> = {}, signOpts?: SignOptions): Promise<{ xml: string; relay: string | undefined; verifier: string }> {
  let relay: string | undefined;
  let verifier = "";
  let inResponseTo: string | null;
  if ("inResponseTo" in o) inResponseTo = o.inResponseTo!;
  else {
    const s = await w.samlStart(tenant);
    inResponseTo = relay = s.requestId;
    verifier = s.verifier;
  }
  return { xml: sign(buildResponse({ sp, ...o, inResponseTo }), signOpts), relay, verifier };
}

const post = (r: { xml: string; relay?: string }) => w.acs(tenant, r.xml, r.relay);
const signedIn = (r: Answer) => r.status === 302 && !!r.location?.searchParams.get("code");
function accepted(r: Answer) {
  expect(r.status, r.text).toBe(302);
  expect(r.location!.origin + r.location!.pathname).toBe("http://127.0.0.1:50123/callback");
  expect(r.location!.searchParams.get("code")).toBeTruthy();
}
/** Refused: the 403 page, or the app's loopback with an error — never a code */
function rejected(r: Answer, error = "sso_failed") {
  expect(signedIn(r), `${r.status} ${r.location}`).toBe(false);
  if (r.status === 302) expect(r.location!.searchParams.get("error")).toBe(error);
  else expect(r.status).toBe(403);
}
const lastReason = () => reasons[reasons.length - 1] ?? "";

describe("the spike's 29 cases, on the real routes", () => {
  it("serves the SP metadata at the SP entity id", async () => {
    const r = await w.call("GET", `/saml/${tenant}`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("application/samlmetadata+xml");
    expect(r.text).toContain(`entityID="${sp}"`);
    expect(r.text).toContain(`Location="${sp}/consume"`);
    expect(r.text).toContain("urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST");
    expect(r.text).toContain('AuthnRequestsSigned="false"');
    expect(r.text).toContain('WantAssertionsSigned="true"');
    expect(r.text).toContain("urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress");
    expect((await w.call("GET", `/saml/999999999999999999`)).status).toBe(404);
  });

  it("valid: the assertion signed (Okta / Entra default) — a code on the loopback, a SAML session", async () => {
    const r = await signedFor(signAssertion);
    const res = await post(r);
    accepted(res);
    const s = await w.token(res.location!, r.verifier);
    expect(s.status).toBe(200);
    expect(s.body.user.email).toBe("eve@acme.test");
    const me = await w.call("GET", "/me", { token: s.body.token });
    expect(me.body.session).toMatchObject({ auth: "saml" });
  });

  it("valid: the Response and the assertion both signed", async () => accepted(await post(await signedFor(signBoth))));

  for (const [name, attack] of Object.entries(xsw)) {
    const base = name === "XSW1" || name === "XSW2" ? signBoth : signAssertion;
    it(`${name} is rejected`, async () => {
      const r = await signedFor(base);
      rejected(await post({ ...r, xml: attack(r.xml) }));
      expect(await w.rows(`SELECT id FROM users WHERE email = ?1`, EVIL)).toHaveLength(0);
    });
  }
  it("XSW1 / XSW2 also rejected when only the Response was signed", async () => {
    for (const attack of [xsw.XSW1, xsw.XSW2]) {
      const r = await signedFor(signResponse);
      rejected(await post({ ...r, xml: attack(r.xml) }));
    }
  });
  it("a forged second assertion after the signed one is rejected", async () => {
    const r = await signedFor(signAssertion);
    rejected(await post({ ...r, xml: appendForgedAssertion(r.xml) }));
  });

  it("an unsigned assertion is rejected", async () => rejected(await post(await signedFor((x) => x))));
  it("only the Response signed is rejected (the tenant requires a signed assertion)", async () => rejected(await post(await signedFor(signResponse))));
  it("signed by an untrusted key with its own certificate in KeyInfo is rejected", async () => rejected(await post(await signedFor(signAssertion, {}, { signer: testKeys().attacker }))));
  it("the NameID changed after signing is rejected", async () => {
    const r = await signedFor(signAssertion);
    rejected(await post({ ...r, xml: tamperNameId(r.xml) }));
  });
  it("comment injection in the NameID never yields the truncated identity", async () => {
    // The IdP signs admin@acme.test.evil.test; the comment splits it. We read the whole signed value — not on a
    // verified domain, so refused (sso_domain) — never admin@acme.test.
    const r = await signedFor(signAssertion, { nameId: "admin@acme.test.evil.test" });
    const res = await post({ ...r, xml: injectComment(r.xml, "admin@acme.test", ".evil.test") });
    expect(signedIn(res)).toBe(false);
    expect(await w.rows(`SELECT id FROM users WHERE email = ?1`, EVIL)).toHaveLength(0);
  });
  it("a DOCTYPE (entity expansion / XXE) is rejected before parsing", async () => {
    const r = await signedFor(signAssertion);
    rejected(await post({ ...r, xml: `<?xml version="1.0"?><!DOCTYPE r [<!ENTITY x "${EVIL}">]>` + r.xml }));
    expect(lastReason()).toContain("DTD");
  });

  it("expired (NotOnOrAfter in the past) is rejected", async () => rejected(await post(await signedFor(signAssertion, { notBefore: -20 * 60_000, notOnOrAfter: -10 * 60_000 }))));
  it("not yet valid (NotBefore in the future) is rejected", async () => rejected(await post(await signedFor(signAssertion, { notBefore: 10 * 60_000, notOnOrAfter: 20 * 60_000 }))));
  it("a wrong Audience is rejected", async () => rejected(await post(await signedFor(signAssertion, { audience: "https://other-sp.test/metadata" }))));
  it("a wrong Recipient is rejected", async () => {
    rejected(await post(await signedFor(signAssertion, { recipient: "https://other-sp.test/acs" })));
    expect(lastReason()).toContain("Recipient");
  });
  it("a wrong Destination is rejected", async () => {
    rejected(await post(await signedFor(signAssertion, { destination: "https://other-sp.test/acs" })));
    expect(lastReason()).toContain("Destination");
  });
  it("a wrong issuer is rejected", async () => rejected(await post(await signedFor(signAssertion, { issuer: "https://evil-idp.test/metadata" }))));
  it("an unknown InResponseTo is rejected", async () => rejected(await post(await signedFor(signAssertion, { inResponseTo: newId() }))));
  it("a missing InResponseTo (unsolicited) never makes a session: the bounce page", async () => {
    const res = await post(await signedFor(signAssertion, { inResponseTo: null }));
    expect(res.status).toBe(200);
    expect(res.text).toContain("Continue to DesignerV2");
    expect(res.text).toContain(`designerv2://sign-in?tenant=${tenant}`);
    expect(signedIn(res)).toBe(false);
    expect(await w.rows(`SELECT id FROM users WHERE email = 'eve@acme.test'`)).toHaveLength(0);
  });
  it("a replay of an accepted Response is rejected (the request id is consumed)", async () => {
    const r = await signedFor(signAssertion);
    accepted(await post(r));
    rejected(await post(r));
  });
  it("a replay of an accepted assertion id under a fresh request is rejected", async () => {
    const assertionId = newId();
    accepted(await post(await signedFor(signAssertion, { assertionId })));
    const res = await post(await signedFor(signAssertion, { assertionId }));
    rejected(res);
    expect(lastReason()).toContain("assertion replayed");
  });
});

describe("round 4's additions", () => {
  it("refuses SHA-1 on the assertion's signature and on the Response's", async () => {
    rejected(await post(await signedFor(signAssertion, {}, { alg: "sha1" })));
    expect(lastReason()).toMatch(/algorithm refused/);
    // A SHA-256 assertion inside a SHA-1-signed Response: refused too
    const r = await signedFor(signAssertion);
    rejected(await post({ ...r, xml: signResponse(r.xml, { alg: "sha1" }) }));
    expect(lastReason()).toMatch(/algorithm refused/);
    // SHA-512 is fine
    accepted(await post(await signedFor(signAssertion, {}, { alg: "sha512" })));
  });

  it("refuses an EncryptedAssertion", async () => {
    rejected(await post(await signedFor((x) => x, { encrypted: true })));
    expect(lastReason()).toContain("encrypted");
  });

  it("an unsolicited Response replayed is refused even on the bounce path; the bounce starts a normal flow", async () => {
    const r = await signedFor(signAssertion, { inResponseTo: null });
    expect((await post(r)).status).toBe(200);
    rejected(await post(r));
    // "Continue" in the app → /auth/login?tenant= → the IdP again (SP-initiated)
    const s = await w.samlStart(tenant);
    expect(s.request).toContain(`AssertionConsumerServiceURL="${sp}/consume"`);
  });

  it("two concurrent posts of one Response: exactly one signs in", async () => {
    const r = await signedFor(signAssertion);
    const both = await Promise.all([post(r), post(r)]);
    expect(both.filter(signedIn)).toHaveLength(1);
  });

  it("sends the AuthnRequest of §15.3.3: unsigned, to the IdP, our ACS and issuer, NameID email, RelayState = its id", async () => {
    const s = await w.samlStart(tenant);
    expect(s.request).toContain(`Destination="https://idp.example.test/sso"`);
    expect(s.request).toContain(`AssertionConsumerServiceURL="${sp}/consume"`);
    expect(s.request).toContain("urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST");
    expect(s.request).toContain(`>${sp}</saml:Issuer>`);
    expect(s.request).toContain('Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress"');
    expect(s.request).not.toContain("Signature");
    expect(s.requestId).toMatch(/^_[0-9a-f]{32}$/);
    const [row] = await w.rows(`SELECT state, expires_at FROM saml_requests WHERE id = ?1`, s.requestId);
    expect(JSON.parse(row.state)).toMatchObject({ p: 50123 });
    expect(row.expires_at - w.now.t).toBe(10 * 60_000);
  });

  it("an expired request (10 minutes) is refused", async () => {
    const r = await signedFor(signAssertion);
    await w.run(`UPDATE saml_requests SET expires_at = ?1`, w.now.t - 1);
    rejected(await post(r));
  });

  it("assertion_or_response: a signed Response envelope is enough, and XSW1 / XSW2 still fail", async () => {
    await w.run(`UPDATE idp_configs SET signing = 'assertion_or_response'`);
    accepted(await post(await signedFor(signResponse)));
    const meta = await w.call("GET", `/saml/${tenant}`);
    expect(meta.text).toContain('WantAssertionsSigned="false"');
    for (const attack of [xsw.XSW1, xsw.XSW2]) {
      const r = await signedFor(signResponse);
      rejected(await post({ ...r, xml: attack(r.xml) }));
    }
    rejected(await post(await signedFor((x) => x)));
  });

  it("two certificates (rotation): either signs", async () => {
    await w.run(`UPDATE idp_configs SET certificates = ?1`, JSON.stringify([testKeys().idp.cert, testKeys().rotated.cert]));
    accepted(await post(await signedFor(signAssertion)));
    accepted(await post(await signedFor(signAssertion, {}, { signer: testKeys().rotated })));
    rejected(await post(await signedFor(signAssertion, {}, { signer: testKeys().attacker })));
  });

  it("a post too large, not a form, or without SAMLResponse is the 403 page", async () => {
    expect((await w.call("POST", `/saml/${tenant}/consume`, { form: { RelayState: "x" } })).status).toBe(403);
    expect((await w.call("POST", `/saml/${tenant}/consume`, { body: { SAMLResponse: "x" } })).status).toBe(403);
    const big = await w.call("POST", `/saml/${tenant}/consume`, { form: { SAMLResponse: "A".repeat(300 * 1024) } });
    expect(big.status).toBe(403);
    expect(big.text).toContain("Single sign-on didn't work");
  });
});
