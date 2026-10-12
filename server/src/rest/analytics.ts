/**
 * Library analytics over REST (docs/multiplayer.md §16.7 "Library analytics"; Figma's names, data.md §17.6's tables):
 *
 *   GET /v1/analytics/libraries/:key/component/actions?group_by=component|team&start_date&end_date&cursor
 *   GET /v1/analytics/libraries/:key/component/usages?group_by=component|file&cursor
 *   …/style/actions · …/style/usages · …/variable/actions · …/variable/usages
 *
 * → `{rows, next_page, cursor}`. Actions are weekly (weeks start on Sunday; only weeks with data, newest first, a year
 * at most); usages are the current counts of the daily roll-up. Callers: org members (not guests) who can view the
 * library's file, or a plan token of its org (any library). Teams and files not open to the caller read "Team not
 * visible" / "File not visible" (a plan token sees them all).
 */
import { libraryRow } from "../libraries/db";
import { addDays, weekOf } from "../analytics/rollup";
import { RestError, restJson, type RestCtx } from "./http";

type AType = "component" | "style" | "variable";
const KINDS: Record<AType, string[]> = { component: ["COMPONENT", "COMPONENT_SET"], style: ["STYLE"], variable: ["VARIABLE"] };
const PAGE = 1000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

interface Asset {
  key: string;
  kind: string;
  name: string;
  style_type: string | null;
  resolved_type: string | null;
  component_set_key: string | null;
  collection_key: string | null;
  set_name: string | null;
  collection_name: string | null;
}

async function access(ctx: RestCtx, key: string): Promise<{ orgId: string; seesAll: boolean; teams: Set<string> }> {
  const lib = await libraryRow(ctx.acc.d1, key);
  if (!lib || lib.status === "deleted") throw new RestError(404, "Library not found");
  if (ctx.caller.kind === "plan") {
    if (ctx.caller.orgId !== lib.org_id) throw new RestError(404, "Library not found");
    return { orgId: lib.org_id, seesAll: true, teams: new Set() };
  }
  const m = await ctx.acc.membership(lib.org_id);
  const f = await ctx.acc.fileRow(key);
  const a = f ? await ctx.acc.openFile(f, { viaLink: true, passOk: false }) : null;
  if (!m || !a?.ok) throw new RestError(404, "Library not found");
  if (m.role === "guest") throw new RestError(403, "Guests can't see library analytics");
  const { results } = await ctx.acc.d1
    .prepare(`SELECT t.id FROM teams t WHERE t.org_id = ?1 AND (t.owner_id = ?2 OR EXISTS (SELECT 1 FROM team_members x WHERE x.team_id = t.id AND x.user_id = ?2))`)
    .bind(lib.org_id, ctx.caller.user.id)
    .all<{ id: string }>();
  return { orgId: lib.org_id, seesAll: m.role === "admin", teams: new Set(results.map((r) => r.id)) };
}

function assetFields(t: AType, a: Asset | undefined, key: string): Record<string, unknown> {
  if (t === "component") return { component_key: key, component_name: a?.name ?? "", component_set_key: a?.component_set_key ?? null, component_set_name: a?.set_name ?? null };
  if (t === "style") return { style_key: key, style_name: a?.name ?? "", style_type: a?.style_type ?? null };
  return { variable_key: key, variable_name: a?.name ?? "", variable_type: a?.resolved_type ?? null, collection_key: a?.collection_key ?? null, collection_name: a?.collection_name ?? null };
}

export async function analyticsRestRoute(ctx: RestCtx): Promise<Response> {
  const { parts, url, acc } = ctx;
  const key = parts[2];
  const type = parts[3] as AType;
  const what = parts[4];
  const groupBy = url.searchParams.get("group_by");
  const allowed = what === "actions" ? [type, "team"] : [type, "file"];
  if (!groupBy || !allowed.includes(groupBy)) throw new RestError(400, `group_by is ${allowed.join(" or ")}`);
  const who = await access(ctx, key);
  const d1 = acc.d1;
  const { results: assets } = await d1
    .prepare(
      `SELECT a.key, a.kind, a.name, a.style_type, a.resolved_type, a.component_set_key, a.collection_key, s.name AS set_name, c.name AS collection_name
       FROM library_assets a LEFT JOIN library_assets s ON s.library_key = a.library_key AND s.key = a.component_set_key
       LEFT JOIN library_assets c ON c.library_key = a.library_key AND c.key = a.collection_key
       WHERE a.library_key = ?1 AND a.kind IN (SELECT value FROM json_each(?2))`,
    )
    .bind(key, JSON.stringify(KINDS[type]))
    .all<Asset>();
  const byKey = new Map(assets.map((a) => [a.key, a]));
  const offset = Math.max(0, Number(url.searchParams.get("cursor")) || 0);
  const teamInfo = async (ids: string[]) => {
    const { results } = await d1
      .prepare(`SELECT t.id, t.name, t.org_access, w.name AS ws FROM teams t LEFT JOIN workspaces w ON w.id = t.workspace_id WHERE t.id IN (SELECT value FROM json_each(?1))`)
      .bind(JSON.stringify(ids))
      .all<{ id: string; name: string; org_access: string; ws: string | null }>();
    return new Map(results.map((r) => [r.id, r]));
  };
  const visible = (t: { id: string; org_access: string } | undefined) => !!t && (who.seesAll || t.org_access !== "none" || who.teams.has(t.id));
  const page = (rows: Record<string, unknown>[]) => {
    const slice = rows.slice(offset, offset + PAGE);
    const more = offset + PAGE < rows.length;
    return restJson({ rows: slice, next_page: more, cursor: more ? String(offset + PAGE) : null });
  };

  if (what === "actions") {
    const today = new Date(ctx.deps.now()).toISOString().slice(0, 10);
    const end = url.searchParams.get("end_date") ?? today;
    const start = url.searchParams.get("start_date") ?? addDays(end, -364);
    if (!DAY.test(start) || !DAY.test(end)) throw new RestError(400, "start_date and end_date are YYYY-MM-DD");
    const from = weekOf(start < addDays(end, -364) ? addDays(end, -364) : start);
    const { results } = await d1
      .prepare(`SELECT day, asset_key, team_id, action, SUM(count) AS n FROM library_actions_daily WHERE library_key = ?1 AND asset_type = ?2 AND day BETWEEN ?3 AND ?4 GROUP BY day, asset_key, team_id, action`)
      .bind(key, type, from, end)
      .all<{ day: string; asset_key: string; team_id: string | null; action: string; n: number }>();
    const cells = new Map<string, { week: string; id: string | null; insertions: number; detachments: number }>();
    for (const r of results) {
      const week = weekOf(r.day);
      const id = groupBy === "team" ? r.team_id : r.asset_key;
      const k = `${week}|${id}`;
      const c = cells.get(k) ?? { week, id, insertions: 0, detachments: 0 };
      if (r.action === "insert") c.insertions += r.n;
      else c.detachments += r.n;
      cells.set(k, c);
    }
    const list = [...cells.values()].sort((a, b) => b.week.localeCompare(a.week) || (b.insertions - a.insertions));
    if (groupBy === "team") {
      const info = await teamInfo(list.map((c) => c.id).filter((x): x is string => !!x));
      return page(list.map((c) => {
        const t = c.id ? info.get(c.id) : undefined;
        return { week: c.week, insertions: c.insertions, detachments: c.detachments, team_name: visible(t) ? t!.name : "Team not visible", workspace_name: visible(t) ? t!.ws : null };
      }));
    }
    return page(list.map((c) => ({ week: c.week, insertions: c.insertions, detachments: c.detachments, ...assetFields(type, byKey.get(c.id!), c.id!) })));
  }

  // usages
  if (groupBy === "file") {
    const { results } = await d1
      .prepare(
        `SELECT f.key, f.name, f.team_id, SUM(u.instances) AS usages FROM library_usage u JOIN files f ON f.key = u.file_key
         WHERE u.library_key = ?1 AND u.asset_type = ?2 AND f.trashed_at IS NULL GROUP BY f.key ORDER BY usages DESC`,
      )
      .bind(key, type)
      .all<{ key: string; name: string; team_id: string | null; usages: number }>();
    const info = await teamInfo(results.map((r) => r.team_id).filter((x): x is string => !!x));
    return page(results.map((r) => {
      const t = r.team_id ? info.get(r.team_id) : undefined;
      const ok = visible(t);
      return { usages: r.usages, team_name: ok ? t!.name : "Team not visible", workspace_name: ok ? t!.ws : null, file_name: ok ? r.name : "File not visible" };
    }));
  }
  const { results } = await d1
    .prepare(`SELECT asset_key, instances, files_using, teams_using FROM library_asset_stats WHERE library_key = ?1 AND asset_type = ?2 ORDER BY instances DESC`)
    .bind(key, type)
    .all<{ asset_key: string; instances: number; files_using: number; teams_using: number }>();
  return page(results.map((r) => ({ usages: r.instances, files_using: r.files_using, teams_using: r.teams_using, ...assetFields(type, byKey.get(r.asset_key), r.asset_key) })));
}
