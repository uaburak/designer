/**
 * A file moving to another data region (docs/multiplayer.md §15.10, docs/cloud.md §1): its images re-homed in the new
 * region's bucket — each object copied (unless the bucket has it already, for another file there), the file's
 * references pointed at the copy. The old objects lose this file's reference; the daily cron deletes those nothing else
 * uses (refs.ts). Runs before the region flip (policy/region.ts `moveObject`), so a failure leaves the file where it was.
 */
import type { Deps } from "../api";
import { bucket, bucketName, type BucketName, type StorageEnv } from "./objects";
import { addRefs, type NewRef } from "./refs";

export async function relocateFileBlobs(deps: Deps, fileKey: string, to: "eu" | null): Promise<number> {
  const env = deps.env as StorageEnv;
  const target = bucketName(to);
  const into = bucket(env, target);
  if (!into) return 0;
  const d1 = deps.db.d1;
  const { results } = await d1
    .prepare(`SELECT r.sha1, r.bucket, r.key, r.owner_id, o.bytes FROM r2_refs r LEFT JOIN r2_objects o ON o.bucket = r.bucket AND o.key = r.key WHERE r.file_key = ?1 AND r.bucket <> ?2`)
    .bind(fileKey, target)
    .all<{ sha1: string; bucket: BucketName; key: string; owner_id: string | null; bytes: number | null }>();
  const moved: NewRef[] = [];
  for (const r of results) {
    const there = await d1.prepare(`SELECT bytes FROM r2_objects WHERE bucket = ?1 AND key = ?2`).bind(target, r.key).first<{ bytes: number }>();
    let bytes = there?.bytes ?? r.bytes ?? 0;
    if (!there) {
      const from = bucket(env, r.bucket);
      const obj = from ? await from.get(r.key) : null;
      if (!obj) continue;
      const data = new Uint8Array(await obj.arrayBuffer());
      await into.put(r.key, data);
      bytes = r.bytes ?? data.length;
    }
    moved.push({ sha1: r.sha1, fileKey, bucket: target, key: r.key, ownerId: r.owner_id, bytes });
  }
  await addRefs(d1, moved, deps.now());
  return moved.length;
}
