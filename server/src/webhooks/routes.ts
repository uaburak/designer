/**
 * Webhooks V2's routes (docs/multiplayer.md §16.9), Figma's shapes:
 *
 *   POST   /v2/webhooks {event_type, context, context_id, endpoint, passcode, status?, description?}   WebhookV2 (+ PING)
 *   GET    /v2/webhooks?context&context_id · ?plan_api_id&cursor      {webhooks, pagination}
 *   GET    /v2/webhooks/:id                                           WebhookV2 (passcode "")
 *   PUT    /v2/webhooks/:id {event_type?, endpoint?, passcode?, status?, description?}   WebhookV2
 *   DELETE /v2/webhooks/:id                                           the deleted WebhookV2
 *   GET    /v2/webhooks/:id/requests                                  {requests}: the last 7 days
 *
 * Who: a team context — the team's admins; a project (folder) — its editors; a file — people who can edit it. A webhook
 * is read and changed by its creator and the admins of its context; org admins and the org's plan tokens reach every
 * webhook of the org (`plan_api_id=organization-<id>`). Outside orgs: file webhooks only, 3 per file, 20 per person.
 * Endpoints are `https://` (`http://localhost` only on a dev server), never a private IP literal.
 */
import { WEBHOOK_LIMITS, type WebhookV2 } from "../../../src/shared/rest/types";
import type { ActivityAction } from "../../../src/shared/org/types";
import { logActivity, type Entity } from "../activity";
import { RestError, planApiId, readBody, restJson, type RestCtx } from "../rest/http";
import { deliverRows } from "./deliver";
import { queue, waitOf } from "./emit";

const EVENTS = ["FILE_UPDATE", "FILE_VERSION_UPDATE", "FILE_DELETE", "LIBRARY_PUBLISH", "FILE_COMMENT", "DEV_MODE_STATUS_UPDATE"] as const;
type Event = (typeof EVENTS)[number];
type Context = "team" | "project" | "file";

interface HookRow {
  id: number;
  event_type: Event;
  context: Context;
  context_id: string;
  org_id: string | null;
  team_id: string | null;
  endpoint: string;
  passcode: string;
  status: "ACTIVE" | "PAUSED";
  description: string | null;
  created_by: string | null;
}

export function toV2(r: HookRow, withPasscode = false): WebhookV2 {
  return {
    id: r.id,
    event_type: r.event_type,
    context: r.context.toUpperCase() as WebhookV2["context"],
    context_id: r.context_id,
    team_id: r.context === "team" ? r.context_id : "",
    plan_api_id: planApiId(r.org_id),
    status: r.status,
    client_id: null,
    passcode: withPasscode ? r.passcode : "",
    endpoint: r.endpoint,
    description: r.description,
  };
}

/** `https://` only; `http://localhost` on a dev server (DEV_AUTH); never a private or loopback IP literal */
export function endpointError(endpoint: unknown, dev: boolean): string | null {
  if (typeof endpoint !== "string" || !endpoint || endpoint.length > 2048) return "endpoint is a URL of at most 2048 characters";
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return "endpoint is not a URL";
  }
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const local = host === "localhost" || host.endsWith(".localhost");
  if (u.protocol === "http:" && local && dev) return null;
  if (u.protocol !== "https:") return "endpoint must use https://";
  if (local) return "endpoint can't be localhost";
  if (/^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) || /^\d+$/.test(host) || host === "::1" || host === "::" || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe80:/.test(host)) return "endpoint can't be a private address";
  return null;
}

/** Context rights: can the caller create (and manage) webhooks of this context? With the context's org and team. */
async function contextRights(ctx: RestCtx, context: Context, id: string): Promise<{ ok: boolean; orgId: string | null; teamId: string | null; entity: Entity | null }> {
  const { acc, caller } = ctx;
  if (context === "team") {
    const team = await acc.team(id);
    if (!team || team.deleted_at !== null) throw new RestError(404, "Team not found");
    if (caller.kind === "plan") return { ok: caller.orgId === team.org_id, orgId: team.org_id, teamId: team.id, entity: { type: "team", id: team.id, name: team.name } };
    const r = await acc.teamRights(team);
    if (!r.canSee) throw new RestError(404, "Team not found");
    return { ok: r.admin, orgId: team.org_id, teamId: team.id, entity: { type: "team", id: team.id, name: team.name } };
  }
  if (context === "project") {
    const p = await acc.project(id);
    const team = p ? await acc.team(p.team_id) : null;
    if (!p || !team) throw new RestError(404, "Project not found");
    const entity: Entity = { type: "project", id: p.id, name: p.name };
    if (caller.kind === "plan") return { ok: caller.orgId === team.org_id, orgId: team.org_id, teamId: team.id, entity };
    const a = await acc.container(team.id, p.id);
    if (!a.ok) throw new RestError(404, "Project not found");
    return { ok: !a.trashed && (a.role === "owner" || a.role === "editor" || a.canManage), orgId: team.org_id, teamId: team.id, entity };
  }
  const f = await acc.fileRow(id);
  if (!f) throw new RestError(404, "File not found");
  const entity: Entity = { type: "file", id: f.key, name: f.name, key: f.key };
  if (caller.kind === "plan") return { ok: caller.orgId === f.org_id, orgId: f.org_id, teamId: f.team_id, entity };
  const a = await acc.file(f, { viaLink: true, passOk: false });
  if (!a.ok) throw new RestError(404, "File not found");
  return { ok: a.canEdit && !a.trashed, orgId: f.org_id, teamId: f.team_id, entity };
}

/** May the caller see / change this webhook? Its creator, the admins of its context, org admins and the org's plan tokens */
async function canManage(ctx: RestCtx, h: HookRow): Promise<boolean> {
  const { caller } = ctx;
  if (caller.kind === "plan") return !!h.org_id && caller.orgId === h.org_id;
  if (h.created_by === caller.user.id) return true;
  if (h.org_id && (await ctx.acc.membership(h.org_id))?.role === "admin") return true;
  try {
    return (await contextRights(ctx, h.context, h.context_id)).ok;
  } catch {
    return false;
  }
}

async function one(ctx: RestCtx, id: string): Promise<HookRow> {
  if (!/^\d{1,15}$/.test(id)) throw new RestError(404, "Webhook not found");
  const h = await ctx.deps.db.d1.prepare(`SELECT * FROM webhooks WHERE id = ?1`).bind(Number(id)).first<HookRow>();
  if (!h || !(await canManage(ctx, h))) throw new RestError(404, "Webhook not found");
  return h;
}

async function log(ctx: RestCtx, h: HookRow, action: ActivityAction, details: Record<string, unknown> = {}): Promise<void> {
  if (!h.org_id) return;
  await logActivity(ctx.deps, {
    orgId: h.org_id,
    action,
    actor: ctx.caller.kind === "plan" ? null : ctx.caller.user,
    entity: { type: "webhook" as Entity["type"], id: String(h.id), name: h.description ?? h.event_type, event_type: h.event_type, context: h.context, context_id: h.context_id },
    teamId: h.team_id,
    details: { ...details, ...(ctx.caller.kind === "plan" ? { plan_access_token_id: ctx.caller.tokenId } : {}) },
    req: ctx.req,
  });
}

/** PING right after a webhook is made (Figma's) */
async function ping(ctx: RestCtx, h: HookRow): Promise<void> {
  const ids = await queue(ctx.deps, [h], { event_type: "PING" });
  waitOf(ctx.deps)(deliverRows(ctx.deps, ids).catch((e) => console.error("webhooks: ping failed", e)));
}

export async function webhooksRoute(ctx: RestCtx): Promise<Response> {
  const { parts, m, url, deps, caller } = ctx;
  const d1 = deps.db.d1;
  const dev = deps.env.DEV_AUTH === "1";

  if (parts.length === 1 && m === "POST") {
    const b = await readBody<Record<string, unknown>>(ctx.req);
    const event = b.event_type as Event;
    if (!EVENTS.includes(event)) throw new RestError(400, `event_type is one of ${EVENTS.join(", ")}`);
    // `team_id` is Figma's deprecated way to name a team context
    const context = (typeof b.context === "string" ? b.context.toLowerCase() : b.team_id !== undefined ? "team" : "") as Context;
    const contextId = typeof b.context_id === "string" ? b.context_id : typeof b.team_id === "string" ? b.team_id : "";
    if (context !== "team" && context !== "project" && context !== "file") throw new RestError(400, "context is team, project or file");
    if (!contextId) throw new RestError(400, "context_id is required");
    const endpointErr = endpointError(b.endpoint, dev);
    if (endpointErr) throw new RestError(400, endpointErr);
    if (typeof b.passcode !== "string" || !b.passcode || b.passcode.length > 100) throw new RestError(400, "passcode is 1 to 100 characters");
    if (b.status !== undefined && b.status !== "ACTIVE" && b.status !== "PAUSED") throw new RestError(400, "status is ACTIVE or PAUSED");
    if (b.description !== undefined && b.description !== null && (typeof b.description !== "string" || b.description.length > 150)) throw new RestError(400, "description is at most 150 characters");
    const r = await contextRights(ctx, context, contextId);
    if (!r.ok) throw new RestError(403, context === "team" ? "Only team admins can add webhooks to a team" : context === "project" ? "Only people who can edit the project can add webhooks to it" : "Only people who can edit the file can add webhooks to it");
    if (!r.orgId && context !== "file") throw new RestError(400, "Team and project webhooks need an organization");
    const count = async (where: string, ...args: unknown[]) => (await d1.prepare(`SELECT COUNT(*) AS n FROM webhooks WHERE ${where}`).bind(...args).first<{ n: number }>())?.n ?? 0;
    const limit = WEBHOOK_LIMITS[context];
    if ((await count(`context = ?1 AND context_id = ?2`, context, contextId)) >= limit) throw new RestError(400, `A ${context} can have at most ${limit} webhooks`);
    if (r.orgId && context === "file" && (await count(`org_id = ?1 AND context = 'file'`, r.orgId)) >= WEBHOOK_LIMITS.orgFileWebhooks) throw new RestError(400, `An organization can have at most ${WEBHOOK_LIMITS.orgFileWebhooks} file webhooks`);
    if (!r.orgId && caller.kind !== "plan" && (await count(`created_by = ?1 AND org_id IS NULL`, caller.user.id)) >= WEBHOOK_LIMITS.personOutsideOrgs) throw new RestError(400, `You can have at most ${WEBHOOK_LIMITS.personOutsideOrgs} webhooks outside organizations`);
    const now = deps.now();
    const h = await d1
      .prepare(
        `INSERT INTO webhooks (event_type, context, context_id, org_id, team_id, endpoint, passcode, status, description, created_by, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11) RETURNING *`,
      )
      .bind(event, context, contextId, r.orgId, context === "team" ? contextId : r.teamId, b.endpoint, b.passcode, b.status ?? "ACTIVE", typeof b.description === "string" ? b.description : null, caller.kind === "plan" ? null : caller.user.id, now)
      .first<HookRow>();
    await log(ctx, h!, "webhook_create", { endpoint: h!.endpoint });
    if (h!.status === "ACTIVE") await ping(ctx, h!);
    return restJson(toV2(h!, true));
  }

  if (parts.length === 1 && m === "GET") {
    const planId = url.searchParams.get("plan_api_id");
    const cursor = Math.max(0, Number(url.searchParams.get("cursor")) || 0);
    const PAGE = 100;
    let rows: HookRow[];
    if (planId) {
      const orgId = /^organization-(.+)$/.exec(planId)?.[1];
      if (!orgId) throw new RestError(400, "plan_api_id is organization-<id>");
      const allowed = caller.kind === "plan" ? caller.orgId === orgId : (await ctx.acc.membership(orgId))?.role === "admin";
      if (!allowed) throw new RestError(403, "Only organization admins can list the organization's webhooks");
      rows = (await d1.prepare(`SELECT * FROM webhooks WHERE org_id = ?1 AND id > ?2 ORDER BY id LIMIT ?3`).bind(orgId, cursor, PAGE + 1).all<HookRow>()).results;
    } else {
      const context = url.searchParams.get("context")?.toLowerCase() as Context | undefined;
      const contextId = url.searchParams.get("context_id") ?? url.searchParams.get("team_id");
      if (context || contextId) {
        const c: Context = context ?? "team";
        if (c !== "team" && c !== "project" && c !== "file") throw new RestError(400, "context is team, project or file");
        if (!contextId) throw new RestError(400, "context_id is required");
        const r = await contextRights(ctx, c, contextId);
        const all = (await d1.prepare(`SELECT * FROM webhooks WHERE context = ?1 AND context_id = ?2 AND id > ?3 ORDER BY id LIMIT ?4`).bind(c, contextId, cursor, PAGE + 1).all<HookRow>()).results;
        rows = r.ok ? all : all.filter((h) => caller.kind !== "plan" && h.created_by === caller.user.id);
      } else {
        if (caller.kind === "plan") throw new RestError(400, "plan_api_id or context is required");
        rows = (await d1.prepare(`SELECT * FROM webhooks WHERE created_by = ?1 AND id > ?2 ORDER BY id LIMIT ?3`).bind(caller.user.id, cursor, PAGE + 1).all<HookRow>()).results;
      }
    }
    const more = rows.length > PAGE;
    const page = rows.slice(0, PAGE);
    const next = new URL(url.toString());
    if (more) next.searchParams.set("cursor", String(page[page.length - 1].id));
    return restJson({ webhooks: page.map((h) => toV2(h)), pagination: more ? { next_page: next.toString() } : {} });
  }

  const h = await one(ctx, parts[1]);
  if (parts.length === 2 && m === "GET") return restJson(toV2(h));
  if (parts.length === 3 && parts[2] === "requests" && m === "GET") {
    const { results } = await d1
      .prepare(`SELECT webhook_id, endpoint, payload, sent_at, status, received_at, error_msg FROM webhook_requests WHERE webhook_id = ?1 AND created_at >= ?2 ORDER BY created_at DESC, id DESC LIMIT 1000`)
      .bind(h.id, deps.now() - 7 * 86_400_000)
      .all<{ webhook_id: number; endpoint: string; payload: string; sent_at: number | null; status: number | null; received_at: number | null; error_msg: string | null }>();
    return restJson({
      requests: results.map((r) => ({
        webhook_id: String(r.webhook_id),
        request_info: { id: String(r.webhook_id), endpoint: r.endpoint, payload: JSON.parse(r.payload) as unknown, sent_at: r.sent_at === null ? null : new Date(r.sent_at).toISOString() },
        response_info: r.status === null ? null : { status: String(r.status), received_at: r.received_at === null ? null : new Date(r.received_at).toISOString() },
        error_msg: r.error_msg,
      })),
    });
  }
  if (parts.length === 2 && m === "PUT") {
    const b = await readBody<Record<string, unknown>>(ctx.req);
    const next = { ...h };
    if (b.event_type !== undefined) {
      if (!EVENTS.includes(b.event_type as Event)) throw new RestError(400, `event_type is one of ${EVENTS.join(", ")}`);
      next.event_type = b.event_type as Event;
    }
    if (b.endpoint !== undefined) {
      const err = endpointError(b.endpoint, dev);
      if (err) throw new RestError(400, err);
      next.endpoint = b.endpoint as string;
    }
    if (b.passcode !== undefined) {
      if (typeof b.passcode !== "string" || !b.passcode || b.passcode.length > 100) throw new RestError(400, "passcode is 1 to 100 characters");
      next.passcode = b.passcode;
    }
    if (b.status !== undefined) {
      if (b.status !== "ACTIVE" && b.status !== "PAUSED") throw new RestError(400, "status is ACTIVE or PAUSED");
      next.status = b.status;
    }
    if (b.description !== undefined) {
      if (b.description !== null && (typeof b.description !== "string" || b.description.length > 150)) throw new RestError(400, "description is at most 150 characters");
      next.description = b.description === "" || b.description === null ? null : (b.description as string);
    }
    await d1
      .prepare(`UPDATE webhooks SET event_type = ?2, endpoint = ?3, passcode = ?4, status = ?5, description = ?6, updated_at = ?7 WHERE id = ?1`)
      .bind(h.id, next.event_type, next.endpoint, next.passcode, next.status, next.description, deps.now())
      .run();
    await log(ctx, next, "webhook_update", { changed: Object.keys(b).filter((k) => k !== "passcode") });
    return restJson(toV2(next));
  }
  if (parts.length === 2 && m === "DELETE") {
    await d1.prepare(`DELETE FROM webhooks WHERE id = ?1`).bind(h.id).run();
    await log(ctx, h, "webhook_delete");
    return restJson(toV2(h));
  }
  throw new RestError(404, "Not found");
}
