/** Previews' Durable Objects for Node tests: each preview's `PreviewBox` on its own node:sqlite database. */
import { DatabaseSync } from "node:sqlite";
import { PreviewBox, type PreviewEnv, type SqlLike } from "../previews";
import type { StorageEnv } from "../storage/objects";

/** A Durable Object's SQLite storage on node:sqlite (ArrayBuffers in and out, as Cloudflare's). */
export function sqliteStorage(): { sql: SqlLike; transaction(fn: () => void): void; wipe(): void } {
  const db = new DatabaseSync(":memory:");
  const sql: SqlLike = {
    exec<T>(query: string, ...binds: unknown[]) {
      const args = binds.map((b) => (b instanceof ArrayBuffer ? new Uint8Array(b) : b)) as (string | number | null | Uint8Array)[];
      const stmt = db.prepare(query);
      const rows = /^\s*select/i.test(query) ? (stmt.all(...args) as Record<string, unknown>[]) : (stmt.run(...args), []);
      const out = rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v instanceof Uint8Array ? v.slice().buffer : v])));
      return { toArray: () => out as T[] };
    },
  };
  return {
    sql,
    transaction(fn) {
      db.exec("BEGIN");
      try {
        fn();
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    wipe: () => db.exec("DROP TABLE IF EXISTS meta; DROP TABLE IF EXISTS files; DROP TABLE IF EXISTS r2_index; DROP TABLE IF EXISTS r2_trash;"),
  };
}

export interface MemoryPreviewObject {
  box: PreviewBox;
  /** The alarm the object set (its expiry), null for none */
  alarm: number | null;
}

/** The `PREVIEWS` binding: one object per name, made on first use. */
export function memoryPreviews(now: () => number, env?: StorageEnv): { binding: NonNullable<PreviewEnv["PREVIEWS"]>; objects: Map<string, MemoryPreviewObject> } {
  const objects = new Map<string, MemoryPreviewObject>();
  const binding: NonNullable<PreviewEnv["PREVIEWS"]> = {
    idFromName: (name) => name,
    get: (id) => {
      const name = id as unknown as string;
      let o = objects.get(name);
      if (!o) {
        const storage = sqliteStorage();
        const made: MemoryPreviewObject = {
          alarm: null,
          box: new PreviewBox({
            sql: storage.sql,
            transaction: storage.transaction,
            now,
            setAlarm: async (at) => void (made.alarm = at),
            deleteAll: async () => {
              made.alarm = null;
              storage.wipe();
            },
            ...(env ? { env, name: () => name } : {}),
          }),
        };
        objects.set(name, (o = made));
      }
      const box = o.box;
      return { fetch: (req: Request) => box.fetch(req) };
    },
  };
  return { binding, objects };
}
