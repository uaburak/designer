/**
 * An org's email domains (docs/multiplayer.md §15.7, [F-domain]): added Unverified with a TXT record to publish,
 * verified over DNS-over-HTTPS from the Worker (Cloudflare's resolver, JSON API), removed (its members become guests).
 * A verified domain belongs to one org (decision 9).
 *
 *   POST   /orgs/:org/admin/domains {domain}            → {domain: OrgDomain}       409 domain_taken
 *   POST   /orgs/:org/admin/domains/:domain/verify      → {domain}                  409 domain_unverified {found} · domain_taken · 503
 *   DELETE /orgs/:org/admin/domains/:domain             → 204                       409 for the caller's own domain
 *   GET    /orgs/:org/admin/domains/:domain/accounts    → {people: PersonRef[]}     accounts on it that aren't members
 *   PUT    /orgs/:org/admin/domains/:domain/idp {tenantId | null} → {domain, tenantId}   round 14, Governance+ only:
 *          the IdP serving the domain (docs/governance.md §2.9); 409 mapping to an untested IdP while SAML is required
 */
import { DOMAIN_TXT_PREFIX, emailDomain, normalizeDomain, type OrgDomain } from "../../../src/shared/org/identity";
import type { OrgSettings, PersonRef } from "../../../src/shared/org/types";
import { logActivity, orgEntity } from "../activity";
import type { D1Like } from "../db";
import { orgNotice } from "../notifications";
import { personRef, settingsOf } from "../org/db";
import { HttpError, type Ctx } from "../org/http";
import { orgUserIds } from "../org/orgs";
import { orgFileKeys, reauth } from "../org/reauth";
import { idpByTenant } from "./saml/config";

/** 403 `governance_plus_required` unless the org has the Governance+ add-on (docs/governance.md §2.1) */
export async function requireGovernancePlus(d1: D1Like, orgId: string): Promise<void> {
  const r = await d1.prepare(`SELECT governance_plus FROM orgs WHERE id = ?1`).bind(orgId).first<{ governance_plus: number }>();
  if (!r?.governance_plus) throw new HttpError(403, "This needs Governance+", "governance_plus_required");
}

interface DomainRow {
  org_id: string;
  domain: string;
  idp_tenant_id: string | null;
  token: string;
  created_by: string | null;
  created_at: number;
  verified_at: number | null;
}

const toDomain = (r: DomainRow): OrgDomain => ({ domain: r.domain, verified: r.verified_at !== null, verifiedAt: r.verified_at, txtRecord: DOMAIN_TXT_PREFIX + r.token, createdAt: r.created_at });

export async function listDomains(d1: D1Like, orgId: string): Promise<OrgDomain[]> {
  const { results } = await d1.prepare(`SELECT * FROM org_domains WHERE org_id = ?1 ORDER BY domain`).bind(orgId).all<DomainRow>();
  return results.map(toDomain);
}

const takenElsewhere = (d1: D1Like, orgId: string, domain: string) => d1.prepare(`SELECT 1 AS x FROM org_domains WHERE domain = ?1 AND org_id <> ?2 AND verified_at IS NOT NULL`).bind(domain, orgId).first();

/** A TXT record's `data` as the JSON API gives it: its quoted strings un-quoted and joined (`"a" "b"` → `ab`) */
export function txtValue(data: string): string {
  const parts = [...data.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].replace(/\\(.)/g, "$1"));
  return parts.length ? parts.join("") : data.trim();
}

/** The TXT values at a domain, over DNS-over-HTTPS (Cloudflare's JSON API). Throws 503 when the resolver fails. */
export async function dohTxt(fetchImpl: typeof fetch, domain: string): Promise<string[]> {
  let body: { Status?: number; Answer?: { type?: number; data?: string }[] };
  try {
    const res = await fetchImpl(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=TXT`, { headers: { accept: "application/dns-json" } });
    if (!res.ok) throw new Error(String(res.status));
    body = (await res.json()) as typeof body;
  } catch {
    throw new HttpError(503, "DNS lookup failed; try again in a moment");
  }
  // NXDOMAIN (3) and other answers without records: nothing found
  if (body.Status !== 0) return [];
  return (body.Answer ?? []).filter((a) => a.type === 16 && typeof a.data === "string").map((a) => txtValue(a.data!));
}

export async function domainsRoute(ctx: Ctx, orgId: string, rest: string[]): Promise<Response> {
  const { m, deps, user, acc } = ctx;
  const d1 = deps.db.d1;
  const org = (await acc.org(orgId))!;
  const log = (action: "org_domain_add" | "org_domain_verify" | "org_domain_remove" | "org_domain_capture_change" | "org_domain_idp_mapping_change", details: Record<string, unknown>) => logActivity(deps, { orgId, action, actor: user, entity: orgEntity(org), details, req: ctx.req });
  const row = async (domain: string) => {
    const r = await d1.prepare(`SELECT * FROM org_domains WHERE org_id = ?1 AND domain = ?2`).bind(orgId, domain).first<DomainRow>();
    if (!r) throw new HttpError(404, "no such domain");
    return r;
  };

  if (!rest.length && m === "GET") return Response.json({ domains: await listDomains(d1, orgId) });
  if (!rest.length && m === "POST") {
    const input = (await ctx.req.json().catch(() => null)) as { domain?: unknown } | null;
    const domain = typeof input?.domain === "string" ? normalizeDomain(input.domain) : null;
    if (!domain) throw new HttpError(400, "Enter a domain like acme.com", "invalid", { field: "domain" });
    if (await takenElsewhere(d1, orgId, domain)) throw new HttpError(409, `${domain} belongs to another organization`, "domain_taken");
    const token = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const had = await d1.prepare(`SELECT * FROM org_domains WHERE org_id = ?1 AND domain = ?2`).bind(orgId, domain).first<DomainRow>();
    if (had) return Response.json({ domain: toDomain(had) });
    await d1.prepare(`INSERT INTO org_domains (org_id, domain, token, created_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5)`).bind(orgId, domain, token, user.id, deps.now()).run();
    await log("org_domain_add", { domain });
    await orgNotice(deps, await orgUserIds(d1, orgId), { what: "org", orgId });
    return Response.json({ domain: toDomain(await row(domain)) }, { status: 201 });
  }
  const domain = rest[0];
  if (rest.length === 2 && rest[1] === "verify" && m === "POST") {
    const r = await row(domain);
    if (r.verified_at !== null) return Response.json({ domain: toDomain(r) });
    if (await takenElsewhere(d1, orgId, domain)) throw new HttpError(409, `${domain} belongs to another organization`, "domain_taken");
    const want = DOMAIN_TXT_PREFIX + r.token;
    const found = await dohTxt(deps.fetch, domain);
    if (!found.includes(want)) throw new HttpError(409, "We couldn't find the TXT record yet. DNS changes can take a while to show up.", "domain_unverified", { found });
    try {
      await d1.prepare(`UPDATE org_domains SET verified_at = ?3 WHERE org_id = ?1 AND domain = ?2`).bind(orgId, domain, deps.now()).run();
    } catch {
      // the unique index: verified by another org in the meantime
      throw new HttpError(409, `${domain} belongs to another organization`, "domain_taken");
    }
    await log("org_domain_verify", { domain });
    await orgNotice(deps, await orgUserIds(d1, orgId), { what: "org", orgId });
    return Response.json({ domain: toDomain(await row(domain)) });
  }
  if (rest.length === 2 && rest[1] === "accounts" && m === "GET") {
    await row(domain);
    const { results } = await d1
      .prepare(
        `SELECT u.id, u.email, u.name, u.picture, m.role FROM users u LEFT JOIN org_members m ON m.org_id = ?1 AND m.user_id = u.id
         WHERE u.email LIKE ?2 AND u.google_sub NOT LIKE 'deleted:%' AND (m.role IS NULL OR m.role = 'guest') ORDER BY u.email LIMIT 500`,
      )
      .bind(orgId, `%@${domain}`)
      .all<{ id: string; email: string; name: string | null; picture: string | null; role: "guest" | null }>();
    const people: PersonRef[] = results.map((r) => personRef({ ...r, role: r.role ?? "guest" }));
    return Response.json({ people });
  }
  if (rest.length === 2 && rest[1] === "idp" && m === "PUT") {
    await requireGovernancePlus(d1, orgId);
    const r = await row(domain);
    const input = (await ctx.req.json().catch(() => null)) as { tenantId?: unknown } | null;
    const to = input?.tenantId;
    if (!input || (to !== null && typeof to !== "string")) throw new HttpError(400, "tenantId is an identity provider's tenant id or null", "invalid", { field: "tenantId" });
    if (to !== null) {
      const idp = await idpByTenant(d1, to);
      if (!idp || idp.org_id !== orgId) throw new HttpError(404, "no such identity provider");
      if (settingsOf(org).authMethod === "saml" && idp.tested_at === null) throw new HttpError(409, "Test SAML SSO first", "invalid", { field: "tenantId" });
    }
    if (r.idp_tenant_id !== to) {
      await d1.prepare(`UPDATE org_domains SET idp_tenant_id = ?3 WHERE org_id = ?1 AND domain = ?2`).bind(orgId, domain, to).run();
      await log("org_domain_idp_mapping_change", { domain, from: r.idp_tenant_id, to });
      await orgNotice(deps, await orgUserIds(d1, orgId), { what: "org", orgId });
    }
    return Response.json({ domain: toDomain(await row(domain)), tenantId: to });
  }
  if (rest.length === 1 && m === "DELETE") {
    const r = await row(domain);
    if (emailDomain(user.email) === domain) throw new HttpError(409, "You can't remove the domain of your own email", "conflict");
    await d1.prepare(`DELETE FROM org_domains WHERE org_id = ?1 AND domain = ?2`).bind(orgId, domain).run();
    // Its members (on no other domain of the org) become guests [F-domain].
    const { results: others } = await d1.prepare(`SELECT domain FROM org_domains WHERE org_id = ?1`).bind(orgId).all<{ domain: string }>();
    const keep = new Set(others.map((o) => o.domain));
    const { results: people } = await d1
      .prepare(`SELECT user_id, email FROM org_members WHERE org_id = ?1 AND role IN ('admin', 'member') AND email LIKE ?2 AND user_id IS NOT NULL`)
      .bind(orgId, `%@${domain}`)
      .all<{ user_id: string; email: string }>();
    const demoted = people.filter((p) => !keep.has(emailDomain(p.email) ?? ""));
    for (const p of demoted) await d1.prepare(`UPDATE org_members SET role = 'guest' WHERE org_id = ?1 AND user_id = ?2`).bind(orgId, p.user_id).run();
    if (demoted.length) await reauth(deps, await orgFileKeys(d1, orgId), demoted.map((p) => p.user_id));
    await log("org_domain_remove", { domain, verified: r.verified_at !== null, guests: demoted.length });
    // Capture stays on only while a verified domain remains.
    const settings = settingsOf(org);
    if (settings.domainCapture) {
      const left = await d1.prepare(`SELECT COUNT(*) AS n FROM org_domains WHERE org_id = ?1 AND verified_at IS NOT NULL`).bind(orgId).first<{ n: number }>();
      if (!left?.n) {
        const next: OrgSettings = { ...settings, domainCapture: false, externalContent: "allowed" }; // restriction needs capture
        await d1.prepare(`UPDATE orgs SET settings = ?2, updated_at = ?3 WHERE id = ?1`).bind(orgId, JSON.stringify(next), deps.now()).run();
        await log("org_domain_capture_change", { from: true, to: false, reason: "no verified domain" });
        acc.reset();
      }
    }
    await orgNotice(deps, await orgUserIds(d1, orgId), { what: "org", orgId });
    return new Response(null, { status: 204 });
  }
  throw new HttpError(405, "method not allowed");
}
