/**
 * Figma's public REST API on our Worker (docs/multiplayer.md §16): `/v1/…` and `/v2/…`, Figma's paths, names and shapes,
 * so a Figma client works with its base URL swapped.
 *
 * Every call: CORS for any origin (no credentials), the token (`X-Figma-Token` or `Authorization: Bearer` — a personal
 * access token `dsgn_…`, a plan access token `dsgn_plan_…`, or a session), the route's scope (scopes.ts), a plan token
 * only where the table allows it, the rate limit of the route's tier (rate.ts), then the route group. Signed URLs
 * (`/v1/blobs/…`, `/v1/library-blobs/…`, `/v1/files/:key/thumbnail`) need no token. `/v1/oauth/*` is not built (404).
 */
import type { User } from "../db";
import type { Deps } from "../api";
import { accessToken, type Caller } from "../account";
import { Access } from "../org/db";
import { HttpError } from "../org/http";
import { errorResponse, has, RestError, type RestCaller, type RestCtx } from "./http";
import { charge, rateType } from "./rate";
import { routeSpec } from "./scopes";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, x-figma-token",
  "access-control-expose-headers": "retry-after, x-figma-plan-tier, x-figma-rate-limit-type",
  "access-control-max-age": "86400",
};

/** Is this a REST path? (api.ts dispatches these before anything else) */
export const isRestPath = (pathname: string): boolean => /^\/v[12](\/|$)/.test(pathname);

/**
 * `session`: the Worker's own session check (api.ts `authenticate`) for a Bearer that isn't an access token.
 */
export async function restRoute(req: Request, deps: Deps, session: (req: Request) => Promise<Caller>): Promise<Response> {
  const url = new URL(req.url);
  const all = url.pathname.replace(/\/+$/, "").split("/").filter(Boolean).map(decodeURIComponent);
  const version = all[0];
  const parts = all.slice(1);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  let res: Response;
  try {
    res = await dispatch(req, url, deps, version, parts, session);
  } catch (e) {
    if (e instanceof RestError) res = errorResponse(e, parts);
    else if (e instanceof HttpError) res = errorResponse(new RestError(e.status, e.message), parts);
    else {
      console.error(e);
      res = errorResponse(new RestError(500, "Internal error"), parts);
    }
  }
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS)) if (!headers.has(k)) headers.set(k, v);
  return new Response(res.body, { status: res.status, headers, ...(res.headers.get("content-encoding") ? { encodeBody: "manual" } : {}) } as ResponseInit);
}

async function authenticate(req: Request, deps: Deps, session: (req: Request) => Promise<Caller>): Promise<RestCaller> {
  const figma = req.headers.get("x-figma-token");
  const header = req.headers.get("authorization");
  const raw = figma ?? (header?.startsWith("Bearer ") ? header.slice(7) : null);
  if (!raw) throw new RestError(403, "Invalid token");
  const t = await accessToken(deps, raw.trim());
  if (t) {
    const user = await deps.db.user(t.userId);
    if (!user) throw new RestError(403, "Invalid token");
    return { kind: t.kind, user, scopes: t.scopes, orgId: t.orgId, tokenId: t.id };
  }
  if (figma) throw new RestError(403, "Invalid token");
  let c: Caller;
  try {
    c = await session(req);
  } catch (e) {
    if (e instanceof HttpError) throw new RestError(e.status === 401 ? 403 : e.status, "Invalid token");
    throw e;
  }
  return { kind: c.scopes ? "personal" : "session", user: c.user as User, scopes: c.scopes, orgId: null, tokenId: null };
}

/** The org whose seats decide the rate type: the file's, the team's or folder's, else none */
async function targetOrg(deps: Deps, parts: string[], fileKey: string | undefined): Promise<string | null> {
  const d1 = deps.db.d1;
  if (fileKey) return (await d1.prepare(`SELECT org_id FROM files WHERE key = ?1`).bind(fileKey).first<{ org_id: string | null }>())?.org_id ?? null;
  if (parts[0] === "teams") return (await d1.prepare(`SELECT org_id FROM teams WHERE id = ?1`).bind(parts[1]).first<{ org_id: string }>())?.org_id ?? null;
  if (parts[0] === "folders" || parts[0] === "projects") return (await d1.prepare(`SELECT t.org_id FROM projects p JOIN teams t ON t.id = p.team_id WHERE p.id = ?1`).bind(parts[1]).first<{ org_id: string }>())?.org_id ?? null;
  if (parts[0] === "analytics") return (await d1.prepare(`SELECT org_id FROM libraries WHERE key = ?1`).bind(parts[2]).first<{ org_id: string }>())?.org_id ?? null;
  return null;
}

async function dispatch(req: Request, url: URL, deps: Deps, version: string, parts: string[], session: (req: Request) => Promise<Caller>): Promise<Response> {
  if (parts[0] === "oauth") throw new RestError(404, "Not found");
  const spec = routeSpec(version, req.method, parts);
  if (!spec) throw new RestError(404, "Not found");
  if (spec.group === "signed") return (await import("./signedUrl")).signedRoute(deps, url, parts);

  const caller = await authenticate(req, deps, session);
  if (!spec.scopes.some((s) => has(caller, s))) throw new RestError(403, `Invalid scope: this endpoint requires the ${spec.scopes.join(" or ")} scope`);
  if (caller.kind === "plan" && !spec.plan) throw new RestError(403, "A plan access token can't call this endpoint");
  const orgId = caller.kind === "plan" ? caller.orgId : await targetOrg(deps, parts, spec.fileKey);
  const headers = await charge(deps, caller, spec.tier, await rateType(deps, caller, orgId), orgId !== null || caller.kind === "plan");

  const ctx: RestCtx = { req, url, deps, caller, parts, version, m: req.method, acc: new Access(deps, caller.user), headers };
  const res = await route(ctx, spec.group);
  const out = new Headers(res.headers);
  for (const [k, v] of Object.entries(headers)) if (!out.has(k)) out.set(k, v);
  return new Response(res.body, { status: res.status, headers: out, ...(out.get("content-encoding") ? { encodeBody: "manual" } : {}) } as ResponseInit);
}

async function route(ctx: RestCtx, group: string): Promise<Response> {
  switch (group) {
    case "me":
      return (await import("./teams")).meRoute(ctx);
    case "files":
    case "images":
      return (await import("./files")).filesRoute(ctx);
    case "comments":
      return (await import("./comments")).commentsRestRoute(ctx);
    case "teams":
      return (await import("./teams")).teamsRestRoute(ctx);
    case "libraries":
      return (await import("./libraries")).librariesRestRoute(ctx);
    case "variables":
      return (await import("./variables")).variablesRestRoute(ctx);
    case "dev":
      return (await import("./devResources")).devResourcesRestRoute(ctx);
    case "analytics":
      return (await import("./analytics")).analyticsRestRoute(ctx);
    case "org":
      return (await import("./org")).orgRestRoute(ctx);
    case "webhooks":
      return (await import("../webhooks/routes")).webhooksRoute(ctx);
  }
  throw new RestError(404, "Not found");
}
