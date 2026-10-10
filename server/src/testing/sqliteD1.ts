/** D1 for Node tests: node:sqlite behind the narrow `D1Like`, with the real migrations applied. */
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { D1Like, D1Stmt } from "../db";

export function sqliteD1(): D1Like {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const dir = new URL("../../migrations/", import.meta.url);
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(f, dir), "utf8"));
  const prepare = (sql: string, params: unknown[] = []): D1Stmt => {
    const stmt = () => db.prepare(sql);
    const args = params as (string | number | null)[];
    return {
      bind: (...values) => prepare(sql, values),
      first: async <T>() => ((stmt().get(...args) as T | undefined) ?? null),
      all: async <T>() => ({ results: stmt().all(...args) as T[] }),
      run: async () => stmt().run(...args),
    };
  };
  return { prepare: (sql) => prepare(sql) };
}
