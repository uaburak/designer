/**
 * The Worker's CPU per route (Cloudflare's free plan: 10 ms of CPU per request, error 1102 past it). Each common route
 * runs on the bench's organization (benchWorld.ts) with Governance+ off and on; the Worker's own time is the handler's
 * time minus node:sqlite's (D1 is wall time on Cloudflare, not CPU). The bounds are generous — Node in a test runner is
 * noisier than workerd — and catch what matters: a route that does work per row it shouldn't (O(n²)), or ten times
 * more than it did. `CPU_REPORT=1 npx vitest run server/src/testing/cpu.test.ts` prints the table.
 */
import { describe, expect, it } from "vitest";
import { benchBody, benchRoutes, benchWorld, type BenchWorld } from "./benchWorld";

/** The JS time (ms) a route may take at the median, warm; Cloudflare's budget is 10 ms and the target ≤ 4–5 */
const WARM_BOUND_MS = 4;
/** The D1 round trips a route may make (each costs the Worker CPU to send and decode; a prefetch batch is one) — was
 *  20–60 before requestD1.ts */
const QUERY_BOUND = 12;

interface Sample {
  name: string;
  status: number;
  jsMs: number;
  sqliteMs: number;
  queries: number;
}

async function measure(w: BenchWorld, route: ReturnType<typeof benchRoutes>[number], token: string, runs: number): Promise<Sample> {
  const js: number[] = [];
  const sql: number[] = [];
  let queries = 0;
  let status = 0;
  for (let i = 0; i < runs; i++) {
    // A new minute each time: per-minute caches (the session's touch, org activity) don't hide their work
    w.now.t += 61_000;
    w.meter.reset();
    const t = performance.now();
    const r = await w.call(route.method, route.path, token, benchBody(route.body), route.headers);
    const total = performance.now() - t;
    status = r.status;
    js.push(total - w.meter.ms);
    sql.push(w.meter.ms);
    queries = w.meter.queries;
  }
  const med = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1];
  return { name: route.name, status, jsMs: med(js), sqliteMs: med(sql), queries };
}

for (const governance of [false, true]) {
  describe(`CPU per route (Governance+ ${governance ? "on" : "off"})`, () => {
    it("every common route stays well under the free plan's 10 ms", { timeout: 120_000 }, async () => {
      const w = await benchWorld({ governance });
      const routes = benchRoutes(w);
      // Warm the JIT and the per-isolate caches like a live isolate
      for (const r of routes) for (let i = 0; i < 3; i++) await w.call(r.method, r.path, w.member.token, benchBody(r.body), r.headers);
      const samples: Sample[] = [];
      for (const r of routes) samples.push(await measure(w, r, w.member.token, 15));
      if (process.env.CPU_DUMP) {
        // The world for the cold-start bench on the built Worker (server/scripts/cpu-cold.mjs): the database and the routes
        const file = `${process.env.CPU_DUMP}/bench-${governance ? "gov" : "plain"}`;
        const { rmSync, writeFileSync } = await import("node:fs");
        rmSync(`${file}.sqlite`, { force: true });
        await w.deps.db.d1.prepare(`VACUUM INTO ?1`).bind(`${file}.sqlite`).run();
        writeFileSync(`${file}.json`, JSON.stringify({ now: w.now.t, token: w.member.token, routes }));
      }
      if (process.env.CPU_SQL) {
        // CPU_SQL=all (or a route's name): each route's D1 statements
        w.meter.log = true;
        for (const r of routes.filter((x) => x.name === process.env.CPU_SQL || process.env.CPU_SQL === "all")) {
          w.now.t += 61_000;
          w.meter.reset();
          const res = await w.call(r.method, r.path, w.member.token, benchBody(r.body), r.headers);
          console.log(`\n${r.name} → ${res.status} ${JSON.stringify(res.body).slice(0, 160)}\n  ` + w.meter.sql.join("\n  "));
        }
        w.meter.log = false;
      }
      if (process.env.CPU_REPORT) {
        console.log(`\nGovernance+ ${governance ? "on" : "off"}\n` + samples.map((s) => `${s.name.padEnd(40)} ${String(s.status).padEnd(4)} js ${s.jsMs.toFixed(2).padStart(6)} ms  sqlite ${s.sqliteMs.toFixed(2).padStart(6)} ms  queries ${s.queries}`).join("\n"));
      }
      for (const s of samples) {
        expect(s.status, s.name).toBeLessThan(400);
        expect(s.jsMs, `${s.name}: ${s.jsMs.toFixed(2)} ms of JS`).toBeLessThan(WARM_BOUND_MS);
        expect(s.queries, `${s.name}: ${s.queries} queries`).toBeLessThanOrEqual(QUERY_BOUND);
      }
    });
  });
}
