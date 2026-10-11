/**
 * SCIM 2.0's shared pieces (docs/multiplayer.md §15.5; RFC 7643 / 7644): errors in RFC 7644's shape, the token's
 * context, `ListResponse` paging, `eq` filters, and the loose values IdPs send (Entra's `"True"` / `"Replace"`).
 */
import type { Deps } from "../../api";

export const SCIM_JSON = "application/scim+json";
export const ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";
export const LIST_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
export const PATCH_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp";

export type ScimType = "uniqueness" | "invalidFilter" | "invalidValue" | "invalidPath" | "mutability" | "noTarget" | "invalidSyntax";

export class ScimError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly scimType?: ScimType,
  ) {
    super(message);
  }
}

export const scimJson = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": `${SCIM_JSON}; charset=utf-8` } });
export const scimError = (e: ScimError): Response => scimJson({ schemas: [ERROR_SCHEMA], status: String(e.status), ...(e.scimType ? { scimType: e.scimType } : {}), detail: e.message }, e.status);

/** The token's org and where its resources live */
export interface ScimCtx {
  deps: Deps;
  req: Request;
  orgId: string;
  tenantId: string;
  /** `<origin>/scim/v2/<tenantId>` */
  base: string;
  /** Who generated the token (user groups made by SCIM name them as their creator); null if they are gone */
  tokenCreator: string | null;
}

export async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const v = (await req.json()) as unknown;
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    // below
  }
  throw new ScimError(400, "expected a JSON object", "invalidSyntax");
}

/** `true` / `false`, or Entra's strings */
export function bool(v: unknown, what: string): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string" && /^(true|false)$/i.test(v.trim())) return v.trim().toLowerCase() === "true";
  throw new ScimError(400, `${what} must be a boolean`, "invalidValue");
}

/** An optional string attribute (null clears), capped */
export function str(v: unknown, what: string, max: number): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v !== "string") throw new ScimError(400, `${what} must be a string`, "invalidValue");
  if (v.length > max) throw new ScimError(400, `${what} is longer than ${max} characters`, "invalidValue");
  return v;
}

/** `filter=<attr> eq "<value>"` on the listed attributes only (else 400 invalidFilter) */
export function parseFilter(filter: string | null, attrs: readonly string[]): { attr: string; value: string } | null {
  if (filter === null || filter.trim() === "") return null;
  const m = /^\s*([A-Za-z.]+)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i.exec(filter);
  const attr = m ? attrs.find((a) => a.toLowerCase() === m[1].toLowerCase()) : undefined;
  if (!m || !attr) throw new ScimError(400, `only ${attrs.map((a) => `${a} eq "…"`).join(" or ")} filters are supported`, "invalidFilter");
  return { attr, value: m[2].replace(/\\(.)/g, "$1") };
}

/** `startIndex` (1-based) and `count` (≤ 200) */
export function paging(url: URL): { offset: number; count: number; startIndex: number } {
  const startIndex = Math.max(1, Math.floor(Number(url.searchParams.get("startIndex")) || 1));
  const raw = url.searchParams.get("count");
  const count = raw === null ? 100 : Math.max(0, Math.min(200, Math.floor(Number(raw)) || 0));
  return { offset: startIndex - 1, count, startIndex };
}

export const listResponse = (resources: unknown[], total: number, startIndex: number) => ({ schemas: [LIST_SCHEMA], totalResults: total, startIndex, itemsPerPage: resources.length, Resources: resources });

export const iso = (ms: number) => new Date(ms).toISOString();

/** A PatchOp body → its operations, `op` lower-cased (Entra sends "Replace") */
export function patchOps(body: Record<string, unknown>): { op: "add" | "replace" | "remove"; path: string | null; value: unknown }[] {
  const ops = body.Operations ?? body.operations;
  if (!Array.isArray(ops) || !ops.length) throw new ScimError(400, "a PatchOp needs Operations", "invalidSyntax");
  return ops.map((o: { op?: unknown; path?: unknown; value?: unknown }) => {
    const op = typeof o?.op === "string" ? o.op.toLowerCase() : "";
    if (op !== "add" && op !== "replace" && op !== "remove") throw new ScimError(400, `unknown op ${String(o?.op)}`, "invalidSyntax");
    if (o.path !== undefined && o.path !== null && typeof o.path !== "string") throw new ScimError(400, "path must be a string", "invalidPath");
    return { op, path: typeof o.path === "string" && o.path.trim() ? o.path.trim() : null, value: o.value };
  });
}
