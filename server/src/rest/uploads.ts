/**
 * Uploads from the app for the REST API (docs/multiplayer.md §16.6, §16.7), on the private API (a session, not a token):
 *
 *   PUT /files/:key/thumbnail                       the file's thumbnail PNG (≤ 2 MB; people who can edit) — the target
 *                                                   of `thumbnailUrl`; the store sends it with snapshots (round 5b)
 *   PUT /files/:key/rest-jobs/:id/parts/:name       a render job's part (≤ 64 MB), from the person the job went to; the
 *                                                   room keeps it by SHA-1 and checks it against `rest-job-done`
 */
import type { Role } from "../../../src/shared/multiplayer/protocol";
import type { AccessGranted } from "../../../src/shared/org/access";
import type { Deps } from "../api";
import type { FileRow } from "../org/db";
import { HttpError } from "../org/http";
import { MAX_PART_BYTES, MAX_THUMBNAIL_BYTES } from "./roomJobs";

async function bytes(req: Request, max: number): Promise<ArrayBuffer> {
  if (Number(req.headers.get("content-length") ?? "0") > max) throw new HttpError(413, "too large");
  const b = await req.arrayBuffer();
  if (b.byteLength > max) throw new HttpError(413, "too large");
  return b;
}

export async function uploadRoute(req: Request, deps: Deps, f: FileRow, a: AccessGranted | null, identity: { userId: string; name: string | null; role: Role }, parts: string[]): Promise<Response> {
  if (!a) throw new HttpError(403, "password required", "password_required");
  const q = `?fileKey=${encodeURIComponent(f.key)}`;
  if (parts[2] === "thumbnail" && parts.length === 3 && req.method === "PUT") {
    if (!a.canEdit || a.trashed) throw new HttpError(403, "you can only view this file");
    const body = await bytes(req, MAX_THUMBNAIL_BYTES);
    const head = new Uint8Array(body.slice(0, 8));
    if (!(head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47)) throw new HttpError(400, "a thumbnail is a PNG");
    return deps.rooms.fetch(f.key, `/room/thumbnail${q}`, { method: "PUT", body, identity });
  }
  if (parts[2] === "rest-jobs" && parts.length === 6 && parts[4] === "parts" && req.method === "PUT") {
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(parts[3])) throw new HttpError(404, "no such job");
    const body = await bytes(req, MAX_PART_BYTES);
    return deps.rooms.fetch(f.key, `/room/rest-parts/${parts[3]}/${encodeURIComponent(parts[5])}${q}`, { method: "PUT", body, identity });
  }
  throw new HttpError(404, "not found");
}
