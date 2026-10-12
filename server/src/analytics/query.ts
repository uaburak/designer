/**
 * Library analytics, the views' routes (docs/data.md §17.6). Who: org members (not guests) who can view the library's
 * file (§17.1). Tables and totals come from the daily roll-up (rollup.ts); graphs read `library_actions_daily` up to
 * its `through_day`, so numbers change once a day, as Figma's.
 *
 *   GET /orgs/:org/libraries/analytics?workspace=&text=                      OrgLibrariesAnalytics
 *   GET /libraries/:key/analytics/overview                                   LibraryOverview
 *   GET /libraries/:key/analytics/actions?type=&range=&compare=<key>         LibraryActions
 *   GET /libraries/:key/analytics/usage/:assetKey                            AssetUsage
 *   GET /libraries/:key/analytics/modes?collection=                          {modes: ModeUsageRow[]}
 *   GET /libraries/:key/analytics/csv?type=&range=                           text/csv, Figma's REST column names
 *
 * Files and teams are named only when the team is open to the org or the caller is in it: otherwise "File not
 * visible" / "Team not visible" (ours), their counts kept.
 */
import type {
  AnalyticsAssetType,
  AnalyticsRange,
  AssetStatsRow,
  AssetUsage,
  FileUsageRow,
  LibraryActions,
  LibraryOverview,
  ModeUsageRow,
  OrgLibrariesAnalytics,
  TeamActionsRow,
  WeeklyActions,
} from "../../../src/shared/libraries/orgTypes";
import { isSha1 } from "../../../src/shared/store/types";
import type { D1Like } from "../db";
import { csv, HttpError, json, type Ctx } from "../org/http";
import { canUseLibrary, reachOf, usable, type Reach } from "../libraries/access";
import { countsOf, libName, libraryRow, orgLibraryRows, type LibRow } from "../libraries/db";
import { addDays, weekOf } from "./rollup";

const TYPES: AnalyticsAssetType[] = ["component", "style", "variable"];
const RANGES: AnalyticsRange[] = [30, 60, 90, 365];
const KINDS: Record<AnalyticsAssetType, string[]> = { component: ["COMPONENT", "COMPONENT_SET"], style: ["STYLE"], variable: ["VARIABLE"] };
const LIVE_FILE = `f.project_id IS NOT NULL AND f.trashed_at IS NULL AND NOT EXISTS (SELECT 1 FROM branches b WHERE b.key = f.key)`;

/** The library, if the caller is a member (not a guest) who can view its file */
async function analyticsAccess(ctx: Ctx, key: string): Promise<{ lib: LibRow; reach: Reach }> {
  const { acc } = ctx;
  const lib = await libraryRow(acc.d1, key);
  if (!lib || lib.status === "deleted") throw new HttpError(404, "no such library");
  const m = await acc.membership(lib.org_id);
  const f = await acc.fileRow(key);
  const a = f ? await acc.openFile(f, { viaLink: true, passOk: false }) : null;
  if (!m || !a?.ok) throw new HttpError(404, "no such library");
  if (m.role === "guest") throw new HttpError(403, "guests can't see library analytics");
  return { lib, reach: await reachOf(acc, lib.org_id) };
}

async function throughDayOf(d1: D1Like, key: string | null): Promise<string> {
  const r = key
    ? await d1.prepare(`SELECT through_day AS d FROM library_stats WHERE library_key = ?1`).bind(key).first<{ d: string | null }>()
    : await d1.prepare(`SELECT MAX(through_day) AS d FROM library_stats`).first<{ d: string | null }>();
  return r?.d ?? "";
}

interface AssetRow {
  key: string;
  kind: string;
  name: string;
  description: string;
  style_type: string | null;
  resolved_type: string | null;
  component_set_key: string | null;
  collection_key: string | null;
  removed_in: number | null;
  instances: number | null;
  files_using: number | null;
  teams_using: number | null;
  inserts_30d: number | null;
  detaches_30d: number | null;
  variants: number;
  set_name: string | null;
  collection_name: string | null;
}

async function assetRows(d1: D1Like, key: string, type: AnalyticsAssetType | null): Promise<AssetRow[]> {
  const kinds = type ? KINDS[type] : [...KINDS.component, ...KINDS.style, ...KINDS.variable];
  const { results } = await d1
    .prepare(
      `SELECT la.key, la.kind, la.name, la.description, la.style_type, la.resolved_type, la.component_set_key, la.collection_key, la.removed_in,
              s.instances, s.files_using, s.teams_using, s.inserts_30d, s.detaches_30d,
              (SELECT COUNT(*) FROM library_assets v WHERE v.library_key = la.library_key AND v.component_set_key = la.key AND v.removed_in IS NULL) AS variants,
              cs.name AS set_name, cc.name AS collection_name
       FROM library_assets la
       LEFT JOIN library_asset_stats s ON s.library_key = la.library_key AND s.asset_key = la.key
       LEFT JOIN library_assets cs ON cs.library_key = la.library_key AND cs.key = la.component_set_key
       LEFT JOIN library_assets cc ON cc.library_key = la.library_key AND cc.key = la.collection_key
       WHERE la.library_key = ?1 AND la.dependency_only = 0 AND la.kind IN (SELECT value FROM json_each(?2))
       ORDER BY la.name COLLATE NOCASE`,
    )
    .bind(key, JSON.stringify(kinds))
    .all<AssetRow>();
  // Removed assets stay while copies of them are still used (their last known name, §17.3).
  return results.filter((r) => r.removed_in === null || (r.instances ?? 0) > 0 || (r.inserts_30d ?? 0) > 0 || (r.detaches_30d ?? 0) > 0);
}

const typeOf = (kind: string): AnalyticsAssetType => (kind === "STYLE" ? "style" : kind === "VARIABLE" ? "variable" : "component");

function toStats(r: AssetRow, sums?: Map<string, { ins: number; det: number }>): AssetStatsRow {
  const t = typeOf(r.kind);
  const s = sums?.get(r.key);
  return {
    key: r.key,
    name: r.name,
    type: t,
    description: r.description,
    ...(r.component_set_key ? { componentSetKey: r.component_set_key, componentSetName: r.set_name ?? "" } : {}),
    ...(r.kind === "COMPONENT_SET" ? { variants: r.variants } : {}),
    ...(r.style_type ? { styleType: r.style_type } : {}),
    ...(t === "variable" ? { variableType: r.resolved_type ?? undefined, collectionKey: r.collection_key ?? undefined, collectionName: r.collection_name ?? undefined } : {}),
    instances: r.instances ?? 0,
    insertions: s ? s.ins : (r.inserts_30d ?? 0),
    detachments: s ? s.det : (r.detaches_30d ?? 0),
    teamsUsing: r.teams_using ?? 0,
    filesUsing: r.files_using ?? 0,
  };
}

/** The listed rows of the views: component sets and components outside sets, styles, variables (§17.1) */
const listed = (rows: AssetRow[]) => rows.filter((r) => !(r.kind === "COMPONENT" && r.component_set_key));

/** Insertions and detachments per asset over [from, to]; variants also count for their set */
async function sumsOver(d1: D1Like, key: string, type: AnalyticsAssetType, from: string, to: string, rows: AssetRow[]): Promise<Map<string, { ins: number; det: number }>> {
  const { results } = await d1
    .prepare(`SELECT asset_key, action, SUM(count) AS n FROM library_actions_daily WHERE library_key = ?1 AND asset_type = ?2 AND day BETWEEN ?3 AND ?4 GROUP BY asset_key, action`)
    .bind(key, type, from, to)
    .all<{ asset_key: string; action: string; n: number }>();
  const setOf = new Map(rows.filter((r) => r.component_set_key).map((r) => [r.key, r.component_set_key!]));
  const out = new Map<string, { ins: number; det: number }>();
  const add = (k: string, action: string, n: number) => {
    const s = out.get(k) ?? { ins: 0, det: 0 };
    if (action === "insert") s.ins += n;
    else s.det += n;
    out.set(k, s);
  };
  for (const r of results) {
    add(r.asset_key, r.action, r.n);
    const set = setOf.get(r.asset_key);
    if (set) add(set, r.action, r.n);
  }
  return out;
}

async function weekly(d1: D1Like, key: string, type: AnalyticsAssetType, from: string, to: string): Promise<WeeklyActions[]> {
  const { results } = await d1
    .prepare(`SELECT day, action, SUM(count) AS n FROM library_actions_daily WHERE library_key = ?1 AND asset_type = ?2 AND day BETWEEN ?3 AND ?4 GROUP BY day, action`)
    .bind(key, type, from, to)
    .all<{ day: string; action: string; n: number }>();
  const weeks = new Map<string, WeeklyActions>();
  // Weeks with no data appear as zero (the graph needs them), up to the week of `to`.
  for (let w = weekOf(from); w <= weekOf(to); w = addDays(w, 7)) weeks.set(w, { week: w, insertions: 0, detachments: 0 });
  for (const r of results) {
    const w = weeks.get(weekOf(r.day));
    if (!w) continue;
    if (r.action === "insert") w.insertions += r.n;
    else w.detachments += r.n;
  }
  return [...weeks.values()];
}

interface TeamInfo {
  id: string;
  name: string;
  org_access: string;
  ws: string | null;
}

async function teamsInfo(d1: D1Like, ids: string[]): Promise<Map<string, TeamInfo>> {
  if (!ids.length) return new Map();
  const { results } = await d1
    .prepare(`SELECT t.id, t.name, t.org_access, w.name AS ws FROM teams t LEFT JOIN workspaces w ON w.id = t.workspace_id WHERE t.id IN (SELECT value FROM json_each(?1))`)
    .bind(JSON.stringify(ids))
    .all<TeamInfo>();
  return new Map(results.map((r) => [r.id, r]));
}

const teamVisible = (r: Reach, t: TeamInfo | undefined) => !!t && (t.org_access !== "none" || r.teams.has(t.id));

async function teamRows(d1: D1Like, r: Reach, counts: { team: string | null; ins: number; det: number }[]): Promise<TeamActionsRow[]> {
  const info = await teamsInfo(d1, counts.map((c) => c.team).filter((x): x is string => !!x));
  const total = counts.reduce((n, c) => n + c.ins, 0);
  return counts
    .map((c) => {
      const t = c.team ? info.get(c.team) : undefined;
      const visible = teamVisible(r, t);
      return { teamId: visible ? c.team : null, teamName: visible ? t!.name : "Team not visible", workspaceName: visible ? t!.ws : null, insertions: c.ins, detachments: c.det, share: total ? c.ins / total : 0 };
    })
    .sort((a, b) => b.insertions - a.insertions || b.detachments - a.detachments);
}

async function teamActions(d1: D1Like, key: string, assetKeys: string[] | null, type: AnalyticsAssetType | null, from: string, to: string): Promise<{ team: string | null; ins: number; det: number }[]> {
  const { results } = await d1
    .prepare(
      `SELECT team_id, SUM(CASE WHEN action = 'insert' THEN count ELSE 0 END) AS ins, SUM(CASE WHEN action = 'detach' THEN count ELSE 0 END) AS det
       FROM library_actions_daily WHERE library_key = ?1 AND (?2 IS NULL OR asset_type = ?2) AND day BETWEEN ?3 AND ?4
         AND (?5 IS NULL OR asset_key IN (SELECT value FROM json_each(?5))) GROUP BY team_id`,
    )
    .bind(key, type, from, to, assetKeys ? JSON.stringify(assetKeys) : null)
    .all<{ team_id: string | null; ins: number; det: number }>();
  return results.map((x) => ({ team: x.team_id, ins: x.ins, det: x.det }));
}

const rangeOf = (url: URL): AnalyticsRange => {
  const n = Number(url.searchParams.get("range") ?? 30) as AnalyticsRange;
  if (!RANGES.includes(n)) throw new HttpError(400, "range is 30, 60, 90 or 365");
  return n;
};
const typeParam = (url: URL): AnalyticsAssetType => {
  const t = (url.searchParams.get("type") ?? "component") as AnalyticsAssetType;
  if (!TYPES.includes(t)) throw new HttpError(400, "type is component, style or variable");
  return t;
};

/** /libraries/:key/analytics/… (librariesRoute dispatches here) */
export async function libraryAnalyticsRoute(ctx: Ctx, key: string): Promise<Response> {
  const { parts, m, url, acc } = ctx;
  if (m !== "GET") throw new HttpError(405, "method not allowed");
  const { lib, reach } = await analyticsAccess(ctx, key);
  const d1 = acc.d1;
  const through = await throughDayOf(d1, key);
  const sub = parts[3];

  if (sub === "overview" && parts.length === 4) {
    const stats = await d1.prepare(`SELECT * FROM library_stats WHERE library_key = ?1`).bind(key).first<{ teams_using: number; inserts_this_week: number; detaches_this_week: number }>();
    const out: LibraryOverview = {
      libraryKey: key,
      teamsUsing: stats?.teams_using ?? 0,
      counts: countsOf(lib),
      thisWeek: { insertions: stats?.inserts_this_week ?? 0, detachments: stats?.detaches_this_week ?? 0 },
      rows: listed(await assetRows(d1, key, null)).map((r) => toStats(r)),
      throughDay: through,
    };
    return json(out);
  }
  if (sub === "actions" && parts.length === 4) {
    const type = typeParam(url);
    const range = rangeOf(url);
    const to = through || addDays(new Date(ctx.deps.now()).toISOString().slice(0, 10), -1);
    const from = addDays(to, -(range - 1));
    let compare: LibraryActions["compare"] = null;
    const other = url.searchParams.get("compare");
    if (other) {
      const o = await libraryRow(d1, other);
      if (!o || o.org_id !== lib.org_id || !(await canUseLibrary(acc, o, reach)).length) throw new HttpError(404, "no such library to compare with");
      compare = { libraryKey: o.key, name: libName(o), series: await weekly(d1, o.key, type, from, to) };
    }
    const rows = await assetRows(d1, key, type);
    const sums = await sumsOver(d1, key, type, from, to, rows);
    const stats = await d1.prepare(`SELECT teams_using FROM library_stats WHERE library_key = ?1`).bind(key).first<{ teams_using: number }>();
    const out: LibraryActions = {
      type,
      range,
      series: await weekly(d1, key, type, from, to),
      compare,
      topTeams: await teamRows(d1, reach, await teamActions(d1, key, null, type, from, to)),
      teamsUsing: stats?.teams_using ?? 0,
      rows: listed(rows).map((r) => toStats(r, sums)),
      throughDay: through,
    };
    return json(out);
  }
  if (sub === "usage" && parts.length === 5) {
    const assetKey = parts[4];
    if (!isSha1(assetKey)) throw new HttpError(400, "bad asset key");
    const all = await assetRows(d1, key, null);
    const row = all.find((r) => r.key === assetKey);
    if (!row) throw new HttpError(404, "no such asset");
    // A component set's usage is its variants'.
    const keys = row.kind === "COMPONENT_SET" ? [row.key, ...all.filter((r) => r.component_set_key === row.key).map((r) => r.key)] : [row.key];
    const to = through || addDays(new Date(ctx.deps.now()).toISOString().slice(0, 10), -1);
    const acts = await teamActions(d1, key, keys, null, addDays(to, -29), to);
    const { results: files } = await d1
      .prepare(
        `SELECT f.key, f.name, f.team_id, f.updated_at, SUM(u.instances) AS instances FROM library_usage u JOIN files f ON f.key = u.file_key
         WHERE u.library_key = ?1 AND u.asset_key IN (SELECT value FROM json_each(?2)) AND ${LIVE_FILE}
         GROUP BY f.key ORDER BY instances DESC LIMIT 500`,
      )
      .bind(key, JSON.stringify(keys))
      .all<{ key: string; name: string; team_id: string | null; updated_at: number; instances: number }>();
    // "Used by": teams with actions in the last 30 days or instances now.
    for (const f of files) if (!acts.some((a) => a.team === f.team_id)) acts.push({ team: f.team_id, ins: 0, det: 0 });
    const info = await teamsInfo(d1, files.map((f) => f.team_id).filter((x): x is string => !!x));
    const fileRows: FileUsageRow[] = files.map((f) => {
      const t = f.team_id ? info.get(f.team_id) : undefined;
      const visible = teamVisible(reach, t);
      return visible
        ? { fileKey: f.key, fileName: f.name, teamName: t!.name, workspaceName: t!.ws, instances: f.instances, lastModified: f.updated_at }
        : { fileKey: null, fileName: "File not visible", teamName: null, workspaceName: null, instances: f.instances, lastModified: null };
    });
    const out: AssetUsage = { row: toStats(row), teams: await teamRows(d1, reach, acts), files: fileRows };
    return json(out);
  }
  if (sub === "modes" && parts.length === 4) {
    const collection = url.searchParams.get("collection");
    const { results } = await d1
      .prepare(
        `SELECT u.asset_key, SUM(u.instances) AS n FROM library_usage u JOIN files f ON f.key = u.file_key
         WHERE u.library_key = ?1 AND u.asset_type = 'mode' AND ${LIVE_FILE} GROUP BY u.asset_key`,
      )
      .bind(key)
      .all<{ asset_key: string; n: number }>();
    const { results: cols } = await d1.prepare(`SELECT key, name, modes FROM library_assets WHERE library_key = ?1 AND kind = 'VARIABLE_COLLECTION'`).bind(key).all<{ key: string; name: string; modes: string | null }>();
    const colOf = new Map(cols.map((c) => [c.key, { name: c.name, modes: parseModes(c.modes) }]));
    const modes: ModeUsageRow[] = results
      .map((r) => {
        const [collectionKey, modeId] = r.asset_key.split("/");
        const c = colOf.get(collectionKey);
        return { collectionKey, collectionName: c?.name ?? "", modeId, modeName: c?.modes.find((x) => x.id === modeId)?.name ?? modeId, instances: r.n };
      })
      .filter((r) => !collection || r.collectionKey === collection)
      .sort((a, b) => a.collectionName.localeCompare(b.collectionName) || b.instances - a.instances);
    return json({ modes });
  }
  if (sub === "csv" && parts.length === 4) {
    const type = typeParam(url);
    const range = rangeOf(url);
    const to = through || addDays(new Date(ctx.deps.now()).toISOString().slice(0, 10), -1);
    const rows = await assetRows(d1, key, type);
    const sums = await sumsOver(d1, key, type, addDays(to, -(range - 1)), to, rows);
    // Figma's REST rows: per component (variants included, with their set), per style, per variable.
    const stats = rows.filter((r) => r.kind !== "COMPONENT_SET").map((r) => toStats(r, sums));
    const tail = (s: AssetStatsRow) => [s.instances, s.insertions, s.detachments, s.teamsUsing, s.filesUsing];
    const counts = ["instances", "insertions", "detachments", "teams_using", "files_using"];
    if (type === "component") return csv(["component_key", "component_name", "component_set_key", "component_set_name", ...counts], stats.map((s) => [s.key, s.name, s.componentSetKey ?? "", s.componentSetName ?? "", ...tail(s)]));
    if (type === "style") return csv(["style_key", "style_name", "style_type", ...counts], stats.map((s) => [s.key, s.name, s.styleType ?? "", ...tail(s)]));
    return csv(["variable_key", "variable_name", "variable_type", "collection_key", "collection_name", ...counts], stats.map((s) => [s.key, s.name, s.variableType ?? "", s.collectionKey ?? "", s.collectionName ?? "", ...tail(s)]));
  }
  throw new HttpError(404, "not found");
}

const parseModes = (s: string | null): { id: string; name: string }[] => {
  try {
    const v = JSON.parse(s ?? "[]") as { id: string; name: string }[];
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};

/** GET /orgs/:org/libraries/analytics: File browser › All teams (All workspaces) › Libraries */
export async function orgAnalyticsRoute(ctx: Ctx, orgId: string): Promise<Response> {
  const { parts, m, url, acc } = ctx;
  if (parts.length !== 4 || m !== "GET") throw new HttpError(405, "method not allowed");
  await acc.requireMember(orgId);
  const d1 = acc.d1;
  const ws = url.searchParams.get("workspace");
  const text = url.searchParams.get("text")?.trim().toLowerCase();
  const reach = await reachOf(acc, orgId);
  const all = (await orgLibraryRows(d1, orgId)).filter((l) => !ws || l.workspace_id === ws);
  const teams = [...reach.allTeams].filter(([, w]) => !ws || w === ws).length;
  const sum = (k: "components" | "styles" | "variables") => all.reduce((n, l) => n + countsOf(l)[k], 0);
  let mine = (await usable(acc, reach, all)).map((x) => x.lib);
  if (text) mine = mine.filter((l) => libName(l).toLowerCase().includes(text));
  const { results: stats } = await d1
    .prepare(`SELECT library_key, inserts_last_week FROM library_stats WHERE library_key IN (SELECT value FROM json_each(?1))`)
    .bind(JSON.stringify(mine.map((l) => l.key)))
    .all<{ library_key: string; inserts_last_week: number }>();
  const inserts = new Map(stats.map((s) => [s.library_key, s.inserts_last_week]));
  const out: OrgLibrariesAnalytics = {
    totals: { teams, teamsWithLibraries: new Set(all.map((l) => l.team_id).filter(Boolean)).size, libraries: all.length, components: sum("components"), styles: sum("styles"), variables: sum("variables") },
    libraries: mine.map((l) => ({ key: l.key, name: libName(l), teamName: l.team_name, ...countsOf(l), insertsLastWeek: inserts.get(l.key) ?? 0 })),
    throughDay: await throughDayOf(d1, null),
  };
  return json(out);
}
