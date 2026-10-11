/**
 * What Dev Mode's server pieces share (docs/editor.md "Dev Mode — round 5"): who may read and change a file's Dev Mode
 * data, node ids, and the activity entity.
 */
import type { AccessResult } from "../../../src/shared/org/access";
import type { ActivityAction } from "../../../src/shared/org/types";
import { fileEntity, logActivity } from "../activity";
import type { Deps } from "../api";
import type { User } from "../db";
import type { FileRow } from "../org/db";
import { HttpError } from "../org/http";

/** Figma's node ids: "1:2", and nested instance layers "I1:2;3:4" */
export const NODE_ID = /^I?-?\d{1,10}:-?\d{1,10}(?:;-?\d{1,10}:-?\d{1,10}){0,31}$/;

export function nodeId(v: unknown, what = "nodeId"): string {
  if (typeof v !== "string" || !NODE_ID.test(v)) throw new HttpError(400, `${what} is a node id like "1:2"`);
  return v;
}

/** Reads Dev Mode data: anyone who can open the file, except prototype-only viewers (D-6: no Dev Mode). */
export const canReadDev = (a: AccessResult): boolean => a.ok && !a.prototypeOnly;

/**
 * Changes it (D-1, D-3, D-4): "can edit" on the file — owner or editor, not trashed, not capped as external — and, in
 * orgs, a Full or Dev seat (`canDevMode`; a Dev seat's editor role is capped for design edits but writes Dev Mode data,
 * as Figma's Dev seats do).
 */
export const canWriteDev = (a: AccessResult): boolean => a.ok && !a.prototypeOnly && !a.trashed && (a.role === "owner" || a.role === "editor") && a.canDevMode && a.capped !== "external";

export function requireReadDev(a: AccessResult): void {
  if (!a.ok) throw new HttpError(404, "no such file");
  if (!canReadDev(a)) throw new HttpError(403, "prototype viewers can't use Dev Mode");
}

export function requireWriteDev(a: AccessResult): void {
  requireReadDev(a);
  if (!a.ok) return;
  if (canWriteDev(a)) return;
  if (!a.canDevMode) throw new HttpError(403, "Dev Mode needs a Full or Dev seat", "seat_required", { seat: "dev" });
  throw new HttpError(403, "you can only view this file");
}

/** An org file's activity (§16.11's actions); files outside orgs aren't logged. */
export async function logDev(deps: Deps, f: FileRow, user: User, action: ActivityAction, details: Record<string, unknown>, req: Request | null): Promise<void> {
  if (!f.org_id) return;
  await logActivity(deps, { orgId: f.org_id, action, actor: user, entity: fileEntity(f), teamId: f.team_id, details, req });
}

export const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });

/** A short single-line string, or the fallback */
export function line(v: unknown, max: number): string {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "";
}
