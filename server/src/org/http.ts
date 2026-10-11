/**
 * What every route shares (docs/multiplayer.md §14.12): errors with a machine-readable `code`, JSON, ids, pages, CSV.
 */
import type { User } from "../db";
import type { Deps } from "../api";
import type { Access } from "./db";

export type ErrorCode = "invalid" | "unauthorized" | "forbidden" | "seat_required" | "not_admin" | "admins_only" | "guest_blocked" | "password_required" | "not_found" | "conflict" | "gone" | "too_large" | "rate_limited" | "internal" | "stale" | "branch_cannot_publish" | "draft_cannot_publish";

const CODE_OF: Record<number, ErrorCode> = { 400: "invalid", 401: "unauthorized", 403: "forbidden", 404: "not_found", 405: "invalid", 409: "conflict", 410: "gone", 413: "too_large", 426: "invalid", 429: "rate_limited" };

/** `{error, code}` (+ `detail`) with the status. `error` stays the human message, as before §14. */
export class HttpError extends Error {
  readonly code: ErrorCode;
  constructor(
    readonly status: number,
    message: string,
    code?: ErrorCode,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.code = code ?? CODE_OF[status] ?? "internal";
  }
}

export const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
export const noContent = (): Response => new Response(null, { status: 204 });
export const errorBody = (e: HttpError) => ({ error: e.message, code: e.code, ...(e.detail ?? {}) });

export async function body<T = Record<string, unknown>>(req: Request): Promise<T> {
  try {
    const v = (await req.json()) as T;
    if (v && typeof v === "object" && !Array.isArray(v)) return v;
  } catch {
    // fall through
  }
  throw new HttpError(400, "expected a JSON object");
}

const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
/** 16-character base62 ids (orgs, workspaces, teams, folders, groups, requests — §14.5 "Ids"). */
export function randomId(n = 16): string {
  const bytes = crypto.getRandomValues(new Uint8Array(n * 2));
  let out = "";
  for (const b of bytes) {
    if (b >= 248) continue; // 248 = 62 × 4: no bias
    out += B62[b % 62];
    if (out.length === n) return out;
  }
  return out + randomId(n - out.length);
}

export const ID = /^[0-9A-Za-z]{16}$/;
export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function cleanName(name: unknown, what = "name", max = 200): string {
  const n = typeof name === "string" ? name.trim().slice(0, max) : "";
  if (!n) throw new HttpError(400, `${what} is required`);
  return n;
}

/** A route's context: the caller and the request-scoped access resolver. */
export interface Ctx {
  req: Request;
  url: URL;
  deps: Deps;
  user: User;
  parts: string[];
  m: string;
  acc: Access;
}

/** `?cursor=&limit=` (≤ 200): offsets as cursors */
export function paging(url: URL, def = 50): { offset: number; limit: number } {
  const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit")) || def));
  const offset = Math.max(0, Number(url.searchParams.get("cursor")) || 0);
  return { offset, limit };
}

export const nextCursor = (offset: number, limit: number, total: number): string | null => (offset + limit < total ? String(offset + limit) : null);

export function csv(header: string[], rows: unknown[][]): Response {
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const text = [header, ...rows].map((r) => r.map(cell).join(",")).join("\n") + "\n";
  return new Response(text, { headers: { "content-type": "text/csv; charset=utf-8" } });
}

export const placeholders = (n: number, from = 1) => Array.from({ length: n }, (_, i) => `?${i + from}`).join(", ");
