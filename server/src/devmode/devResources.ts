/**
 * Dev resources (docs/editor.md D-3; D1 `dev_resources`, migration 0015): links on a node of a shared file — at most
 * 10 per node, a URL once per node, live at once (not published). Read by anyone who can open the file (not prototype
 * viewers); changed by people who can edit it, with a Full or Dev seat in orgs.
 *
 *   GET    /files/:key/dev-resources?nodeIds=1:2,3:4   → {devResources: DevResourceRecord[]}
 *   POST   /files/:key/dev-resources {nodeId, name, url} → {devResource}  (201)
 *   PATCH  /files/:key/dev-resources/:id {name?, url?}  → {devResource}
 *   DELETE /files/:key/dev-resources/:id                → 204
 *
 * The REST twins (`/v1/…dev_resources`, §16.7) are in rest.ts over the same functions. Logged as `dev_resource_create`
 * / `dev_resource_delete` (ours) for org files.
 */
import { DEV_RESOURCE_LIMIT, type DevResourceRecord } from "../../../src/shared/devmode/types";
import type { AccessResult } from "../../../src/shared/org/access";
import type { Deps } from "../api";
import type { User } from "../db";
import type { FileRow } from "../org/db";
import { body, HttpError, noContent, randomId } from "../org/http";
import { json, line, logDev, nodeId, requireReadDev, requireWriteDev } from "./common";

interface Row {
  id: string;
  file_key: string;
  node_id: string;
  name: string;
  url: string;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

export const toRecord = (r: Row): DevResourceRecord => ({ id: r.id, fileKey: r.file_key, nodeId: r.node_id, name: r.name, url: r.url, createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at });

/** Our wording (Figma's is unverified) */
export const TOO_MANY = `You can add up to ${DEV_RESOURCE_LIMIT} links to a layer.`;
export const DUPLICATE = "This link has already been added.";

/** An http(s) URL, ≤ 2048 characters */
export function cleanUrl(v: unknown): string {
  const s = typeof v === "string" ? v.trim() : "";
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new HttpError(400, "url is a link (https://…)");
  }
  if ((u.protocol !== "https:" && u.protocol !== "http:") || s.length > 2048) throw new HttpError(400, "url is an http(s) link of at most 2048 characters");
  return s;
}

/** The name, or the URL's host and path when none is given (docs/editor.md D-3) */
export function nameFor(name: unknown, url: string): string {
  const n = line(name, 200);
  if (n) return n;
  const u = new URL(url);
  return `${u.host}${u.pathname === "/" ? "" : u.pathname}`.slice(0, 200);
}

export async function listResources(deps: Deps, key: string, nodeIds: string[] | null): Promise<DevResourceRecord[]> {
  const d1 = deps.db.d1;
  if (nodeIds && !nodeIds.length) return [];
  if (nodeIds) {
    const ids = nodeIds.slice(0, 500);
    const { results } = await d1.prepare(`SELECT * FROM dev_resources WHERE file_key = ?1 AND node_id IN (SELECT value FROM json_each(?2)) ORDER BY created_at, id`).bind(key, JSON.stringify(ids)).all<Row>();
    return results.map(toRecord);
  }
  const { results } = await d1.prepare(`SELECT * FROM dev_resources WHERE file_key = ?1 ORDER BY node_id, created_at, id`).bind(key).all<Row>();
  return results.map(toRecord);
}

export async function resourceRow(deps: Deps, key: string, id: string): Promise<Row | null> {
  return deps.db.d1.prepare(`SELECT * FROM dev_resources WHERE id = ?1 AND file_key = ?2`).bind(id, key).first<Row>();
}

/** Adds one (the caller checked access). Throws TOO_MANY / DUPLICATE as 400 / 409. */
export async function addResource(deps: Deps, f: FileRow, user: User, input: { nodeId: unknown; name: unknown; url: unknown }, req: Request | null): Promise<DevResourceRecord> {
  const node = nodeId(input.nodeId);
  const url = cleanUrl(input.url);
  const name = nameFor(input.name, url);
  const d1 = deps.db.d1;
  const count = await d1.prepare(`SELECT COUNT(*) AS n, SUM(url = ?3) AS dup FROM dev_resources WHERE file_key = ?1 AND node_id = ?2`).bind(f.key, node, url).first<{ n: number; dup: number | null }>();
  if (count?.dup) throw new HttpError(409, DUPLICATE);
  if ((count?.n ?? 0) >= DEV_RESOURCE_LIMIT) throw new HttpError(400, TOO_MANY);
  const now = deps.now();
  const id = randomId();
  const r = await d1
    .prepare(`INSERT INTO dev_resources (id, file_key, node_id, name, url, created_by, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7) ON CONFLICT DO NOTHING RETURNING *`)
    .bind(id, f.key, node, name, url, user.id, now)
    .first<Row>();
  if (!r) throw new HttpError(409, DUPLICATE);
  await (await import("../roomBroadcast")).roomBroadcast(deps, f.key, "dev-resources");
  await logDev(deps, f, user, "dev_resource_create", { node_id: node, url, name }, req);
  return toRecord(r);
}

export async function editResource(deps: Deps, row: Row, patch: { name?: unknown; url?: unknown }): Promise<DevResourceRecord> {
  const url = patch.url !== undefined ? cleanUrl(patch.url) : row.url;
  const name = patch.name !== undefined ? nameFor(patch.name, url) : row.name;
  if (url !== row.url) {
    const dup = await deps.db.d1.prepare(`SELECT 1 AS x FROM dev_resources WHERE file_key = ?1 AND node_id = ?2 AND url = ?3 AND id <> ?4`).bind(row.file_key, row.node_id, url, row.id).first();
    if (dup) throw new HttpError(409, DUPLICATE);
  }
  const r = await deps.db.d1.prepare(`UPDATE dev_resources SET name = ?2, url = ?3, updated_at = ?4 WHERE id = ?1 RETURNING *`).bind(row.id, name, url, deps.now()).first<Row>();
  await (await import("../roomBroadcast")).roomBroadcast(deps, row.file_key, "dev-resources");
  return toRecord(r!);
}

export async function removeResource(deps: Deps, f: FileRow, user: User, row: Row, req: Request | null): Promise<void> {
  await deps.db.d1.prepare(`DELETE FROM dev_resources WHERE id = ?1`).bind(row.id).run();
  await (await import("../roomBroadcast")).roomBroadcast(deps, f.key, "dev-resources");
  await logDev(deps, f, user, "dev_resource_delete", { node_id: row.node_id, url: row.url, name: row.name }, req);
}

/** `/files/:key/dev-resources…` (parts: ["files", key, "dev-resources", id?]) */
export async function devResourcesRoute(req: Request, url: URL, deps: Deps, user: User, parts: string[], f: FileRow, a: AccessResult): Promise<Response> {
  const m = req.method;
  if (parts.length === 3 && m === "GET") {
    requireReadDev(a);
    const q = url.searchParams.get("nodeIds");
    const ids = q === null ? null : q.split(",").map((s) => s.trim()).filter(Boolean);
    return json({ devResources: await listResources(deps, f.key, ids) });
  }
  if (parts.length === 3 && m === "POST") {
    requireWriteDev(a);
    const b = await body<{ nodeId?: unknown; name?: unknown; url?: unknown }>(req);
    return json({ devResource: await addResource(deps, f, user, { nodeId: b.nodeId, name: b.name, url: b.url }, req) }, 201);
  }
  if (parts.length === 4 && (m === "PATCH" || m === "DELETE")) {
    requireWriteDev(a);
    const row = await resourceRow(deps, f.key, parts[3]);
    if (!row) throw new HttpError(404, "no such dev resource");
    if (m === "DELETE") {
      await removeResource(deps, f, user, row, req);
      return noContent();
    }
    const b = await body<{ name?: unknown; url?: unknown }>(req);
    return json({ devResource: await editResource(deps, row, b) });
  }
  throw new HttpError(405, "method not allowed");
}
