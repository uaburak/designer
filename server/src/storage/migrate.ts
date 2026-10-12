/**
 * The operator's migration loop (docs/cloud.md §1 "Migration"): rooms and library objects move their old SQLite rows
 * to R2 lazily on wake; this drives the rest, one file (or library) per call — Settings › Operator, or a shell loop:
 *
 *   GET  /operator/storage                          StorageMigration (progress only)
 *   POST /operator/storage/migrate-next {after?}    the next file not migrated yet (key order, after `after`), its room
 *                                                   told to move everything it still holds in rows (a bounded batch per
 *                                                   call: a big file takes several calls) → StorageMigration with
 *                                                   `{key, kind, done, moved}` of this call and `cursor` (pass it back as
 *                                                   `after` to step past a file that fails); `finished` once nothing is left
 *
 * Idempotent: a file is done when its room says so (`files.storage_r2_at`, set by the room as well); a call that fails
 * leaves it as it was.
 */
import type { Deps } from "../api";
import type { User } from "../db";
import { libraryFetch } from "../libraries/db";
import { body, HttpError, json } from "../org/http";

export interface StorageMigration {
  files: { total: number; migrated: number };
  libraries: { total: number; migrated: number };
  /** This call's object: what it moved and whether it is done */
  key?: string;
  kind?: "file" | "library";
  done?: boolean;
  moved?: number;
  error?: string;
  /** Pass back as `after`: the key this call worked on */
  cursor: string | null;
  finished: boolean;
}

async function progress(deps: Deps): Promise<Omit<StorageMigration, "cursor" | "finished">> {
  const d1 = deps.db.d1;
  const f = await d1.prepare(`SELECT COUNT(*) AS total, SUM(storage_r2_at IS NOT NULL) AS migrated FROM files`).first<{ total: number; migrated: number | null }>();
  const l = await d1.prepare(`SELECT COUNT(*) AS total, SUM(storage_r2_at IS NOT NULL) AS migrated FROM libraries WHERE status <> 'deleted'`).first<{ total: number; migrated: number | null }>();
  return { files: { total: f?.total ?? 0, migrated: f?.migrated ?? 0 }, libraries: { total: l?.total ?? 0, migrated: l?.migrated ?? 0 } };
}

export async function storageRoute(req: Request, deps: Deps, _user: User, parts: string[]): Promise<Response> {
  const m = req.method;
  if (parts.length === 2 && m === "GET") {
    const p = await progress(deps);
    return json({ ...p, cursor: null, finished: p.files.migrated >= p.files.total && p.libraries.migrated >= p.libraries.total } satisfies StorageMigration);
  }
  if (parts.length === 3 && parts[2] === "migrate-next" && m === "POST") return json(await migrateNext(deps, await body<{ after?: unknown }>(req).catch(() => ({}) as { after?: unknown })));
  throw new HttpError(404, "not found");
}

async function migrateNext(deps: Deps, b: { after?: unknown }): Promise<StorageMigration> {
  const d1 = deps.db.d1;
  const after = typeof b.after === "string" ? b.after : "";
  const now = deps.now();
  const file = await d1.prepare(`SELECT key, jurisdiction FROM files WHERE storage_r2_at IS NULL AND key > ?1 ORDER BY key LIMIT 1`).bind(after).first<{ key: string; jurisdiction: string | null }>();
  if (file) {
    const res = await deps.rooms.fetch(file.key, "/room/storage/migrate", { method: "POST", jurisdiction: file.jurisdiction === "eu" ? "eu" : null });
    const r = (await res.json().catch(() => null)) as { done?: boolean; enabled?: boolean; moved?: number; error?: string } | null;
    if (r?.enabled === false) throw new HttpError(503, "R2 isn't set up on this server (the FILES / FILES_EU bindings)");
    const done = res.ok && r?.done === true;
    if (done) await d1.prepare(`UPDATE files SET storage_r2_at = ?2 WHERE key = ?1 AND storage_r2_at IS NULL`).bind(file.key, now).run();
    // Not done yet (a big file): the next call takes the same file again (cursor before it); failed: stepped past
    const cursor = res.ok ? (done ? file.key : after || null) : file.key;
    return { ...(await progress(deps)), key: file.key, kind: "file", done, moved: r?.moved ?? 0, ...(res.ok ? {} : { error: r?.error ?? `the room answered ${res.status}` }), cursor, finished: false };
  }
  const lib = await d1.prepare(`SELECT key FROM libraries WHERE storage_r2_at IS NULL AND status <> 'deleted' AND key > ?1 ORDER BY key LIMIT 1`).bind(after).first<{ key: string }>();
  if (lib) {
    const res = await libraryFetch(deps, lib.key, "/storage/migrate", { method: "POST" });
    const r = (await res.json().catch(() => null)) as { done?: boolean; enabled?: boolean; moved?: number; error?: string } | null;
    if (r?.enabled === false) throw new HttpError(503, "R2 isn't set up on this server (the FILES / FILES_EU bindings)");
    const done = res.ok && r?.done === true;
    if (done) await d1.prepare(`UPDATE libraries SET storage_r2_at = ?2 WHERE key = ?1 AND storage_r2_at IS NULL`).bind(lib.key, now).run();
    const cursor = res.ok ? (done ? lib.key : after || null) : lib.key;
    return { ...(await progress(deps)), key: lib.key, kind: "library", done, moved: r?.moved ?? 0, ...(res.ok ? {} : { error: r?.error ?? `the library answered ${res.status}` }), cursor, finished: false };
  }
  const p = await progress(deps);
  // The end of a pass: files a call failed on (stepped past) are in the counts; a new pass (no `after`) tries them again
  return { ...p, cursor: null, finished: true };
}
