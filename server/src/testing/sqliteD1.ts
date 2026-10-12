/** D1 for Node tests: node:sqlite behind the narrow `D1Like`, with the real migrations applied and D1's own limits that
 *  node:sqlite's defaults don't have. */
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { D1Like, D1Stmt } from "../db";

export function sqliteD1(): D1Like {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  // A path, not a URL: a happy-dom test's global URL isn't Node's (Home's DOM tests run the real handler too)
  const dir = join(fileURLToPath(import.meta.url), "../../../migrations");
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) db.exec(readFileSync(join(dir, f), "utf8"));
  const prepare = (sql: string, params: unknown[] = []): D1Stmt => {
    const stmt = () => {
      checkD1Limits(sql);
      return db.prepare(sql);
    };
    const args = params as (string | number | null)[];
    return {
      bind: (...values) => prepare(sql, values),
      first: async <T>() => ((stmt().get(...args) as T | undefined) ?? null),
      all: async <T>() => ({ results: stmt().all(...args) as T[] }),
      run: async () => stmt().run(...args),
    };
  };
  return {
    prepare: (sql) => prepare(sql),
    // D1's batch: one transaction (node:sqlite runs synchronously, so nothing interleaves)
    batch: async (stmts) => {
      db.exec("BEGIN");
      try {
        const out: unknown[] = [];
        for (const s of stmts) out.push(await s.run());
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
}

/** D1 refuses a compound SELECT of more than 5 terms (its SQLITE_MAX_COMPOUND_SELECT; node:sqlite allows 500). Counted
 *  over the whole statement — stricter than SQLite, which counts per compound — so what passes here passes on D1. */
export const D1_MAX_COMPOUND_TERMS = 5;

export function checkD1Limits(sql: string): void {
  const operators = sql.replace(/'(?:[^']|'')*'/g, "''").match(/\b(?:UNION|INTERSECT|EXCEPT)\b/gi)?.length ?? 0;
  if (operators + 1 > D1_MAX_COMPOUND_TERMS) throw new Error(`too many terms in compound SELECT: SQLITE_ERROR (D1 allows ${D1_MAX_COMPOUND_TERMS})`);
}
