/**
 * One org library's bytes (docs/data.md §16.2, §16.13): the logic of the `LibraryObject` Durable Object over its
 * SQLite storage, so Node's tests run it on node:sqlite (testing/memoryLibraries.ts) — as `PreviewBox` is to
 * `PreviewObject`. Reached only through the Worker (libraries/routes.ts), which has checked who may read or write.
 *
 * Tables (1 MB rows; SQLite values hold 2 MB):
 *   meta (k, v)                          'latest' → the latest version number
 *   manifests (version, idx, json)       each version's LibraryVersion, immutable once committed
 *   payloads (key, hash, idx, bytes)     asset payloads (snapshot containers, §9.2), content-addressed by versionHash
 *   blobs (sha1, idx, bytes)             thumbnails and the images payloads use, by SHA-1
 *
 * Routes (the Worker's paths after `https://library`):
 *   POST /missing {payloads, blobs}      → the same shape, only what isn't stored
 *   PUT  /payload/:key/:hash             the payload's bytes (container prelude checked)
 *   PUT  /blob/:sha1                     an image's bytes (SHA-1 checked)
 *   POST /batch                          many payloads and images in one call (readBundle's frames; each checked as
 *                                        the single PUTs check it, all before any is written) → 204
 *   GET  /blob/:sha1                     → bytes
 *   POST /commit {baseVersion, publishedAt, libraryFileKey, description, changes, assets}
 *                                        → 201 {version}; 409 {code: "conflict", latest}; 400 {code: "invalid", missing}
 *   GET  /version/:n | /version/latest   → LibraryVersion
 *   POST /diff {have, movedOut}          → LibraryDiff (libraryRules.diffWithHistory)
 *   POST /payloads {wants, withDependencies}
 *                                        → [u32 n] then n × [u32 jsonLen][{key, versionHash, size}][bytes] (u32 LE)
 *   POST /delete                         everything dropped (the file was deleted forever)
 *   POST /freeze · /unfreeze             a move to another region (docs/multiplayer.md §15.10): writes answer 503
 *                                        {code: "moving"} while frozen
 *   GET  /dump?after= · POST /load {rows} its tables paged out and into the copy (policy/dump.ts)
 *   POST /relocate                       after a move's load: its R2 objects copied into its own region's bucket
 *   POST /storage/migrate                old rows moved to R2 (the operator's loop; also one item per wake)
 *
 * On R2 (docs/cloud.md §1, storage/boxObjects.ts): with the env's buckets, payloads are `l/<libKey>/p/<key>/<hash>`
 * and images `l/<libKey>/b/<sha1>` in the library's region's bucket (the Worker's `x-region`, kept in meta `region`);
 * the rows above are what it stored before, read until moved.
 */
import { diffWithHistory, stampUserFacingVersions, withDependencies } from "../../../src/shared/store/libraryRules";
import type { LibraryAsset, LibraryVersion, Redirect } from "../../../src/shared/store/types";
import type { SqlLike } from "../previews";
import { dumpPage, loadPage } from "../policy/dump";
import { BoxObjects, boxObjectsHost, type ChunkTable } from "../storage/boxObjects";
import type { StorageEnv } from "../storage/objects";

/** The object's tables, in the order a move copies them */
export const LIBRARY_TABLES = ["meta", "manifests", "payloads", "blobs", "r2_index"] as const;

const PAYLOADS: ChunkTable = { table: "payloads", cols: ["key", "hash"], name: ([k, h]) => `p/${k}/${h}` };
const BLOBS: ChunkTable = { table: "blobs", cols: ["sha1"], name: ([s]) => `b/${s}` };

const CHUNK = 1024 * 1024;
/** A payload or an image (data.md §16.10) */
export const MAX_LIBRARY_BYTES = 50 * 1024 * 1024;
const SHA1 = /^[0-9a-f]{40}$/;
/** The container preludes a payload may start with (src/shared/fig/container.ts) */
const PRELUDES = ["fig-kiwi", "fig-jam.", "fig-deck"];

export interface LibraryBoxHost {
  sql: SqlLike;
  /** All of `fn` or none of it (`ctx.storage.transactionSync`) */
  transaction(fn: () => void): void;
  /** Deletes everything the object stores */
  deleteAll(): Promise<void>;
  /** R2 (docs/cloud.md §1): the env's buckets and the library's key (the object's name); absent: rows only */
  env?: StorageEnv;
  name?(): string | null;
}

export interface CommitInput {
  libraryFileKey: string;
  baseVersion: number;
  publishedAt: number;
  description: string;
  changes: LibraryVersion["changes"];
  assets: LibraryAsset[];
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });

export class LibraryBox {
  readonly objects: BoxObjects;
  private stepped = false;

  constructor(private host: LibraryBoxHost) {
    this.objects = new BoxObjects(host.sql, (fn) => host.transaction(fn), host.env ? boxObjectsHost(host.env, () => this.region(), () => (host.name?.() ? `l/${host.name()}/` : null)) : undefined);
  }

  private region(): "eu" | "default" | null {
    const r = this.host.sql.exec<{ v: string }>(`SELECT v FROM meta WHERE k = 'region'`).toArray()[0];
    return r?.v === "eu" ? "eu" : r?.v === "default" ? "default" : null;
  }

  private ensure(): void {
    const sql = this.host.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS manifests (version INTEGER NOT NULL, idx INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY (version, idx))`);
    sql.exec(`CREATE TABLE IF NOT EXISTS payloads (key TEXT NOT NULL, hash TEXT NOT NULL, idx INTEGER NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY (key, hash, idx))`);
    sql.exec(`CREATE TABLE IF NOT EXISTS blobs (sha1 TEXT NOT NULL, idx INTEGER NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY (sha1, idx))`);
    this.objects.ensure();
  }

  async fetch(req: Request): Promise<Response> {
    this.ensure();
    const region = req.headers.get("x-region");
    if ((region === "eu" || region === "default") && this.region() !== region) this.host.sql.exec(`INSERT OR REPLACE INTO meta (k, v) VALUES ('region', ?)`, region);
    try {
      return await this.route(req);
    } finally {
      await this.objects.flush();
    }
  }

  private async route(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    const m = req.method;
    // One old item moved to R2 per wake (docs/cloud.md §1), after this call's own work
    const moving = () => this.host.sql.exec(`SELECT 1 AS x FROM meta WHERE k = 'moving'`).toArray().length > 0;
    if (!this.stepped && path !== "/delete" && path !== "/dump" && path !== "/load" && path !== "/storage/migrate" && !moving()) {
      this.stepped = true;
      void this.objects.step([PAYLOADS, BLOBS]).catch((e) => console.error("r2: the library's migration step failed", e));
    }
    if (path === "/delete" && m === "POST") {
      await this.objects.dropAll();
      await this.host.deleteAll();
      return json({ ok: true });
    }
    if (path === "/relocate" && m === "POST") return json(await this.objects.relocate());
    if (path === "/storage/migrate" && m === "POST") return json(await this.objects.migrate([PAYLOADS, BLOBS]));
    // A move to another region (§15.10)
    if (path === "/freeze" && m === "POST") {
      this.host.sql.exec(`INSERT OR REPLACE INTO meta (k, v) VALUES ('moving', '1')`);
      return json({ ok: true });
    }
    if (path === "/unfreeze" && m === "POST") {
      this.host.sql.exec(`DELETE FROM meta WHERE k = 'moving'`);
      return json({ ok: true });
    }
    if (path === "/dump" && m === "GET") return json(dumpPage(this.host.sql, LIBRARY_TABLES, new URL(req.url).searchParams.get("after"), (t, row) => t === "meta" && row.k === "moving"));
    if (path === "/load" && m === "POST") {
      const { rows } = (await req.json()) as { rows?: unknown };
      try {
        let n = 0;
        this.host.transaction(() => {
          n = loadPage(this.host.sql, LIBRARY_TABLES, rows);
        });
        return json({ ok: true, rows: n });
      } catch (e) {
        return json({ error: `load: ${(e as Error).message}`, code: "invalid" }, 400);
      }
    }
    if (m === "PUT" || path === "/commit" || path === "/batch") {
      if (this.host.sql.exec(`SELECT 1 AS x FROM meta WHERE k = 'moving'`).toArray().length) return json({ error: "this library is moving to another region; try again in a moment", code: "moving" }, 503);
    }
    if (path === "/missing" && m === "POST") {
      const b = (await req.json()) as { payloads?: { key: string; versionHash: string }[]; blobs?: string[] };
      return json({
        payloads: (b.payloads ?? []).filter((p) => !this.hasPayload(p.key, p.versionHash)),
        blobs: [...new Set(b.blobs ?? [])].filter((s) => !this.hasBlob(s)),
      });
    }
    const payload = /^\/payload\/([0-9a-f]{40})\/([0-9a-f]{40})$/.exec(path);
    if (payload && m === "PUT") {
      const bytes = new Uint8Array(await req.arrayBuffer());
      if (bytes.length > MAX_LIBRARY_BYTES) return json({ error: "payload too large", code: "too_large" }, 413);
      const prelude = String.fromCharCode(...bytes.subarray(0, 8));
      if (bytes.length < 12 || !PRELUDES.includes(prelude)) return json({ error: "a payload is a fig-kiwi container", code: "invalid" }, 400);
      // Content-addressed by versionHash (the canonical payload's SHA-1, computed by the engine): written once.
      if (!this.hasPayload(payload[1], payload[2])) await this.objects.put(PAYLOADS, [payload[1], payload[2]], bytes);
      return new Response(null, { status: 204 });
    }
    if (path === "/batch" && m === "POST") return this.batch(new Uint8Array(await req.arrayBuffer()));
    const blob = /^\/blob\/([0-9a-f]{40})$/.exec(path);
    if (blob && m === "PUT") {
      const bytes = new Uint8Array(await req.arrayBuffer());
      if (bytes.length > MAX_LIBRARY_BYTES) return json({ error: "image too large", code: "too_large" }, 413);
      if ((await sha1Hex(bytes)) !== blob[1]) return json({ error: "the bytes don't match their SHA-1", code: "invalid" }, 400);
      if (!this.hasBlob(blob[1])) await this.objects.put(BLOBS, [blob[1]], bytes);
      return new Response(null, { status: 204 });
    }
    if (blob && m === "GET") {
      return this.objects.response(BLOBS, [blob[1]], { "content-type": "application/octet-stream", "cache-control": "private, max-age=31536000, immutable" }) ?? json({ error: "not found", code: "not_found" }, 404);
    }
    if (path === "/commit" && m === "POST") return this.commit((await req.json()) as CommitInput);
    const version = /^\/version\/(latest|\d+)$/.exec(path);
    if (version && m === "GET") {
      const n = version[1] === "latest" ? this.latest() : Number(version[1]);
      const v = n > 0 ? this.manifest(n) : null;
      return v ? json(v) : json({ error: "no such version", code: "not_found" }, 404);
    }
    if (path === "/diff" && m === "POST") {
      const b = (await req.json()) as { have?: { key: string; versionHash: string }[]; movedOut?: Redirect[] };
      const latest = this.latest();
      const cache = new Map<number, LibraryVersion | null>();
      const load = (n: number) => {
        if (!cache.has(n)) cache.set(n, this.manifest(n));
        return cache.get(n)!;
      };
      const entry = (key: string, hash: string) => {
        for (let n = latest; n >= 1; n--) {
          const a = load(n)?.assets.find((x) => x.key === key && x.versionHash === hash);
          if (a) return a;
        }
        return null;
      };
      return json(await diffWithHistory(latest ? load(latest) : null, latest, b.have ?? [], b.movedOut ?? [], { entry, version: load }));
    }
    if (path === "/payloads" && m === "POST") {
      const b = (await req.json()) as { wants?: { key: string; versionHash: string }[]; withDependencies?: boolean };
      return this.payloads(b.wants ?? [], b.withDependencies === true);
    }
    return json({ error: "not found", code: "not_found" }, 404);
  }

  latest(): number {
    const r = this.host.sql.exec<{ v: string }>(`SELECT v FROM meta WHERE k = 'latest'`).toArray()[0];
    return r ? Number(r.v) : 0;
  }

  manifest(n: number): LibraryVersion | null {
    const rows = this.host.sql.exec<{ json: string }>(`SELECT json FROM manifests WHERE version = ? ORDER BY idx`, n).toArray();
    return rows.length ? (JSON.parse(rows.map((r) => r.json).join("")) as LibraryVersion) : null;
  }

  private commit(input: CommitInput): Response {
    const latest = this.latest();
    if (input.baseVersion !== latest) return json({ error: "someone published this library meanwhile", code: "conflict", latest }, 409);
    // Every payload the manifest names, and every thumbnail, must be here already (uploaded before the commit).
    const missing: string[] = [];
    for (const a of input.assets) {
      if (!this.hasPayload(a.key, a.versionHash)) missing.push(`payload ${a.key}/${a.versionHash}`);
      if (a.thumbnail && !this.hasBlob(a.thumbnail.sha1)) missing.push(`blob ${a.thumbnail.sha1}`);
    }
    if (missing.length) return json({ error: `missing: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? "…" : ""}`, code: "invalid", missing }, 400);
    const version: LibraryVersion = {
      libraryFileKey: input.libraryFileKey,
      version: latest + 1,
      publishedAt: input.publishedAt,
      description: input.description,
      changes: input.changes,
      // Figma's userFacingVersion (atlas 12 §6.1), stamped here against the latest manifest the commit builds on.
      assets: stampUserFacingVersions(input.assets, latest ? this.manifest(latest) : null, latest + 1),
    };
    const text = JSON.stringify(version);
    this.host.transaction(() => {
      // Re-read inside the transaction: two commits can't both take latest + 1.
      if (this.latest() !== latest) throw new Error("conflict");
      for (let i = 0, idx = 0; i < text.length || idx === 0; i += CHUNK / 2, idx++) this.host.sql.exec(`INSERT INTO manifests (version, idx, json) VALUES (?, ?, ?)`, version.version, idx, text.slice(i, i + CHUNK / 2));
      this.host.sql.exec(`INSERT INTO meta (k, v) VALUES ('latest', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v`, String(version.version));
    });
    return json({ version }, 201);
  }

  private async payloads(wants: { key: string; versionHash: string }[], deps: boolean): Promise<Response> {
    let list = wants.filter((w) => SHA1.test(w.key) && SHA1.test(w.versionHash));
    if (deps) {
      // A dependency's version is the one in the manifest that holds the wanted asset at that version (§9.1).
      const cache = new Map<number, LibraryVersion | null>();
      const load = (n: number) => {
        if (!cache.has(n)) cache.set(n, this.manifest(n));
        return cache.get(n)!;
      };
      const latest = this.latest();
      list = withDependencies((key, versionHash) => {
        for (let n = latest; n >= 1; n--) {
          const man = load(n);
          const asset = man?.assets.find((a) => a.key === key && a.versionHash === versionHash);
          if (man && asset) return { asset, manifest: man };
        }
        return null;
      }, list);
    }
    const parts: Uint8Array[] = [];
    let count = 0;
    const enc = new TextEncoder();
    for (const w of list) {
      const bytes = await this.objects.read(PAYLOADS, [w.key, w.versionHash]);
      if (!bytes) continue;
      const head = enc.encode(JSON.stringify({ key: w.key, versionHash: w.versionHash, size: bytes.length }));
      parts.push(u32(head.length), head, bytes);
      count++;
    }
    const total = 4 + parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    out.set(u32(count), 0);
    let at = 4;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return new Response(out, { headers: { "content-type": "application/octet-stream" } });
  }

  /** POST /batch: every item checked first (none written when one is bad), then the new ones stored, a few at a time */
  private async batch(body: Uint8Array): Promise<Response> {
    let items: BundleItem[];
    try {
      items = readBundle(body);
    } catch (e) {
      return json({ error: (e as Error).message, code: "invalid" }, 400);
    }
    for (const it of items) {
      if (it.bytes.length > MAX_LIBRARY_BYTES) return json({ error: `${it.type} too large`, code: "too_large" }, 413);
      if (it.type === "payload") {
        const prelude = String.fromCharCode(...it.bytes.subarray(0, 8));
        if (it.bytes.length < 12 || !PRELUDES.includes(prelude)) return json({ error: `payload ${it.key}: a payload is a fig-kiwi container`, code: "invalid" }, 400);
      } else if ((await sha1Hex(it.bytes)) !== it.sha1) return json({ error: `image ${it.sha1}: the bytes don't match their SHA-1`, code: "invalid" }, 400);
    }
    const todo = items.filter((it) => (it.type === "payload" ? !this.hasPayload(it.key, it.versionHash) : !this.hasBlob(it.sha1)));
    let next = 0;
    const worker = async () => {
      for (let it = todo[next++]; it; it = todo[next++]) {
        if (it.type === "payload") {
          if (!this.hasPayload(it.key, it.versionHash)) await this.objects.put(PAYLOADS, [it.key, it.versionHash], it.bytes);
        } else if (!this.hasBlob(it.sha1)) await this.objects.put(BLOBS, [it.sha1], it.bytes);
      }
    };
    await Promise.all(Array.from({ length: Math.min(BATCH_WRITES, todo.length) }, worker));
    return new Response(null, { status: 204 });
  }

  private hasPayload(key: string, hash: string): boolean {
    return this.objects.has(PAYLOADS, [key, hash]);
  }

  private hasBlob(sha1: string): boolean {
    return SHA1.test(sha1) && this.objects.has(BLOBS, [sha1]);
  }
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function u32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}

/** Splits POST /payloads' answer (the store's reader and the tests) */
export function readPayloads(bytes: Uint8Array): { key: string; versionHash: string; bytes: Uint8Array }[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = view.getUint32(0, true);
  const out: { key: string; versionHash: string; bytes: Uint8Array }[] = [];
  let at = 4;
  const dec = new TextDecoder();
  for (let i = 0; i < n; i++) {
    const len = view.getUint32(at, true);
    const head = JSON.parse(dec.decode(bytes.subarray(at + 4, at + 4 + len))) as { key: string; versionHash: string; size: number };
    at += 4 + len;
    out.push({ key: head.key, versionHash: head.versionHash, bytes: bytes.subarray(at, at + head.size) });
    at += head.size;
  }
  return out;
}

/** One item of a bundle (POST /libraries/:key/bundle, the object's /batch) */
export type BundleItem = { type: "payload"; key: string; versionHash: string; bytes: Uint8Array } | { type: "blob"; sha1: string; bytes: Uint8Array };

/** Items a bundle holds at most (each may be an R2 write: well under a call's subrequests) */
export const MAX_BUNDLE_ITEMS = 500;
/** A bundle's body at most */
export const MAX_BUNDLE_BYTES = 32 * 1024 * 1024;
/** R2 writes of a /batch at once */
const BATCH_WRITES = 6;

/**
 * A bundle of library bytes, as POST /payloads' answer frames them: `[u32 n]` then n × `[u32 jsonLen][head][bytes]`
 * (u32 LE), head `{type: "payload", key, versionHash, size}` or `{type: "blob", sha1, size}`. Throws on anything else.
 */
export function readBundle(bytes: Uint8Array): BundleItem[] {
  if (bytes.length < 4) throw new Error("a bundle starts with its item count");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = view.getUint32(0, true);
  if (n > MAX_BUNDLE_ITEMS) throw new Error(`a bundle holds ${MAX_BUNDLE_ITEMS} items at most`);
  const dec = new TextDecoder();
  const out: BundleItem[] = [];
  let at = 4;
  for (let i = 0; i < n; i++) {
    if (at + 4 > bytes.length) throw new Error("the bundle is cut short");
    const len = view.getUint32(at, true);
    at += 4;
    if (len > 1024 || at + len > bytes.length) throw new Error("the bundle is cut short");
    let head: { type?: unknown; key?: unknown; versionHash?: unknown; sha1?: unknown; size?: unknown };
    try {
      head = JSON.parse(dec.decode(bytes.subarray(at, at + len))) as typeof head;
    } catch {
      throw new Error("a bundle item's head isn't JSON");
    }
    at += len;
    const size = head.size;
    if (typeof size !== "number" || !Number.isInteger(size) || size < 0 || at + size > bytes.length) throw new Error("a bundle item's size is wrong");
    const body = bytes.subarray(at, at + size);
    at += size;
    if (head.type === "payload" && typeof head.key === "string" && SHA1.test(head.key) && typeof head.versionHash === "string" && SHA1.test(head.versionHash)) out.push({ type: "payload", key: head.key, versionHash: head.versionHash, bytes: body });
    else if (head.type === "blob" && typeof head.sha1 === "string" && SHA1.test(head.sha1)) out.push({ type: "blob", sha1: head.sha1, bytes: body });
    else throw new Error("a bundle item is {type: payload, key, versionHash} or {type: blob, sha1}, SHA-1s");
  }
  if (at !== bytes.length) throw new Error("the bundle has bytes after its items");
  return out;
}

/** The inverse (tests) */
export function writeBundle(items: BundleItem[]): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [u32(items.length)];
  for (const it of items) {
    const head = enc.encode(JSON.stringify(it.type === "payload" ? { type: "payload", key: it.key, versionHash: it.versionHash, size: it.bytes.length } : { type: "blob", sha1: it.sha1, size: it.bytes.length }));
    parts.push(u32(head.length), head, it.bytes);
  }
  return concat(parts);
}

export async function sha1Hex(bytes: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-1", bytes as Uint8Array<ArrayBuffer>))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
