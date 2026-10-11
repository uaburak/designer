// Round 1e spike: a minimal SAML 2.0 service provider in a Cloudflare Worker (nodejs_compat).
// Never deployed and not wired into server/src — see README.md. Routes, per tenant (an org):
//   GET  /saml/:tenant/metadata   SP metadata (entity id, ACS, NameID format, AuthnRequestsSigned=false)
//   GET  /saml/:tenant/login      AuthnRequest over HTTP-Redirect (302 to the IdP; the request id is remembered)
//   POST /saml/:tenant/acs        the HTTP-POST binding: the Response is verified, then 200 {profile} or 403 {error}
// Signature checking and the SAML conditions are @node-saml/node-saml's (xml-crypto + @xmldom/xmldom underneath); the
// checks it leaves to the SP (Recipient, Destination, the signed InResponseTo, assertion replay) are ours, run on the
// XML node-saml returns as *verified* — never on the raw document.
import { SAML, ValidateInResponseTo, type CacheProvider, type CacheItem } from "@node-saml/node-saml";
import { DOMParser } from "@xmldom/xmldom";
import { IDP_CERT } from "./trust.generated";

/** What a real org row would hold (D1 `org_saml`): the IdP's entity id, SSO URL and signing certificate(s). */
interface TenantConfig { idpEntityId: string; idpSsoUrl: string; idpCerts: string[] }
const TENANTS: Record<string, TenantConfig> = {
  acme: { idpEntityId: "https://idp.spike.test/metadata", idpSsoUrl: "https://idp.spike.test/sso", idpCerts: [IDP_CERT] },
};
const SP_ORIGIN = "https://designer.spike.test";
const REQUEST_TTL_MS = 10 * 60 * 1000;

/**
 * Outstanding AuthnRequest ids. In the spike a module Map (one isolate under Miniflare); in production a D1 table
 * `saml_requests(id PRIMARY KEY, tenant, created_at)` with the consume done as one `DELETE … RETURNING` so two
 * concurrent posts of the same Response cannot both pass.
 */
class RequestIdCache implements CacheProvider {
  private items = new Map<string, CacheItem>();
  async saveAsync(key: string, value: string): Promise<CacheItem | null> {
    if (this.items.has(key)) return null;
    const item = { value, createdAt: Date.now() };
    this.items.set(key, item);
    return item;
  }
  async getAsync(key: string): Promise<string | null> {
    const item = this.items.get(key);
    if (!item) return null;
    if (Date.now() - item.createdAt > REQUEST_TTL_MS) { this.items.delete(key); return null; }
    return item.value;
  }
  async removeAsync(key: string | null): Promise<string | null> {
    if (key == null) return null;
    const item = this.items.get(key);
    this.items.delete(key);
    return item?.value ?? null;
  }
}
const requestIds = new RequestIdCache();

/** Assertion ids already accepted, kept until their NotOnOrAfter (D1 `saml_assertions(id PRIMARY KEY, expires_at)`, INSERT fails on replay). */
const seenAssertions = new Map<string, number>();
function consumeAssertionId(id: string, expiresAtMs: number): boolean {
  const now = Date.now();
  for (const [k, exp] of seenAssertions) if (exp < now) seenAssertions.delete(k);
  if (seenAssertions.has(id)) return false;
  seenAssertions.set(id, expiresAtMs);
  return true;
}

function samlFor(tenant: string, cfg: TenantConfig): SAML {
  const base = `${SP_ORIGIN}/saml/${tenant}`;
  return new SAML({
    issuer: `${base}/metadata`, // our SP entity id
    audience: `${base}/metadata`,
    callbackUrl: `${base}/acs`,
    entryPoint: cfg.idpSsoUrl,
    idpIssuer: cfg.idpEntityId,
    idpCert: cfg.idpCerts,
    wantAssertionsSigned: true, // the assertion itself must carry a valid signature…
    wantAuthnResponseSigned: false, // …the Response envelope may or may not (Okta / Entra sign the assertion by default)
    signatureAlgorithm: "sha256",
    identifierFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
    validateInResponseTo: ValidateInResponseTo.always, // SP-initiated only; IdP-initiated would need its own decision
    requestIdExpirationPeriodMs: REQUEST_TTL_MS,
    cacheProvider: requestIds,
    acceptedClockSkewMs: 60_000,
    maxAssertionAgeMs: 5 * 60_000,
    disableRequestedAuthnContext: true,
  });
}

const NS = { saml: "urn:oasis:names:tc:SAML:2.0:assertion", samlp: "urn:oasis:names:tc:SAML:2.0:protocol" };

/** The SP-side checks node-saml leaves to us, on the verified assertion XML. Throws with a reason. */
function checkVerifiedAssertion(assertionXml: string, rawResponseXml: string, acsUrl: string, cfg: TenantConfig): { id: string; expiresAtMs: number } {
  const doc = new DOMParser().parseFromString(assertionXml, "text/xml");
  const a = doc.documentElement;
  if (!a || a.localName !== "Assertion" || a.namespaceURI !== NS.saml) throw new Error("verified content is not an Assertion");
  const id = a.getAttribute("ID");
  if (!id) throw new Error("assertion has no ID");
  const issuer = a.getElementsByTagNameNS(NS.saml, "Issuer")[0]?.textContent?.trim();
  if (issuer !== cfg.idpEntityId) throw new Error("assertion issuer mismatch");
  // Bearer SubjectConfirmationData: Recipient must be our ACS, InResponseTo must be present (it is signed here).
  const confirmations = Array.from(a.getElementsByTagNameNS(NS.saml, "SubjectConfirmation"))
    .filter((c) => c.getAttribute("Method") === "urn:oasis:names:tc:SAML:2.0:cm:bearer");
  if (confirmations.length !== 1) throw new Error("expected exactly one bearer SubjectConfirmation");
  const data = confirmations[0].getElementsByTagNameNS(NS.saml, "SubjectConfirmationData")[0];
  if (!data) throw new Error("SubjectConfirmationData missing");
  if (data.getAttribute("Recipient") !== acsUrl) throw new Error("Recipient mismatch");
  if (!data.getAttribute("InResponseTo")) throw new Error("signed InResponseTo missing");
  const notOnOrAfter = data.getAttribute("NotOnOrAfter");
  if (!notOnOrAfter) throw new Error("SubjectConfirmationData NotOnOrAfter missing");
  // Destination on the Response (SAML core 3.2.2: must match where it was received when present).
  const resp = new DOMParser().parseFromString(rawResponseXml, "text/xml").documentElement;
  const dest = resp?.getAttribute("Destination");
  if (dest && dest !== acsUrl) throw new Error("Destination mismatch");
  return { id, expiresAtMs: Date.parse(notOnOrAfter) };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/saml\/([a-z0-9-]+)\/(metadata|login|acs)$/);
    if (!m) return json(404, { error: "not found" });
    const [, tenant, route] = m;
    const cfg = TENANTS[tenant];
    if (!cfg) return json(404, { error: "unknown tenant" });
    const saml = samlFor(tenant, cfg);
    const acsUrl = `${SP_ORIGIN}/saml/${tenant}/acs`;

    if (route === "metadata" && request.method === "GET") {
      return new Response(saml.generateServiceProviderMetadata(null, null), { headers: { "content-type": "application/samlmetadata+xml" } });
    }
    if (route === "login" && request.method === "GET") {
      const relayState = url.searchParams.get("relay") ?? "";
      const location = await saml.getAuthorizeUrlAsync(relayState, url.host, {});
      return new Response(null, { status: 302, headers: { location } });
    }
    if (route === "acs" && request.method === "POST") {
      try {
        const form = await request.formData();
        const SAMLResponse = form.get("SAMLResponse");
        if (typeof SAMLResponse !== "string" || SAMLResponse.length > 256 * 1024) throw new Error("SAMLResponse missing or too large");
        const raw = Buffer.from(SAMLResponse, "base64").toString("utf8");
        if (/<!DOCTYPE/i.test(raw)) throw new Error("DTDs are not accepted");
        const { profile } = await saml.validatePostResponseAsync({ SAMLResponse });
        if (!profile) throw new Error("no profile");
        const assertionXml = profile.getAssertionXml?.();
        if (!assertionXml) throw new Error("no verified assertion");
        const { id, expiresAtMs } = checkVerifiedAssertion(assertionXml, raw, acsUrl, cfg);
        if (!consumeAssertionId(id, expiresAtMs)) throw new Error("assertion replayed");
        // A real ACS would now JIT-provision the member and continue the loopback / PKCE hand-off (multiplayer.md §2).
        return json(200, { nameID: profile.nameID, nameIDFormat: profile.nameIDFormat, issuer: profile.issuer, sessionIndex: profile.sessionIndex, email: profile.email ?? profile.mail ?? null });
      } catch (e) {
        return json(403, { error: e instanceof Error ? e.message : String(e) });
      }
    }
    return json(405, { error: "method not allowed" });
  },
};
