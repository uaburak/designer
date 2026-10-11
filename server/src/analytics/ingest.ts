/**
 * Library analytics, ingestion (docs/data.md §17.5): the store's pre-aggregated insert / detach counts and each file's
 * instance snapshot. No person is stored (§17.7): library, asset, file, team, workspace, day, counts.
 *
 *   POST /analytics/library-events {events: WireUsageEvent[]}   → {accepted, dropped}
 *   PUT  /files/:key/library-usage FileUsageSnapshot            → 204
 *
 * Kept: org files the caller can edit, in a folder (not drafts), not branches, not in the trash; libraries that are
 * org libraries of the file's org; days in [today − 7, today] (UTC); counts 1…10,000. Rate: 60 calls an hour per
 * person over both routes (429 `rate_limited`) — counted per Worker isolate (ours: the migration has no table for it,
 * and a few friends don't need a global count).
 */
import type { AnalyticsAssetType, FileUsageSnapshot, UsageAction, WireUsageEvent } from "../../../src/shared/libraries/orgTypes";
import { isSha1 } from "../../../src/shared/store/types";
import type { D1Like } from "../db";
import { body, HttpError, json, noContent, type Ctx } from "../org/http";

const DAY_MS = 86_400_000;
/** Events per call (the store sends chunks of 500) */
const MAX_EVENTS = 1000;
/** Distinct files per call checked with resolveAccess; rows of more are dropped */
const MAX_FILES = 20;
const MAX_USAGE_ROWS = 50_000;
const ROWS_PER_STATEMENT = 2000;
export const CALLS_PER_HOUR = 60;

const TYPES: AnalyticsAssetType[] = ["component", "style", "variable"];
const ACTIONS: UsageAction[] = ["insert", "detach"];

export const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const calls = new Map<string, { hour: number; n: number }>();
export function rateLimit(userId: string, now: number): void {
  const hour = Math.floor(now / 3_600_000);
  const c = calls.get(userId);
  if (!c || c.hour !== hour) calls.set(userId, { hour, n: 1 });
  else if (++c.n > CALLS_PER_HOUR) throw new HttpError(429, "too many analytics calls; try again later", "rate_limited");
  if (calls.size > 10_000) for (const [k, v] of calls) if (v.hour !== hour) calls.delete(k);
}

interface FilePlace {
  key: string;
  org_id: string;
  team_id: string | null;
  workspace_id: string | null;
}

/** The files of `keys` that report (§17.2), with the place they report from; editable by the caller */
async function reportingFiles(ctx: Ctx, keys: string[]): Promise<Map<string, FilePlace>> {
  const { results } = await ctx.acc.d1
    .prepare(
      `SELECT f.key, f.org_id, f.team_id, t.workspace_id FROM files f LEFT JOIN teams t ON t.id = f.team_id
       WHERE f.key IN (SELECT value FROM json_each(?1)) AND f.org_id IS NOT NULL AND f.project_id IS NOT NULL AND f.trashed_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM branches b WHERE b.key = f.key)`,
    )
    .bind(JSON.stringify(keys))
    .all<FilePlace>();
  const out = new Map<string, FilePlace>();
  for (const r of results) {
    const f = await ctx.acc.fileRow(r.key);
    const a = f ? await ctx.acc.file(f, { viaLink: true, passOk: false }) : null;
    if (a?.ok && a.canEdit && !a.trashed) out.set(r.key, r);
  }
  return out;
}

/** Org libraries (not deleted) of `keys`, with their org */
async function libraryOrgs(d1: D1Like, keys: string[]): Promise<Map<string, string>> {
  if (!keys.length) return new Map();
  const { results } = await d1.prepare(`SELECT key, org_id FROM libraries WHERE key IN (SELECT value FROM json_each(?1)) AND status != 'deleted'`).bind(JSON.stringify(keys)).all<{ key: string; org_id: string }>();
  return new Map(results.map((r) => [r.key, r.org_id]));
}

/** POST /analytics/library-events */
export async function analyticsRoute(ctx: Ctx): Promise<Response> {
  const { parts, m, req, deps, user } = ctx;
  if (parts.length !== 2 || parts[1] !== "library-events" || m !== "POST") throw new HttpError(404, "not found");
  rateLimit(user.id, deps.now());
  const b = await body<{ events?: unknown }>(req);
  if (!Array.isArray(b.events) || b.events.length > MAX_EVENTS) throw new HttpError(400, `events is a list of at most ${MAX_EVENTS}`);
  const events = b.events as Partial<WireUsageEvent>[];
  const today = utcDay(deps.now());
  const oldest = utcDay(deps.now() - 7 * DAY_MS);
  const wellFormed = events.filter(
    (e) =>
      e &&
      typeof e.file === "string" &&
      typeof e.library === "string" &&
      isSha1(e.asset) &&
      TYPES.includes(e.type as AnalyticsAssetType) &&
      ACTIONS.includes(e.action as UsageAction) &&
      typeof e.day === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(e.day) &&
      e.day >= oldest &&
      e.day <= today &&
      Number.isInteger(e.count) &&
      e.count! >= 1 &&
      e.count! <= 10_000,
  ) as WireUsageEvent[];
  const fileKeys = [...new Set(wellFormed.map((e) => e.file))].slice(0, MAX_FILES);
  const files = fileKeys.length ? await reportingFiles(ctx, fileKeys) : new Map<string, FilePlace>();
  const libs = await libraryOrgs(deps.db.d1, [...new Set(wellFormed.map((e) => e.library))]);
  const rows = wellFormed
    .filter((e) => {
      const f = files.get(e.file);
      return !!f && libs.get(e.library) === f.org_id && e.library !== e.file;
    })
    .map((e) => ({ day: e.day, library: e.library, asset: e.asset, type: e.type, file: e.file, team: files.get(e.file)!.team_id, workspace: files.get(e.file)!.workspace_id, action: e.action, count: e.count }));
  for (let i = 0; i < rows.length; i += ROWS_PER_STATEMENT) {
    await deps.db.d1
      .prepare(
        `INSERT INTO library_actions_daily (day, library_key, asset_key, asset_type, file_key, team_id, workspace_id, action, count)
         SELECT e.value ->> 'day', e.value ->> 'library', e.value ->> 'asset', e.value ->> 'type', e.value ->> 'file',
                e.value ->> 'team', e.value ->> 'workspace', e.value ->> 'action', e.value ->> 'count'
         FROM json_each(?1) AS e WHERE true
         ON CONFLICT (library_key, day, asset_key, file_key, action) DO UPDATE SET count = count + excluded.count`,
      )
      .bind(JSON.stringify(rows.slice(i, i + ROWS_PER_STATEMENT)))
      .run();
  }
  return json({ accepted: rows.length, dropped: events.length - rows.length });
}

/** PUT /files/:key/library-usage: the file's current instances of org-library assets (§17.4), replaced whole */
export async function fileUsageRoute(ctx: Ctx): Promise<Response> {
  const { parts, m, req, deps, user } = ctx;
  if (parts.length !== 3 || m !== "PUT") throw new HttpError(405, "method not allowed");
  const key = parts[1];
  rateLimit(user.id, deps.now());
  const file = (await reportingFiles(ctx, [key])).get(key);
  if (!file) {
    // Not reporting (a draft, a branch, outside an org) or not editable: what the caller can't even open is 404.
    const f = await ctx.acc.fileRow(key);
    const a = f ? await ctx.acc.file(f, { viaLink: true, passOk: false }) : null;
    if (!a?.ok) throw new HttpError(404, "no such file");
    throw new HttpError(403, a.canEdit ? "this file doesn't report library usage" : "you can only view this file");
  }
  const s = await body<Partial<FileUsageSnapshot>>(req);
  if (typeof s.hash !== "string" || s.hash.length > 64 || !Array.isArray(s.assets) || !Array.isArray(s.modes)) throw new HttpError(400, "a snapshot is {hash, assets, modes}");
  if (s.assets.length + s.modes.length > MAX_USAGE_ROWS) throw new HttpError(400, "too many rows");
  const d1 = deps.db.d1;
  const had = await d1.prepare(`SELECT hash FROM library_usage_files WHERE file_key = ?1`).bind(key).first<{ hash: string }>();
  if (had?.hash === s.hash) return noContent();
  const libs = await libraryOrgs(d1, [...new Set([...s.assets.map((a) => a?.library), ...s.modes.map((x) => x?.library)].filter((x): x is string => typeof x === "string"))]);
  const sum = new Map<string, { library: string; asset: string; type: string; instances: number }>();
  const add = (library: unknown, asset: string, type: string, n: unknown) => {
    if (typeof library !== "string" || libs.get(library) !== file.org_id || library === key || !Number.isInteger(n) || (n as number) < 1) return;
    const k = `${library}\u0000${asset}`;
    const r = sum.get(k);
    if (r) r.instances += n as number;
    else sum.set(k, { library, asset, type, instances: n as number });
  };
  for (const a of s.assets) if (a && isSha1(a.asset) && TYPES.includes(a.type)) add(a.library, a.asset, a.type, a.instances);
  for (const x of s.modes) if (x && typeof x.collection === "string" && typeof x.mode === "string" && x.collection.length <= 64 && x.mode.length <= 64) add(x.library, `${x.collection}/${x.mode}`, "mode", x.instances);
  const rows = [...sum.values()];
  await d1.prepare(`DELETE FROM library_usage WHERE file_key = ?1`).bind(key).run();
  for (let i = 0; i < rows.length; i += ROWS_PER_STATEMENT) {
    await d1
      .prepare(
        `INSERT INTO library_usage (file_key, library_key, asset_key, asset_type, instances)
         SELECT ?1, e.value ->> 'library', e.value ->> 'asset', e.value ->> 'type', e.value ->> 'instances' FROM json_each(?2) AS e`,
      )
      .bind(key, JSON.stringify(rows.slice(i, i + ROWS_PER_STATEMENT)))
      .run();
  }
  await d1
    .prepare(`INSERT INTO library_usage_files (file_key, hash, reported_at) VALUES (?1, ?2, ?3) ON CONFLICT (file_key) DO UPDATE SET hash = ?2, reported_at = ?3`)
    .bind(key, s.hash, deps.now())
    .run();
  return noContent();
}
