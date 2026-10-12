/**
 * Bytes of a Durable Object's box on R2 (docs/cloud.md §1): a library's payloads and images (`l/<libKey>/…`), an org's
 * shared fonts and icons (`f/<orgId>/…`, `i/<orgId>/…`), a developer preview's files (`p/<id>/…`). Each box names its
 * bytes the way its rows did (a "chunk table": the table, its id columns, the object name of an id); with R2 bound a
 * new item is one object, indexed in the box's own `r2_index`, and the old 1 MB rows stay readable until the lazy
 * migration moves them (`step`, one item per call). Plain objects are read by the Worker straight from R2
 * (`redirect` → `resolveR2`); boxes hold nothing sealed.
 */
import type { SqlLike } from "../previews";
import { bucket, r2Redirect, type BucketName, type ObjectStore, type StorageEnv } from "./objects";

/**
 * A box's host over the env's buckets: `region()` its region as the Worker last said it (`x-region`; null while never
 * said — then nothing goes to R2, so an EU object never writes into the default bucket), `prefix()` its key prefix.
 */
export function boxObjectsHost(env: StorageEnv | undefined, region: () => "eu" | "default" | null, prefix: () => string | null): BoxObjectsHost {
  return {
    target() {
      const r = region();
      if (r === null) return null;
      const name = r === "eu" ? "files_eu" : "files";
      const store = bucket(env, name);
      return store ? { name, store } : null;
    },
    store: (name) => bucket(env, name),
    prefix,
  };
}

export interface BoxObjectsHost {
  /** Where the box writes; null: R2 isn't bound (rows as before) */
  target(): { name: BucketName; store: ObjectStore } | null;
  store(name: BucketName): ObjectStore | null;
  /** The box's key prefix (`l/<libKey>/`); null while unknown (nothing written to R2 then) */
  prefix(): string | null;
}

/** A table of 1 MB rows `(…ids, idx, bytes)` and how its items are named on R2 */
export interface ChunkTable {
  table: string;
  cols: string[];
  name(ids: string[]): string;
}

const CHUNK = 1024 * 1024;

interface IndexRow {
  name: string;
  bucket: BucketName;
  key: string;
  size: number;
}

export class BoxObjects {
  constructor(
    private sql: SqlLike,
    private transaction: (fn: () => void) => void,
    private host: BoxObjectsHost | undefined,
  ) {}

  ensure(): void {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS r2_index (name TEXT PRIMARY KEY, bucket TEXT NOT NULL, key TEXT NOT NULL, size INTEGER NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS r2_trash (bucket TEXT NOT NULL, key TEXT NOT NULL, PRIMARY KEY (bucket, key))`);
  }

  enabled(): boolean {
    return !!this.host?.target() && this.host.prefix() !== null;
  }

  private where(t: ChunkTable): string {
    return t.cols.map((c) => `${c} = ?`).join(" AND ");
  }

  private indexRow(name: string): IndexRow | null {
    return this.sql.exec<IndexRow>(`SELECT name, bucket, key, size FROM r2_index WHERE name = ?`, name).toArray()[0] ?? null;
  }

  has(t: ChunkTable, ids: string[]): boolean {
    if (this.indexRow(t.name(ids))) return true;
    return this.sql.exec(`SELECT 1 AS x FROM ${t.table} WHERE ${this.where(t)} AND idx = 0`, ...ids).toArray().length > 0;
  }

  /**
   * One named object written and indexed (`also` runs in the same transaction: the old rows dropped); false when R2
   * isn't there (the caller keeps rows)
   */
  async putObject(name: string, bytes: Uint8Array, also?: () => void, keyName: string = name): Promise<boolean> {
    const target = this.host?.target();
    const prefix = this.host?.prefix();
    if (!target || prefix === null || prefix === undefined) return false;
    const key = `${prefix}${keyName}`;
    await target.store.put(key, bytes);
    this.transaction(() => {
      const old = this.indexRow(name);
      if (old && (old.key !== key || old.bucket !== target.name)) this.trash(old.bucket, old.key);
      also?.();
      this.sql.exec(`INSERT OR REPLACE INTO r2_index (name, bucket, key, size) VALUES (?, ?, ?, ?)`, name, target.name, key, bytes.length);
    });
    return true;
  }

  hasObject(name: string): boolean {
    return !!this.indexRow(name);
  }

  /** A named object's read: by name for the Worker, or null */
  objectResponse(name: string, headers: Record<string, string>): Response | null {
    const r = this.indexRow(name);
    return r ? r2Redirect(r.bucket, r.key, headers) : null;
  }

  /** A named object gone (trashed; deleted by `flush`) */
  removeObject(name: string): void {
    const r = this.indexRow(name);
    if (!r) return;
    this.trash(r.bucket, r.key);
    this.sql.exec(`DELETE FROM r2_index WHERE name = ?`, r.name);
  }

  /** The item's bytes stored: one R2 object when R2 is there, else 1 MB rows */
  async put(t: ChunkTable, ids: string[], bytes: Uint8Array): Promise<void> {
    if (await this.putObject(t.name(ids), bytes, () => this.sql.exec(`DELETE FROM ${t.table} WHERE ${this.where(t)}`, ...ids))) return;
    this.transaction(() => {
      this.sql.exec(`DELETE FROM ${t.table} WHERE ${this.where(t)}`, ...ids);
      for (let i = 0, idx = 0; i < bytes.length || idx === 0; i += CHUNK, idx++) {
        this.sql.exec(`INSERT INTO ${t.table} (${t.cols.join(", ")}, idx, bytes) VALUES (${t.cols.map(() => "?").join(", ")}, ?, ?)`, ...ids, idx, bytes.slice(i, i + CHUNK).buffer);
      }
    });
  }

  private rows(t: ChunkTable, ids: string[]): Uint8Array | null {
    const rows = this.sql.exec<{ bytes: ArrayBuffer }>(`SELECT bytes FROM ${t.table} WHERE ${this.where(t)} ORDER BY idx`, ...ids).toArray();
    if (!rows.length) return null;
    const out = new Uint8Array(rows.reduce((n, r) => n + r.bytes.byteLength, 0));
    let at = 0;
    for (const r of rows) {
      out.set(new Uint8Array(r.bytes), at);
      at += r.bytes.byteLength;
    }
    return out;
  }

  /** The item's bytes (rows first, then R2), or null */
  async read(t: ChunkTable, ids: string[]): Promise<Uint8Array | null> {
    const rows = this.rows(t, ids);
    if (rows) return rows;
    const r = this.indexRow(t.name(ids));
    const store = r ? this.host?.store(r.bucket) : null;
    const obj = r && store ? await store.get(r.key) : null;
    return obj ? new Uint8Array(await obj.arrayBuffer()) : null;
  }

  /** A read's answer: R2 by name (the Worker streams it), the rows' bytes, or null */
  response(t: ChunkTable, ids: string[], headers: Record<string, string>): Response | null {
    const r = this.indexRow(t.name(ids));
    if (r) return r2Redirect(r.bucket, r.key, headers);
    const rows = this.rows(t, ids);
    return rows ? new Response(rows, { headers }) : null;
  }

  /** Inside or outside a transaction: the item gone (its object trashed, deleted by `flush`) */
  remove(t: ChunkTable, ids: string[]): void {
    this.sql.exec(`DELETE FROM ${t.table} WHERE ${this.where(t)}`, ...ids);
    this.removeObject(t.name(ids));
  }

  /** The names indexed on R2 with this prefix (a box's listing: preview images) */
  names(prefix: string): string[] {
    return this.sql.exec<{ name: string }>(`SELECT name FROM r2_index WHERE name >= ? AND name < ?`, prefix, `${prefix}￿`).toArray().map((r) => r.name);
  }

  private trash(bucket: BucketName, key: string): void {
    this.sql.exec(`INSERT OR IGNORE INTO r2_trash (bucket, key) VALUES (?, ?)`, bucket, key);
  }

  async flush(): Promise<void> {
    // Nothing to do on a box whose storage was just deleted (its tables gone)
    if (!this.sql.exec(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'r2_trash'`).toArray().length) return;
    const rows = this.sql.exec<{ bucket: BucketName; key: string }>(`SELECT bucket, key FROM r2_trash LIMIT 1000`).toArray();
    for (const name of ["files", "files_eu"] as const) {
      const keys = rows.filter((r) => r.bucket === name).map((r) => r.key);
      const store = this.host?.store(name);
      if (!keys.length || !store) continue;
      try {
        await store.delete(keys);
        for (const k of keys) this.sql.exec(`DELETE FROM r2_trash WHERE bucket = ? AND key = ?`, name, k);
      } catch (e) {
        console.error("r2: trashed objects not deleted yet", e);
      }
    }
  }

  /** Every object the box wrote (the box is deleted) */
  async dropAll(): Promise<void> {
    this.ensure();
    const rows = [...this.sql.exec<{ bucket: BucketName; key: string }>(`SELECT bucket, key FROM r2_index`).toArray(), ...this.sql.exec<{ bucket: BucketName; key: string }>(`SELECT bucket, key FROM r2_trash`).toArray()];
    for (const name of ["files", "files_eu"] as const) {
      const keys = rows.filter((r) => r.bucket === name).map((r) => r.key);
      const store = this.host?.store(name);
      for (let i = 0; store && i < keys.length; i += 1000) await store.delete(keys.slice(i, i + 1000));
    }
  }

  /** After a region move's load: objects still in another bucket copied into this box's */
  async relocate(): Promise<{ done: boolean; copied: number }> {
    const t = this.host?.target();
    if (!t) return { done: true, copied: 0 };
    let copied = 0;
    for (const r of this.sql.exec<IndexRow>(`SELECT name, bucket, key, size FROM r2_index WHERE bucket <> ?`, t.name).toArray()) {
      const from = this.host!.store(r.bucket);
      const obj = from ? await from.get(r.key) : null;
      if (obj) await t.store.put(r.key, new Uint8Array(await obj.arrayBuffer()));
      this.sql.exec(`UPDATE r2_index SET bucket = ? WHERE name = ?`, t.name, r.name);
      copied++;
    }
    return { done: true, copied };
  }

  /** One old item of `tables` moved from rows to R2 → whether anything is left, and the bytes moved */
  async step(tables: ChunkTable[]): Promise<{ done: boolean; enabled: boolean; moved: number }> {
    if (!this.enabled()) return { done: false, enabled: false, moved: 0 };
    for (const t of tables) {
      const first = this.sql.exec<Record<string, string>>(`SELECT ${t.cols.join(", ")} FROM ${t.table} WHERE idx = 0 LIMIT 1`).toArray()[0];
      if (!first) continue;
      const ids = t.cols.map((c) => String(first[c]));
      const bytes = this.rows(t, ids)!;
      await this.put(t, ids, bytes);
      return { done: false, enabled: true, moved: bytes.length };
    }
    return { done: true, enabled: true, moved: 0 };
  }

  /** `step` until done or about `budget` bytes moved */
  async migrate(tables: ChunkTable[], budget = 96 * 1024 * 1024): Promise<{ done: boolean; enabled: boolean; moved: number }> {
    let moved = 0;
    for (let i = 0; i < 256; i++) {
      const r = await this.step(tables);
      moved += r.moved;
      if (r.done || !r.enabled || moved >= budget) return { ...r, moved };
    }
    return { done: false, enabled: true, moved };
  }
}
