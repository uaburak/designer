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
 *   GET  /blob/:sha1                     → bytes
 *   POST /commit {baseVersion, publishedAt, libraryFileKey, description, changes, assets}
 *                                        → 201 {version}; 409 {code: "conflict", latest}; 400 {code: "invalid", missing}
 *   GET  /version/:n | /version/latest   → LibraryVersion
 *   POST /diff {have, movedOut}          → LibraryDiff (libraryRules.diffAgainst)
 *   POST /payloads {wants, withDependencies}
 *                                        → [u32 n] then n × [u32 jsonLen][{key, versionHash, size}][bytes] (u32 LE)
 *   POST /delete                         everything dropped (the file was deleted forever)
 *   POST /freeze · /unfreeze             a move to another region (docs/multiplayer.md §15.10): writes answer 503
 *                                        {code: "moving"} while frozen
 *   GET  /dump?after= · POST /load {rows} its tables paged out and into the copy (policy/dump.ts)
 */
import { diffAgainst, withDependencies } from "../../../src/shared/store/libraryRules";
import type { LibraryAsset, LibraryVersion, Redirect } from "../../../src/shared/store/types";
import type { SqlLike } from "../previews";
import { dumpPage, loadPage } from "../policy/dump";

/** The object's tables, in the order a move copies them */
export const LIBRARY_TABLES = ["meta", "manifests", "payloads", "blobs"] as const;

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
  constructor(private host: LibraryBoxHost) {}

  private ensure(): void {
    const sql = this.host.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS manifests (version INTEGER NOT NULL, idx INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY (version, idx))`);
    sql.exec(`CREATE TABLE IF NOT EXISTS payloads (key TEXT NOT NULL, hash TEXT NOT NULL, idx INTEGER NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY (key, hash, idx))`);
    sql.exec(`CREATE TABLE IF NOT EXISTS blobs (sha1 TEXT NOT NULL, idx INTEGER NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY (sha1, idx))`);
  }

  async fetch(req: Request): Promise<Response> {
    this.ensure();
    const path = new URL(req.url).pathname;
    const m = req.method;
    if (path === "/delete" && m === "POST") {
      await this.host.deleteAll();
      return json({ ok: true });
    }
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
    if (m === "PUT" || path === "/commit") {
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
      if (!this.hasPayload(payload[1], payload[2])) this.put("payloads", ["key", "hash"], [payload[1], payload[2]], bytes);
      return new Response(null, { status: 204 });
    }
    const blob = /^\/blob\/([0-9a-f]{40})$/.exec(path);
    if (blob && m === "PUT") {
      const bytes = new Uint8Array(await req.arrayBuffer());
      if (bytes.length > MAX_LIBRARY_BYTES) return json({ error: "image too large", code: "too_large" }, 413);
      if ((await sha1Hex(bytes)) !== blob[1]) return json({ error: "the bytes don't match their SHA-1", code: "invalid" }, 400);
      if (!this.hasBlob(blob[1])) this.put("blobs", ["sha1"], [blob[1]], bytes);
      return new Response(null, { status: 204 });
    }
    if (blob && m === "GET") {
      const bytes = this.read("blobs", ["sha1"], [blob[1]]);
      if (!bytes) return json({ error: "not found", code: "not_found" }, 404);
      return new Response(bytes, { headers: { "content-type": "application/octet-stream", "cache-control": "private, max-age=31536000, immutable" } });
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
      return json(diffAgainst(latest ? this.manifest(latest) : null, latest, b.have ?? [], b.movedOut ?? []));
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
      assets: input.assets,
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

  private payloads(wants: { key: string; versionHash: string }[], deps: boolean): Response {
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
      const bytes = this.read("payloads", ["key", "hash"], [w.key, w.versionHash]);
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

  private hasPayload(key: string, hash: string): boolean {
    return this.host.sql.exec(`SELECT 1 FROM payloads WHERE key = ? AND hash = ? AND idx = 0`, key, hash).toArray().length > 0;
  }

  private hasBlob(sha1: string): boolean {
    return SHA1.test(sha1) && this.host.sql.exec(`SELECT 1 FROM blobs WHERE sha1 = ? AND idx = 0`, sha1).toArray().length > 0;
  }

  private put(table: "payloads" | "blobs", cols: string[], ids: string[], bytes: Uint8Array): void {
    this.host.transaction(() => {
      const where = cols.map((c) => `${c} = ?`).join(" AND ");
      this.host.sql.exec(`DELETE FROM ${table} WHERE ${where}`, ...ids);
      for (let i = 0, idx = 0; i < bytes.length || idx === 0; i += CHUNK, idx++) {
        this.host.sql.exec(`INSERT INTO ${table} (${cols.join(", ")}, idx, bytes) VALUES (${cols.map(() => "?").join(", ")}, ?, ?)`, ...ids, idx, bytes.slice(i, i + CHUNK).buffer);
      }
    });
  }

  private read(table: "payloads" | "blobs", cols: string[], ids: string[]): Uint8Array | null {
    const where = cols.map((c) => `${c} = ?`).join(" AND ");
    const rows = this.host.sql.exec<{ bytes: ArrayBuffer }>(`SELECT bytes FROM ${table} WHERE ${where} ORDER BY idx`, ...ids).toArray();
    if (!rows.length) return null;
    return concat(rows.map((r) => new Uint8Array(r.bytes)));
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

export async function sha1Hex(bytes: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-1", bytes as Uint8Array<ArrayBuffer>))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
