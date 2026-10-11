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
 */
import type { IdentityOverview, IdpConfigInput, ScimTokenCreated, ScimTokenInfo } from "../../../src/shared/org/identity";
import { logActivity, orgEntity } from "../activity";
import type { D1Like } from "../db";
import { orgNotice } from "../notifications";
import { personIn } from "../org/db";
import { HttpError, json, noContent, type Ctx } from "../org/http";
import { orgUserIds } from "../org/orgs";
import { randomToken, sha256b64url } from "../tokens";
import { domainsRoute, listDomains } from "./domains";
import { idpByOrg, newTenantId, resolveInput, toIdpConfig, type IdpRow } from "./saml/config";

export const SCIM_TOKEN_PREFIX = "dsgn_scim_";

export async function identityRoute(ctx: Ctx): Promise<Response> {
  const { parts, acc } = ctx;
  const orgId = parts[1];
  await acc.requireOrgAdmin(orgId);
  const rest = parts.slice(4);
  if (parts[3] === "domains") return domainsRoute(ctx, orgId, rest);
  return identity(ctx, orgId, rest);
}

const scimBase = (origin: string, tenantId: string) => `${origin}/scim/v2/${tenantId}`;

async function liveToken(d1: D1Like, orgId: string): Promise<{ id: string; created_at: number; created_by: string | null; last_used_at: number | null } | null> {
  return d1.prepare(`SELECT id, created_at, created_by, last_used_at FROM scim_tokens WHERE org_id = ?1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`).bind(orgId).first();
}

async function tokenInfo(d1: D1Like, orgId: string, r: { id: string; created_at: number; created_by: string | null; last_used_at: number | null }): Promise<ScimTokenInfo> {
  return { id: r.id, createdAt: r.created_at, createdBy: r.created_by ? await personIn(d1, orgId, r.created_by) : null, lastUsedAt: r.last_used_at };
}

export async function identityOverview(ctx: Ctx, orgId: string): Promise<IdentityOverview> {
  const d1 = ctx.acc.d1;
  const settings = await ctx.acc.settings(orgId);
  const idp = await idpByOrg(d1, orgId);
  const token = idp ? await liveToken(d1, orgId) : null;
  return {
    authMethod: settings.authMethod,
    idp: idp ? toIdpConfig(idp, ctx.url.origin) : null,
    scim: idp ? { baseUrl: scimBase(ctx.url.origin, idp.tenant_id), token: token ? await tokenInfo(d1, orgId, token) : null } : null,
    domains: await listDomains(d1, orgId),
    domainCapture: settings.domainCapture,
  };
}

/** Revokes the org's live SCIM token, logged; false when there was none */
async function revokeScim(ctx: Ctx, orgId: string): Promise<boolean> {
  const d1 = ctx.acc.d1;
  const { results } = await d1.prepare(`UPDATE scim_tokens SET revoked_at = ?2 WHERE org_id = ?1 AND revoked_at IS NULL RETURNING id`).bind(orgId, ctx.deps.now()).all<{ id: string }>();
  const org = (await ctx.acc.org(orgId))!;
  for (const r of results) await logActivity(ctx.deps, { orgId, action: "scim_token_revoke", actor: ctx.user, entity: orgEntity(org), details: { token_id: r.id }, req: ctx.req });
  return results.length > 0;
}

async function identity(ctx: Ctx, orgId: string, rest: string[]): Promise<Response> {
  const { m, deps, user, acc, url } = ctx;
  const d1 = acc.d1;
  const now = deps.now();
  const org = (await acc.org(orgId))!;
  const log = (action: "idp_config_create" | "idp_config_update" | "idp_config_delete" | "scim_token_generate", details: Record<string, unknown> = {}) =>
    logActivity(deps, { orgId, action, actor: user, entity: orgEntity(org), details, req: ctx.req });
  const changed = async () => orgNotice(deps, await orgUserIds(d1, orgId), { what: "org", orgId });

  if (!rest.length && m === "GET") return json(await identityOverview(ctx, orgId));

  if (rest[0] === "saml") {
    const had = await idpByOrg(d1, orgId);
    const save = async (v: Awaited<ReturnType<typeof resolveInput>>, keepUrl: boolean): Promise<IdpRow> => {
      const metadataUrl = v.metadataUrl ?? (keepUrl ? (had?.metadata_url ?? null) : null);
      if (had) {
        // Another IdP (entity id or SSO URL) has to be tested again before it can be required; a rotated certificate not.
        const same = had.idp_entity_id === v.idpEntityId && had.sso_url === v.ssoUrl;
        await d1
          .prepare(`UPDATE idp_configs SET provider = ?2, idp_entity_id = ?3, sso_url = ?4, certificates = ?5, metadata_url = ?6, signing = ?7, tested_at = CASE WHEN ?8 = 1 THEN tested_at ELSE NULL END, updated_at = ?9 WHERE org_id = ?1`)
          .bind(orgId, v.provider, v.idpEntityId, v.ssoUrl, JSON.stringify(v.certificates), metadataUrl, v.signing, same ? 1 : 0, now)
          .run();
        await log("idp_config_update", { tenant_id: had.tenant_id, provider: v.provider, idp_entity_id: v.idpEntityId });
      } else {
        const tenantId = newTenantId();
        await d1
          .prepare(`INSERT INTO idp_configs (org_id, tenant_id, provider, idp_entity_id, sso_url, certificates, metadata_url, signing, created_by, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)`)
          .bind(orgId, tenantId, v.provider, v.idpEntityId, v.ssoUrl, JSON.stringify(v.certificates), metadataUrl, v.signing, user.id, now)
          .run();
        await log("idp_config_create", { tenant_id: tenantId, provider: v.provider, idp_entity_id: v.idpEntityId });
      }
      await changed();
      return (await idpByOrg(d1, orgId))!;
    };
    if (rest.length === 1 && m === "PUT") {
      const input = (await ctx.req.json().catch(() => null)) as IdpConfigInput | null;
      if (!input || typeof input !== "object") throw new HttpError(400, "expected a JSON object");
      const v = await resolveInput(input, deps.fetch, now);
      // Changing the IdP while it is required could lock everyone out: back to any method first [F-auth].
      if (had && (await acc.settings(orgId)).authMethod === "saml" && (v.idpEntityId !== had.idp_entity_id || JSON.stringify(v.certificates) !== had.certificates || v.ssoUrl !== had.sso_url))
        throw new HttpError(409, "Members must log in with SAML SSO. Let members log in with any method before changing the SAML configuration.", "conflict");
      return json({ idp: toIdpConfig(await save(v, false), url.origin) });
    }
    if (rest.length === 2 && rest[1] === "refresh" && m === "POST") {
      if (!had) throw new HttpError(404, "SAML SSO isn't set up");
      if (!had.metadata_url) throw new HttpError(409, "This configuration has no metadata URL", "conflict");
      // A rotated certificate is what Refresh is for, so it is allowed while SAML is required (the IdP's own metadata).
      const v = await resolveInput({ provider: had.provider, metadataUrl: had.metadata_url, signing: had.signing }, deps.fetch, now);
      return json({ idp: toIdpConfig(await save(v, true), url.origin) });
    }
    if (rest.length === 1 && m === "DELETE") {
      if (!had) return noContent();
      if ((await acc.settings(orgId)).authMethod === "saml") throw new HttpError(409, "Members must log in with SAML SSO. Let members log in with any method before removing SAML SSO.", "conflict");
      await revokeScim(ctx, orgId);
      await d1.prepare(`DELETE FROM idp_configs WHERE org_id = ?1`).bind(orgId).run();
      await d1.prepare(`DELETE FROM saml_requests WHERE org_id = ?1`).bind(orgId).run();
      await log("idp_config_delete", { tenant_id: had.tenant_id });
      await changed();
      return noContent();
    }
  }

  if (rest[0] === "scim-token" && rest.length === 1) {
    if (m === "POST") {
      const idp = await idpByOrg(d1, orgId);
      if (!idp) throw new HttpError(409, "Set up SAML SSO first", "conflict");
      // One live token per org (decision 8): a new one revokes the old.
      await revokeScim(ctx, orgId);
      const id = `st_${randomToken(9)}`;
      const token = `${SCIM_TOKEN_PREFIX}${randomToken(32)}`;
      await d1.prepare(`INSERT INTO scim_tokens (id, org_id, token_hash, created_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5)`).bind(id, orgId, await sha256b64url(token), user.id, now).run();
      await log("scim_token_generate", { token_id: id });
      await changed();
      return json({ token, info: await tokenInfo(d1, orgId, { id, created_at: now, created_by: user.id, last_used_at: null }) } satisfies ScimTokenCreated, 201);
    }
    if (m === "DELETE") {
      if (await revokeScim(ctx, orgId)) await changed();
      return noContent();
    }
  }
  throw new HttpError(404, "not found");
}
