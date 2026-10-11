/**
 * Organization routes (docs/multiplayer.md §16.7 "Organization"):
 *
 *   GET /v1/activity_logs?events&start_time&end_time&limit&order&cursor&org_id
 *       a plan token (its org), or an org admin (`org_id` required when they admin several) — Figma requires OAuth
 *       here; we take these instead (decision 2). → {status, error: false, i18n: null, meta: {activity_logs, cursor, next_page}}
 *   GET /v1/ai_usage/daily?start_date&end_date&user_email&limit&cursor
 *       plan tokens only (403 otherwise, as Figma). Rows from `ai_usage_daily` (round 6 fills it).
 */
import { activityPage } from "../activity";
import { RestError, planApiId, restJson, type RestCtx } from "./http";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The org a caller reads the log of */
async function logOrg(ctx: RestCtx): Promise<string> {
  const asked = ctx.url.searchParams.get("org_id");
  if (ctx.caller.kind === "plan") {
    if (asked && asked !== ctx.caller.orgId) throw new RestError(403, "This token belongs to another organization");
    return ctx.caller.orgId!;
  }
  const { results } = await ctx.deps.db.d1.prepare(`SELECT org_id FROM org_members WHERE user_id = ?1 AND role = 'admin'`).bind(ctx.caller.user.id).all<{ org_id: string }>();
  const orgs = results.map((r) => r.org_id);
  if (asked) {
    if (!orgs.includes(asked)) throw new RestError(403, "Only organization admins can read the activity log");
    return asked;
  }
  if (!orgs.length) throw new RestError(403, "Only organization admins can read the activity log");
  if (orgs.length > 1) throw new RestError(400, "org_id is required: you administer more than one organization");
  return orgs[0];
}

export async function orgRestRoute(ctx: RestCtx): Promise<Response> {
  const { parts, url, deps } = ctx;
  const q = url.searchParams;
  if (parts[0] === "activity_logs") {
    const orgId = await logOrg(ctx);
    const num = (k: string) => {
      const v = q.get(k);
      if (v === null || v === "") return undefined;
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0) throw new RestError(400, `Invalid ${k}`);
      return n;
    };
    const order = q.get("order") ?? "asc";
    if (order !== "asc" && order !== "desc") throw new RestError(400, "order is asc or desc");
    const limit = num("limit") ?? 1000;
    const page = await activityPage(deps, orgId, {
      events: q.get("events") ? q.get("events")!.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
      startTime: num("start_time"),
      endTime: num("end_time"),
      limit: Math.min(1000, Math.max(1, limit)),
      order,
      cursor: q.get("cursor") ?? undefined,
    });
    return restJson({ status: 200, error: false, i18n: null, meta: page });
  }

  // ai_usage/daily
  if (ctx.caller.kind !== "plan") throw new RestError(403, "This endpoint takes a plan access token");
  const orgId = ctx.caller.orgId!;
  const today = new Date(deps.now()).toISOString().slice(0, 10);
  const end = q.get("end_date") ?? today;
  const start = q.get("start_date") ?? new Date(deps.now() - 29 * 86_400_000).toISOString().slice(0, 10);
  if (!DAY.test(start) || !DAY.test(end)) throw new RestError(400, "start_date and end_date are YYYY-MM-DD");
  const limit = Math.max(1, Math.min(1000, Number(q.get("limit")) || 1000));
  const offset = Math.max(0, Number(q.get("cursor")) || 0);
  const email = q.get("user_email")?.trim().toLowerCase() ?? null;
  const { results } = await deps.db.d1
    .prepare(
      `SELECT a.*, u.email AS user_email, w.name AS workspace_name, t.name AS team_name, g.name AS group_name
       FROM ai_usage_daily a LEFT JOIN users u ON u.id = a.user_id LEFT JOIN workspaces w ON w.id = a.workspace_id LEFT JOIN teams t ON t.id = a.team_id
       LEFT JOIN billing_groups g ON g.id = a.billing_group_id
       WHERE a.org_id = ?1 AND a.day BETWEEN ?2 AND ?3 AND (?4 IS NULL OR u.email = ?4)
       ORDER BY a.day, a.user_id, a.editor_type LIMIT ?5 OFFSET ?6`,
    )
    .bind(orgId, start, end, email, limit + 1, offset)
    .all<{ user_id: string; user_email: string | null; day: string; editor_type: string; seat_credits: number; plan_credits: number; workspace_id: string | null; workspace_name: string | null; team_id: string | null; team_name: string | null; billing_group_id: string | null; group_name: string | null }>();
  const more = results.length > limit;
  const rows = results.slice(0, limit).map((r) => {
    const month = r.day.slice(0, 7);
    const last = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
    return {
      plan_id: planApiId(orgId),
      user_id: r.user_id,
      user_email: r.user_email,
      day: r.day,
      editor_type: r.editor_type,
      seat_credits_sum: r.seat_credits,
      plan_credits_sum: r.plan_credits,
      workspace_id: r.workspace_id,
      workspace_name: r.workspace_name,
      team_id: r.team_id,
      team_name: r.team_name,
      license_group_id: r.billing_group_id,
      license_group_name: r.group_name,
      metering_period_start: `${month}-01`,
      metering_period_end: last,
    };
  });
  return restJson({ rows, next_cursor: more ? String(offset + limit) : null, has_next_page: more });
}
