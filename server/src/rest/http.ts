/**
 * What the REST routes share (docs/multiplayer.md §16.2 decision 5, §16.5): the caller, Figma's error shapes, JSON,
 * ISO dates, users as Figma's `User`.
 */
import type { RestScope, RestUser } from "../../../src/shared/rest/types";
import type { Deps } from "../api";
import type { User } from "../db";
import { Access } from "../org/db";

/** Who calls: a session (every scope), a personal access token (its scopes), or a plan access token (one org) */
export interface RestCaller {
  kind: "session" | "personal" | "plan";
  /** A plan token's: the admin who made it (it acts as the org, never as them) */
  user: User;
  /** null: a session — everything the person may do */
  scopes: readonly RestScope[] | null;
  /** A plan token's org */
  orgId: string | null;
  tokenId: string | null;
}

export interface RestCtx {
  req: Request;
  url: URL;
  deps: Deps;
  caller: RestCaller;
  /** The path's parts after the version: ["files", key, …] */
  parts: string[];
  /** "v1" | "v2" */
  version: string;
  m: string;
  acc: Access;
  /** The rate-limit headers to send (§16.4) */
  headers?: Record<string, string>;
}

/**
 * A refusal in the route's own shape: `/v1/files/…` and `/v1/images/…` answer `{status, err}`; every other route
 * `{status, error: true, message}` (decision 5). `images`: GET /v1/images's `{id: null}` map.
 */
export class RestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

export const restJson = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });

/** Figma's file routes' error shape? (variables keep Figma's `{status, error, message}`: §16.8) */
export const fileShaped = (parts: string[]): boolean => (parts[0] === "files" && parts[2] !== "variables") || parts[0] === "images";

export function errorResponse(e: RestError, parts: string[]): Response {
  const body = e.status === 429 ? { status: 429, err: e.message } : fileShaped(parts) ? { status: e.status, err: e.message, ...e.extra } : { status: e.status, error: true, message: e.message, ...e.extra };
  return restJson(body, e.status, e.headers);
}

export const iso = (ms: number | null | undefined): string | null => (ms === null || ms === undefined ? null : new Date(ms).toISOString());

/** Figma's User: our avatars are data: URLs, so `img_url` is null (decision 14) */
export const restUser = (u: { id: string; name: string | null; email?: string | null }): RestUser => ({ id: u.id, handle: u.name || u.email || "Someone", img_url: null });

export async function userById(deps: Deps, id: string | null | undefined): Promise<RestUser | null> {
  if (!id) return null;
  const u = await deps.db.user(id);
  return u ? restUser(u) : null;
}

export const has = (c: RestCaller, scope: RestScope): boolean => {
  if (!c.scopes) return true;
  if (c.scopes.includes(scope)) return true;
  // Figma's deprecated names, still honoured
  if (scope === "folders:read") return c.scopes.includes("projects:read");
  if (scope === "folder_metadata:read") return c.scopes.includes("project_metadata:read");
  return false;
};

export async function readBody<T = Record<string, unknown>>(req: Request, maxBytes = 1024 * 1024): Promise<T> {
  const text = await req.text();
  if (text.length > maxBytes) throw new RestError(413, "Request body too large");
  try {
    const v = JSON.parse(text) as T;
    if (v && typeof v === "object" && !Array.isArray(v)) return v;
  } catch {
    // fall through
  }
  throw new RestError(400, "Invalid request body: expected a JSON object");
}

/** `plan_api_id` of an org (Figma's form) */
export const planApiId = (orgId: string | null | undefined): string => (orgId ? `organization-${orgId}` : "");

/** Figma's editorType */
export const editorTypeOf = (t: string | null | undefined): string => (!t || t === "design" ? "figma" : t);
