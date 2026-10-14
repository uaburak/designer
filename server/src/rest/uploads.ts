/**
 * Uploads from the app for the REST API (docs/multiplayer.md §16.6, §16.7), on the private API (a session, not a token):
 *
 *   PUT /files/:key/thumbnail                       the file's thumbnail PNG (≤ 2 MB; people who can edit) — the target
 *                                                   of `thumbnailUrl`; the store sends it with snapshots (round 5b);
 *                                                   it stamps the file's thumbnail_at (OrgFile.thumbnailUrl's `v`)
 *   GET /files/:key/thumbnail                       the same PNG for anyone who can open the file (Home's org cards,
 *                                                   through the store); 404 until one was uploaded
 *   PUT /files/:key/rest-jobs/:id/parts/:name       a render job's part (≤ 64 MB), from the person the job went to; the
 *                                                   room keeps it by SHA-1 and checks it against `rest-job-done`
 */
import type { Role } from "../../../src/shared/multiplayer/protocol";
import type { AccessGranted } from "../../../src/shared/org/access";
import type { Deps } from "../api";
import type { FileRow } from "../org/db";
import { HttpError } from "../org/http";
import { MAX_PART_BYTES, MAX_THUMBNAIL_BYTES } from "./roomJobs";
import { guardedUpload } from "../quota/quota";

export async function uploadRoute(req: Request, deps: Deps, f: FileRow, a: AccessGranted | null, identity: { userId: string; name: string | null; role: Role }, parts: string[]): Promise<Response> {
  if (!a) throw new HttpError(403, "password required", "password_required");
  const q = `?fileKey=${encodeURIComponent(f.key)}`;
  if (parts[2] === "thumbnail" && parts.length === 3 && req.method === "PUT") {
    if (!a.canEdit || a.trashed) throw new HttpError(403, "you can only view this file");
    // Daily uploads and the owner's stored bytes (docs/multiplayer.md §17), before the body is read
    const up = await guardedUpload(deps, req, { id: identity.userId }, { ownerId: f.owner_id, item: `f:${f.key}:thumb` }, MAX_THUMBNAIL_BYTES, "too large");
    const head = new Uint8Array(up.body.slice(0, 8));
    if (!(head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47)) throw new HttpError(400, "a thumbnail is a PNG");
    const res = await deps.rooms.fetch(f.key, `/room/thumbnail${q}`, { method: "PUT", body: up.body, identity });
    if (res.ok) {
      await up.commit();
      await deps.db.d1.prepare(`UPDATE files SET thumbnail_at = ?2 WHERE key = ?1`).bind(f.key, deps.now()).run();
    }
    return res;
  }
  if (parts[2] === "thumbnail" && parts.length === 3 && req.method === "GET") {
    if (a.prototypeOnly) throw new HttpError(403, "you can only view this file's prototype");
    const res = await deps.rooms.fetch(f.key, `/room/thumbnail${q}`, { method: "GET", identity });
    if (!res.ok) throw new HttpError(404, "no thumbnail");
    return new Response(res.body, { headers: { "content-type": "image/png", "cache-control": "private, max-age=31536000, immutable" } });
  }
  if (parts[2] === "rest-jobs" && parts.length === 6 && parts[4] === "parts" && req.method === "PUT") {
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(parts[3])) throw new HttpError(404, "no such job");
    // A render job's part is kept briefly (§16.6): counted as an upload, not as stored bytes
    const { body } = await guardedUpload(deps, req, { id: identity.userId }, null, MAX_PART_BYTES, "too large");
    return deps.rooms.fetch(f.key, `/room/rest-parts/${parts[3]}/${encodeURIComponent(parts[5])}${q}`, { method: "PUT", body, identity });
  }
  throw new HttpError(404, "not found");
}
