/**
 * An R2 bucket for Node tests (docs/cloud.md §1): the `ObjectStore` part of `R2Bucket` in memory — get, head, put,
 * delete, list (by prefix, paged), multipart uploads (parts of at least 5 MiB but the last, as R2 asks) — counting
 * operations by R2's classes (A: writes and lists; B: reads; deletes and aborts free).
 */
import type { MultipartPart, MultipartUpload, ObjectStore, StoredObject } from "../storage/objects";

export interface MemoryR2 extends ObjectStore {
  objects: Map<string, Uint8Array>;
  ops: { a: number; b: number; deletes: number };
  /** Multipart uploads not completed or aborted */
  uploads: Map<string, { key: string; parts: Map<number, Uint8Array> }>;
  /** The next operation whose name matches fails (one shot), e.g. "uploadPart" */
  failNext(op: string): void;
}

const MIN_PART = 5 * 1024 * 1024;

async function bytesOf(v: ReadableStream | ArrayBuffer | ArrayBufferView | string | null): Promise<Uint8Array> {
  if (v === null) return new Uint8Array(0);
  if (typeof v === "string") return new TextEncoder().encode(v);
  if (v instanceof ArrayBuffer) return new Uint8Array(v.slice(0));
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
  return new Uint8Array(await new Response(v).arrayBuffer());
}

const stored = (b: Uint8Array): StoredObject => ({
  size: b.length,
  get body() {
    return new Response(b.slice()).body!;
  },
  arrayBuffer: async () => b.slice().buffer,
});

export function memoryR2(): MemoryR2 {
  const objects = new Map<string, Uint8Array>();
  const uploads: MemoryR2["uploads"] = new Map();
  const ops = { a: 0, b: 0, deletes: 0 };
  const failing: string[] = [];
  let n = 0;
  const maybeFail = (op: string) => {
    const at = failing.indexOf(op);
    if (at >= 0) {
      failing.splice(at, 1);
      throw new Error(`injected R2 failure: ${op}`);
    }
  };
  const upload = (key: string, uploadId: string): MultipartUpload => ({
    key,
    uploadId,
    async uploadPart(partNumber, value) {
      ops.a++;
      maybeFail("uploadPart");
      const u = uploads.get(uploadId);
      if (!u || u.key !== key) throw new Error("no such upload");
      u.parts.set(partNumber, await bytesOf(value));
      return { partNumber, etag: `etag-${uploadId}-${partNumber}-${u.parts.get(partNumber)!.length}` };
    },
    async abort() {
      uploads.delete(uploadId);
    },
    async complete(parts: MultipartPart[]) {
      ops.a++;
      const u = uploads.get(uploadId);
      if (!u || u.key !== key) throw new Error("no such upload");
      const sorted = [...parts].sort((x, y) => x.partNumber - y.partNumber);
      const chunks = sorted.map((p, i) => {
        const b = u.parts.get(p.partNumber);
        if (!b || p.etag !== `etag-${uploadId}-${p.partNumber}-${b.length}`) throw new Error(`part ${p.partNumber} wasn't uploaded`);
        if (i < sorted.length - 1 && b.length < MIN_PART) throw new Error("EntityTooSmall: a part but the last is under 5 MiB");
        return b;
      });
      const out = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
      let at = 0;
      for (const c of chunks) {
        out.set(c, at);
        at += c.length;
      }
      objects.set(key, out);
      uploads.delete(uploadId);
      return { key, size: out.length };
    },
  });
  return {
    objects,
    ops,
    uploads,
    failNext: (op) => void failing.push(op),
    async get(key) {
      ops.b++;
      maybeFail("get");
      const b = objects.get(key);
      return b ? stored(b) : null;
    },
    async head(key) {
      ops.b++;
      const b = objects.get(key);
      return b ? { size: b.length } : null;
    },
    async put(key, value) {
      ops.a++;
      maybeFail("put");
      objects.set(key, await bytesOf(value));
      return { key };
    },
    async delete(keys) {
      ops.deletes++;
      for (const k of Array.isArray(keys) ? keys : [keys]) objects.delete(k);
    },
    async list({ prefix = "", cursor, limit = 1000 }) {
      ops.a++;
      const all = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      const from = cursor ? all.findIndex((k) => k > cursor) : 0;
      const page = from < 0 ? [] : all.slice(from, from + limit);
      const truncated = from >= 0 && from + limit < all.length;
      return { objects: page.map((key) => ({ key, size: objects.get(key)!.length })), truncated, ...(truncated ? { cursor: page[page.length - 1] } : {}) };
    },
    async createMultipartUpload(key) {
      ops.a++;
      const uploadId = `mpu${++n}`;
      uploads.set(uploadId, { key, parts: new Map() });
      return upload(key, uploadId);
    },
    resumeMultipartUpload: (key, uploadId) => upload(key, uploadId),
  };
}

/** The Worker's two buckets (wrangler.jsonc `r2_buckets`) */
export const memoryBuckets = () => ({ FILES: memoryR2(), FILES_EU: memoryR2() });
