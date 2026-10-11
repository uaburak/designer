/**
 * A test IdP in Node (moved from the round 1e spike, server/spikes/saml/test/idp.ts): throwaway keys and certificates
 * made with openssl per test run (never committed), SAML Responses built and signed with xml-crypto, the DOM surgery of
 * the signature-wrapping (XSW) attacks, and IdP metadata. Used by server/src/auth/saml/saml.test.ts and the identity
 * tests (docs/multiplayer.md §15.3.5).
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { SignedXml } from "xml-crypto";

export interface KeyPair {
  key: string;
  cert: string;
}

/** `openssl req -x509` (LibreSSL or OpenSSL): an RSA-2048 (or other) key and its self-signed certificate */
function makeKey(dir: string, name: string, cn: string, newkey: string[] = ["-newkey", "rsa:2048"], days = "30"): KeyPair {
  execFileSync("openssl", ["req", "-x509", ...newkey, "-nodes", "-sha256", "-days", days, "-keyout", join(dir, `${name}.key`), "-out", join(dir, `${name}.crt`), "-subj", `/CN=${cn}`], { stdio: "ignore" });
  return { key: readFileSync(join(dir, `${name}.key`), "utf8"), cert: readFileSync(join(dir, `${name}.crt`), "utf8") };
}

let cached: { idp: KeyPair; attacker: KeyPair; rotated: KeyPair; weak: KeyPair; ec: KeyPair } | null = null;
/** The test keys, made once per test file: the trusted IdP, an attacker, a rotated IdP key, RSA-1024 and EC (refused) */
export function testKeys() {
  if (cached) return cached;
  const dir = mkdtempSync(join(tmpdir(), "designer-saml-"));
  try {
    cached = {
      idp: makeKey(dir, "idp", "Test IdP"),
      attacker: makeKey(dir, "attacker", "Attacker"),
      rotated: makeKey(dir, "rotated", "Test IdP 2"),
      weak: makeKey(dir, "weak", "Weak IdP", ["-newkey", "rsa:1024"]),
      ec: makeKey(dir, "ec", "EC IdP", ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1"]),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return cached;
}

export const IDP_ENTITY = "https://idp.example.test/metadata";
export const IDP_SSO = "https://idp.example.test/sso";
const P = "urn:oasis:names:tc:SAML:2.0:protocol";
const A = "urn:oasis:names:tc:SAML:2.0:assertion";
const DS = "http://www.w3.org/2000/09/xmldsig#";

export const newId = () => "_" + randomBytes(16).toString("hex");
const iso = (ms: number) => new Date(ms).toISOString();
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

export interface ResponseOptions {
  /** The SP's entity id (`<origin>/saml/<tenantId>`); ACS = `<sp>/consume` */
  sp: string;
  inResponseTo: string | null;
  /** On the Response element too (default: the same as inResponseTo) */
  responseInResponseTo?: string | null;
  nameId?: string;
  nameIdFormat?: string;
  issuer?: string;
  audience?: string;
  recipient?: string;
  destination?: string | null;
  /** offsets from now, in ms */
  notBefore?: number;
  notOnOrAfter?: number;
  assertionId?: string;
  attributes?: Record<string, string>;
  /** Replaces the assertion with an EncryptedAssertion placeholder */
  encrypted?: boolean;
}

export function buildResponse(o: ResponseOptions): string {
  const now = Date.now();
  const nb = iso(now + (o.notBefore ?? -60_000));
  const noa = iso(now + (o.notOnOrAfter ?? 5 * 60_000));
  const irt = o.inResponseTo ? ` InResponseTo="${o.inResponseTo}"` : "";
  const rIrt = o.responseInResponseTo === undefined ? irt : o.responseInResponseTo ? ` InResponseTo="${o.responseInResponseTo}"` : "";
  const issuer = o.issuer ?? IDP_ENTITY;
  const dest = o.destination === null ? "" : ` Destination="${o.destination ?? o.sp + "/consume"}"`;
  const attrs = Object.entries(o.attributes ?? {})
    .map(([k, v]) => `<saml:Attribute Name="${esc(k)}"><saml:AttributeValue>${esc(v)}</saml:AttributeValue></saml:Attribute>`)
    .join("");
  const assertion = o.encrypted
    ? `<saml:EncryptedAssertion><xenc:EncryptedData xmlns:xenc="http://www.w3.org/2001/04/xmlenc#"/></saml:EncryptedAssertion>`
    : `<saml:Assertion xmlns:saml="${A}" ID="${o.assertionId ?? newId()}" Version="2.0" IssueInstant="${iso(now)}">` +
      `<saml:Issuer>${issuer}</saml:Issuer>` +
      `<saml:Subject><saml:NameID Format="${o.nameIdFormat ?? "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress"}">${o.nameId ?? "eve@acme.test"}</saml:NameID>` +
      `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData NotOnOrAfter="${noa}" Recipient="${o.recipient ?? o.sp + "/consume"}"${irt}/></saml:SubjectConfirmation></saml:Subject>` +
      `<saml:Conditions NotBefore="${nb}" NotOnOrAfter="${noa}"><saml:AudienceRestriction><saml:Audience>${o.audience ?? o.sp}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
      `<saml:AuthnStatement AuthnInstant="${iso(now)}" SessionIndex="${newId()}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>` +
      (attrs ? `<saml:AttributeStatement>${attrs}</saml:AttributeStatement>` : "") +
      `</saml:Assertion>`;
  return (
    `<samlp:Response xmlns:samlp="${P}" xmlns:saml="${A}" ID="${newId()}" Version="2.0" IssueInstant="${iso(now)}"${dest}${rIrt}>` +
    `<saml:Issuer>${issuer}</saml:Issuer>` +
    `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>` +
    assertion +
    `</samlp:Response>`
  );
}

export interface SignOptions {
  signer?: KeyPair;
  /** "sha1": rsa-sha1 with a sha1 digest (AD FS's old default) — refused */
  alg?: "sha256" | "sha1" | "sha512";
}

const ALGS = {
  sha256: { sig: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256", digest: "http://www.w3.org/2001/04/xmlenc#sha256" },
  sha512: { sig: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha512", digest: "http://www.w3.org/2001/04/xmlenc#sha512" },
  sha1: { sig: "http://www.w3.org/2000/09/xmldsig#rsa-sha1", digest: "http://www.w3.org/2000/09/xmldsig#sha1" },
};

function sign(xml: string, target: "Assertion" | "Response", o: SignOptions = {}): string {
  const signer = o.signer ?? testKeys().idp;
  const alg = ALGS[o.alg ?? "sha256"];
  const sig = new SignedXml({ privateKey: signer.key, publicCert: signer.cert, signatureAlgorithm: alg.sig, canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#" });
  const path = target === "Assertion" ? "/*[local-name(.)='Response']/*[local-name(.)='Assertion']" : "/*[local-name(.)='Response']";
  sig.addReference({ xpath: path, digestAlgorithm: alg.digest, transforms: ["http://www.w3.org/2000/09/xmldsig#enveloped-signature", "http://www.w3.org/2001/10/xml-exc-c14n#"] });
  sig.computeSignature(xml, { location: { reference: `${path}/*[local-name(.)='Issuer']`, action: "after" } });
  return sig.getSignedXml();
}

export const signAssertion = (xml: string, o?: SignOptions) => sign(xml, "Assertion", o);
export const signResponse = (xml: string, o?: SignOptions) => sign(xml, "Response", o);
export const signBoth = (xml: string, o?: SignOptions) => signResponse(signAssertion(xml, o), o);

/** IdP metadata as Okta / Entra publish it (an EntitiesDescriptor wrapper optional) */
export function idpMetadata(o: { entityId?: string; sso?: string; certs?: string[]; redirect?: boolean; wrap?: boolean } = {}): string {
  const body = (o.certs ?? [testKeys().idp.cert]).map((c) => `<md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${c.replace(/-----[^-]+-----|\s+/g, "")}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>`).join("");
  const binding = o.redirect === false ? "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" : "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect";
  const ed = `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="${DS}" entityID="${o.entityId ?? IDP_ENTITY}"><md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">${body}<md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</md:NameIDFormat><md:SingleSignOnService Binding="${binding}" Location="${o.sso ?? IDP_SSO}"/></md:IDPSSODescriptor></md:EntityDescriptor>`;
  return o.wrap ? `<md:EntitiesDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata">${ed}</md:EntitiesDescriptor>` : ed;
}

// ---- DOM helpers for the attacks -------------------------------------------------------------------------------
type El = Element;
const parse = (xml: string) => new DOMParser().parseFromString(xml, "text/xml") as unknown as Document;
const serialize = (doc: Document | Node) => new XMLSerializer().serializeToString(doc as never);
const kids = (n: El, ns: string, local: string) => Array.from(n.childNodes).filter((c): c is El => c.nodeType === 1 && (c as El).namespaceURI === ns && (c as El).localName === local);
const assertionOf = (resp: El) => kids(resp, A, "Assertion")[0];
const signatureOf = (el: El) => kids(el, DS, "Signature")[0];
function setNameId(assertion: El, value: string) {
  const nameId = assertion.getElementsByTagNameNS(A, "NameID")[0];
  while (nameId.firstChild) nameId.removeChild(nameId.firstChild);
  nameId.appendChild(nameId.ownerDocument.createTextNode(value));
}
function stripSignature(el: El) {
  const s = signatureOf(el);
  if (s) el.removeChild(s);
  return el;
}
export const EVIL = "admin@acme.test";

/** The XSW1–XSW8 transformations (Somorovsky et al., "On Breaking SAML", 2012; SAML Raider's names). Input: a legitimately signed Response for eve. */
export const xsw: Record<string, (signedXml: string) => string> = {
  XSW1(xml) {
    const doc = parse(xml);
    const root = doc.documentElement;
    const original = root.cloneNode(true) as El;
    stripSignature(original);
    signatureOf(root).appendChild(original);
    root.setAttribute("ID", newId());
    setNameId(assertionOf(root), EVIL);
    stripSignature(assertionOf(root));
    return serialize(doc);
  },
  XSW2(xml) {
    const doc = parse(xml);
    const root = doc.documentElement;
    const original = root.cloneNode(true) as El;
    stripSignature(original);
    root.insertBefore(original, signatureOf(root));
    root.setAttribute("ID", newId());
    setNameId(assertionOf(root), EVIL);
    stripSignature(assertionOf(root));
    return serialize(doc);
  },
  XSW3(xml) {
    const doc = parse(xml);
    const root = doc.documentElement;
    const signed = assertionOf(root);
    const evil = stripSignature(signed.cloneNode(true) as El);
    evil.setAttribute("ID", newId());
    setNameId(evil, EVIL);
    root.insertBefore(evil, signed);
    return serialize(doc);
  },
  XSW4(xml) {
    const doc = parse(xml);
    const root = doc.documentElement;
    const signed = assertionOf(root);
    const evil = stripSignature(signed.cloneNode(true) as El);
    evil.setAttribute("ID", newId());
    setNameId(evil, EVIL);
    root.replaceChild(evil, signed);
    evil.appendChild(signed);
    return serialize(doc);
  },
  XSW5(xml) {
    const doc = parse(xml);
    const root = doc.documentElement;
    const signed = assertionOf(root);
    const copy = stripSignature(signed.cloneNode(true) as El);
    setNameId(signed, EVIL);
    root.appendChild(copy);
    return serialize(doc);
  },
  XSW6(xml) {
    const doc = parse(xml);
    const root = doc.documentElement;
    const signed = assertionOf(root);
    const copy = stripSignature(signed.cloneNode(true) as El);
    setNameId(signed, EVIL);
    signatureOf(signed).appendChild(copy);
    return serialize(doc);
  },
  XSW7(xml) {
    const doc = parse(xml);
    const root = doc.documentElement;
    const signed = assertionOf(root);
    const ext = doc.createElementNS(P, "samlp:Extensions");
    const evil = stripSignature(signed.cloneNode(true) as El);
    setNameId(evil, EVIL);
    root.replaceChild(evil, signed);
    ext.appendChild(signed);
    root.insertBefore(ext, evil);
    return serialize(doc);
  },
  XSW8(xml) {
    const doc = parse(xml);
    const root = doc.documentElement;
    const signed = assertionOf(root);
    const sig = signatureOf(signed);
    const original = stripSignature(signed.cloneNode(true) as El);
    const obj = doc.createElementNS(DS, "ds:Object");
    obj.appendChild(original);
    sig.appendChild(obj);
    setNameId(signed, EVIL);
    return serialize(doc);
  },
};

/** Change the signed NameID after signing (no wrapping) — the digest must fail. */
export function tamperNameId(xml: string, value = EVIL): string {
  const doc = parse(xml);
  setNameId(assertionOf(doc.documentElement), value);
  return serialize(doc);
}
/** Comment injection (CVE-2017-11427 class): split the NameID text with a comment; exclusive C14N drops comments. */
export function injectComment(xml: string, before: string, after: string): string {
  return xml.replace(`>${before}${after}<`, `>${before}<!---->${after}<`);
}
/** Two assertions in one Response: the signed one and a forged one after it. */
export function appendForgedAssertion(xml: string): string {
  const doc = parse(xml);
  const root = doc.documentElement;
  const signed = assertionOf(root);
  const evil = stripSignature(signed.cloneNode(true) as El);
  evil.setAttribute("ID", newId());
  setNameId(evil, EVIL);
  root.appendChild(evil);
  return serialize(doc);
}
