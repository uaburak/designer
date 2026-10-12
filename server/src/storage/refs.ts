/**
 * Reference counting of blob objects in D1 (docs/cloud.md §1, migration 0022): `r2_objects` lists every blob object
 * put, `r2_refs (sha1, file_key)` every file's use of one. An object nothing refers to is orphaned (`orphan_at`) and
 * deleted by the daily cron 7 days later; a new reference within that time keeps it.
 *
 * Stored bytes (docs/cloud.md §3): a blob is charged once per owner of the files that use it, as the item
 * `b:<ownerId>:<sha1>`; it is released when the last of that owner's references goes.
 */
import type { D1Like } from "../db";
import { releaseStorage } from "../quota/quota";
import type { Deps } from "../api";
import { bucket, deleteKeys, type BucketName, type StorageEnv } from "./objects";

/** Objects orphaned this long are deleted (the grace a re-upload or a restored file has) */
export const ORPHAN_GRACE_MS = 7 * 86_400_000;
/** Rows a cron run handles per step */
const SWEEP_BATCH = 500;

export interface BlobRef {
  sha1: string;
  bucket: BucketName;
  key: string;
}

export interface NewRef extends BlobRef {
  fileKey: string;
  ownerId: string | null;
  /** The plain size */
  bytes: number;
}

const runAll = async (d1: D1Like, stmts: ReturnType<D1Like["prepare"]>[]) => {
  if (!stmts.length) return;
  if (d1.batch) await d1.batch(stmts);
  else for (const s of stmts) await s.run();
};

/** The statements that record a blob object and a file's reference to it (the object no longer orphaned) */
export function refStatements(d1: D1Like, r: NewRef, now: number): ReturnType<D1Like["prepare"]>[] {
  return [
    d1
      .prepare(`INSERT INTO r2_objects (bucket, key, bytes, created_at, orphan_at) VALUES (?1, ?2, ?3, ?4, NULL) ON CONFLICT (bucket, key) DO UPDATE SET orphan_at = NULL`)
      .bind(r.bucket, r.key, r.bytes, now),
    d1
      .prepare(`INSERT INTO r2_refs (sha1, file_key, bucket, key, owner_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT (sha1, file_key) DO UPDATE SET bucket = ?3, key = ?4`)
      .bind(r.sha1, r.fileKey, r.bucket, r.key, r.ownerId, now),
  ];
}

export async function addRefs(d1: D1Like, refs: NewRef[], now: number): Promise<void> {
  await runAll(d1, refs.flatMap((r) => refStatements(d1, r, now)));
}

/** This file's references among `sha1s` */
export const fileRefsQ = (fileKey: string, sha1s: string[]) => ({
  sql: `SELECT sha1, bucket, key FROM r2_refs WHERE file_key = ?1 AND sha1 IN (SELECT value FROM json_each(?2))`,
  args: [fileKey, JSON.stringify(sha1s)],
});

/** The objects among `keys` already in `bucket` (uploaded for another file) */
export const objectsQ = (bucketName: BucketName, keys: string[]) => ({
  sql: `SELECT key, bytes FROM r2_objects WHERE bucket = ?1 AND key IN (SELECT value FROM json_each(?2))`,
  args: [bucketName, JSON.stringify(keys)],
});

/**
 * The objects among `keys` a file may refer to without its bytes being sent (docs/cloud.md §1): those already referenced
 * by a file in the same place — the same org (`orgId`), or for a file outside any org one of the same owner — that the
 * caller owns or was invited to edit. Knowing a hash alone never reaches another tenant's image: anything else is
 * uploaded, its SHA-1 checked, and only then referenced.
 */
export const reusableQ = (bucketName: BucketName, keys: string[], place: { orgId: string | null; ownerId: string }, callerId: string) => ({
  sql: `SELECT DISTINCT o.key, o.bytes FROM r2_objects o JOIN r2_refs r ON r.bucket = o.bucket AND r.key = o.key JOIN files f ON f.key = r.file_key
        WHERE o.bucket = ?1 AND o.key IN (SELECT value FROM json_each(?2))
          AND ((?3 IS NOT NULL AND f.org_id = ?3) OR (?3 IS NULL AND f.org_id IS NULL AND f.owner_id = ?4))
          AND (f.owner_id = ?5 OR EXISTS (SELECT 1 FROM members m WHERE m.file_key = f.key AND m.user_id = ?5 AND m.role = 'editor'))`,
  args: [bucketName, JSON.stringify(keys), place.orgId, place.ownerId, callerId],
});

export async function fileRefs(d1: D1Like, fileKey: string, sha1s: string[]): Promise<Map<string, BlobRef>> {
  if (!sha1s.length) return new Map();
  const q = fileRefsQ(fileKey, sha1s);
  const { results } = await d1.prepare(q.sql).bind(...q.args).all<BlobRef>();
  return new Map(results.map((r) => [r.sha1, r]));
}

/** Every image a file refers to (REST `GET /v1/files/:key/images`) */
export async function fileRefSha1s(d1: D1Like, fileKey: string): Promise<string[]> {
  const { results } = await d1.prepare(`SELECT sha1 FROM r2_refs WHERE file_key = ?1 ORDER BY sha1`).bind(fileKey).all<{ sha1: string }>();
  return results.map((r) => r.sha1);
}

export interface SweepReport {
  /** References of files deleted for good, dropped */
  dropped: number;
  /** Objects newly orphaned */
  orphaned: number;
  /** Objects deleted from R2 (orphaned past the grace) */
  deleted: number;
}

/**
 * The daily cron's step (index.ts "17 3 * * *"): references of files no longer in D1 dropped (their owners' stored bytes
 * released where it was their last use), objects without references orphaned, objects orphaned past the grace deleted.
 * Bounded per run (SWEEP_BATCH per step); what is left goes the next day.
 */
export async function sweepR2(deps: Pick<Deps, "db" | "now" | "env">): Promise<SweepReport> {
  const d1 = deps.db.d1;
  const now = deps.now();
  const report: SweepReport = { dropped: 0, orphaned: 0, deleted: 0 };
  // 1. References of deleted files
  const { results: gone } = await d1
    .prepare(`SELECT r.sha1, r.file_key, r.owner_id FROM r2_refs r WHERE NOT EXISTS (SELECT 1 FROM files f WHERE f.key = r.file_key) LIMIT ${SWEEP_BATCH}`)
    .all<{ sha1: string; file_key: string; owner_id: string | null }>();
  if (gone.length) {
    await runAll(
      d1,
      gone.map((g) => d1.prepare(`DELETE FROM r2_refs WHERE sha1 = ?1 AND file_key = ?2`).bind(g.sha1, g.file_key)),
    );
    report.dropped = gone.length;
    const owners = new Map<string, { owner: string; sha1: string }>();
    for (const g of gone) if (g.owner_id) owners.set(`${g.owner_id}:${g.sha1}`, { owner: g.owner_id, sha1: g.sha1 });
    for (const { owner, sha1 } of owners.values()) {
      const still = await d1.prepare(`SELECT 1 AS x FROM r2_refs WHERE owner_id = ?1 AND sha1 = ?2 LIMIT 1`).bind(owner, sha1).first();
      if (!still) await releaseStorage(d1, `b:${owner}:${sha1}`);
    }
  }
  // 2. Objects nothing refers to any more
  const { results: orphans } = await d1
    .prepare(`UPDATE r2_objects SET orphan_at = ?1 WHERE orphan_at IS NULL AND NOT EXISTS (SELECT 1 FROM r2_refs r WHERE r.bucket = r2_objects.bucket AND r.key = r2_objects.key) RETURNING key`)
    .bind(now)
    .all<{ key: string }>();
  report.orphaned = orphans.length;
  // 3. Orphans past the grace (asked again: a reference since keeps them)
  const { results: due } = await d1
    .prepare(
      `SELECT bucket, key FROM r2_objects o WHERE o.orphan_at IS NOT NULL AND o.orphan_at <= ?1
         AND NOT EXISTS (SELECT 1 FROM r2_refs r WHERE r.bucket = o.bucket AND r.key = o.key) ORDER BY o.orphan_at LIMIT ${SWEEP_BATCH}`,
    )
    .bind(now - ORPHAN_GRACE_MS)
    .all<{ bucket: BucketName; key: string }>();
  for (const name of ["files", "files_eu"] as const) {
    const keys = due.filter((d) => d.bucket === name).map((d) => d.key);
    const store = bucket(deps.env as StorageEnv, name);
    if (!keys.length || !store) continue;
    await deleteKeys(store, keys);
    await runAll(
      d1,
      keys.map((k) => d1.prepare(`DELETE FROM r2_objects WHERE bucket = ?1 AND key = ?2 AND orphan_at IS NOT NULL`).bind(name, k)),
    );
    report.deleted += keys.length;
  }
  return report;
}
