/**
 * A file's images and blobs on R2 (docs/cloud.md §1, §4), the Worker's side — `api.ts` hands `/files/:key/blobs/…` here
 * when the file's bucket is bound (otherwise the room keeps them in SQLite as before):
 *
 *   POST   /files/:key/blobs/missing {sha1s}                → {missing}: what the file has no reference to, except
 *                                                             objects already used by a file of the same org (outside
 *                                                             orgs: of the same owner) that the caller owns or edits —
 *                                                             those are referenced at once; then the room's own rows
 *                                                             for an unmigrated file. Any other hash is missing: its
 *                                                             bytes are sent and checked (an object already in the
 *                                                             bucket isn't written again)
 *   POST   /files/:key/blobs/sizes {sha1s}                  → {sizes}: the stored bytes of those the file refers to
 *                                                             (the client's download total, Wecra 1.1.1)
 *   GET    /files/:key/blobs/:sha1                          the bytes from R2 (the file's reference), opened when
 *                                                             sealed; else the room (rows not migrated yet)
 *   PUT    /files/:key/blobs/:sha1                          ≤ 40 MB, SHA-1 checked, sealed for orgs with key management
 *   POST   /files/:key/blobs/:sha1/uploads {size}           a multipart upload (blobs > 8 MB) → {uploadId, partSize}
 *                                                             or {done: true} when the bucket has it already
 *   PUT    /files/:key/blobs/:sha1/uploads/:id/parts/:n     a part (1-based, ≤ 16 MB) → {partNumber, etag}
 *   POST   /files/:key/blobs/:sha1/uploads/:id/complete {parts}  assembled, SHA-1 checked, referenced
 *   DELETE /files/:key/blobs/:sha1/uploads/:id               aborted (Cancel)
 *
 * Multipart uploads assemble at `u/<fileKey>/<sha1>` and are copied to `b/<sha1>` once checked (a failed check leaves
 * nothing). Orgs with key management upload with a single PUT (the Worker seals the whole blob): their `…/uploads`
 * answers 409 `multipart_unavailable`.
 *
 * Stored bytes: `b:<ownerId>:<sha1>`, charged to the file's owner once per blob (refs.ts).
 */
import type { Deps } from "../api";
import type { User } from "../db";
import { MAX_BLOB_BYTES } from "../roomBox";
import { HttpError, json } from "../org/http";
import { chargeNew, countFor, guardedUpload, reserveStorage } from "../quota/quota";
import { prefetch } from "../requestD1";
import { addRefs, fileRefs, fileRefsQ, objectsQ, reusableQ } from "./refs";
import { orgKeyQ, orgObjectCipher, orgOfKey } from "./sealing";
import { blobKey, bucket, bucketName, IMMUTABLE, sha1Hex, sha1OfStream, type BucketName, type ObjectStore, type StorageEnv } from "./objects";
import type { RoomCipher } from "../ekm/cipher";

/** Blobs larger than this go up in parts (the client's choice; docs/cloud.md §4) */
export const MULTIPART_THRESHOLD = 8 * 1024 * 1024;
/** A part's size (R2: at least 5 MiB but the last; all but the last the same size) */
export const PART_BYTES = 8 * 1024 * 1024;
const MAX_PART_BYTES = 16 * 1024 * 1024;
const SHA1 = /^[0-9a-f]{40}$/;

export interface BlobFile {
  key: string;
  owner_id: string;
  org_id: string | null;
  jurisdiction?: "eu" | null;
  storage_r2_at?: number | null;
}

export interface BlobCtx {
  deps: Deps;
  req: Request;
  user: User;
  f: BlobFile;
  canEdit: boolean;
  /** The room's own blob routes (files not migrated yet) */
  room(path: string, init: RequestInit): Promise<Response>;
}

type Env = StorageEnv & { EKM_ROOT_KEY?: string };

/** The file's bucket, or null when R2 isn't bound (everything stays in the room) */
export function fileBucket(deps: Pick<Deps, "env">, f: Pick<BlobFile, "jurisdiction">): { name: BucketName; store: ObjectStore } | null {
  const name = bucketName(f.jurisdiction);
  const store = bucket(deps.env as Env, name);
  return store ? { name, store } : null;
}

const cipherOf = (deps: Deps, f: BlobFile): Promise<RoomCipher | null> => orgObjectCipher(deps.db.d1, (deps.env as Env).EKM_ROOT_KEY, f.org_id);

/** `/files/:key/blobs/…` (`rest`: the path after `blobs`); null when R2 isn't bound for the file */
export async function fileBlobsRoute(c: BlobCtx, rest: string[]): Promise<Response | null> {
  const b = fileBucket(c.deps, c.f);
  if (!b) return null;
  const m = c.req.method;
  if (rest.length === 1 && rest[0] === "missing" && m === "POST") return missing(c, b);
  if (rest.length === 1 && rest[0] === "sizes" && m === "POST") return sizes(c);
  const sha1 = rest[0];
  if (!sha1 || !SHA1.test(sha1)) throw new HttpError(404, "not found");
  if (rest.length === 1 && m === "GET") return (await readFileBlob(c.deps, c.f, sha1)) ?? c.room(`/room/blobs/${sha1}`, { method: "GET" });
  if (!c.canEdit) throw new HttpError(403, "you can only view this file");
  if (rest.length === 1 && m === "PUT") return put(c, b, sha1);
  if (rest[1] !== "uploads") throw new HttpError(404, "not found");
  if (rest.length === 2 && m === "POST") return createUpload(c, b, sha1);
  const uploadId = rest[2];
  if (!uploadId || uploadId.length > 1024) throw new HttpError(404, "not found");
  if (rest.length === 3 && m === "DELETE") {
    await b.store.resumeMultipartUpload(stagingKey(c.f.key, sha1), uploadId).abort().catch(() => undefined);
    return json({ ok: true });
  }
  if (rest.length === 5 && rest[3] === "parts" && m === "PUT") return putPart(c, b, sha1, uploadId, Number(rest[4]));
  if (rest.length === 4 && rest[3] === "complete" && m === "POST") return complete(c, b, sha1, uploadId);
  throw new HttpError(404, "not found");
}

const stagingKey = (fileKey: string, sha1: string) => `u/${fileKey}/${sha1}`;
const itemOf = (ownerId: string, sha1: string) => `b:${ownerId}:${sha1}`;

/** The file's blob from R2 (immutable), or null when the file has no reference to it */
export async function readFileBlob(deps: Deps, f: BlobFile, sha1: string): Promise<Response | null> {
  if (!fileBucket(deps, f)) return null;
  const ref = (await fileRefs(deps.db.d1, f.key, [sha1])).get(sha1);
  if (!ref) return null;
  const store = bucket(deps.env as Env, ref.bucket);
  const obj = store ? await store.get(ref.key) : null;
  if (!obj) return new Response("no such blob", { status: 404 });
  const headers = { "content-type": "application/octet-stream", "cache-control": IMMUTABLE };
  const org = orgOfKey(ref.key);
  if (!org) return new Response(obj.body, { headers: { ...headers, "content-length": String(obj.size) } });
  const cipher = await orgObjectCipher(deps.db.d1, (deps.env as Env).EKM_ROOT_KEY, org);
  if (!cipher) throw new HttpError(503, "this file's encryption key is unavailable", "key_unavailable");
  return new Response(await cipher.open(new Uint8Array(await obj.arrayBuffer()), "blobs"), { headers });
}

async function missing(c: BlobCtx, b: { name: BucketName; store: ObjectStore }): Promise<Response> {
  const { sha1s } = (await c.req.json().catch(() => ({}))) as { sha1s?: unknown };
  if (!Array.isArray(sha1s) || sha1s.length > 1000 || !sha1s.every((s) => typeof s === "string" && SHA1.test(s))) throw new HttpError(400, "sha1s");
  const list = [...new Set(sha1s as string[])];
  const d1 = c.deps.db.d1;
  // The file's references and its org's key in one round trip
  await prefetch(d1, [fileRefsQ(c.f.key, list), c.f.org_id && orgKeyQ(c.f.org_id)]);
  const refs = await fileRefs(d1, c.f.key, list);
  let rest = list.filter((s) => !refs.has(s));
  if (rest.length && c.canEdit) {
    const cipher = await cipherOf(c.deps, c.f);
    const org = cipher ? c.f.org_id : null;
    const keyOf = (s: string) => blobKey(s, org);
    // Only objects a file of the same place that the caller owns or edits already uses (refs.ts reusableQ): a hash
    // alone never claims someone else's image — anything else is reported missing, sent and checked
    const q = reusableQ(b.name, rest.map(keyOf), { orgId: c.f.org_id, ownerId: c.f.owner_id }, c.user.id);
    const { results } = await d1.prepare(q.sql).bind(...q.args).all<{ key: string; bytes: number }>();
    const found = new Map(results.map((r) => [r.key, r.bytes]));
    const there = rest.filter((s) => found.has(keyOf(s)));
    if (there.length) {
      // Uploaded already for another of those files: this file refers to it now (its owner charged once)
      await addRefs(d1, there.map((sha1) => ({ sha1, fileKey: c.f.key, bucket: b.name, key: keyOf(sha1), ownerId: c.f.owner_id, bytes: found.get(keyOf(sha1))! })), c.deps.now());
      await chargeNew(c.deps, c.f.owner_id, there.map((sha1) => ({ item: itemOf(c.f.owner_id, sha1), bytes: found.get(keyOf(sha1))! })));
      rest = rest.filter((s) => !found.has(keyOf(s)));
    }
  }
  // A room not migrated yet may hold some in its rows
  if (rest.length && !c.f.storage_r2_at) {
    const res = await c.room("/room/blobs/missing", { method: "POST", body: JSON.stringify({ sha1s: rest }) });
    if (res.ok) rest = ((await res.json()) as { missing: string[] }).missing;
  }
  return json({ missing: rest });
}

/**
 * `POST …/blobs/sizes {sha1s}` → `{sizes: {sha1: bytes}}`: the stored size of each image the file refers to (others
 * left out) — the client's "Downloading images" total before they come (Wecra 1.1.1, docs/cloud.md §4.1). Viewers too.
 */
async function sizes(c: BlobCtx): Promise<Response> {
  const { sha1s } = (await c.req.json().catch(() => ({}))) as { sha1s?: unknown };
  if (!Array.isArray(sha1s) || sha1s.length > 1000 || !sha1s.every((s) => typeof s === "string" && SHA1.test(s))) throw new HttpError(400, "sha1s");
  const { results } = await c.deps.db.d1
    .prepare(`SELECT r.sha1 AS sha1, o.bytes AS bytes FROM r2_refs r JOIN r2_objects o ON o.bucket = r.bucket AND o.key = r.key WHERE r.file_key = ?1 AND r.sha1 IN (SELECT value FROM json_each(?2))`)
    .bind(c.f.key, JSON.stringify([...new Set(sha1s as string[])]))
    .all<{ sha1: string; bytes: number }>();
  return json({ sizes: Object.fromEntries(results.map((r) => [r.sha1, r.bytes])) });
}

/** A stream R2 can store: its length known (Workers' FixedLengthStream; Node's tests take any stream) */
function knownLength(stream: ReadableStream, size: number): ReadableStream {
  const FLS = (globalThis as unknown as { FixedLengthStream?: new (n: number) => TransformStream }).FixedLengthStream;
  if (!FLS) return stream;
  const t = new FLS(size);
  void stream.pipeTo(t.writable).catch(() => undefined);
  return t.readable;
}

async function put(c: BlobCtx, b: { name: BucketName; store: ObjectStore }, sha1: string): Promise<Response> {
  const { deps, f } = c;
  const d1 = deps.db.d1;
  await prefetch(d1, [fileRefsQ(f.key, [sha1]), f.org_id && orgKeyQ(f.org_id)]);
  if ((await fileRefs(d1, f.key, [sha1])).has(sha1)) {
    await c.req.body?.cancel().catch(() => undefined);
    return json({ ok: true });
  }
  const cipher = await cipherOf(deps, f);
  const key = blobKey(sha1, cipher ? f.org_id : null);
  const q = objectsQ(b.name, [key]);
  const exists = !!(await d1.prepare(q.sql).bind(...q.args).first());
  const item = itemOf(f.owner_id, sha1);
  const length = c.req.headers.get("content-length");
  const declared = length !== null && /^\d+$/.test(length) ? Number(length) : NaN;
  let size: number;
  let commit: () => Promise<void>;
  if (!cipher && c.req.body && Number.isSafeInteger(declared)) {
    // Streamed: the Worker never holds the bytes; hashed on the way (DigestStream) and dropped again if they lie
    if (declared > MAX_BLOB_BYTES) throw new HttpError(413, "image too large");
    await countFor(deps, c.user, "uploads_per_day");
    const reservation = await reserveStorage(deps, f.owner_id, item, declared);
    const [toStore, toHash] = c.req.body.tee();
    const stored = exists ? toStore.cancel() : b.store.put(key, knownLength(toStore, declared));
    const [sum] = await Promise.all([sha1OfStream(toHash), stored]);
    if (sum !== sha1) {
      if (!exists) await b.store.delete(key);
      throw new HttpError(400, "the bytes don't match their SHA-1");
    }
    size = declared;
    commit = () => reservation.commit(declared);
  } else {
    const up = await guardedUpload(deps, c.req, c.user, { ownerId: f.owner_id, item }, MAX_BLOB_BYTES, "image too large");
    const bytes = new Uint8Array(up.body);
    if ((await sha1Hex(bytes)) !== sha1) throw new HttpError(400, "the bytes don't match their SHA-1");
    if (!exists) await b.store.put(key, cipher ? await cipher.seal(bytes, "blobs") : bytes);
    size = bytes.length;
    commit = up.commit;
  }
  await addRefs(d1, [{ sha1, fileKey: f.key, bucket: b.name, key, ownerId: f.owner_id, bytes: size }], deps.now());
  await commit();
  return json({ ok: true });
}

async function createUpload(c: BlobCtx, b: { name: BucketName; store: ObjectStore }, sha1: string): Promise<Response> {
  const { deps, f } = c;
  const d1 = deps.db.d1;
  const { size } = (await c.req.json().catch(() => ({}))) as { size?: unknown };
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0) throw new HttpError(400, "size is the blob's length in bytes");
  if (size > MAX_BLOB_BYTES) throw new HttpError(413, "image too large");
  await prefetch(d1, [fileRefsQ(f.key, [sha1]), f.org_id && orgKeyQ(f.org_id)]);
  if ((await fileRefs(d1, f.key, [sha1])).has(sha1)) return json({ done: true });
  if (await cipherOf(deps, f)) throw new HttpError(409, "this file's images are encrypted; upload them in one request", "multipart_unavailable");
  const key = blobKey(sha1);
  // Reused without its bytes only from a file of the same place the caller owns or edits (as `missing`); otherwise the
  // parts are sent and checked at complete (which then skips the R2 write when the object exists)
  const q = reusableQ(b.name, [key], { orgId: f.org_id, ownerId: f.owner_id }, c.user.id);
  const there = await d1.prepare(q.sql).bind(...q.args).first<{ bytes: number }>();
  if (there) {
    await addRefs(d1, [{ sha1, fileKey: f.key, bucket: b.name, key, ownerId: f.owner_id, bytes: there.bytes }], deps.now());
    await chargeNew(deps, f.owner_id, [{ item: itemOf(f.owner_id, sha1), bytes: there.bytes }]);
    return json({ done: true });
  }
  await countFor(deps, c.user, "uploads_per_day");
  // Refused now when the size would pass the owner's storage (charged when complete)
  await reserveStorage(deps, f.owner_id, itemOf(f.owner_id, sha1), size);
  const mpu = await b.store.createMultipartUpload(stagingKey(f.key, sha1));
  return json({ uploadId: mpu.uploadId, partSize: PART_BYTES }, 201);
}

async function putPart(c: BlobCtx, b: { name: BucketName; store: ObjectStore }, sha1: string, uploadId: string, n: number): Promise<Response> {
  if (!Number.isInteger(n) || n < 1 || n > 10_000) throw new HttpError(400, "bad part number");
  const length = Number(c.req.headers.get("content-length") ?? "NaN");
  if (Number.isFinite(length) && length > MAX_PART_BYTES) throw new HttpError(413, "part too large");
  let body: ReadableStream | ArrayBuffer;
  if (c.req.body && Number.isSafeInteger(length)) body = knownLength(c.req.body, length);
  else {
    body = await c.req.arrayBuffer();
    if (body.byteLength > MAX_PART_BYTES) throw new HttpError(413, "part too large");
  }
  try {
    const part = await b.store.resumeMultipartUpload(stagingKey(c.f.key, sha1), uploadId).uploadPart(n, body);
    return json({ partNumber: part.partNumber, etag: part.etag });
  } catch (e) {
    // R2 refused it for a moment: 503, so the app tries this part again alone
    throw new HttpError(503, `the part wasn't stored: ${(e as Error).message}`, "internal");
  }
}

async function complete(c: BlobCtx, b: { name: BucketName; store: ObjectStore }, sha1: string, uploadId: string): Promise<Response> {
  const { deps, f } = c;
  const d1 = deps.db.d1;
  const { parts } = (await c.req.json().catch(() => ({}))) as { parts?: unknown };
  if (!Array.isArray(parts) || !parts.length || parts.length > 10_000 || !parts.every((p) => p && typeof p === "object" && Number.isInteger((p as { partNumber?: unknown }).partNumber) && typeof (p as { etag?: unknown }).etag === "string")) {
    throw new HttpError(400, "parts is [{partNumber, etag}]");
  }
  const staging = stagingKey(f.key, sha1);
  try {
    await b.store.resumeMultipartUpload(staging, uploadId).complete(parts as { partNumber: number; etag: string }[]);
  } catch (e) {
    throw new HttpError(409, `the upload couldn't be completed: ${(e as Error).message}`);
  }
  const assembled = await b.store.get(staging);
  if (!assembled) throw new HttpError(409, "the upload couldn't be completed");
  const size = assembled.size;
  const ok = size <= MAX_BLOB_BYTES && (await sha1OfStream(assembled.body)) === sha1;
  if (!ok) {
    await b.store.delete(staging);
    throw new HttpError(400, "the bytes don't match their SHA-1");
  }
  const key = blobKey(sha1);
  const q = objectsQ(b.name, [key]);
  if (!(await d1.prepare(q.sql).bind(...q.args).first())) {
    const again = await b.store.get(staging);
    if (!again) throw new HttpError(409, "the upload couldn't be completed");
    await b.store.put(key, knownLength(again.body, size));
  }
  await b.store.delete(staging);
  const reservation = await reserveStorage(deps, f.owner_id, itemOf(f.owner_id, sha1), size);
  await addRefs(d1, [{ sha1, fileKey: f.key, bucket: b.name, key, ownerId: f.owner_id, bytes: size }], deps.now());
  await reservation.commit(size);
  return json({ ok: true, size });
}
