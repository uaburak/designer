/**
 * The spend guard (docs/multiplayer.md §17.1) on a node:sqlite world with a fake GraphQL Analytics API: parsing,
 * threshold math, warnings once a month, the guard on and off, the monthly reset, the operator's bypass and overrides,
 * API failures (no enforcement), the per-isolate cache and the storage cap.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SPEND_INCLUDED, type SpendGuardStatus } from "../../../src/shared/spendGuard";
import { QUOTA_LIMITS } from "../../../src/shared/quota";
import { handle, type Deps } from "../api";
import { Db, type D1Like } from "../db";
import { sqliteD1 } from "../testing/sqliteD1";
import { checkSpend, material, resetCheckLog } from "./check";
import { decide, guardActive, metricsPast, readGuard, REFRESH_MS, resetGuardCache, type GuardState } from "./state";
import { serverStorageLimit } from "./storageCap";
import { fetchUsage, GRAPHQL_URL, queryFor, r2Class, toUsage } from "./usage";

const ORIGIN = "https://designer.example.workers.dev";
const OPERATOR = "design.burakkoc@gmail.com";
const ACCOUNT = "dd8b9e757657d35f82adff075509b048";

type Datasets = Record<string, unknown[] | { error: string }>;

let now: number;
let d1: D1Like;
let reads: number;
let deps: Deps;
let api: Datasets;
let graphqlCalls: string[];

/** The analytics API's answer: the dataset named in the query, or its error */
function fakeFetch(): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url !== GRAPHQL_URL) return new Response("no", { status: 404 });
    const { query } = JSON.parse(String(init?.body)) as { query: string };
    graphqlCalls.push(query);
    const name = /\{ (\w+)\(limit/.exec(query)![1];
    const got = api[name];
    if (!got) return Response.json({ data: null, errors: [{ message: `unknown field ${name}` }] });
    if (!Array.isArray(got)) return Response.json({ data: null, errors: [{ message: got.error }] });
    return Response.json({ data: { viewer: { accounts: [{ [name]: got }] } }, errors: null });
  }) as typeof fetch;
}

/** Usage at these fractions of what's included (others near zero) */
function usageAt(f: { workers?: number; d1Written?: number; doStorage?: number } = {}): Datasets {
  return {
    workersInvocationsAdaptive: [{ sum: { requests: (f.workers ?? 0.01) * SPEND_INCLUDED.workers_requests, cpuTimeUs: 1_000_000 } }],
    durableObjectsInvocationsAdaptiveGroups: [{ sum: { requests: 1000 } }],
    durableObjectsPeriodicGroups: [{ sum: { activeTime: 1e6, inboundWebsocketMsgCount: 0, rowsRead: 10, rowsWritten: 10 } }],
    durableObjectsStorageGroups: [{ max: { storedBytes: (f.doStorage ?? 0.01) * SPEND_INCLUDED.do_storage_bytes }, dimensions: { date: "2026-10-12" } }],
    d1AnalyticsAdaptiveGroups: [{ sum: { rowsRead: 100, rowsWritten: (f.d1Written ?? 0.01) * SPEND_INCLUDED.d1_rows_written } }],
    d1StorageAdaptiveGroups: [{ max: { databaseSizeBytes: 1e6 }, dimensions: { date: "2026-10-12", databaseId: "a" } }],
    r2StorageAdaptiveGroups: [{ max: { payloadSize: 1e6, metadataSize: 100 }, dimensions: { datetime: "2026-10-12T00:00:00Z", bucketName: "wecra-files" } }],
    r2OperationsAdaptiveGroups: [{ sum: { requests: 10 }, dimensions: { actionType: "PutObject" } }],
  };
}

beforeEach(() => {
  now = Date.UTC(2026, 9, 12, 12);
  resetGuardCache();
  resetCheckLog();
  graphqlCalls = [];
  api = usageAt();
  const raw = sqliteD1();
  reads = 0;
  d1 = {
    prepare: (sql) => {
      if (sql.includes("'spend_guard', 'spend_usage'")) reads++;
      return raw.prepare(sql);
    },
    batch: raw.batch?.bind(raw),
  };
  deps = {
    db: new Db(d1),
    env: { SESSION_SECRET: "s".repeat(40), DEV_AUTH: "1", CF_API_TOKEN: "t", CF_ACCOUNT_ID: ACCOUNT } as Deps["env"],
    rooms: { fetch: async () => new Response("{}", { status: 200 }) },
    now: () => now,
    fetch: fakeFetch(),
  };
});

const call = (method: string, path: string, token?: string, body?: unknown) =>
  handle(new Request(ORIGIN + path, { method, headers: token ? { authorization: `Bearer ${token}` } : {}, body: body === undefined ? undefined : JSON.stringify(body) }), deps);

async function dev(email: string): Promise<{ status: number; token: string; code?: string }> {
  const r = await call("POST", "/auth/dev", undefined, { email, name: email.split("@")[0] });
  const b = (await r.json()) as { token: string; code?: string; reason?: string };
  return { status: r.status, token: b.token, code: b.reason };
}

const warnings = async () => (await d1.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE kind = 'capacity_warning'`).first<{ n: number }>())!.n;
const status = async (token: string) => (await (await call("GET", "/operator/spend-guard", token)).json()) as SpendGuardStatus;
/** Past the per-isolate cache's minute */
const later = (ms = REFRESH_MS + 1) => (now += ms);

describe("usage from Cloudflare's GraphQL Analytics API", () => {
  it("asks for this month, account-wide, one dataset a query", async () => {
    const q = queryFor("workers", ACCOUNT, now);
    expect(q).toContain(`accountTag: "${ACCOUNT}"`);
    expect(q).toContain(`datetime_geq: "2026-10-01T00:00:00Z"`);
    expect(queryFor("d1", ACCOUNT, now)).toContain(`date_geq: "2026-10-01", date_leq: "2026-10-12"`);
    await fetchUsage(deps.fetch, deps.env, now);
    expect(graphqlCalls).toHaveLength(8);
    expect(queryFor("r2Storage", ACCOUNT, now)).toContain(`r2StorageAdaptiveGroups(limit: 10000, filter: {datetime_geq: "2026-10-01T00:00:00Z", datetime_leq: "2026-10-12T12:00:00Z"}`);
    expect(queryFor("r2Ops", ACCOUNT, now)).toContain(`r2OperationsAdaptiveGroups(`);
  });

  it("R2 (docs/cloud.md §3): each bucket's latest stored size summed; operations by class, deletes free", () => {
    const u = toUsage({
      r2Storage: [
        { max: { payloadSize: 5e9, metadataSize: 1e6 }, dimensions: { datetime: "2026-10-12T10:00:00Z", bucketName: "wecra-files" } },
        { max: { payloadSize: 4e9, metadataSize: 0 }, dimensions: { datetime: "2026-10-11T10:00:00Z", bucketName: "wecra-files" } },
        { max: { payloadSize: 2e9, metadataSize: 0 }, dimensions: { datetime: "2026-10-12T09:00:00Z", bucketName: "wecra-files-eu" } },
      ],
      r2Ops: [
        { sum: { requests: 700 }, dimensions: { actionType: "PutObject" } },
        { sum: { requests: 30 }, dimensions: { actionType: "UploadPart" } },
        { sum: { requests: 5 }, dimensions: { actionType: "ListObjects" } },
        { sum: { requests: 9000 }, dimensions: { actionType: "GetObject" } },
        { sum: { requests: 100 }, dimensions: { actionType: "HeadObject" } },
        { sum: { requests: 400 }, dimensions: { actionType: "DeleteObject" } },
        { sum: { requests: 2 }, dimensions: { actionType: "AbortMultipartUpload" } },
      ],
    });
    expect(u.r2_storage_bytes).toBe(7e9 + 1e6);
    expect(u.r2_class_a).toBe(735);
    expect(u.r2_class_b).toBe(9100);
    expect(r2Class("CompleteMultipartUpload")).toBe("a");
    expect(SPEND_INCLUDED.r2_storage_bytes).toBe(10e9);
    expect(SPEND_INCLUDED.r2_class_a).toBe(1_000_000);
    expect(SPEND_INCLUDED.r2_class_b).toBe(10_000_000);
  });

  it("parses each metric: CPU µs → ms, hibernated messages 20:1, active time → GB-s, the latest day's storage", () => {
    const u = toUsage({
      workers: [{ sum: { requests: 100, cpuTimeUs: 5000 } }, { sum: { requests: 50, cpuTimeUs: 1000 } }],
      doInvocations: [{ sum: { requests: 1000 } }],
      doPeriodic: [{ sum: { activeTime: 8e6, inboundWebsocketMsgCount: 800, rowsRead: 7, rowsWritten: 3 } }],
      doStorage: [{ max: { storedBytes: 5 }, dimensions: { date: "2026-10-11" } }, { max: { storedBytes: 9 }, dimensions: { date: "2026-10-12" } }],
      d1: [{ sum: { rowsRead: 11, rowsWritten: 4 } }],
      d1Storage: [
        { max: { databaseSizeBytes: 100 }, dimensions: { date: "2026-10-11", databaseId: "a" } },
        { max: { databaseSizeBytes: 200 }, dimensions: { date: "2026-10-12", databaseId: "a" } },
        { max: { databaseSizeBytes: 30 }, dimensions: { date: "2026-10-12", databaseId: "b" } },
      ],
    });
    expect(u).toEqual({
      workers_requests: 150,
      workers_cpu_ms: 6,
      do_requests: 200 + 40,
      do_duration_gbs: 1,
      do_rows_read: 7,
      do_rows_written: 3,
      do_storage_bytes: 9,
      d1_rows_read: 11,
      d1_rows_written: 4,
      d1_storage_bytes: 230,
      log_events: 1150,
    });
  });

  it("a failing dataset leaves only its metrics unknown; a missing token asks nothing", async () => {
    api.d1AnalyticsAdaptiveGroups = { error: "not authorized" };
    const r = await fetchUsage(deps.fetch, deps.env, now);
    expect(r.error).toContain("not authorized");
    expect(r.usage.d1_rows_written).toBeUndefined();
    expect(r.usage.workers_requests).toBeDefined();
    graphqlCalls = [];
    const none = await fetchUsage(deps.fetch, { CF_ACCOUNT_ID: ACCOUNT }, now);
    expect(none).toEqual({ usage: {}, error: expect.stringContaining("CF_API_TOKEN") });
    expect(graphqlCalls).toHaveLength(0);
  });
});

describe("threshold math", () => {
  const state = (usage: GuardState["snapshot"] extends infer S ? NonNullable<S>["usage"] : never, month = "2026-10"): GuardState => ({
    settings: { mode: "auto", modeMonth: null, warnPercent: 80, guardPercent: 95 },
    snapshot: { month, checkedAt: now, writtenAt: now, usage, error: null, warned: [], guardNotified: false },
  });
  it("warns at 80%, guards at 95%, last month's usage doesn't count", () => {
    expect(metricsPast({ workers_requests: 7_999_999 }, 80)).toEqual([]);
    expect(metricsPast({ workers_requests: 8_000_000, do_requests: 950_000 }, 80)).toEqual(["workers_requests", "do_requests"]);
    expect(decide(state({ do_requests: 949_999 }), now).active).toBe(false);
    expect(decide(state({ do_requests: 950_000 }), now)).toEqual({ active: true, reason: "usage" });
    expect(decide(state({ do_requests: 950_000 }, "2026-09"), now).active).toBe(false);
    expect(decide(state({}), now).active).toBe(false);
  });
});

describe("the five-minute check", () => {
  it("warns each metric once a month, in the operator's bell", async () => {
    const op = await dev(OPERATOR);
    api = usageAt({ workers: 0.85, d1Written: 0.82 });
    await checkSpend(deps);
    expect(await warnings()).toBe(2);
    const n = await d1.prepare(`SELECT text, user_id FROM notifications WHERE kind = 'capacity_warning' ORDER BY text`).all<{ text: string }>();
    expect(n.results[1].text).toContain("Workers requests: 8.5M of 10M included this month (85%)");
    expect(await guardActive(deps)).toBe(false);
    await checkSpend(deps);
    api = usageAt({ workers: 0.9, d1Written: 0.82 });
    await checkSpend(deps);
    expect(await warnings()).toBe(2);
    // November: the month starts again
    now = Date.UTC(2026, 10, 1, 0, 5);
    await checkSpend(deps);
    expect(await warnings()).toBe(4);
    expect((await status(op.token)).month).toBe("2026-11");
  });

  it("at 95% only operators are served; the 1st lifts it", async () => {
    const op = await dev(OPERATOR);
    const alice = await dev("alice@example.com");
    api = usageAt({ doStorage: 0.96 });
    await checkSpend(deps);
    // Told once: the warning and the guard
    expect(await warnings()).toBe(2);
    const refused = await call("GET", "/files", alice.token);
    expect(refused.status).toBe(503);
    expect(await refused.json()).toMatchObject({ code: "capacity_reached", error: "Wecra has reached its capacity for this month. Try again on the 1st." });
    expect((await call("GET", "/files", op.token)).status).toBe(200);
    expect((await call("GET", "/me/usage", alice.token)).status).toBe(503);
    // Public previews, links, embeds: off
    for (const p of ["/p/abcdefghij", "/f/abcdefgh", "/embed/abcdefgh", "/previews/abcdefghij/manifest.json"]) expect((await call("GET", p)).status, p).toBe(503);
    // Sign-up closed (the operator still signs in)
    expect(await dev("new@example.com")).toMatchObject({ status: 403, code: "signup_closed" });
    expect((await dev(OPERATOR)).status).toBe(200);
    const s = await status(op.token);
    expect(s).toMatchObject({ active: true, reason: "usage" });
    expect(s.usage.find((u) => u.metric === "do_storage_bytes")!.percent).toBeCloseTo(96);
    await checkSpend(deps);
    expect(await warnings()).toBe(2);
    // Midnight UTC on the 1st: no check needed
    now = Date.UTC(2026, 10, 1, 0, 0, 1);
    expect((await call("GET", "/files", alice.token)).status).toBe(200);
  });

  it("the API failing (or no token) is usage unknown: nothing enforced, logged once", async () => {
    const op = await dev(OPERATOR);
    const alice = await dev("alice@example.com");
    api = usageAt({ workers: 0.99 });
    await checkSpend(deps);
    expect((await call("GET", "/files", alice.token)).status).toBe(503);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    deps.fetch = (async () => new Response("down", { status: 500 })) as typeof fetch;
    later();
    await checkSpend(deps);
    await checkSpend(deps);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("usage unknown"))).toHaveLength(1);
    warn.mockRestore();
    expect((await call("GET", "/files", alice.token)).status).toBe(200);
    const s = await status(op.token);
    expect(s.active).toBe(false);
    expect(s.usage.every((u) => u.used === null)).toBe(true);
    expect(s.error).toContain("500");
    deps.env = { ...deps.env, CF_API_TOKEN: undefined } as Deps["env"];
    expect((await status(op.token)).configured).toBe(false);
  });

  it("writes only on material changes (or hourly)", async () => {
    await checkSpend(deps);
    const at = async () => (await d1.prepare(`SELECT updated_at FROM server_settings WHERE k = 'spend_usage'`).first<{ updated_at: number }>())!.updated_at;
    const first = await at();
    later(5 * 60_000);
    await checkSpend(deps);
    expect(await at()).toBe(first);
    api = usageAt({ workers: 0.02 });
    later(5 * 60_000);
    await checkSpend(deps);
    expect(await at()).toBe(now);
    const second = now;
    later(3_600_000);
    await checkSpend(deps);
    expect(await at()).toBeGreaterThan(second);
    const s = (await readGuard(d1)).snapshot!;
    expect(material({ settings: (await readGuard(d1)).settings, snapshot: s }, { settings: (await readGuard(d1)).settings, snapshot: { ...s, usage: { ...s.usage, workers_requests: s.usage.workers_requests! + 10 } } }, now)).toBe(false);
  });
});

describe("the operator", () => {
  it("forces operator-only or normal for the month, or turns enforcement off; nobody else may", async () => {
    const op = await dev(OPERATOR);
    const alice = await dev("alice@example.com");
    expect((await call("GET", "/operator/spend-guard", alice.token)).status).toBe(403);
    expect((await call("PATCH", "/operator/spend-guard", op.token, { mode: "operator_only" })).status).toBe(200);
    later();
    expect((await call("GET", "/files", alice.token)).status).toBe(503);
    expect((await status(op.token)).reason).toBe("forced");
    // A forced mode lasts the month
    now = Date.UTC(2026, 10, 1, 1);
    expect((await call("GET", "/files", alice.token)).status).toBe(200);
    expect((await status(op.token)).mode).toBe("auto");
    api = usageAt({ workers: 0.99 });
    await checkSpend(deps);
    expect((await call("GET", "/files", alice.token)).status).toBe(503);
    await call("PATCH", "/operator/spend-guard", op.token, { mode: "normal" });
    later();
    expect((await call("GET", "/files", alice.token)).status).toBe(200);
    await call("PATCH", "/operator/spend-guard", op.token, { mode: "auto" });
    later();
    expect((await call("GET", "/files", alice.token)).status).toBe(503);
    await call("PATCH", "/operator/spend-guard", op.token, { mode: "off" });
    later();
    await checkSpend(deps);
    expect((await call("GET", "/files", alice.token)).status).toBe(200);
  });

  it("adjusts the thresholds", async () => {
    const op = await dev(OPERATOR);
    const alice = await dev("alice@example.com");
    api = usageAt({ workers: 0.6 });
    await checkSpend(deps);
    expect((await call("PATCH", "/operator/spend-guard", op.token, { warnPercent: 90, guardPercent: 50 })).status).toBe(400);
    expect((await call("PATCH", "/operator/spend-guard", op.token, { guardPercent: 101 })).status).toBe(400);
    const r = (await (await call("PATCH", "/operator/spend-guard", op.token, { warnPercent: 40, guardPercent: 55 })).json()) as SpendGuardStatus;
    expect(r).toMatchObject({ warnPercent: 40, guardPercent: 55, active: true });
    later();
    expect((await call("GET", "/files", alice.token)).status).toBe(503);
  });

  it("sets the server's storage cap (none by default since R2, docs/cloud.md §3)", async () => {
    const op = await dev(OPERATOR);
    expect(await serverStorageLimit(d1)).toBe(Infinity);
    expect((await status(op.token)).serverStorageBytes).toBe(QUOTA_LIMITS.server_storage_bytes);
    expect((await call("PATCH", "/operator/spend-guard", op.token, { serverStorageBytes: 12 })).status).toBe(400);
    const s = (await (await call("PATCH", "/operator/spend-guard", op.token, { serverStorageBytes: 500 * 1024 * 1024 })).json()) as SpendGuardStatus;
    expect(s).toMatchObject({ serverStorageBytes: 500 * 1024 * 1024, serverStorageCustom: true });
    expect(await serverStorageLimit(d1)).toBe(500 * 1024 * 1024);
    await call("PATCH", "/operator/spend-guard", op.token, { serverStorageBytes: null });
    expect(await serverStorageLimit(d1)).toBe(Infinity);
  });
});

describe("the per-isolate cache", () => {
  it("reads D1 at most once a minute, whatever the traffic", async () => {
    const alice = await dev("alice@example.com");
    resetGuardCache();
    reads = 0;
    for (let i = 0; i < 20; i++) expect((await call("GET", "/files", alice.token)).status).toBe(200);
    expect(reads).toBe(1);
    // Another isolate (the cron) engages the guard: seen here within the minute
    api = usageAt({ workers: 0.99 });
    await checkSpend(deps);
    // … as this isolate still remembers it from before
    resetGuardCache({ settings: (await readGuard(d1)).settings, snapshot: null }, now);
    reads = 0;
    expect((await call("GET", "/files", alice.token)).status).toBe(200);
    expect(reads).toBe(0);
    later();
    expect((await call("GET", "/files", alice.token)).status).toBe(503);
    expect(reads).toBe(1);
  });

  it("concurrent requests share one read; a failed read is no guard", async () => {
    reads = 0;
    await Promise.all(Array.from({ length: 10 }, () => guardActive(deps)));
    expect(reads).toBe(1);
    resetGuardCache();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = { ...deps, db: new Db({ prepare: () => ({ bind: () => { throw new Error("x"); }, first: async () => null, all: async () => { throw new Error("d1 down"); }, run: async () => ({}) }) } as unknown as D1Like) };
    expect(await guardActive(broken)).toBe(false);
    err.mockRestore();
  });
});
