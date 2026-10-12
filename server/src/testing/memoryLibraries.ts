/**
 * Libraries' and fonts' Durable Objects for Node tests (docs/data.md §16.13): each `LibraryBox` / `FontBox` on its own
 * node:sqlite database, made on first use — the `LIBRARIES` and `FONTS` bindings, as memoryPreviews.ts is `PREVIEWS`.
 */
import type { ObjectNamespace } from "../libraries/db";
import { LibraryBox } from "../libraries/libraryBox";
import { FontBox } from "../fonts/fontBox";
import { sqliteStorage } from "./memoryPreviews";
import type { StorageEnv } from "../storage/objects";

interface Box {
  fetch(req: Request): Promise<Response>;
}

type Host = { sql: ReturnType<typeof sqliteStorage>["sql"]; transaction: (fn: () => void) => void; deleteAll: () => Promise<void>; env?: StorageEnv; name?: () => string | null };

/** `env`: R2 buckets (testing/memoryR2.ts) — the objects then keep their bytes there (docs/cloud.md §1) */
function namespace<B extends Box>(make: (host: Host) => B, env?: StorageEnv) {
  type Made = { box: B; wiped: number };
  const objects = new Map<string, Made>();
  /** Objects of the `eu` jurisdiction (docs/multiplayer.md §15.10): separate from the default ones */
  const euObjects = new Map<string, Made>();
  const failing: string[] = [];
  const over = (map: Map<string, Made>, eu: boolean): ObjectNamespace => ({
    idFromName: (name) => name,
    get: (id) => {
      const name = id as unknown as string;
      let o = map.get(name);
      if (!o) {
        const storage = sqliteStorage();
        const made = { wiped: 0 } as Made;
        made.box = make({
          sql: storage.sql,
          transaction: storage.transaction,
          deleteAll: async () => {
            made.wiped++;
            dropAll(storage.sql);
          },
          ...(env ? { env, name: () => name } : {}),
        });
        map.set(name, (o = made));
      }
      const box = o.box;
      return {
        fetch: async (req: Request) => {
          const at = failing.indexOf(new URL(req.url).pathname);
          if (at >= 0) {
            failing.splice(at, 1);
            return new Response("injected failure", { status: 500 });
          }
          return box.fetch(req);
        },
      };
    },
    ...(eu ? {} : { jurisdiction: () => euBinding }),
  });
  const euBinding = over(euObjects, true);
  const binding = over(objects, false);
  return { binding, objects, euObjects, failNext: (path: string) => void failing.push(path) };
}

/** Every table of the object's database dropped (Cloudflare's deleteAll) */
function dropAll(sql: ReturnType<typeof sqliteStorage>["sql"]): void {
  for (const { name } of sql.exec<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table'`).toArray()) sql.exec(`DROP TABLE IF EXISTS "${name}"`);
}

export function memoryLibraries(env?: StorageEnv) {
  return namespace((host) => new LibraryBox(host), env);
}

export function memoryFonts(env?: StorageEnv) {
  return namespace((host) => new FontBox(host), env);
}

/** Rows of one object's table (tests look inside) */
export function tableCount(box: unknown, table: string): number {
  const host = (box as { host: { sql: ReturnType<typeof sqliteStorage>["sql"] } }).host;
  try {
    return (host.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).toArray()[0]?.n ?? 0) as number;
  } catch {
    return 0;
  }
}
