/**
 * The SAML service provider of one org (docs/multiplayer.md §15.3): @node-saml/node-saml 5.1.0 under `nodejs_compat`,
 * wrapped by the checks it leaves to the SP — run on the XML it returns as *verified*, never on the raw post (the
 * round 1e spike, server/spikes/saml/README.md). Pure: no D1 here (the request cache is passed in).
 *
 * URLs (Figma's shapes, decision 2): SP entity id and metadata `<origin>/saml/<tenantId>`, ACS `…/consume`, start
 * `…/start`.
 */
import { DOMParser, SAML, ValidateInResponseTo, loadSamlLib, type CacheProvider, type Profile, type XDocument, type XElement, type XNode } from "./lib.js";

export const NS = {
  saml: "urn:oasis:names:tc:SAML:2.0:assertion",
  samlp: "urn:oasis:names:tc:SAML:2.0:protocol",
  ds: "http://www.w3.org/2000/09/xmldsig#",
  md: "urn:oasis:names:tc:SAML:2.0:metadata",
};
export const EMAIL_FORMAT = "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress";
export const UNSPECIFIED_FORMAT = "urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified";
export const REDIRECT_BINDING = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect";
export const REQUEST_TTL_MS = 10 * 60_000;
export const MAX_POST_BYTES = 256 * 1024;

/** §15.3.4 step 3: RSA with SHA-256 / 384 / 512 only — SHA-1 (`rsa-sha1`, `xmldsig#sha1`) is refused */
export const SIGNATURE_METHODS = new Set([
  "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
  "http://www.w3.org/2001/04/xmldsig-more#rsa-sha384",
  "http://www.w3.org/2001/04/xmldsig-more#rsa-sha512",
]);
export const DIGEST_METHODS = new Set(["http://www.w3.org/2001/04/xmlenc#sha256", "http://www.w3.org/2001/04/xmldsig-more#sha384", "http://www.w3.org/2001/04/xmlenc#sha512"]);

/** What the SP needs of `idp_configs` */
export interface SpConfig {
  tenantId: string;
  idpEntityId: string;
  ssoUrl: string;
  /** PEM, ≤ 2 */
  certificates: string[];
  signing: "assertion" | "assertion_or_response";
}

export const spUrls = (origin: string, tenantId: string) => {
  const entityId = `${origin}/saml/${tenantId}`;
  return { entityId, acs: `${entityId}/consume`, start: `${entityId}/start` };
};

/** A refusal; `reason` goes to the log line only (the person sees "Single sign-on didn't work") */
export class SamlError extends Error {}

export function samlFor(origin: string, cfg: SpConfig, opts: { cache: CacheProvider; inResponseTo: "always" | "never"; requestId?: string }): SAML {
  const u = spUrls(origin, cfg.tenantId);
  return new SAML({
    issuer: u.entityId,
    audience: u.entityId,
    callbackUrl: u.acs,
    entryPoint: cfg.ssoUrl,
    idpIssuer: cfg.idpEntityId,
    idpCert: cfg.certificates,
    wantAssertionsSigned: cfg.signing === "assertion",
    wantAuthnResponseSigned: false,
    signatureAlgorithm: "sha256",
    identifierFormat: EMAIL_FORMAT,
    allowCreate: true,
    validateInResponseTo: opts.inResponseTo === "always" ? ValidateInResponseTo.always : ValidateInResponseTo.never,
    requestIdExpirationPeriodMs: REQUEST_TTL_MS,
    cacheProvider: opts.cache,
    acceptedClockSkewMs: 60_000,
    maxAssertionAgeMs: 5 * 60_000,
    disableRequestedAuthnContext: true,
    ...(opts.requestId ? { generateUniqueId: () => opts.requestId! } : {}),
  });
}

/** `GET /saml/:tenantId` (§15.3.2): no key of ours (AuthnRequests unsigned, no encrypted assertions) */
export function spMetadata(origin: string, cfg: Pick<SpConfig, "tenantId" | "signing">): string {
  const u = spUrls(origin, cfg.tenantId);
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  return (
    `<?xml version="1.0"?>\n<EntityDescriptor xmlns="${NS.md}" entityID="${esc(u.entityId)}">` +
    `<SPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol" AuthnRequestsSigned="false" WantAssertionsSigned="${cfg.signing === "assertion"}">` +
    `<NameIDFormat>${EMAIL_FORMAT}</NameIDFormat>` +
    `<AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${esc(u.acs)}" index="0" isDefault="true"/>` +
    `</SPSSODescriptor></EntityDescriptor>`
  );
}

/** The redirect to the IdP (§15.3.3): an unsigned AuthnRequest with this id, RelayState = the id */
export async function authnRedirect(origin: string, cfg: SpConfig, requestId: string): Promise<string> {
  await loadSamlLib();
  const noCache: CacheProvider = { saveAsync: async () => null, getAsync: async () => null, removeAsync: async () => null };
  const saml = samlFor(origin, cfg, { cache: noCache, inResponseTo: "never", requestId });
  return saml.getAuthorizeUrlAsync(requestId, undefined, {});
}

const children = (n: XElement, ns: string, local: string): XElement[] => Array.from(n.childNodes).filter((c): c is XElement => c.nodeType === 1 && (c as XElement).namespaceURI === ns && (c as XElement).localName === local);
const all = (n: XDocument | XElement, ns: string, local: string): XElement[] => Array.from(n.getElementsByTagNameNS(ns, local));

/** xmldom with every error (not warnings) refused */
export function parseXml(xml: string): XDocument {
  const errors: string[] = [];
  let doc: XDocument;
  try {
    doc = new DOMParser({ errorHandler: (level, msg) => void (level !== "warning" && errors.push(msg)) }).parseFromString(xml, "text/xml");
  } catch (e) {
    throw new SamlError(`malformed XML: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (errors.length || !doc.documentElement) throw new SamlError(`malformed XML: ${errors[0] ?? "empty"}`);
  return doc;
}

/** What the raw post says before verification (only used to pick the path; everything that matters is re-read signed) */
export interface RawResponse {
  xml: string;
  /** `Response/@InResponseTo` or any `SubjectConfirmationData/@InResponseTo` */
  solicited: boolean;
  destination: string | null;
}

/** §15.3.4 step 1 and the parts of step 3 that hold for the whole document: size, DOCTYPE, encryption, algorithms */
export function readRawResponse(samlResponse: string): RawResponse {
  if (samlResponse.length > MAX_POST_BYTES) throw new SamlError("SAMLResponse too large");
  let xml: string;
  try {
    xml = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(Uint8Array.from(atob(samlResponse.replace(/\s+/g, "")), (c) => c.charCodeAt(0)));
  } catch {
    throw new SamlError("SAMLResponse is not base64 UTF-8");
  }
  if (/<!DOCTYPE/i.test(xml)) throw new SamlError("DTDs are not accepted");
  const doc = parseXml(xml);
  const root = doc.documentElement!;
  if (root.namespaceURI !== NS.samlp || root.localName !== "Response") throw new SamlError("not a SAML Response");
  if (all(doc, NS.saml, "EncryptedAssertion").length) throw new SamlError("encrypted assertions are not accepted");
  // Every signature in the document, the verified one among them: SHA-1 anywhere is refused.
  for (const m of all(doc, NS.ds, "SignatureMethod")) if (!SIGNATURE_METHODS.has(m.getAttribute("Algorithm") ?? "")) throw new SamlError(`signature algorithm refused: ${m.getAttribute("Algorithm")}`);
  for (const m of all(doc, NS.ds, "DigestMethod")) if (!DIGEST_METHODS.has(m.getAttribute("Algorithm") ?? "")) throw new SamlError(`digest algorithm refused: ${m.getAttribute("Algorithm")}`);
  const solicited = !!root.getAttribute("InResponseTo") || all(doc, NS.saml, "SubjectConfirmationData").some((d) => !!d.getAttribute("InResponseTo"));
  return { xml, solicited, destination: root.getAttribute("Destination") || null };
}

/** The verified assertion's facts (§15.3.4 step 3) */
export interface VerifiedAssertion {
  id: string;
  /** The signed `SubjectConfirmationData/@InResponseTo`, or null (unsolicited) */
  inResponseTo: string | null;
  /** SubjectConfirmationData NotOnOrAfter, else Conditions NotOnOrAfter, else now + 5 min */
  expiresAt: number;
  nameId: string | null;
  nameIdFormat: string | null;
  attributes: Record<string, string>;
}

/** The SP-side checks node-saml leaves to us, on the verified assertion XML only. Throws SamlError. */
export function checkVerifiedAssertion(assertionXml: string, raw: RawResponse, acsUrl: string, idpEntityId: string, now: number): VerifiedAssertion {
  const a = parseXml(assertionXml).documentElement!;
  if (a.localName !== "Assertion" || a.namespaceURI !== NS.saml) throw new SamlError("verified content is not an Assertion");
  const id = a.getAttribute("ID");
  if (!id) throw new SamlError("assertion has no ID");
  const issuer = children(a, NS.saml, "Issuer")[0]?.textContent?.trim();
  if (issuer !== idpEntityId) throw new SamlError("assertion issuer mismatch");
  const subject = children(a, NS.saml, "Subject")[0];
  if (!subject) throw new SamlError("no Subject");
  const bearer = children(subject, NS.saml, "SubjectConfirmation").filter((c) => c.getAttribute("Method") === "urn:oasis:names:tc:SAML:2.0:cm:bearer");
  if (bearer.length !== 1) throw new SamlError("expected exactly one bearer SubjectConfirmation");
  const data = children(bearer[0], NS.saml, "SubjectConfirmationData")[0];
  if (!data) throw new SamlError("SubjectConfirmationData missing");
  if (data.getAttribute("Recipient") !== acsUrl) throw new SamlError("Recipient mismatch");
  if (raw.destination && raw.destination !== acsUrl) throw new SamlError("Destination mismatch");
  const conditions = children(a, NS.saml, "Conditions")[0];
  const noa = data.getAttribute("NotOnOrAfter") ?? conditions?.getAttribute("NotOnOrAfter") ?? null;
  const parsed = noa ? Date.parse(noa) : NaN;
  const nameIdEl = children(subject, NS.saml, "NameID")[0];
  const attributes: Record<string, string> = {};
  for (const st of children(a, NS.saml, "AttributeStatement"))
    for (const at of children(st, NS.saml, "Attribute")) {
      const name = at.getAttribute("Name");
      const v = children(at, NS.saml, "AttributeValue")[0];
      if (name && v && !(name in attributes)) attributes[name] = textOf(v).trim();
    }
  return {
    id,
    inResponseTo: data.getAttribute("InResponseTo") || null,
    expiresAt: Number.isFinite(parsed) ? parsed : now + 5 * 60_000,
    nameId: nameIdEl ? textOf(nameIdEl).trim() : null,
    nameIdFormat: nameIdEl?.getAttribute("Format") ?? null,
    attributes,
  };
}

/** Text content with comments dropped (they are, by C14N: CVE-2017-11427's split NameID reads whole) */
function textOf(n: XNode): string {
  let s = "";
  for (const c of Array.from(n.childNodes)) {
    if (c.nodeType === 3 || c.nodeType === 4) s += c.nodeValue ?? "";
    else if (c.nodeType === 1) s += textOf(c);
  }
  return s;
}

/** node-saml's verification, then ours. `inResponseTo: "never"` on the unsolicited path. */
export async function verifyResponse(origin: string, cfg: SpConfig, samlResponse: string, cache: CacheProvider, now: number): Promise<{ assertion: VerifiedAssertion; profile: Profile; raw: RawResponse }> {
  await loadSamlLib();
  const raw = readRawResponse(samlResponse);
  const saml = samlFor(origin, cfg, { cache, inResponseTo: raw.solicited ? "always" : "never" });
  let profile: Profile | null;
  try {
    ({ profile } = await saml.validatePostResponseAsync({ SAMLResponse: samlResponse }));
  } catch (e) {
    throw new SamlError(e instanceof Error ? e.message : String(e));
  }
  const xml = profile?.getAssertionXml?.();
  if (!profile || !xml) throw new SamlError("no verified assertion");
  const assertion = checkVerifiedAssertion(xml, raw, spUrls(origin, cfg.tenantId).acs, cfg.idpEntityId, now);
  return { assertion, profile, raw };
}

const EMAIL_ATTRS = ["email", "emailaddress", "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress", "username"];

/** §15.3.4 step 6: the NameID when it is an email, else the first email attribute. Null: none. */
export function assertionEmail(a: VerifiedAssertion): string | null {
  const ok = (v: string | null | undefined) => (v && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()) ? v.trim().toLowerCase() : null);
  if (a.nameId && (a.nameIdFormat === null || a.nameIdFormat === EMAIL_FORMAT || a.nameIdFormat === UNSPECIFIED_FORMAT)) {
    const e = ok(a.nameId);
    if (e) return e;
  }
  const lower = Object.fromEntries(Object.entries(a.attributes).map(([k, v]) => [k.toLowerCase(), v]));
  for (const k of EMAIL_ATTRS) {
    const e = ok(lower[k]);
    if (e) return e;
  }
  return null;
}

/** Name and title from the attributes Figma reads (`displayName`, `givenName`, `familyName`, `title`) */
export function assertionPerson(a: VerifiedAssertion): { name: string | null; title: string | null } {
  const lower = Object.fromEntries(Object.entries(a.attributes).map(([k, v]) => [k.toLowerCase().replace(/^.*\//, ""), v]));
  const display = lower["displayname"] || null;
  const given = lower["givenname"] || lower["firstname"] || "";
  const family = lower["familyname"] || lower["surname"] || lower["lastname"] || "";
  const name = display || `${given} ${family}`.trim() || null;
  return { name: name ? name.slice(0, 100) : null, title: lower["title"] ? lower["title"].slice(0, 200) : null };
}
