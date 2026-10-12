/**
 * Developer logs (docs/governance.md §1 "Developer Logs API", §2.12):
 *
 * - Written: `restRoute` (rest/index.ts `developerLogLine`) for every `/v1` and `/v2` call that reached a Governance+
 *   org's resource (the file's, team's, folder's or library's org, or a plan token's), after the answer
 *   (`waitUntil`); main's MCP tool calls on org files, client-reported (discovery/routes.ts
 *   `POST /orgs/:org/developer-logs/mcp`). `event_name` is the path pattern ("/v1/files/:file_key/comments") or the
 *   tool's name; city, region and country are `request.cf`'s.
 * - Read: `POST /v1/developer_logs` (Tier 3, plan tokens only, scope `org:developer_log_read`) with Figma's body and
 *   answer, and Admin › Activity › Developer logs (`GET /orgs/:org/admin/developer-logs?…`, the same filters as query
 *   parameters, `adminDeveloperLogs`). Newest first; the cursor is opaque.
 *
 * Filters (Figma's): `token` (the secret itself: hashed and matched against `access_tokens.token_hash`),
 * `token_name`, `user_email`, `ip_address` (prefixes; a comma means OR), `token_type`, `event_source`,
 * `date_range` (LAST_24H | LAST_7D | LAST_30D, default LAST_30D — ours), `limit` (25, at most 100), `cursor`.
 */
import { DEVELOPER_LOGS_RETENTION_MS, type DeveloperLogItem, type DeveloperLogsQuery, type DeveloperLogsResponse } from "../../../src/shared/org/governance";
import type { Deps } from "../api";
import { HttpError, type Ctx } from "../org/http";
import { b64url, fromB64url, sha256b64url } from "../tokens";
import { afterAnswer, governanceOrgs } from "../discovery/record";
import { RestError, readBody, restJson, type RestCaller, type RestCtx } from "./http";

export interface DeveloperLogEntry {
  orgId: string;
  eventName: string;
  eventSource: "rest_api" | "mcp_server";
  userId: string | null;
  tokenId: string | null;
  /** null: the token's description, read with the row */
  tokenName: string | null;
  tokenType: "plan_access_token" | "personal_access_token" | "oauth_token" | "session";
  /** `name` null: read with the row from the type's table (file, team, project) */
  resource: { type: string | null; id: string | null; name: string | null };
  /** `CF-Connecting-IP` and `request.cf`'s place */
  ip: string;
  city: string | null;
  countryRegion: string | null;
  country: string | null;
  /** ms; default now */
  at?: number;
}

/** One row; the person's name and email, the token's name and the resource's name are read by the same statement */
export async function logDeveloperCall(deps: Pick<Deps, "db" | "now">, entry: DeveloperLogEntry): Promise<void> {
  await logDeveloperCalls(deps, [entry]);
}

export async function logDeveloperCalls(deps: Pick<Deps, "db" | "now">, entries: DeveloperLogEntry[]): Promise<void> {
  if (!entries.length) return;
  const rows = entries.map((e) => ({
    uuid: crypto.randomUUID(),
    org_id: e.orgId,
    at: e.at ?? deps.now(),
    event_name: e.eventName.slice(0, 200),
    event_source: e.eventSource,
    user_id: e.userId,
    token_id: e.tokenId,
    token_name: e.tokenName,
    token_type: e.tokenType,
    resource_type: e.resource.type,
    resource_id: e.resource.id,
    resource_name: e.resource.name,
    ip_address: e.ip,
    city: e.city,
    country_region: e.countryRegion,
    country: e.country,
  }));
  await deps.db.d1
    .prepare(
      `INSERT INTO developer_logs (uuid, org_id, at, event_name, event_source, user_id, user_name, user_email, token_id, token_name, token_type,
         resource_type, resource_id, resource_name, ip_address, city, country_region, country)
       SELECT j.value ->> 'uuid', j.value ->> 'org_id', j.value ->> 'at', j.value ->> 'event_name', j.value ->> 'event_source', j.value ->> 'user_id',
         u.name, u.email, j.value ->> 'token_id',
         COALESCE(j.value ->> 'token_name', (SELECT t.description FROM access_tokens t WHERE t.id = j.value ->> 'token_id')),
         j.value ->> 'token_type', j.value ->> 'resource_type', j.value ->> 'resource_id',
         COALESCE(j.value ->> 'resource_name', CASE j.value ->> 'resource_type'
           WHEN 'file' THEN (SELECT f.name FROM files f WHERE f.key = j.value ->> 'resource_id')
           WHEN 'team' THEN (SELECT tm.name FROM teams tm WHERE tm.id = j.value ->> 'resource_id')
           WHEN 'project' THEN (SELECT p.name FROM projects p WHERE p.id = j.value ->> 'resource_id')
           WHEN 'org' THEN (SELECT o.name FROM orgs o WHERE o.id = j.value ->> 'resource_id') END),
         j.value ->> 'ip_address', j.value ->> 'city', j.value ->> 'country_region', j.value ->> 'country'
       FROM json_each(?1) j LEFT JOIN users u ON u.id = j.value ->> 'user_id'`,
    )
    .bind(JSON.stringify(rows))
    .run();
}

// ---- the line in restRoute ------------------------------------------------------------------------------------------

/** Path parts whose next part is an id, and the id's name in the pattern */
const IDS: Record<string, string> = {
  files: ":file_key",
  images: ":file_key",
  teams: ":team_id",
  projects: ":project_id",
  folders: ":folder_id",
  components: ":key",
  component_sets: ":key",
  styles: ":key",
  libraries: ":file_key",
  webhooks: ":webhook_id",
  comments: ":comment_id",
  dev_resources: ":dev_resource_id",
};

/** "/v1/files/:file_key/comments/:comment_id/reactions" */
export function pathPattern(version: string, parts: string[]): string {
  return `/${[version, ...parts.map((p, i) => (i > 0 && IDS[parts[i - 1]] ? IDS[parts[i - 1]] : p))].join("/")}`;
}

const TOKEN_TYPE: Record<RestCaller["kind"], DeveloperLogEntry["tokenType"]> = { plan: "plan_access_token", personal: "personal_access_token", session: "session" };

/**
 * The developer log line of a REST call, or null (no org, or not a Governance+ org: one cached list, no query).
 * `fileKey`: the route's file.
 */
export async function developerLogLine(deps: Deps, req: Request, version: string, parts: string[], caller: RestCaller, orgId: string | null, fileKey: string | undefined): Promise<DeveloperLogEntry | null> {
  if (!orgId || !(await governanceOrgs(deps.db.d1, deps.now())).gplus.has(orgId)) return null;
  const cf = (req as { cf?: { city?: string; region?: string; country?: string } }).cf;
  const resource: DeveloperLogEntry["resource"] = fileKey
    ? { type: "file", id: fileKey, name: null }
    : parts[0] === "teams"
      ? { type: "team", id: parts[1] ?? null, name: null }
      : parts[0] === "projects" || parts[0] === "folders"
        ? { type: "project", id: parts[1] ?? null, name: null }
        : parts[0] === "analytics"
          ? { type: "file", id: parts[2] ?? null, name: null }
          : parts[0] === "webhooks" && parts[1]
            ? { type: "webhook", id: parts[1], name: null }
            : { type: "org", id: orgId, name: null };
  return {
    orgId,
    eventName: pathPattern(version, parts),
    eventSource: "rest_api",
    userId: caller.user.id,
    tokenId: caller.tokenId,
    tokenName: null,
    tokenType: TOKEN_TYPE[caller.kind],
    resource,
    ip: req.headers.get("cf-connecting-ip") ?? "",
    city: cf?.city ?? null,
    countryRegion: cf?.region ?? null,
    country: cf?.country ?? null,
  };
}

/** Written after the answer, so it never slows it */
export function writeDeveloperLog(deps: Deps, entry: DeveloperLogEntry): Promise<void> {
  return afterAnswer(deps, () => logDeveloperCall(deps, entry));
}

// ---- reading ---------------------------------------------------------------------------------------------------------

const RANGES = { LAST_24H: 86_400_000, LAST_7D: 7 * 86_400_000, LAST_30D: DEVELOPER_LOGS_RETENTION_MS } as const;
const TYPES = { PLAN_ACCESS_TOKEN: "plan_access_token", PERSONAL_ACCESS_TOKEN: "personal_access_token", OAUTH_TOKEN: "oauth_token" } as const;
const SOURCES = { REST_API: "rest_api", MCP_SERVER: "mcp_server" } as const;
/** Values per comma list (D1 binds at most 100 parameters) */
const MAX_VALUES = 10;

class BadQuery extends Error {}

const list = (v: unknown, name: string): string[] => {
  if (v === undefined || v === null || v === "") return [];
  if (typeof v !== "string") throw new BadQuery(`${name} is a string`);
  const out = v.split(",").map((s) => s.trim()).filter(Boolean);
  if (out.length > MAX_VALUES) throw new BadQuery(`${name}: at most ${MAX_VALUES} values`);
  return out;
};

const likePrefix = (s: string) => `${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

interface Row {
  uuid: string;
  org_id: string;
  at: number;
  event_name: string;
  event_source: "rest_api" | "mcp_server";
  user_id: string | null;
  user_name: string | null;
  user_email: string | null;
  token_name: string | null;
  token_type: DeveloperLogItem["actor"]["token_type"];
  resource_type: string | null;
  resource_id: string | null;
  resource_name: string | null;
  ip_address: string;
  city: string | null;
  country_region: string | null;
  country: string | null;
}

const itemOf = (r: Row): DeveloperLogItem => ({
  uuid: r.uuid,
  timestamp: new Date(r.at).toISOString(),
  action: { event_name: r.event_name, event_source: r.event_source },
  actor: { user_id: r.user_id, user_name: r.user_name, token_name: r.token_name, token_type: r.token_type, user_email: r.user_email },
  resource: { id_or_key: r.resource_id, name: r.resource_name, type: r.resource_type, org_id: r.org_id },
  context: { ip_address: r.ip_address, city: r.city, country_region: r.country_region, country: r.country },
});

/** One page of an org's developer logs (throws BadQuery on a bad filter) */
export async function developerLogsPage(deps: Pick<Deps, "db" | "now">, orgId: string, q: DeveloperLogsQuery): Promise<DeveloperLogsResponse> {
  const where: string[] = ["org_id = ?1", "at >= ?2"];
  const binds: unknown[] = [orgId];
  const range = q.date_range ?? "LAST_30D";
  if (typeof range !== "string" || !Object.hasOwn(RANGES, range)) throw new BadQuery("date_range is LAST_24H, LAST_7D or LAST_30D");
  binds.push(deps.now() - RANGES[range]);
  const bind = (v: unknown) => `?${binds.push(v)}`;
  const prefixes = (col: string, values: string[]) => {
    if (values.length) where.push(`(${values.map((v) => `${col} LIKE ${bind(likePrefix(v))} ESCAPE '\\'`).join(" OR ")})`);
  };
  const tokens = list(q.token, "token");
  if (tokens.length) {
    const hashes = await Promise.all(tokens.map((t) => sha256b64url(t)));
    where.push(`token_id IN (SELECT id FROM access_tokens WHERE token_hash IN (SELECT value FROM json_each(${bind(JSON.stringify(hashes))})))`);
  }
  prefixes("token_name", list(q.token_name, "token_name"));
  prefixes("user_email", list(q.user_email, "user_email"));
  prefixes("ip_address", list(q.ip_address, "ip_address"));
  if (q.token_type !== undefined) {
    if (typeof q.token_type !== "string" || !Object.hasOwn(TYPES, q.token_type)) throw new BadQuery("token_type is PLAN_ACCESS_TOKEN, PERSONAL_ACCESS_TOKEN or OAUTH_TOKEN");
    where.push(`token_type = ${bind(TYPES[q.token_type])}`);
  }
  if (q.event_source !== undefined) {
    if (typeof q.event_source !== "string" || !Object.hasOwn(SOURCES, q.event_source)) throw new BadQuery("event_source is REST_API or MCP_SERVER");
    where.push(`event_source = ${bind(SOURCES[q.event_source])}`);
  }
  const limit = q.limit === undefined ? 25 : Number(q.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new BadQuery("limit is between 1 and 100");
  if (q.cursor) {
    const raw = fromB64url(q.cursor);
    const m = raw ? /^(\d+):([0-9a-f-]{36})$/.exec(new TextDecoder().decode(raw)) : null;
    if (!m) throw new BadQuery("Invalid cursor");
    const at = bind(Number(m[1]));
    where.push(`(at < ${at} OR (at = ${at} AND uuid < ${bind(m[2])}))`);
  }
  const { results } = await deps.db.d1
    .prepare(`SELECT * FROM developer_logs WHERE ${where.join(" AND ")} ORDER BY at DESC, uuid DESC LIMIT ${bind(limit + 1)}`)
    .bind(...binds)
    .all<Row>();
  const more = results.length > limit;
  const page = results.slice(0, limit);
  const last = page.at(-1);
  return { status: 200, error: false, meta: { items: page.map(itemOf), cursor: more && last ? b64url(new TextEncoder().encode(`${last.at}:${last.uuid}`)) : null, has_more: more } };
}

/** `POST /v1/developer_logs`: plan tokens only (Figma) */
export async function developerLogsRestRoute(ctx: RestCtx): Promise<Response> {
  if (ctx.caller.kind !== "plan") throw new RestError(403, "This endpoint takes a plan access token");
  const orgId = ctx.caller.orgId!;
  const o = await ctx.deps.db.d1.prepare(`SELECT governance_plus FROM orgs WHERE id = ?1`).bind(orgId).first<{ governance_plus: number }>();
  if (!o?.governance_plus) throw new RestError(403, "This endpoint requires Governance+");
  const body = await readBody<DeveloperLogsQuery>(ctx.req, 64 * 1024);
  try {
    return restJson(await developerLogsPage(ctx.deps, orgId, body));
  } catch (e) {
    if (e instanceof BadQuery) throw new RestError(400, e.message);
    throw e;
  }
}

/** `GET /orgs/:org/admin/developer-logs?…` (org admins; admin.ts checked that): Admin › Activity › Developer logs */
export async function adminDeveloperLogs(ctx: Ctx, orgId: string): Promise<Response> {
  const org = await ctx.acc.org(orgId);
  if (!org?.governance_plus) throw new HttpError(403, "Requires Governance+", "governance_plus_required");
  const q = ctx.url.searchParams;
  const get = (k: string) => q.get(k) ?? undefined;
  const query: DeveloperLogsQuery = {
    token: get("token"),
    token_name: get("token_name"),
    user_email: get("user_email"),
    ip_address: get("ip_address"),
    token_type: get("token_type") as DeveloperLogsQuery["token_type"],
    event_source: get("event_source") as DeveloperLogsQuery["event_source"],
    date_range: get("date_range") as DeveloperLogsQuery["date_range"],
    limit: q.get("limit") ? Number(q.get("limit")) : undefined,
    cursor: get("cursor"),
  };
  try {
    return new Response(JSON.stringify(await developerLogsPage(ctx.deps, orgId, query)), { headers: { "content-type": "application/json; charset=utf-8" } });
  } catch (e) {
    if (e instanceof BadQuery) throw new HttpError(400, e.message);
    throw e;
  }
}
