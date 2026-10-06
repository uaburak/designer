/**
 * The content-addressed blob store (docs/data.md §10.2–10.3): `blobs/<sha1[0..2]>/<sha1>`, immutable, shared by every
 * file, version, library and preview. `put` is idempotent. Garbage collection is mark and sweep with a 24 h grace.
 */
import { promises as fsp } from "node:fs";
import { join } from "node:path";
import { StoreError } from "../../shared/store/protocol";
import { isSha1 } from "../../shared/store/types";
import { own } from "../kiwi/codecs";
import { sha1Hex } from "../kiwi/schemas";
import { atomicWrite, ensureDir, exists } from "./fsutil";

/** Sniffs the MIME type from magic bytes (PNG, JPEG, GIF, WebP), else the hint, else octet-stream. */
export function sniffMime(b: Uint8Array, hint?: string): string {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif";
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return hint ?? "application/octet-stream";
}

/** Width and height from a PNG's IHDR, or null. */
export function pngSize(b: Uint8Array): { width: number; height: number } | null {
  if (b.length < 24 || sniffMime(b) !== "image/png") return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { width: v.getUint32(16), height: v.getUint32(20) };
}

export const BLOB_GRACE_MS = 24 * 60 * 60 * 1000;

export class LocalBlobs {
  constructor(
    readonly dir: string,
    private readonly tmpDir: string,
  ) {}

  path(sha1: string): string {
    return join(this.dir, sha1.slice(0, 2), sha1);
  }

  async put(bytes: Uint8Array, hint?: { mime?: string }): Promise<{ sha1: string; size: number; mime: string }> {
    if (!(bytes instanceof Uint8Array)) throw new StoreError("invalid", "blobs.put takes a Uint8Array");
    const sha1 = sha1Hex(bytes);
    const path = this.path(sha1);
    if (!(await exists(path))) {
      await ensureDir(join(this.dir, sha1.slice(0, 2)));
      await atomicWrite(this.tmpDir, path, bytes);
    } else {
      // Refresh the mtime so a sweep in progress keeps a blob that is being put again.
      const now = new Date();
      await fsp.utimes(path, now, now).catch(() => {});
    }
    return { sha1, size: bytes.length, mime: sniffMime(bytes, hint?.mime) };
  }

  async has(sha1s: string[]): Promise<boolean[]> {
    return Promise.all(sha1s.map((s) => (isSha1(s) ? exists(this.path(s)) : Promise.resolve(false))));
  }

  async get(sha1: string): Promise<Uint8Array> {
    if (!isSha1(sha1)) throw new StoreError("invalid", `not a blob id: ${sha1}`);
    try {
      return own(await fsp.readFile(this.path(sha1)));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new StoreError("not-found", `no blob ${sha1}`);
      throw e;
    }
  }

  async list(): Promise<string[]> {
    const out: string[] = [];
    let subs: string[];
    try {
      subs = await fsp.readdir(this.dir);
    } catch {
      return out;
    }
    for (const sub of subs) {
      if (!/^[0-9a-f]{2}$/.test(sub)) continue;
      for (const name of await fsp.readdir(join(this.dir, sub)).catch(() => [] as string[])) if (isSha1(name)) out.push(name);
    }
    return out;
  }

  /** Deletes blobs that are not live and older than the grace period. */
  async sweep(live: ReadonlySet<string>, now: number, graceMs = BLOB_GRACE_MS): Promise<{ deleted: number; kept: number }> {
    let deleted = 0;
    let kept = 0;
    for (const sha1 of await this.list()) {
      if (live.has(sha1)) continue;
      const p = this.path(sha1);
      try {
        const st = await fsp.stat(p);
        if (now - st.mtimeMs < graceMs) {
          kept++;
          continue;
        }
        await fsp.rm(p, { force: true });
        deleted++;
      } catch {
        /* gone already */
      }
    }
    return { deleted, kept };
  }
}
