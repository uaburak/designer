/**
 * An org's IdP configuration (docs/multiplayer.md §15.3.1, `idp_configs`): read from the IdP's metadata (a URL the
 * Worker fetches, or the XML pasted) or the three values by hand [F-adfs]; certificates checked with
 * `crypto.X509Certificate` (nodejs_compat). The D1 `CacheProvider` of node-saml (§15.3.4 step 5) lives here too.
 */
import { X509Certificate, createHash, loadSamlLib, type CacheProvider, type XDocument } from "./lib.js";
import type { IdpCertificateInfo, IdpConfig, IdpConfigInput, IdpProvider } from "../../../../src/shared/org/identity";
import type { D1Like } from "../../db";
import { HttpError } from "../../org/http";
import { NS, REDIRECT_BINDING, REQUEST_TTL_MS, parseXml, spUrls, type SpConfig } from "./sp";

export const PROVIDERS: readonly IdpProvider[] = ["okta", "entra", "onelogin", "google", "custom"];
const MAX_METADATA = 256 * 1024;

export interface IdpRow {
  org_id: string;
  tenant_id: string;
  /** Round 14: the Identity providers table's name */
  name: string;
  provider: IdpProvider;
  idp_entity_id: string;
  sso_url: string;
  certificates: string;
  metadata_url: string | null;
  signing: "assertion" | "assertion_or_response";
  tested_at: number | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

/** The org's oldest IdP — the one round 4's single-IdP routes work on (docs/governance.md §2.9) */
export const idpByOrg = (d1: D1Like, orgId: string) => d1.prepare(`SELECT * FROM idp_configs WHERE org_id = ?1 ORDER BY created_at, tenant_id LIMIT 1`).bind(orgId).first<IdpRow>();
/** Every IdP of the org, oldest first */
export const idpsByOrg = async (d1: D1Like, orgId: string) => (await d1.prepare(`SELECT * FROM idp_configs WHERE org_id = ?1 ORDER BY created_at, tenant_id`).bind(orgId).all<IdpRow>()).results;
export const idpByTenant = (d1: D1Like, tenantId: string) => (/^\d{18}$/.test(tenantId) ? d1.prepare(`SELECT * FROM idp_configs WHERE tenant_id = ?1`).bind(tenantId).first<IdpRow>() : Promise.resolve(null));

/**
 * The IdP that serves an email domain in an org (docs/governance.md §2.9): the IdP the domain is mapped to; an unmapped
 * domain uses the org's IdP when it has exactly one (round 4's behaviour), none otherwise ("unmapped domains can't use
 * SSO"). A domain that isn't a verified domain of the org gets null — or, with `offDomain`, the sole IdP (round 4's
 * Google-then-SAML path, whose ACS then refuses the email).
 */
export async function idpForDomain(d1: D1Like, orgId: string, domain: string | null, o: { offDomain?: boolean } = {}): Promise<IdpRow | null> {
  const d = domain ? await d1.prepare(`SELECT idp_tenant_id FROM org_domains WHERE org_id = ?1 AND domain = ?2 AND verified_at IS NOT NULL`).bind(orgId, domain).first<{ idp_tenant_id: string | null }>() : null;
  if (d?.idp_tenant_id) {
    const mapped = await idpByTenant(d1, d.idp_tenant_id);
    if (mapped && mapped.org_id === orgId) return mapped;
  }
  if (!d && !o.offDomain) return null;
  const { results } = await d1.prepare(`SELECT * FROM idp_configs WHERE org_id = ?1 LIMIT 2`).bind(orgId).all<IdpRow>();
  return results.length === 1 ? results[0] : null;
}

export const spConfigOf = (r: IdpRow): SpConfig => ({ tenantId: r.tenant_id, idpEntityId: r.idp_entity_id, ssoUrl: r.sso_url, certificates: JSON.parse(r.certificates) as string[], signing: r.signing });

/** The 18 random decimal digits of Figma's tenant ids (decision 2) */
export function newTenantId(): string {
  const b = crypto.getRandomValues(new Uint8Array(18));
  let s = String(1 + (b[0] % 9));
  for (let i = 1; i < 18; i++) s += String(b[i] % 10);
  return s;
}

export function toIdpConfig(r: IdpRow, origin: string, domains?: string[]): IdpConfig {
  const u = spUrls(origin, r.tenant_id);
  return {
    tenantId: r.tenant_id,
    name: r.name ?? "",
    ...(domains ? { domains } : {}),
    provider: r.provider,
    idpEntityId: r.idp_entity_id,
    ssoUrl: r.sso_url,
    certificates: (JSON.parse(r.certificates) as string[]).map((p) => certificateInfo(p)),
    metadataUrl: r.metadata_url,
    signing: r.signing,
    spEntityId: u.entityId,
    spAcsUrl: u.acs,
    startUrl: u.start,
    testedAt: r.tested_at,
    updatedAt: r.updated_at,
  };
}

/** PEM, or base64 DER as IdPs show it → PEM */
export function toPem(cert: string): string {
  const body = cert.replace(/-----(BEGIN|END) CERTIFICATE-----/g, "").replace(/\s+/g, "");
  if (!body || !/^[A-Za-z0-9+/]+=*$/.test(body)) throw new HttpError(400, "the signing certificate isn't a certificate", "invalid", { field: "certificate" });
  return `-----BEGIN CERTIFICATE-----\n${body.match(/.{1,64}/g)!.join("\n")}\n-----END CERTIFICATE-----\n`;
}

/** Refuses a certificate that isn't RSA ≥ 2048 or has expired (§15.3.1) */
export function checkCertificate(pem: string, now: number): IdpCertificateInfo {
  let x: X509Certificate;
  try {
    x = new X509Certificate(pem);
  } catch {
    throw new HttpError(400, "the signing certificate can't be read", "invalid", { field: "certificate" });
  }
  if (x.publicKey.asymmetricKeyType !== "rsa") throw new HttpError(400, "the signing certificate must use an RSA key", "invalid", { field: "certificate" });
  if (rsaBits(x) < 2048) throw new HttpError(400, "the signing certificate's RSA key is shorter than 2048 bits", "invalid", { field: "certificate" });
  const info = certificateInfo(pem, x);
  if (info.notAfter <= now) throw new HttpError(400, "the signing certificate has expired", "invalid", { field: "certificate" });
  return info;
}

function rsaBits(x: X509Certificate): number {
  const bits = x.publicKey.asymmetricKeyDetails?.modulusLength;
  if (bits) return bits;
  const n = (x.publicKey.export({ format: "jwk" }) as { n?: string }).n ?? "";
  return Math.floor((n.replace(/=+$/, "").length * 6) / 8) * 8;
}

export function certificateInfo(pem: string, x = new X509Certificate(pem)): IdpCertificateInfo {
  return { sha256: createHash("sha256").update(x.raw).digest("hex"), subject: x.subject.replace(/\n/g, ", "), notAfter: Date.parse(x.validTo) };
}

/** The three values of an IdP's metadata */
export interface IdpValues {
  idpEntityId: string;
  ssoUrl: string;
  certificates: string[];
}

/** An IdP's SAML metadata → its entity id, HTTP-Redirect SSO service and signing certificates (≤ 2) */
export function parseIdpMetadata(xml: string): IdpValues {
  if (xml.length > MAX_METADATA) throw new HttpError(400, "the metadata is larger than 256 KB", "invalid", { field: "metadata" });
  if (/<!DOCTYPE/i.test(xml)) throw new HttpError(400, "the metadata can't contain a DOCTYPE", "invalid", { field: "metadata" });
  let doc: XDocument;
  try {
    doc = parseXml(xml);
  } catch {
    throw new HttpError(400, "the metadata isn't XML", "invalid", { field: "metadata" });
  }
  const entity = Array.from(doc.getElementsByTagNameNS(NS.md, "EntityDescriptor")).find((e) => e.getElementsByTagNameNS(NS.md, "IDPSSODescriptor").length);
  const idp = entity?.getElementsByTagNameNS(NS.md, "IDPSSODescriptor")[0];
  const entityId = entity?.getAttribute("entityID");
  if (!entity || !idp || !entityId) throw new HttpError(400, "the metadata has no identity provider", "invalid", { field: "metadata" });
  const sso = Array.from(idp.getElementsByTagNameNS(NS.md, "SingleSignOnService")).find((s) => s.getAttribute("Binding") === REDIRECT_BINDING)?.getAttribute("Location");
  if (!sso) throw new HttpError(400, "the metadata has no SSO service with the HTTP-Redirect binding", "invalid", { field: "ssoUrl" });
  const certificates: string[] = [];
  for (const kd of Array.from(idp.getElementsByTagNameNS(NS.md, "KeyDescriptor"))) {
    const use = kd.getAttribute("use");
    if (use && use !== "signing") continue;
    for (const c of Array.from(kd.getElementsByTagNameNS(NS.ds, "X509Certificate"))) {
      const pem = toPem(c.textContent ?? "");
      if (!certificates.includes(pem) && certificates.length < 2) certificates.push(pem);
    }
  }
  if (!certificates.length) throw new HttpError(400, "the metadata has no signing certificate", "invalid", { field: "certificate" });
  return { idpEntityId: entityId, ssoUrl: sso, certificates };
}

/** Fetches metadata over HTTPS (≤ 256 KiB) */
export async function fetchMetadata(url: string, fetchImpl: typeof fetch): Promise<string> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new HttpError(400, "the metadata URL isn't a URL", "invalid", { field: "metadataUrl" });
  }
  if (u.protocol !== "https:") throw new HttpError(400, "the metadata URL must use HTTPS", "invalid", { field: "metadataUrl" });
  let res: Response;
  try {
    res = await fetchImpl(u.toString(), { headers: { accept: "application/samlmetadata+xml, application/xml, text/xml" }, redirect: "follow" });
  } catch {
    throw new HttpError(400, "the metadata URL can't be reached", "invalid", { field: "metadataUrl" });
  }
  if (!res.ok) throw new HttpError(400, `the metadata URL answered ${res.status}`, "invalid", { field: "metadataUrl" });
  const text = await res.text();
  if (text.length > MAX_METADATA) throw new HttpError(400, "the metadata is larger than 256 KB", "invalid", { field: "metadata" });
  return text;
}

/** `IdpConfigInput` → the values to store (metadata URL, XML, or the three values by hand) */
export async function resolveInput(input: IdpConfigInput, fetchImpl: typeof fetch, now: number): Promise<IdpValues & { provider: IdpProvider; metadataUrl: string | null; signing: IdpRow["signing"] }> {
  await loadSamlLib();
  if (!input || !PROVIDERS.includes(input.provider)) throw new HttpError(400, "provider", "invalid", { field: "provider" });
  const signing = input.signing ?? "assertion";
  if (signing !== "assertion" && signing !== "assertion_or_response") throw new HttpError(400, "signing", "invalid", { field: "signing" });
  let v: IdpValues;
  let metadataUrl: string | null = null;
  if (typeof input.metadataUrl === "string" && input.metadataUrl.trim()) {
    metadataUrl = input.metadataUrl.trim();
    v = parseIdpMetadata(await fetchMetadata(metadataUrl, fetchImpl));
  } else if (typeof input.metadataXml === "string" && input.metadataXml.trim()) {
    v = parseIdpMetadata(input.metadataXml.trim());
  } else {
    const entity = typeof input.idpEntityId === "string" ? input.idpEntityId.trim() : "";
    const sso = typeof input.ssoUrl === "string" ? input.ssoUrl.trim() : "";
    if (!entity || entity.length > 1024) throw new HttpError(400, "the IdP Entity ID is required", "invalid", { field: "idpEntityId" });
    if (!/^https:\/\/\S+$/.test(sso)) throw new HttpError(400, "the IdP SSO Target URL must be an HTTPS URL", "invalid", { field: "ssoUrl" });
    if (typeof input.certificate !== "string" || !input.certificate.trim()) throw new HttpError(400, "the signing certificate is required", "invalid", { field: "certificate" });
    v = { idpEntityId: entity, ssoUrl: sso, certificates: [toPem(input.certificate)] };
  }
  if (!/^https:\/\//.test(v.ssoUrl)) throw new HttpError(400, "the IdP SSO Target URL must be an HTTPS URL", "invalid", { field: "ssoUrl" });
  for (const c of v.certificates) checkCertificate(c, now);
  return { ...v, provider: input.provider, metadataUrl, signing };
}

/**
 * node-saml's cache of request ids, backed by `saml_requests` (§15.3.4 step 5): `saveAsync` does nothing (the row is
 * inserted at start), `getAsync` reads an unexpired row (its value is the request's IssueInstant, as node-saml
 * expects), `removeAsync` does nothing — the atomic `DELETE … RETURNING` of step 4 is the real check.
 */
export function d1Cache(d1: D1Like, orgId: string, now: () => number): CacheProvider {
  return {
    saveAsync: async () => null,
    async getAsync(key: string) {
      const r = await d1.prepare(`SELECT expires_at FROM saml_requests WHERE id = ?1 AND org_id = ?2 AND expires_at > ?3`).bind(key, orgId, now()).first<{ expires_at: number }>();
      return r ? new Date(r.expires_at - REQUEST_TTL_MS).toISOString() : null;
    },
    removeAsync: async () => null,
  };
}
