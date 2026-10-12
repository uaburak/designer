/**
 * Admin › Settings › Login and provisioning (docs/multiplayer.md §15.13), org admins only — workspace and billing
 * group admins get 403 `not_admin`:
 *
 *   GET    /orgs/:org/admin/identity                    → IdentityOverview
 *   PUT    /orgs/:org/admin/identity/saml               IdpConfigInput → {idp: IdpConfig} (400 naming the bad field)
 *   POST   /orgs/:org/admin/identity/saml/refresh       → {idp} (re-fetches metadataUrl)
 *   DELETE /orgs/:org/admin/identity/saml               → 204 (409 while authMethod is saml; revokes the SCIM token)
 *   POST   /orgs/:org/admin/identity/scim-token         → ScimTokenCreated (409 without an IdP configuration)
 *   DELETE /orgs/:org/admin/identity/scim-token         → 204
 *   …/admin/domains…                                    auth/domains.ts
 *
 * Round 4's single-IdP routes above work on the org's oldest IdP. Round 14, multiple IdPs (docs/governance.md §2.9;
 * Governance+ only — 403 `governance_plus_required` without it):
 *
 *   GET    /orgs/:org/admin/identity/idps               → {idps: IdpScimConfig[]} (oldest first, with domains and SCIM)
 *   POST   /orgs/:org/admin/identity/idps               IdpConfigInput (+ name) → 201 {idp}
 *   GET    /orgs/:org/admin/identity/idps/:tenantId     → {idp}
 *   PUT    /orgs/:org/admin/identity/idps/:tenantId     IdpConfigInput, or {name} alone → {idp}
 *   DELETE /orgs/:org/admin/identity/idps/:tenantId     → 204 (409 while SAML is required and the IdP serves domains)
 *   POST   /orgs/:org/admin/identity/idps/:tenantId/refresh       → {idp}
 *   POST   /orgs/:org/admin/identity/idps/:tenantId/scim-token    → ScimTokenCreated (one live token per IdP)
 *   DELETE /orgs/:org/admin/identity/idps/:tenantId/scim-token    → 204
 */
import type { IdentityOverview, IdpConfig, IdpConfigInput, ScimTokenCreated, ScimTokenInfo } from "../../../src/shared/org/identity";
import { logActivity, orgEntity } from "../activity";
import type { D1Like } from "../db";
import { orgNotice } from "../notifications";
import { personIn } from "../org/db";
import { HttpError, json, noContent, type Ctx } from "../org/http";
import { orgUserIds } from "../org/orgs";
import { randomToken, sha256b64url } from "../tokens";
import { domainsRoute, listDomains, requireGovernancePlus } from "./domains";
import { idpByOrg, idpByTenant, idpsByOrg, newTenantId, resolveInput, toIdpConfig, type IdpRow } from "./saml/config";

export const SCIM_TOKEN_PREFIX = "dsgn_scim_";
const NAME_MAX = 100;

/** An IdP as `GET identity/idps` lists it: the configuration, its domains, its SCIM base URL and live token */
export type IdpScimConfig = IdpConfig & { scim: { baseUrl: string; token: ScimTokenInfo | null } };

export async function identityRoute(ctx: Ctx): Promise<Response> {
  const { parts, acc } = ctx;
  const orgId = parts[1];
  await acc.requireOrgAdmin(orgId);
  const rest = parts.slice(4);
  if (parts[3] === "domains") return domainsRoute(ctx, orgId, rest);
  return identity(ctx, orgId, rest);
}

const scimBase = (origin: string, tenantId: string) => `${origin}/scim/v2/${tenantId}`;

interface TokenRow {
  id: string;
  created_at: number;
  created_by: string | null;
  last_used_at: number | null;
}

/** The IdP's live SCIM token; tokens from before round 14 without a tenant count as the oldest IdP's */
async function liveToken(d1: D1Like, orgId: string, tenantId: string, oldest: boolean): Promise<TokenRow | null> {
  return d1
    .prepare(`SELECT id, created_at, created_by, last_used_at FROM scim_tokens WHERE org_id = ?1 AND revoked_at IS NULL AND (tenant_id = ?2 OR (?3 = 1 AND tenant_id IS NULL)) ORDER BY created_at DESC LIMIT 1`)
    .bind(orgId, tenantId, oldest ? 1 : 0)
    .first();
}

async function tokenInfo(d1: D1Like, orgId: string, r: TokenRow): Promise<ScimTokenInfo> {
  return { id: r.id, createdAt: r.created_at, createdBy: r.created_by ? await personIn(d1, orgId, r.created_by) : null, lastUsedAt: r.last_used_at };
}

/** Domains by the IdP they're mapped to */
async function mappedDomains(d1: D1Like, orgId: string): Promise<Map<string, string[]>> {
  const { results } = await d1.prepare(`SELECT domain, idp_tenant_id FROM org_domains WHERE org_id = ?1 AND idp_tenant_id IS NOT NULL ORDER BY domain`).bind(orgId).all<{ domain: string; idp_tenant_id: string }>();
  const out = new Map<string, string[]>();
  for (const r of results) out.set(r.idp_tenant_id, [...(out.get(r.idp_tenant_id) ?? []), r.domain]);
  return out;
}

async function idpList(ctx: Ctx, orgId: string): Promise<IdpScimConfig[]> {
  const d1 = ctx.acc.d1;
  const idps = await idpsByOrg(d1, orgId);
  const domains = await mappedDomains(d1, orgId);
  const out: IdpScimConfig[] = [];
  for (const [i, r] of idps.entries()) {
    const token = await liveToken(d1, orgId, r.tenant_id, i === 0);
    out.push({ ...toIdpConfig(r, ctx.url.origin, domains.get(r.tenant_id) ?? []), scim: { baseUrl: scimBase(ctx.url.origin, r.tenant_id), token: token ? await tokenInfo(d1, orgId, token) : null } });
  }
  return out;
}

export async function identityOverview(ctx: Ctx, orgId: string): Promise<IdentityOverview> {
  const settings = await ctx.acc.settings(orgId);
  const idps = await idpList(ctx, orgId);
  const oldest = idps[0] ?? null;
  return {
    authMethod: settings.authMethod,
    idp: oldest ? stripScim(oldest) : null,
    ...(idps.length ? { idps } : {}),
    scim: oldest ? oldest.scim : null,
    domains: await listDomains(ctx.acc.d1, orgId),
    domainCapture: settings.domainCapture,
  };
}

function stripScim(c: IdpScimConfig): IdpConfig {
  const { scim: _scim, ...rest } = c;
  return rest;
}

/** Is this IdP in use for sign-in: the org's only one, or one with a mapped domain? */
async function inUse(d1: D1Like, orgId: string, idp: IdpRow): Promise<boolean> {
  const n = await d1.prepare(`SELECT (SELECT COUNT(*) FROM idp_configs WHERE org_id = ?1) AS n, (SELECT COUNT(*) FROM org_domains WHERE org_id = ?1 AND idp_tenant_id = ?2) AS d`).bind(orgId, idp.tenant_id).first<{ n: number; d: number }>();
  return !!n && (n.n === 1 || n.d > 0);
}

function cleanIdpName(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw new HttpError(400, "name", "invalid", { field: "name" });
  return v.trim().slice(0, NAME_MAX);
}

async function identity(ctx: Ctx, orgId: string, rest: string[]): Promise<Response> {
  const { m, deps, user, acc, url } = ctx;
  const d1 = acc.d1;
  const now = deps.now();
  const org = (await acc.org(orgId))!;
  const log = (action: "idp_config_create" | "idp_config_update" | "idp_config_delete" | "scim_token_generate" | "scim_token_revoke" | "org_domain_idp_mapping_change", details: Record<string, unknown> = {}) =>
    logActivity(deps, { orgId, action, actor: user, entity: orgEntity(org), details, req: ctx.req });
  const changed = async () => orgNotice(deps, await orgUserIds(d1, orgId), { what: "org", orgId });
  const samlRequired = async () => (await acc.settings(orgId)).authMethod === "saml";
  const oldestTenant = async () => (await idpByOrg(d1, orgId))?.tenant_id ?? null;

  /** Revokes the IdP's live SCIM tokens (all of the org's with `all`), logged; false when there were none */
  const revokeScim = async (tenantId: string | null, all = false): Promise<boolean> => {
    const oldest = tenantId !== null && tenantId === (await oldestTenant());
    const { results } = await d1
      .prepare(`UPDATE scim_tokens SET revoked_at = ?2 WHERE org_id = ?1 AND revoked_at IS NULL AND (?5 = 1 OR tenant_id = ?3 OR (?4 = 1 AND tenant_id IS NULL)) RETURNING id`)
      .bind(orgId, now, tenantId, oldest ? 1 : 0, all ? 1 : 0)
      .all<{ id: string }>();
    for (const r of results) await log("scim_token_revoke", { token_id: r.id, ...(tenantId ? { tenant_id: tenantId } : {}) });
    return results.length > 0;
  };

  /** A new SCIM token for the IdP; one live token per IdP (decision 8): a new one revokes the old */
  const newScimToken = async (idp: IdpRow): Promise<Response> => {
    await revokeScim(idp.tenant_id);
    const id = `st_${randomToken(9)}`;
    const token = `${SCIM_TOKEN_PREFIX}${randomToken(32)}`;
    await d1.prepare(`INSERT INTO scim_tokens (id, org_id, token_hash, created_by, created_at, tenant_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`).bind(id, orgId, await sha256b64url(token), user.id, now, idp.tenant_id).run();
    await log("scim_token_generate", { token_id: id, tenant_id: idp.tenant_id });
    await changed();
    return json({ token, info: await tokenInfo(d1, orgId, { id, created_at: now, created_by: user.id, last_used_at: null }) } satisfies ScimTokenCreated, 201);
  };

  /** Saves the values into `had` (or a new IdP); `keepUrl`: a refresh keeps the metadata URL */
  const save = async (had: IdpRow | null, v: Awaited<ReturnType<typeof resolveInput>>, keepUrl: boolean, name?: string): Promise<IdpRow> => {
    const metadataUrl = v.metadataUrl ?? (keepUrl ? (had?.metadata_url ?? null) : null);
    let tenantId: string;
    try {
      if (had) {
        tenantId = had.tenant_id;
        // Another IdP (entity id or SSO URL) has to be tested again before it can be required; a rotated certificate not.
        const same = had.idp_entity_id === v.idpEntityId && had.sso_url === v.ssoUrl;
        await d1
          .prepare(`UPDATE idp_configs SET provider = ?2, idp_entity_id = ?3, sso_url = ?4, certificates = ?5, metadata_url = ?6, signing = ?7, tested_at = CASE WHEN ?8 = 1 THEN tested_at ELSE NULL END, updated_at = ?9, name = COALESCE(?10, name) WHERE tenant_id = ?1`)
          .bind(tenantId, v.provider, v.idpEntityId, v.ssoUrl, JSON.stringify(v.certificates), metadataUrl, v.signing, same ? 1 : 0, now, name ?? null)
          .run();
      } else {
        tenantId = newTenantId();
        await d1
          .prepare(`INSERT INTO idp_configs (org_id, tenant_id, name, provider, idp_entity_id, sso_url, certificates, metadata_url, signing, created_by, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)`)
          .bind(orgId, tenantId, name ?? "", v.provider, v.idpEntityId, v.ssoUrl, JSON.stringify(v.certificates), metadataUrl, v.signing, user.id, now)
          .run();
      }
    } catch (e) {
      // idp_configs_entity: one configuration per IdP entity in an org
      if (/UNIQUE|constraint/i.test(String(e))) throw new HttpError(409, "This identity provider is already set up", "conflict", { field: "idpEntityId" });
      throw e;
    }
    await log(had ? "idp_config_update" : "idp_config_create", { tenant_id: tenantId, provider: v.provider, idp_entity_id: v.idpEntityId, ...(name !== undefined ? { name } : {}) });
    await changed();
    return (await idpByTenant(d1, tenantId))!;
  };

  /** Changing an IdP in use while SAML is required could lock its people out: back to any method first [F-auth] */
  const refuseLockout = async (had: IdpRow, v: Awaited<ReturnType<typeof resolveInput>>, what: string) => {
    if (!(await samlRequired()) || !(await inUse(d1, orgId, had))) return;
    if (v.idpEntityId !== had.idp_entity_id || JSON.stringify(v.certificates) !== had.certificates || v.ssoUrl !== had.sso_url)
      throw new HttpError(409, `Members must log in with SAML SSO. Let members log in with any method before changing ${what}.`, "conflict");
  };

  const remove = async (idp: IdpRow, what: string): Promise<Response> => {
    const idps = await idpsByOrg(d1, orgId);
    if (await samlRequired()) {
      if (await inUse(d1, orgId, idp)) throw new HttpError(409, `Members must log in with SAML SSO. Let members log in with any method before removing ${what}.`, "conflict");
      // The IdP left alone would serve every domain: it must be tested
      const left = idps.filter((i) => i.tenant_id !== idp.tenant_id);
      if (left.length === 1 && left[0].tested_at === null) throw new HttpError(409, "Test SAML SSO first", "conflict");
    }
    await revokeScim(idp.tenant_id, idps.length === 1);
    const { results: unmapped } = await d1.prepare(`UPDATE org_domains SET idp_tenant_id = NULL WHERE org_id = ?1 AND idp_tenant_id = ?2 RETURNING domain`).bind(orgId, idp.tenant_id).all<{ domain: string }>();
    for (const r of unmapped) await log("org_domain_idp_mapping_change", { domain: r.domain, from: idp.tenant_id, to: null });
    await d1.prepare(`DELETE FROM idp_configs WHERE tenant_id = ?1`).bind(idp.tenant_id).run();
    if (idps.length === 1) await d1.prepare(`DELETE FROM saml_requests WHERE org_id = ?1`).bind(orgId).run();
    await log("idp_config_delete", { tenant_id: idp.tenant_id });
    await changed();
    return noContent();
  };

  const input = async (): Promise<IdpConfigInput> => {
    const v = (await ctx.req.json().catch(() => null)) as IdpConfigInput | null;
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new HttpError(400, "expected a JSON object");
    return v;
  };

  if (!rest.length && m === "GET") return json(await identityOverview(ctx, orgId));

  // ---- round 4: the oldest IdP ----
  if (rest[0] === "saml") {
    const had = await idpByOrg(d1, orgId);
    if (rest.length === 1 && m === "PUT") {
      const body = await input();
      const v = await resolveInput(body, deps.fetch, now);
      if (had) await refuseLockout(had, v, "the SAML configuration");
      return json({ idp: toIdpConfig(await save(had, v, false, cleanIdpName(body.name)), url.origin) });
    }
    if (rest.length === 2 && rest[1] === "refresh" && m === "POST") {
      if (!had) throw new HttpError(404, "SAML SSO isn't set up");
      if (!had.metadata_url) throw new HttpError(409, "This configuration has no metadata URL", "conflict");
      // A rotated certificate is what Refresh is for, so it is allowed while SAML is required (the IdP's own metadata).
      const v = await resolveInput({ provider: had.provider, metadataUrl: had.metadata_url, signing: had.signing }, deps.fetch, now);
      return json({ idp: toIdpConfig(await save(had, v, true), url.origin) });
    }
    if (rest.length === 1 && m === "DELETE") {
      if (!had) return noContent();
      return remove(had, "SAML SSO");
    }
  }

  if (rest[0] === "scim-token" && rest.length === 1) {
    if (m === "POST") {
      const idp = await idpByOrg(d1, orgId);
      if (!idp) throw new HttpError(409, "Set up SAML SSO first", "conflict");
      return newScimToken(idp);
    }
    if (m === "DELETE") {
      const t = await oldestTenant();
      if (await revokeScim(t, t === null)) await changed();
      return noContent();
    }
  }

  // ---- round 14: every IdP (Governance+) ----
  if (rest[0] === "idps") {
    await requireGovernancePlus(d1, orgId);
    if (rest.length === 1) {
      if (m === "GET") return json({ idps: await idpList(ctx, orgId) });
      if (m === "POST") {
        const body = await input();
        const name = cleanIdpName(body.name);
        const v = await resolveInput(body, deps.fetch, now);
        return json({ idp: toIdpConfig(await save(null, v, false, name ?? ""), url.origin, []) }, 201);
      }
      throw new HttpError(405, "method not allowed");
    }
    const idp = await idpByTenant(d1, rest[1]);
    if (!idp || idp.org_id !== orgId) throw new HttpError(404, "no such identity provider");
    const domainsOf = async (t: string) => (await mappedDomains(d1, orgId)).get(t) ?? [];
    if (rest.length === 2) {
      if (m === "GET") return json({ idp: toIdpConfig(idp, url.origin, await domainsOf(idp.tenant_id)) });
      if (m === "PUT") {
        const body = await input();
        const name = cleanIdpName(body.name);
        const onlyName = Object.keys(body).every((k) => k === "name");
        if (onlyName) {
          if (name === undefined) throw new HttpError(400, "name", "invalid", { field: "name" });
          await d1.prepare(`UPDATE idp_configs SET name = ?2, updated_at = ?3 WHERE tenant_id = ?1`).bind(idp.tenant_id, name, now).run();
          await log("idp_config_update", { tenant_id: idp.tenant_id, name });
          await changed();
          return json({ idp: toIdpConfig((await idpByTenant(d1, idp.tenant_id))!, url.origin, await domainsOf(idp.tenant_id)) });
        }
        const v = await resolveInput(body, deps.fetch, now);
        await refuseLockout(idp, v, "this identity provider");
        return json({ idp: toIdpConfig(await save(idp, v, false, name), url.origin, await domainsOf(idp.tenant_id)) });
      }
      if (m === "DELETE") return remove(idp, "this identity provider");
      throw new HttpError(405, "method not allowed");
    }
    if (rest.length === 3 && rest[2] === "refresh" && m === "POST") {
      if (!idp.metadata_url) throw new HttpError(409, "This configuration has no metadata URL", "conflict");
      const v = await resolveInput({ provider: idp.provider, metadataUrl: idp.metadata_url, signing: idp.signing }, deps.fetch, now);
      return json({ idp: toIdpConfig(await save(idp, v, true), url.origin, await domainsOf(idp.tenant_id)) });
    }
    if (rest.length === 3 && rest[2] === "scim-token") {
      if (m === "POST") return newScimToken(idp);
      if (m === "DELETE") {
        if (await revokeScim(idp.tenant_id)) await changed();
        return noContent();
      }
    }
  }
  throw new HttpError(404, "not found");
}
