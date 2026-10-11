/**
 * Libraries' and fonts' Durable Objects for Node tests (docs/data.md §16.13): each `LibraryBox` / `FontBox` on its own
 * node:sqlite database, made on first use — the `LIBRARIES` and `FONTS` bindings, as memoryPreviews.ts is `PREVIEWS`.
 */
import type { ObjectNamespace } from "../libraries/db";
import { LibraryBox } from "../libraries/libraryBox";
import { FontBox } from "../fonts/fontBox";
import { sqliteStorage } from "./memoryPreviews";

interface Box {
  fetch(req: Request): Promise<Response>;
}

function namespace<B extends Box>(make: (host: { sql: ReturnType<typeof sqliteStorage>["sql"]; transaction: (fn: () => void) => void; deleteAll: () => Promise<void> }) => B) {
  const objects = new Map<string, { box: B; wiped: number }>();
  const binding: ObjectNamespace = {
    idFromName: (name) => name,
    get: (id) => {
      const name = id as unknown as string;
      let o = objects.get(name);
      if (!o) {
        const storage = sqliteStorage();
        const made = { wiped: 0 } as { box: B; wiped: number };
        made.box = make({
          sql: storage.sql,
          transaction: storage.transaction,
          deleteAll: async () => {
            made.wiped++;
            dropAll(storage.sql);
          },
        });
        objects.set(name, (o = made));
      }
      const box = o.box;
      return { fetch: (req: Request) => box.fetch(req) };
    },
  };
  return { binding, objects };
}

/** Every table of the object's database dropped (Cloudflare's deleteAll) */
function dropAll(sql: ReturnType<typeof sqliteStorage>["sql"]): void {
  for (const { name } of sql.exec<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table'`).toArray()) sql.exec(`DROP TABLE IF EXISTS "${name}"`);
}

export function memoryLibraries() {
  return namespace((host) => new LibraryBox(host));
}

export function memoryFonts() {
  return namespace((host) => new FontBox(host));
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
