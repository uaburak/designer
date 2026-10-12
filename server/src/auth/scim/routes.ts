/**
 * SCIM 2.0 — `/scim/v2/:tenantId/…` (docs/multiplayer.md §15.5; Figma's [F-scim-api]). `Authorization: Bearer
 * dsgn_scim_…`, the org's one live token (only its SHA-256 is stored), whose org must own the tenant; every answer is
 * `application/scim+json`, errors RFC 7644's.
 *
 *   GET  /scim/v2/:tenantId                        200 {} — Figma's tenant check (400 for an unknown tenant)
 *   GET  …/ServiceProviderConfig · …/Schemas · …/ResourceTypes
 *   GET|POST …/Users        GET|PUT|PATCH|DELETE …/Users/:id        (auth/scim/users.ts)
 *   GET|POST …/Groups       GET|PUT|PATCH|DELETE …/Groups/:id       (auth/scim/groups.ts)
 */
import { SCIM_ENTERPRISE_SCHEMA, SCIM_FIGMA_SCHEMA, SCIM_GROUP_SCHEMA, SCIM_USER_SCHEMA } from "../../../../src/shared/org/identity";
import type { Deps } from "../../api";
import { sha256b64url } from "../../tokens";
import { idpByOrg, idpByTenant } from "../saml/config";
import { SCIM_TOKEN_PREFIX } from "../identityRoutes";
import { ScimError, scimError, scimJson, type ScimCtx } from "./common";
import { groupsRoute } from "./groups";
import { usersRoute } from "./users";

export async function scimRoute(req: Request, url: URL, deps: Deps, parts: string[]): Promise<Response> {
  try {
    return await route(req, url, deps, parts);
  } catch (e) {
    if (e instanceof ScimError) return scimError(e);
    console.error("scim:", e);
    return scimError(new ScimError(500, "internal error"));
  }
}

async function route(req: Request, url: URL, deps: Deps, parts: string[]): Promise<Response> {
  // ["scim", "v2", tenantId, …rest]
  if (parts[1] !== "v2" || !parts[2]) throw new ScimError(404, "not found");
  const idp = await idpByTenant(deps.db.d1, parts[2]);
  const rest = parts.slice(3);
  const header = req.headers.get("authorization");
  const raw = header?.startsWith("Bearer ") ? header.slice(7).trim() : null;
  if (!raw) {
    if (!rest.length && req.method === "GET") {
      if (!idp) throw new ScimError(400, "unknown tenant");
      return scimJson({});
    }
    throw new ScimError(401, "a SCIM token is required");
  }
  const tok = raw.startsWith(SCIM_TOKEN_PREFIX)
    ? await deps.db.d1.prepare(`SELECT id, org_id, tenant_id, created_by, last_used_at FROM scim_tokens WHERE token_hash = ?1 AND revoked_at IS NULL`).bind(await sha256b64url(raw)).first<{ id: string; org_id: string; tenant_id: string | null; created_by: string | null; last_used_at: number | null }>()
    : null;
  // A token per IdP (docs/governance.md §2.9); one from before round 14 without a tenant serves the org's oldest IdP
  const forTenant = tok && idp && tok.org_id === idp.org_id && (tok.tenant_id === idp.tenant_id || (tok.tenant_id === null && (await idpByOrg(deps.db.d1, idp.org_id))?.tenant_id === idp.tenant_id));
  if (!tok || !idp || !forTenant) throw new ScimError(401, "the SCIM token isn't valid for this tenant");
  const now = deps.now();
  if (tok.last_used_at === null || tok.last_used_at < now - 60_000) await deps.db.d1.prepare(`UPDATE scim_tokens SET last_used_at = ?2 WHERE id = ?1`).bind(tok.id, now).run();
  const ctx: ScimCtx = { deps, req, orgId: idp.org_id, tenantId: idp.tenant_id, base: `${url.origin}/scim/v2/${idp.tenant_id}`, tokenCreator: tok.created_by };

  if (!rest.length) {
    if (req.method === "GET") return scimJson({});
    throw new ScimError(405, "method not allowed");
  }
  switch (rest[0]) {
    case "Users":
      return usersRoute(ctx, url, rest.slice(1));
    case "Groups":
      return groupsRoute(ctx, url, rest.slice(1));
    case "ServiceProviderConfig":
      if (req.method === "GET" && rest.length === 1) return scimJson(serviceProviderConfig(ctx));
      break;
    case "Schemas":
      if (req.method === "GET" && rest.length === 1) return scimJson({ schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"], totalResults: SCHEMAS.length, startIndex: 1, itemsPerPage: SCHEMAS.length, Resources: SCHEMAS });
      if (req.method === "GET" && rest.length === 2) {
        const s = SCHEMAS.find((x) => x.id === rest[1]);
        if (s) return scimJson(s);
        throw new ScimError(404, `no schema ${rest[1]}`);
      }
      break;
    case "ResourceTypes":
      if (req.method === "GET" && rest.length === 1) return scimJson({ schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"], totalResults: 2, startIndex: 1, itemsPerPage: 2, Resources: resourceTypes(ctx) });
      if (req.method === "GET" && rest.length === 2) {
        const t = resourceTypes(ctx).find((x) => x.id === rest[1]);
        if (t) return scimJson(t);
        throw new ScimError(404, `no resource type ${rest[1]}`);
      }
      break;
  }
  throw new ScimError(404, "not found");
}

function serviceProviderConfig(ctx: ScimCtx) {
  return {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: 200 },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [{ type: "oauthbearertoken", name: "OAuth Bearer Token", description: "The API token from Admin › Settings › SCIM provisioning", primary: true }],
    meta: { resourceType: "ServiceProviderConfig", location: `${ctx.base}/ServiceProviderConfig` },
  };
}

function resourceTypes(ctx: ScimCtx) {
  return [
    {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
      id: "User",
      name: "User",
      endpoint: "/Users",
      schema: SCIM_USER_SCHEMA,
      schemaExtensions: [
        { schema: SCIM_ENTERPRISE_SCHEMA, required: false },
        { schema: SCIM_FIGMA_SCHEMA, required: false },
      ],
      meta: { resourceType: "ResourceType", location: `${ctx.base}/ResourceTypes/User` },
    },
    { schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"], id: "Group", name: "Group", endpoint: "/Groups", schema: SCIM_GROUP_SCHEMA, meta: { resourceType: "ResourceType", location: `${ctx.base}/ResourceTypes/Group` } },
  ];
}

type Attr = { name: string; type: string; multiValued: boolean; required: boolean; mutability: string; returned: string; uniqueness: string; caseExact: boolean; subAttributes?: Attr[] };
const attr = (name: string, o: Partial<Attr> = {}): Attr => ({ name, type: "string", multiValued: false, required: false, mutability: "readWrite", returned: "default", uniqueness: "none", caseExact: false, ...o });
const schema = (id: string, name: string, attributes: Attr[]) => ({ schemas: ["urn:ietf:params:scim:schemas:core:2.0:Schema"], id, name, description: name, attributes, meta: { resourceType: "Schema", location: `/Schemas/${id}` } });

/** RFC 7643 §7: the attributes we read and return */
const SCHEMAS = [
  schema(SCIM_USER_SCHEMA, "User", [
    attr("userName", { required: true, uniqueness: "server" }),
    attr("name", { type: "complex", subAttributes: [attr("givenName"), attr("familyName")] }),
    attr("displayName"),
    attr("title"),
    attr("externalId", { caseExact: true }),
    attr("emails", { type: "complex", multiValued: true, subAttributes: [attr("value"), attr("type"), attr("primary", { type: "boolean" })] }),
    attr("active", { type: "boolean" }),
    attr("roles", { type: "complex", multiValued: true, subAttributes: [attr("type"), attr("value"), attr("primary", { type: "boolean" })] }),
  ]),
  schema(SCIM_ENTERPRISE_SCHEMA, "EnterpriseUser", [
    attr("employeeNumber"),
    attr("costCenter"),
    attr("organization"),
    attr("division"),
    attr("department"),
    attr("manager", { type: "complex", subAttributes: [attr("value"), attr("displayName", { mutability: "readOnly" })] }),
  ]),
  schema(SCIM_FIGMA_SCHEMA, "FigmaUser", [attr("figmaAdmin", { type: "boolean" })]),
  schema(SCIM_GROUP_SCHEMA, "Group", [attr("displayName", { required: true }), attr("externalId", { caseExact: true }), attr("members", { type: "complex", multiValued: true, subAttributes: [attr("value", { mutability: "immutable" }), attr("display", { mutability: "readOnly" })] })]),
];
