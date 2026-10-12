/**
 * Object storage on Cloudflare R2 (docs/cloud.md §1): the narrow part of an `R2Bucket` the server uses, the buckets by
 * data region, and the keys. Every object is immutable once written and named by what it holds:
 *
 *   b/<sha1>                         an image or blob of any file (shared by every file that uses it; D1 `r2_refs`)
 *   e/<orgId>/b/<sha1>               the same for an org with key management, sealed (no dedup across orgs)
 *   c/<fileKey>/<name>               a file's checkpoint: `<seq>` (the document at seq, live or a version's) or
 *                                    `base-<seq>` (a branch's merge base); `e/<orgId>/c/…` sealed
 *   r/<fileKey>/<sha1>               a REST render job's part or the thumbnail (`e/<orgId>/r/…` sealed)
 *   l/<libKey>/p/<key>/<hash>        a library payload; `l/<libKey>/b/<sha1>` its images
 *   p/<previewId>/<name>             a developer preview's files
 *   i/<orgId>/<sha1>                 an org or team icon
 *   f/<orgId>/<sha1>                 a shared font
 *   u/<fileKey>/<sha1>/<n>           a multipart upload being assembled (deleted when completed or aborted)
 *
 * Reads go Worker → R2 (not through a Durable Object's memory): an object answers a read with no body and the headers
 * `x-r2-key` / `x-r2-bucket` (`r2Redirect`), and the Worker's stub wrappers (`resolveR2`) stream the object in its place.
 * Sealed objects are opened where the key is (the room), so they are never redirected.
 */

/** The buckets (wrangler.jsonc `r2_buckets`): `files` = wecra-files, `files_eu` = wecra-files-eu (jurisdiction eu) */
export type BucketName = "files" | "files_eu";

export interface StoredObject {
  size: number;
  body: ReadableStream;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface MultipartPart {
  partNumber: number;
  etag: string;
}

export interface MultipartUpload {
  readonly key: string;
  readonly uploadId: string;
  uploadPart(partNumber: number, value: ReadableStream | ArrayBuffer | ArrayBufferView | string): Promise<MultipartPart>;
  abort(): Promise<void>;
  complete(parts: MultipartPart[]): Promise<unknown>;
}

/** The part of R2's `R2Bucket` used here (tests: testing/memoryR2.ts) */
export interface ObjectStore {
  get(key: string): Promise<StoredObject | null>;
  head(key: string): Promise<{ size: number } | null>;
  put(key: string, value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null): Promise<unknown>;
  delete(keys: string | string[]): Promise<void>;
  list(options: { prefix?: string; cursor?: string; limit?: number }): Promise<{ objects: { key: string; size: number }[]; truncated: boolean; cursor?: string }>;
  createMultipartUpload(key: string): Promise<MultipartUpload>;
  resumeMultipartUpload(key: string, uploadId: string): MultipartUpload;
}

/** What the server reads of the Worker's (or an object's) env */
export interface StorageEnv {
  FILES?: ObjectStore;
  FILES_EU?: ObjectStore;
}

export const bucketName = (jurisdiction: "eu" | null | undefined): BucketName => (jurisdiction === "eu" ? "files_eu" : "files");

/** The bucket binding by name; null where it isn't bound (a server not yet given R2: everything stays in SQLite) */
export function bucket(env: StorageEnv | undefined, name: BucketName): ObjectStore | null {
  return (name === "files_eu" ? env?.FILES_EU : env?.FILES) ?? null;
}

/** The key prefix of an org with key management (its objects sealed), else "" */
export const sealedPrefix = (orgId: string | null | undefined): string => (orgId ? `e/${orgId}/` : "");

export const blobKey = (sha1: string, orgId?: string | null): string => `${sealedPrefix(orgId)}b/${sha1}`;
export const checkpointKey = (fileKey: string, name: string, orgId?: string | null): string => `${sealedPrefix(orgId)}c/${fileKey}/${name}`;
export const restKey = (fileKey: string, sha1: string, orgId?: string | null): string => `${sealedPrefix(orgId)}r/${fileKey}/${sha1}`;

/** Immutable reads (the client caches by hash) */
export const IMMUTABLE = "private, max-age=31536000, immutable";

/** A read answered by the Worker from R2: no body, the object named (resolveR2) */
export function r2Redirect(bucketName: BucketName, key: string, headers: Record<string, string> = {}): Response {
  return new Response(null, { status: 200, headers: { "x-r2-key": key, "x-r2-bucket": bucketName, ...headers } });
}

/**
 * A Durable Object's answer with its R2 object in place of the redirect (other answers as they are). The object's
 * other headers stay (x-seq, content-type, cache-control); a missing object is 404.
 */
export async function resolveR2(res: Response, env: StorageEnv | undefined): Promise<Response> {
  const key = res.headers.get("x-r2-key");
  if (!key) return res;
  const store = bucket(env, res.headers.get("x-r2-bucket") === "files_eu" ? "files_eu" : "files");
  const obj = store ? await store.get(key) : null;
  if (!obj) return new Response("not found", { status: 404 });
  const headers = new Headers(res.headers);
  headers.delete("x-r2-key");
  headers.delete("x-r2-bucket");
  if (!headers.has("content-type")) headers.set("content-type", "application/octet-stream");
  headers.set("content-length", String(obj.size));
  return new Response(obj.body, { status: res.status, headers });
}

/** An object's bytes, or null */
export async function getBytes(store: ObjectStore, key: string): Promise<Uint8Array | null> {
  const obj = await store.get(key);
  return obj ? new Uint8Array(await obj.arrayBuffer()) : null;
}

/** Deletes keys in R2's batches of 1000 */
export async function deleteKeys(store: ObjectStore, keys: string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += 1000) await store.delete(keys.slice(i, i + 1000));
}

/** Every object under `prefix` deleted (a room or an object going away) */
export async function deletePrefix(store: ObjectStore, prefix: string): Promise<number> {
  let n = 0;
  let cursor: string | undefined;
  do {
    const page = await store.list({ prefix, cursor, limit: 1000 });
    if (page.objects.length) await store.delete(page.objects.map((o) => o.key));
    n += page.objects.length;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return n;
}

export const sha1Hex = async (bytes: Uint8Array): Promise<string> => [...new Uint8Array(await crypto.subtle.digest("SHA-1", bytes as Uint8Array<ArrayBuffer>))].map((b) => b.toString(16).padStart(2, "0")).join("");

/**
 * The SHA-1 of a stream: Workers' `crypto.DigestStream` (no copy held, little CPU per byte) where there is one, else
 * the bytes read and hashed (Node's tests).
 */
export async function sha1OfStream(stream: ReadableStream): Promise<string> {
  const DS = (crypto as unknown as { DigestStream?: new (alg: string) => WritableStream & { digest: Promise<ArrayBuffer> } }).DigestStream;
  if (DS) {
    const ds = new DS("SHA-1");
    await stream.pipeTo(ds);
    return [...new Uint8Array(await ds.digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  return sha1Hex(new Uint8Array(await new Response(stream).arrayBuffer()));
}
