/**
 * The activity log (docs/multiplayer.md §14.10): Figma's ActivityLog events, one D1 row each (migration 0010
 * `activity_log`), written after a mutating route's write succeeds on an org's content. Files outside any org are
 * not logged (Figma logs organizations only). Read by Admin › Activity (`GET /orgs/:org/admin/activity`, JSON or CSV)
 * and, in round 5, the REST `/v1/activity_logs`.
 *
 * As built: written inline (Deps has no execution context, so no `ctx.waitUntil`); a failure is logged and swallowed,
 * never failing the action. Retention (one year) is swept by the daily Cron Trigger (index.ts `scheduled()`,
 * analytics/rollup.ts, docs/data.md §17.5) — no longer when an org's log is read; reads leave older events out.
 */
import { deviceFromUserAgent } from "../../src/shared/account";
import type { ActivityAction, ActivityEntityType, ActivityLog, ActivityPage, ActivityQuery } from "../../src/shared/org/types";
import type { Deps } from "./api";
import type { User } from "./db";
import { rootD1 } from "./requestD1";

export const RETENTION_MS = 365 * 86_400_000;
/** fig_file_view at most once per person per file per hour (ours; Figma's rate is unpublished) */
export const VIEW_EVERY_MS = 3_600_000;

export type Entity = { type: ActivityEntityType; id: string; name: string } & Record<string, string>;

export interface ActivityInput {
  orgId: string;
  action: ActivityAction;
  /** null: anonymous */
  actor: Pick<User, "id" | "email" | "name"> | null;
  entity: Entity;
  details?: Record<string, unknown>;
  teamId?: string | null;
  req?: Request | null;
}

/** "DesignerV2-Desktop/<v>" or the browser */
export function clientName(req: Request | null | undefined): string | null {
  const ua = req?.headers.get("user-agent") ?? null;
  if (!ua) return null;
  const app = /DesignerV2-Desktop\/[\w.-]+/.exec(ua);
  if (app) return app[0];
  const d = deviceFromUserAgent(ua);
  return d.browser ?? null;
}

export async function logActivity(deps: Deps, a: ActivityInput): Promise<void> {
  try {
    const { type, id, ...fields } = a.entity;
    await deps.db.d1
      .prepare(
        `INSERT INTO activity_log (org_id, at, action, actor_id, actor_email, actor_name, entity_type, entity_id, entity, details, team_id, ip, client_name)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
      )
      .bind(a.orgId, deps.now(), a.action, a.actor?.id ?? null, a.actor?.email ?? null, a.actor?.name ?? null, type, id, JSON.stringify(fields), JSON.stringify(a.details ?? {}), a.teamId ?? null, a.req?.headers.get("cf-connecting-ip") ?? null, clientName(a.req))
      .run();
  } catch (e) {
    console.error("activity: not logged", a.action, e);
  }
}

/** An event at most once per `everyMs` per actor and action in the org (e.g. `ip_allowlist_rejected`, hourly: docs/governance.md §3) */
export async function logOncePer(deps: Deps, everyMs: number, a: ActivityInput): Promise<void> {
  try {
    const seen = await deps.db.d1
      .prepare(`SELECT 1 AS x FROM activity_log WHERE org_id = ?1 AND actor_id = ?2 AND action = ?3 AND at > ?4 LIMIT 1`)
      .bind(a.orgId, a.actor?.id ?? null, a.action, deps.now() - everyMs)
      .first();
    if (seen) return;
  } catch {
    return;
  }
  await logActivity(deps, a);
}

/** One event in every org the user is in (sign-ins, sign-outs, tokens: §14.10). */
export async function logForUserOrgs(deps: Deps, user: Pick<User, "id" | "email" | "name">, action: ActivityAction, req: Request | null, details: Record<string, unknown> = {}): Promise<void> {
  try {
    const { results } = await deps.db.d1.prepare(`SELECT org_id FROM org_members WHERE user_id = ?1`).bind(user.id).all<{ org_id: string }>();
    for (const r of results) await logActivity(deps, { orgId: r.org_id, action, actor: user, entity: userEntity(user), details, req });
  } catch (e) {
    console.error("activity: not logged", action, e);
  }
}

/**
 * A socket opened on an org file (docs/multiplayer.md §15.9, corrected in round 4): the file's org logs
 * `fig_file_view` (`fig_file_view_prototype` for Present) — guests included —, and the viewer's home org (captured, and
 * not the file's) logs `fig_file_view_external` / `fig_file_view_prototype_external` with the file's entity [F-log].
 * Each at most hourly per person and file.
 */
export async function logFileView(deps: Deps, f: FileEntitySource & { org_id: string; team_id: string | null }, user: Pick<User, "id" | "email" | "name">, opts: { prototype: boolean; req: Request; home?: { orgId: string } | null }): Promise<void> {
  const once = async (orgId: string, action: ActivityAction, details: Record<string, unknown> = {}) => {
    // Reconnects of the same person to the same file: this isolate already knows it logged the view
    const seenHere = viewsOf(deps);
    const k = `${orgId} ${user.id} ${action} ${f.key}`;
    if (deps.now() - (seenHere.get(k) ?? -Infinity) < VIEW_EVERY_MS) return;
    if (seenHere.size >= 5_000) seenHere.clear();
    seenHere.set(k, deps.now());
    try {
      const seen = await deps.db.d1
        .prepare(`SELECT 1 AS x FROM activity_log WHERE org_id = ?1 AND actor_id = ?2 AND at > ?3 AND action = ?4 AND entity_id = ?5 LIMIT 1`)
        .bind(orgId, user.id, deps.now() - VIEW_EVERY_MS, action, f.key)
        .first();
      if (seen) return;
    } catch {
      return;
    }
    await logActivity(deps, { orgId, action, actor: user, entity: fileEntity(f), teamId: orgId === f.org_id ? f.team_id : null, details, req: opts.req });
  };
  await once(f.org_id, opts.prototype ? "fig_file_view_prototype" : "fig_file_view");
  if (opts.home && opts.home.orgId !== f.org_id) await once(opts.home.orgId, opts.prototype ? "fig_file_view_prototype_external" : "fig_file_view_external", { external_org_id: f.org_id });
}

/** Views this isolate logged (or found logged), by D1 binding (each test world has its own) */
const viewsByD1 = new WeakMap<object, Map<string, number>>();
function viewsOf(deps: Deps): Map<string, number> {
  const key = rootD1(deps.db.d1);
  let m = viewsByD1.get(key);
  if (!m) viewsByD1.set(key, (m = new Map()));
  return m;
}

export interface FileEntitySource {
  key: string;
  name: string;
  editor_type?: string;
  link_access?: string;
  proto_link_access?: string;
}

export const fileEntity = (f: FileEntitySource): Entity => ({ type: "file", id: f.key, name: f.name, key: f.key, editor_type: f.editor_type ?? "design", link_access: f.link_access ?? "none", proto_link_access: f.proto_link_access ?? "none" });
/** A main file and its branches (Figma's `file_repo {id, name, main_file_key}`): branch events are the repo's (data.md §15) */
export const repoEntity = (main: { key: string; name: string }): Entity => ({ type: "file_repo", id: main.key, name: main.name, main_file_key: main.key });
export const teamEntity =(t: { id: string; name: string }): Entity => ({ type: "team", id: t.id, name: t.name });
export const projectEntity = (p: { id: string; name: string }): Entity => ({ type: "project", id: p.id, name: p.name });
export const orgEntity = (o: { id: string; name: string }): Entity => ({ type: "org", id: o.id, name: o.name });
export const workspaceEntity = (w: { id: string; name: string }): Entity => ({ type: "workspace", id: w.id, name: w.name });
/** Figma's `policy_acknowledgement_config {id, title, audience, cadence, enabled_at, enabled_status}` [F-log] (docs/governance.md §1) */
export const policyEntity = (p: { id: string; title: string; audience: string; cadence: string; enabled_at: number | null; disabled_at: number | null }): Entity => ({
  type: "policy_acknowledgement_config",
  id: p.id,
  name: p.title,
  title: p.title,
  audience: p.audience,
  cadence: p.cadence,
  enabled_at: p.enabled_at === null ? "" : new Date(p.enabled_at).toISOString(),
  enabled_status: p.enabled_at !== null && p.disabled_at === null ? "enabled" : "disabled",
});
export const userEntity = (u: { id: string; email: string; name: string | null }): Entity => ({ type: "user", id: u.id, name: u.name ?? u.email, email: u.email });

interface Row {
  id: number;
  at: number;
  action: ActivityAction;
  actor_id: string | null;
  actor_email: string | null;
  actor_name: string | null;
  entity_type: ActivityEntityType;
  entity_id: string;
  entity: string;
  details: string;
  team_id: string | null;
  ip: string | null;
  client_name: string | null;
  org_id: string;
}

const parse = (s: string): Record<string, unknown> => {
  try {
    const v = JSON.parse(s) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

const toLog = (r: Row): ActivityLog => {
  const e = parse(r.entity) as Record<string, string>;
  return {
    id: String(r.id),
    timestamp: Math.floor(r.at / 1000),
    actor: r.actor_id ? { type: "user", id: r.actor_id, email: r.actor_email ?? "", name: r.actor_name ?? r.actor_email ?? "" } : null,
    action: { type: r.action, details: parse(r.details) },
    entity: { ...e, type: r.entity_type, id: r.entity_id, name: e.name ?? "" },
    context: { client_name: r.client_name, ip_address: r.ip ?? "", is_figma_support_team_action: false, org_id: r.org_id, team_id: r.team_id },
  };
};

/** Figma's query: events, email, team, start_time / end_time (Unix seconds; start defaults to a year ago), order, cursor. */
export async function activityPage(deps: Deps, orgId: string, q: ActivityQuery): Promise<ActivityPage> {
  const d1 = deps.db.d1;
  // Retention is the daily cron's (analytics/rollup.ts); events older than a year are left out until it runs.
  const where = [`org_id = ?1`];
  const args: unknown[] = [orgId];
  const arg = (v: unknown) => {
    args.push(v);
    return `?${args.length}`;
  };
  if (q.events?.length) where.push(`action IN (${q.events.map((e) => arg(e)).join(", ")})`);
  if (q.email) where.push(`actor_email = ${arg(q.email.trim().toLowerCase())}`);
  if (q.teamId) where.push(`team_id = ${arg(q.teamId)}`);
  where.push(`at >= ${arg((q.startTime ?? Math.floor((deps.now() - RETENTION_MS) / 1000)) * 1000)}`);
  if (q.endTime !== undefined) where.push(`at <= ${arg(q.endTime * 1000)}`);
  const asc = q.order === "asc";
  if (q.cursor && /^\d+$/.test(q.cursor)) where.push(`id ${asc ? ">" : "<"} ${arg(Number(q.cursor))}`);
  const limit = Math.max(1, Math.min(1000, q.limit ?? 100));
  const { results } = await d1
    .prepare(`SELECT * FROM activity_log WHERE ${where.join(" AND ")} ORDER BY id ${asc ? "ASC" : "DESC"} LIMIT ${arg(limit + 1)}`)
    .bind(...args)
    .all<Row>();
  const more = results.length > limit;
  const logs = results.slice(0, limit).map(toLog);
  return { activity_logs: logs, cursor: more ? logs[logs.length - 1].id : null, next_page: more };
}

export const ACTIVITY_CSV_HEADER = ["timestamp", "actor_email", "actor_name", "action", "entity_type", "entity_id", "entity_name", "details", "team_id", "ip_address", "client_name"];
export const activityCsvRows = (logs: ActivityLog[]): unknown[][] =>
  logs.map((l) => [new Date(l.timestamp * 1000).toISOString(), l.actor?.email ?? "", l.actor?.name ?? "", l.action.type, l.entity.type, l.entity.id, l.entity.name, l.action.details, l.context.team_id ?? "", l.context.ip_address, l.context.client_name ?? ""]);
