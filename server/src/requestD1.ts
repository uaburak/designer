/**
 * D1 for one request, with prefetching (docs/multiplayer.md §17, "CPU per request"). Every D1 call is a round trip the
 * Worker pays for in CPU (the binding encodes the query, sends it, decodes the rows) — on the free plan's 10 ms a route
 * of twenty sequential reads didn't fit. A route that knows which reads its code will make sends them first as one
 * `batch` (one round trip): `prefetch([{sql, args}…])`. The code then runs unchanged: a read whose SQL and arguments
 * match a prefetched one takes those rows (each such read, until a write); any other read goes to D1 as before. A write
 * (run, a batch, or a statement that changes rows) drops everything prefetched, so nothing read after a write is older
 * than the write.
 *
 * The statements a route prefetches come from the same builders its code reads with (org/db.ts `Q`), so the SQL text
 * is the same by construction. Without a `batch` (narrow stand-ins in tests) prefetching does nothing.
 */
import type { D1Like, D1Stmt } from "./db";

/** A statement and its arguments */
export interface Query {
  sql: string;
  args: unknown[];
}

const WRITE = /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i;
const keyOf = (sql: string, args: unknown[]) => `${sql}\u0000${JSON.stringify(args)}`;
const BASE = Symbol("base statement");

export class RequestD1 implements D1Like {
  private ready = new Map<string, unknown[]>();
  /** Statements prefetched and read (tests and the CPU bench look) */
  hits = 0;

  constructor(
    readonly base: D1Like,
    /** The request's time (ms): reads bound to "now" use it, so a prefetched read and the code's read are the same */
    readonly at: number = Date.now(),
  ) {}

  prepare(sql: string): D1Stmt {
    return this.stmt(sql, []);
  }

  private stmt(sql: string, args: unknown[]): D1Stmt {
    const take = (): unknown[] | null => {
      if (WRITE.test(sql)) {
        this.ready.clear();
        return null;
      }
      const rows = this.ready.get(keyOf(sql, args));
      if (!rows) return null;
      this.hits++;
      // Copies: a caller may change the rows it got
      return rows.map((r) => (r && typeof r === "object" ? { ...r } : r));
    };
    const inner = () => this.base.prepare(sql).bind(...args);
    return {
      bind: (...values: unknown[]) => this.stmt(sql, values),
      first: async <T>() => {
        const rows = take();
        return rows ? ((rows[0] as T | undefined) ?? null) : inner().first<T>();
      },
      all: async <T>() => {
        const rows = take();
        return rows ? { results: rows as T[] } : inner().all<T>();
      },
      run: async () => {
        this.ready.clear();
        return inner().run();
      },
      // The base statement, for batch()
      [BASE]: inner,
    } as D1Stmt;
  }

  batch = async (stmts: D1Stmt[]): Promise<unknown[]> => {
    this.ready.clear();
    const list = stmts.map((s) => ((s as unknown as Record<symbol, () => D1Stmt>)[BASE]?.() ?? s));
    if (this.base.batch) return this.base.batch(list);
    const out: unknown[] = [];
    for (const s of list) out.push(await s.run());
    return out;
  };

  /** Runs these reads now, in one round trip; the code's identical reads then take their rows */
  async prefetch(all: Query[]): Promise<void> {
    // Reads prefetched already (and not dropped by a write since) aren't sent again: a route that prefetches a page's
    // reads together (org/pages.ts) makes the helpers' own prefetches free
    const seen = new Set<string>();
    const queries = all.filter((q) => {
      const k = keyOf(q.sql, q.args);
      if (this.ready.has(k) || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    if (!queries.length || !this.base.batch) return;
    const results = (await this.base.batch(queries.map((q) => this.base.prepare(q.sql).bind(...q.args)))) as { results?: unknown[] }[];
    queries.forEach((q, i) => this.ready.set(keyOf(q.sql, q.args), results[i]?.results ?? []));
  }
}

/** `d1`'s prefetch when it is a request's (no-op otherwise) */
export function prefetch(d1: D1Like, queries: (Query | null | undefined | false | "")[]): Promise<void> {
  return d1 instanceof RequestD1 ? d1.prefetch(queries.filter((q): q is Query => !!q)) : Promise.resolve();
}

/** The request's time for reads bound to "now" (`RequestD1.at`), else `now()` */
export const requestTime = (d1: D1Like, now: () => number): number => (d1 instanceof RequestD1 ? d1.at : now());

/** The binding under a request's D1 — what per-isolate caches key on (governance/network.ts, discovery/record.ts) */
export const rootD1 = (d1: D1Like): D1Like => (d1 instanceof RequestD1 ? d1.base : d1);
