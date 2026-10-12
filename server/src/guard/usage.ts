/**
 * The account's month-to-date usage from Cloudflare's GraphQL Analytics API (docs/multiplayer.md §17.1), for the spend
 * guard. One query per dataset, so a dataset the API refuses leaves only its own metrics unknown:
 *
 * - `workersInvocationsAdaptive` sum {requests, cpuTimeUs} — Workers requests and CPU time, every script of the account
 *   (the bill is the account's)
 * - `durableObjectsInvocationsAdaptiveGroups` sum {requests} — Durable Objects requests. With WebSocket Hibernation
 *   (FileRoom, Inbox) incoming messages are counted here one by one but billed 20:1, so
 *   `durableObjectsPeriodicGroups.inboundWebsocketMsgCount` takes them back to their billed twentieth.
 * - `durableObjectsPeriodicGroups` sum {activeTime (µs), inboundWebsocketMsgCount, rowsRead, rowsWritten} — duration in
 *   GB-s at the objects' 128 MB, SQLite rows
 * - `durableObjectsStorageGroups` max {storedBytes} — the latest day's stored bytes
 * - `d1AnalyticsAdaptiveGroups` sum {rowsRead, rowsWritten}; `d1StorageAdaptiveGroups` max {databaseSizeBytes}, the
 *   latest day's, summed over the databases
 * - Workers Logs events, estimated: one invocation log per Worker and Durable Object request (console lines not seen)
 *
 * Secrets: `CF_API_TOKEN` (Account › Account Analytics › Read), var `CF_ACCOUNT_ID`.
 */
import { SPEND_METRICS, type SpendMetric } from "../../../src/shared/spendGuard";

export const GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql";

export interface GuardEnv {
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
}

/** Month-to-date amounts; a metric missing is unknown */
export type Usage = Partial<Record<SpendMetric, number>>;

export interface UsageResult {
  usage: Usage;
  /** The first failure, if any dataset failed ("Usage unknown" for its metrics) */
  error: string | null;
}

const ACCOUNT_ID = /^[0-9a-f]{32}$/;
/** Durable Objects are billed at 128 MB of memory: GB-s = active seconds × 0.125 (Cloudflare's own example) */
const DO_GB = 128 / 1024;

export const configured = (env: GuardEnv): boolean => !!env.CF_API_TOKEN && ACCOUNT_ID.test(env.CF_ACCOUNT_ID ?? "");

type Row = { sum?: Record<string, number | null>; max?: Record<string, number | null>; dimensions?: Record<string, string> };

/** The queries, by dataset; `{start}` / `{end}` / `{nowIso}` make the month-to-date filter (queryFor) */
const QUERIES = {
  workers: `workersInvocationsAdaptive(limit: 10000, filter: {datetime_geq: "{start}T00:00:00Z", datetime_leq: "{nowIso}"}) { sum { requests cpuTimeUs } }`,
  doInvocations: `durableObjectsInvocationsAdaptiveGroups(limit: 10000, filter: {date_geq: "{start}", date_leq: "{end}"}) { sum { requests } }`,
  doPeriodic: `durableObjectsPeriodicGroups(limit: 10000, filter: {date_geq: "{start}", date_leq: "{end}"}) { sum { activeTime inboundWebsocketMsgCount rowsRead rowsWritten } }`,
  doStorage: `durableObjectsStorageGroups(limit: 1, filter: {date_geq: "{start}", date_leq: "{end}"}, orderBy: [date_DESC]) { max { storedBytes } dimensions { date } }`,
  d1: `d1AnalyticsAdaptiveGroups(limit: 10000, filter: {date_geq: "{start}", date_leq: "{end}"}) { sum { rowsRead rowsWritten } }`,
  d1Storage: `d1StorageAdaptiveGroups(limit: 10000, filter: {date_geq: "{start}", date_leq: "{end}"}) { max { databaseSizeBytes } dimensions { date databaseId } }`,
} as const;
type Dataset = keyof typeof QUERIES;

/** The GraphQL document for one dataset this month (UTC) */
export function queryFor(dataset: Dataset, accountId: string, now: number): string {
  const iso = new Date(now).toISOString();
  const start = `${iso.slice(0, 7)}-01`;
  const field = QUERIES[dataset].replace("{start}", start).replace("{end}", iso.slice(0, 10)).replace("{nowIso}", `${iso.slice(0, 19)}Z`);
  return `query { viewer { accounts(filter: {accountTag: "${accountId}"}) { ${field} } } }`;
}

const sumOf = (rows: Row[], k: string) => rows.reduce((n, r) => n + (Number(r.sum?.[k]) || 0), 0);
const has = (rows: Row[], part: "sum" | "max", k: string) => rows.length === 0 || rows.some((r) => r[part]?.[k] !== undefined && r[part]?.[k] !== null);

/** One dataset's rows, or throws the API's error */
async function rowsOf(fetcher: typeof fetch, env: GuardEnv, dataset: Dataset, now: number): Promise<Row[]> {
  const res = await fetcher(GRAPHQL_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${env.CF_API_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ query: queryFor(dataset, env.CF_ACCOUNT_ID!, now) }),
  });
  if (!res.ok) throw new Error(`Cloudflare's analytics API said ${res.status}`);
  const body = (await res.json()) as { data?: { viewer?: { accounts?: Record<string, Row[] | undefined>[] } } | null; errors?: { message?: string }[] | null };
  if (body.errors && body.errors.length > 0) throw new Error(`Cloudflare's analytics API: ${body.errors[0]?.message ?? "error"}`);
  const name = QUERIES[dataset].slice(0, QUERIES[dataset].indexOf("("));
  const rows = body.data?.viewer?.accounts?.[0]?.[name];
  if (!Array.isArray(rows)) throw new Error(`Cloudflare's analytics API returned no ${name}`);
  return rows;
}

/** The latest day's values, summed over its rows (per database, per namespace) */
function latestDay(rows: Row[], k: string): number {
  if (rows.length === 0) return 0;
  const day = rows.reduce((d, r) => ((r.dimensions?.date ?? "") > d ? (r.dimensions?.date ?? "") : d), "");
  return rows.filter((r) => (r.dimensions?.date ?? "") === day).reduce((n, r) => n + (Number(r.max?.[k]) || 0), 0);
}

/** Month-to-date usage. Never throws: failures leave their metrics out and say why. */
export async function fetchUsage(fetcher: typeof fetch, env: GuardEnv, now: number): Promise<UsageResult> {
  if (!configured(env)) return { usage: {}, error: "CF_API_TOKEN or CF_ACCOUNT_ID isn't set" };
  const datasets = Object.keys(QUERIES) as Dataset[];
  const settled = await Promise.allSettled(datasets.map((d) => rowsOf(fetcher, env, d, now)));
  const got = {} as Partial<Record<Dataset, Row[]>>;
  let error: string | null = null;
  settled.forEach((s, i) => {
    if (s.status === "fulfilled") got[datasets[i]] = s.value;
    else error ??= s.reason instanceof Error ? s.reason.message : String(s.reason);
  });
  return { usage: toUsage(got), error };
}

/** The metrics from whichever datasets answered */
export function toUsage(got: Partial<Record<Dataset, Row[]>>): Usage {
  const u: Usage = {};
  const { workers, doInvocations, doPeriodic, doStorage, d1, d1Storage } = got;
  if (workers) {
    u.workers_requests = sumOf(workers, "requests");
    if (has(workers, "sum", "cpuTimeUs")) u.workers_cpu_ms = sumOf(workers, "cpuTimeUs") / 1000;
  }
  if (doInvocations) {
    const counted = sumOf(doInvocations, "requests");
    // Hibernated sockets' incoming messages: counted 1:1 there, billed 20:1. Without the periodic dataset, all of them
    // stay (more than billed: the guard errs on the safe side).
    const inbound = doPeriodic ? sumOf(doPeriodic, "inboundWebsocketMsgCount") : 0;
    u.do_requests = Math.max(0, counted - inbound) + Math.ceil(Math.min(inbound, counted) / 20);
  }
  if (doPeriodic) {
    u.do_duration_gbs = (sumOf(doPeriodic, "activeTime") / 1e6) * DO_GB;
    if (has(doPeriodic, "sum", "rowsRead")) u.do_rows_read = sumOf(doPeriodic, "rowsRead");
    if (has(doPeriodic, "sum", "rowsWritten")) u.do_rows_written = sumOf(doPeriodic, "rowsWritten");
  }
  if (doStorage) u.do_storage_bytes = latestDay(doStorage, "storedBytes");
  if (d1) {
    u.d1_rows_read = sumOf(d1, "rowsRead");
    u.d1_rows_written = sumOf(d1, "rowsWritten");
  }
  if (d1Storage) u.d1_storage_bytes = latestDay(d1Storage, "databaseSizeBytes");
  if (workers && doInvocations) u.log_events = sumOf(workers, "requests") + sumOf(doInvocations, "requests");
  // Only known metrics, in the shared order
  return Object.fromEntries(SPEND_METRICS.filter((m) => u[m] !== undefined && Number.isFinite(u[m])).map((m) => [m, u[m]!])) as Usage;
}
