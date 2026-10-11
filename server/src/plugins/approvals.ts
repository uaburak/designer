/**
 * Plugin and widget approval in an organization (docs/plugins.md §10.2–§10.3; D1 `plugin_approvals` and
 * `plugin_requests`, migration 0015). The settings themselves (`pluginApproval`, `pluginRequests`, `widgetApproval`,
 * `widgetRequests`) are org settings (org/admin.ts `patchSettings`). The server can't see plugin runs: the store
 * checks `allowed` client-side from the approved list (Figma's check is client-side too).
 *
 * Members (not guests):
 *   GET  /orgs/:org/plugins/approved?kind=         → {approved: PluginApproval[]}      (the store's `allowed`)
 *   GET  /orgs/:org/plugins/requests               → {requests: PluginRequest[]}       (the caller's own)
 *   POST /orgs/:org/plugins/requests {pluginId, kind, name, manifest, reason, workspaceId?} → {request} (201)
 *        Only with `pluginRequests` / `widgetRequests` on; one pending request per person and plugin. Every org admin
 *        (and the workspace's admins) is told (`plugin_request`). Logged `plugin_approvelist_request_org`.
 * Org admins (workspace admins for their workspaces' rows):
 *   GET    /orgs/:org/admin/plugins?kind=          → {approved, requests, private}
 *   POST   /orgs/:org/admin/plugins/approvals {pluginId, kind, name, scope: {type: "org"} | {type: "workspace", ids}} → 204
 *   DELETE /orgs/:org/admin/plugins/approvals/:pluginId?workspace=&kind= → 204
 *   POST   /orgs/:org/admin/plugins/requests/:id {approve, reason?, workspaceIds?} → {request}
 *        The requester is told (`plugin_request_answer`); a declined requester may ask again.
 *
 * Approving a plugin also answers its pending requests in that scope. Actions: Figma's `plugin_approvelist_*` /
 * `widget_approvelist_*` (§16.11).
 */
import type { PluginApproval, PluginKind, PluginManifest, PluginRequest } from "../../../src/shared/plugins/types";
import type { ActivityAction } from "../../../src/shared/org/types";
import { logActivity } from "../activity";
import { notifyPluginAnswer, notifyPluginRequest } from "../notifications";
import { body, HttpError, json, noContent, placeholders, randomId, type Ctx } from "../org/http";
import { kindParam, privatePlugins, toPlugin } from "./private";

/** Any manifest id (Community ids are digits; development ids are whatever the manifest says) */
const PLUGIN_REF = /^[A-Za-z0-9_.:-]{1,100}$/;

interface ApprovalRow {
  org_id: string;
  plugin_id: string;
  kind: PluginKind;
  name: string;
  scope_type: "org" | "workspace";
  scope_id: string;
  added_by: string | null;
  added_at: number;
}

interface RequestRow {
  id: string;
  org_id: string;
  plugin_id: string;
  kind: PluginKind;
  name: string;
  manifest: string;
  requested_by: string;
  workspace_id: string | null;
  reason: string;
  state: "pending" | "approved" | "declined";
  decline_reason: string;
  created_at: number;
  answered_at: number | null;
  answered_by: string | null;
  r_email?: string;
  r_name?: string | null;
}

const toApproval = (r: ApprovalRow): PluginApproval => ({ pluginId: r.plugin_id, kind: r.kind, name: r.name, scope: r.scope_type === "org" ? { type: "org" } : { type: "workspace", id: r.scope_id }, addedBy: r.added_by, addedAt: r.added_at });

function toRequest(r: RequestRow): PluginRequest {
  let manifest: PluginManifest | null = null;
  try {
    const m = JSON.parse(r.manifest) as unknown;
    if (m && typeof m === "object" && !Array.isArray(m) && Object.keys(m).length) manifest = m as PluginManifest;
  } catch {
    // none
  }
  return { id: r.id, orgId: r.org_id, pluginId: r.plugin_id, kind: r.kind, name: r.name, manifest, requestedBy: { id: r.requested_by, email: r.r_email ?? "", name: r.r_name ?? null }, workspaceId: r.workspace_id, reason: r.reason, state: r.state, declineReason: r.decline_reason, createdAt: r.created_at, answeredAt: r.answered_at };
}

const REQ_SELECT = `SELECT q.*, u.email AS r_email, u.name AS r_name FROM plugin_requests q JOIN users u ON u.id = q.requested_by`;

const actionOf = (kind: PluginKind, what: string): ActivityAction => `${kind === "widget" ? "widget" : "plugin"}_approvelist_${what}` as ActivityAction;

async function approvals(ctx: Ctx, orgId: string, kind: PluginKind | null): Promise<ApprovalRow[]> {
  const { results } = await ctx.acc.d1.prepare(`SELECT * FROM plugin_approvals WHERE org_id = ?1 AND (?2 IS NULL OR kind = ?2) ORDER BY name COLLATE NOCASE, scope_type, scope_id`).bind(orgId, kind).all<ApprovalRow>();
  return results;
}

/** The caller's admin reach: the whole org, or some workspaces; 403 otherwise */
async function adminReach(ctx: Ctx, orgId: string): Promise<{ org: boolean; workspaces: string[] }> {
  const m = await ctx.acc.requireMember(orgId, { guests: true });
  if (m.role === "admin") return { org: true, workspaces: [] };
  const ws = m.role === "guest" ? [] : await ctx.acc.workspaceAdminOf(orgId);
  if (!ws.length) throw new HttpError(403, "only organization admins can do that", "not_admin");
  return { org: false, workspaces: ws };
}

async function orgName(ctx: Ctx, orgId: string): Promise<string> {
  return (await ctx.acc.org(orgId))?.name ?? "";
}

async function log(ctx: Ctx, orgId: string, kind: PluginKind, action: ActivityAction, plugin: { id: string; name: string }, details: Record<string, unknown> = {}): Promise<void> {
  await logActivity(ctx.deps, { orgId, action, actor: ctx.user, entity: { type: kind, id: plugin.id, name: plugin.name }, details, req: ctx.req });
}

/** The workspaces given are the org's, and the caller administers each (unless an org admin) */
async function checkWorkspaces(ctx: Ctx, orgId: string, ids: unknown, reach: { org: boolean; workspaces: string[] }): Promise<string[]> {
  if (!Array.isArray(ids) || !ids.length || ids.length > 200 || !ids.every((x) => typeof x === "string")) throw new HttpError(400, "ids is a list of workspace ids");
  const list = [...new Set(ids as string[])];
  const { results } = await ctx.acc.d1.prepare(`SELECT id FROM workspaces WHERE org_id = ?1 AND id IN (${placeholders(list.length, 2)})`).bind(orgId, ...list).all<{ id: string }>();
  if (results.length !== list.length) throw new HttpError(400, "no such workspace");
  if (!reach.org && !list.every((w) => reach.workspaces.includes(w))) throw new HttpError(403, "you can only approve for the workspaces you administer", "not_admin");
  return list;
}

async function addApprovals(ctx: Ctx, orgId: string, p: { pluginId: string; kind: PluginKind; name: string }, scope: { type: "org" } | { type: "workspace"; ids: string[] }): Promise<void> {
  const d1 = ctx.acc.d1;
  const now = ctx.deps.now();
  const rows = scope.type === "org" ? [["org", orgId]] : scope.ids.map((w) => ["workspace", w]);
  for (const [type, id] of rows) {
    await d1
      .prepare(`INSERT INTO plugin_approvals (org_id, plugin_id, kind, name, scope_type, scope_id, added_by, added_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) ON CONFLICT DO UPDATE SET name = ?4`)
      .bind(orgId, p.pluginId, p.kind, p.name, type, id, ctx.user.id, now)
      .run();
  }
  await log(ctx, orgId, p.kind, actionOf(p.kind, scope.type === "org" ? "add" : "add_workspace"), { id: p.pluginId, name: p.name }, scope.type === "org" ? {} : { workspace_ids: scope.ids });
}

async function answer(ctx: Ctx, orgId: string, q: RequestRow, approve: boolean, reason: string): Promise<void> {
  await ctx.acc.d1
    .prepare(`UPDATE plugin_requests SET state = ?2, decline_reason = ?3, answered_at = ?4, answered_by = ?5 WHERE id = ?1`)
    .bind(q.id, approve ? "approved" : "declined", approve ? "" : reason, ctx.deps.now(), ctx.user.id)
    .run();
  await notifyPluginAnswer(ctx.deps, { orgId, orgName: await orgName(ctx, orgId), by: ctx.user, requesterId: q.requested_by, pluginName: q.name, approve });
}

/** Pending requests a new approval covers: answered as approved */
async function settleCovered(ctx: Ctx, orgId: string, pluginId: string, kind: PluginKind, scope: { type: "org" } | { type: "workspace"; ids: string[] }): Promise<void> {
  const { results } = await ctx.acc.d1.prepare(`${REQ_SELECT} WHERE q.org_id = ?1 AND q.plugin_id = ?2 AND q.kind = ?3 AND q.state = 'pending'`).bind(orgId, pluginId, kind).all<RequestRow>();
  for (const q of results) if (scope.type === "org" || (q.workspace_id !== null && scope.ids.includes(q.workspace_id))) await answer(ctx, orgId, q, true, "");
}

function cleanRef(b: { pluginId?: unknown; kind?: unknown; name?: unknown }): { pluginId: string; kind: PluginKind; name: string } {
  if (typeof b.pluginId !== "string" || !PLUGIN_REF.test(b.pluginId)) throw new HttpError(400, "pluginId is the plugin's manifest id");
  const kind = b.kind === undefined ? "plugin" : b.kind;
  if (kind !== "plugin" && kind !== "widget") throw new HttpError(400, "kind is plugin or widget");
  const name = typeof b.name === "string" ? b.name.trim().slice(0, 100) : "";
  if (!name) throw new HttpError(400, "name is required");
  return { pluginId: b.pluginId, kind, name };
}

/** `/orgs/:org/plugins/approved` and `/orgs/:org/plugins/requests` (members) */
export async function memberApprovalsRoute(ctx: Ctx, orgId: string): Promise<Response> {
  const { m, parts, acc, deps, user, url } = ctx;
  await acc.requireMember(orgId);
  const d1 = acc.d1;
  if (parts[3] === "approved" && parts.length === 4 && m === "GET") return json({ approved: (await approvals(ctx, orgId, kindParam(url))).map(toApproval) });
  if (parts[3] !== "requests" || parts.length !== 4) throw new HttpError(404, "not found");
  if (m === "GET") {
    const { results } = await d1.prepare(`${REQ_SELECT} WHERE q.org_id = ?1 AND q.requested_by = ?2 ORDER BY q.created_at DESC LIMIT 200`).bind(orgId, user.id).all<RequestRow>();
    return json({ requests: results.map(toRequest) });
  }
  if (m !== "POST") throw new HttpError(405, "method not allowed");
  const b = await body<Record<string, unknown>>(ctx.req);
  const ref = cleanRef(b);
  const settings = await acc.settings(orgId);
  const allowed = ref.kind === "widget" ? settings.widgetRequests : settings.pluginRequests;
  if (!allowed) throw new HttpError(403, `your organization doesn't take ${ref.kind} requests`, "forbidden");
  const manifest = b.manifest && typeof b.manifest === "object" && !Array.isArray(b.manifest) ? JSON.stringify(b.manifest) : "{}";
  if (manifest.length > 64 * 1024) throw new HttpError(413, "the manifest is too large");
  const reason = typeof b.reason === "string" ? b.reason.trim().slice(0, 1000) : "";
  let workspaceId: string | null = null;
  if (b.workspaceId !== undefined && b.workspaceId !== null) {
    if (typeof b.workspaceId !== "string" || !(await d1.prepare(`SELECT 1 AS x FROM workspaces WHERE id = ?1 AND org_id = ?2`).bind(b.workspaceId, orgId).first())) throw new HttpError(400, "no such workspace");
    workspaceId = b.workspaceId;
  }
  // Covered already: approved for the org, or for the workspace asked about (a workspace approval doesn't reach drafts)
  const covered = await d1
    .prepare(`SELECT 1 AS x FROM plugin_approvals WHERE org_id = ?1 AND plugin_id = ?2 AND kind = ?3 AND (scope_type = 'org' OR (scope_type = 'workspace' AND scope_id = ?4))`)
    .bind(orgId, ref.pluginId, ref.kind, workspaceId ?? "")
    .first();
  if (covered) throw new HttpError(409, `this ${ref.kind} is already approved`);
  const open = await d1.prepare(`SELECT 1 AS x FROM plugin_requests WHERE org_id = ?1 AND plugin_id = ?2 AND requested_by = ?3 AND state = 'pending'`).bind(orgId, ref.pluginId, user.id).first();
  if (open) throw new HttpError(409, "you already asked for this one");
  const id = randomId();
  await d1
    .prepare(`INSERT INTO plugin_requests (id, org_id, plugin_id, kind, name, manifest, requested_by, workspace_id, reason, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`)
    .bind(id, orgId, ref.pluginId, ref.kind, ref.name, manifest, user.id, workspaceId, reason, deps.now())
    .run();
  await log(ctx, orgId, ref.kind, actionOf(ref.kind, "request_org"), { id: ref.pluginId, name: ref.name }, { reason, ...(workspaceId ? { workspace_id: workspaceId } : {}) });
  const { results: admins } = await d1.prepare(`SELECT user_id FROM org_members WHERE org_id = ?1 AND role = 'admin' AND user_id IS NOT NULL`).bind(orgId).all<{ user_id: string }>();
  const wsAdmins = workspaceId ? (await d1.prepare(`SELECT user_id FROM workspace_admins WHERE workspace_id = ?1`).bind(workspaceId).all<{ user_id: string }>()).results : [];
  await notifyPluginRequest(deps, { orgId, orgName: await orgName(ctx, orgId), by: user, adminIds: [...admins, ...wsAdmins].map((r) => r.user_id), pluginName: ref.name });
  const row = (await d1.prepare(`${REQ_SELECT} WHERE q.id = ?1`).bind(id).first<RequestRow>())!;
  return json({ request: toRequest(row) }, 201);
}

/** `/orgs/:org/admin/plugins…` */
export async function adminPluginsRoute(ctx: Ctx, orgId: string): Promise<Response> {
  const { m, parts, acc, url, user } = ctx;
  const reach = await adminReach(ctx, orgId);
  const d1 = acc.d1;
  const rest = parts.slice(4);
  if (!rest.length && m === "GET") {
    const kind = kindParam(url) ?? "plugin";
    const { results } = await d1
      .prepare(`${REQ_SELECT} WHERE q.org_id = ?1 AND q.kind = ?2 ORDER BY q.state = 'pending' DESC, q.created_at DESC LIMIT 500`)
      .bind(orgId, kind)
      .all<RequestRow>();
    const requests = reach.org ? results : results.filter((q) => q.workspace_id !== null && reach.workspaces.includes(q.workspace_id));
    const priv = await privatePlugins(d1, orgId, kind);
    return json({ approved: (await approvals(ctx, orgId, kind)).map(toApproval), requests: requests.map(toRequest), private: priv.map((r) => toPlugin(r, reach.org || r.published_by === user.id)) });
  }
  if (rest[0] === "approvals") {
    if (rest.length === 1 && m === "POST") {
      const b = await body<Record<string, unknown>>(ctx.req);
      const ref = cleanRef(b);
      const s = b.scope as { type?: unknown; ids?: unknown } | undefined;
      let scope: { type: "org" } | { type: "workspace"; ids: string[] };
      if (!s || s.type === "org") {
        if (!reach.org) throw new HttpError(403, "only organization admins can approve for the whole organization", "not_admin");
        scope = { type: "org" };
      } else if (s.type === "workspace") scope = { type: "workspace", ids: await checkWorkspaces(ctx, orgId, s.ids, reach) };
      else throw new HttpError(400, "scope is {type: org} or {type: workspace, ids}");
      await addApprovals(ctx, orgId, ref, scope);
      await settleCovered(ctx, orgId, ref.pluginId, ref.kind, scope);
      return noContent();
    }
    if (rest.length === 2 && m === "DELETE") {
      const pluginId = rest[1];
      const kind = kindParam(url) ?? "plugin";
      const workspace = url.searchParams.get("workspace");
      if (workspace) {
        if (!reach.org && !reach.workspaces.includes(workspace)) throw new HttpError(403, "you can only change approvals of the workspaces you administer", "not_admin");
      } else if (!reach.org) throw new HttpError(403, "only organization admins can do that", "not_admin");
      const gone = await d1
        .prepare(`DELETE FROM plugin_approvals WHERE org_id = ?1 AND plugin_id = ?2 AND kind = ?3 AND scope_type = ?4 AND scope_id = ?5 RETURNING name`)
        .bind(orgId, pluginId, kind, workspace ? "workspace" : "org", workspace ?? orgId)
        .first<{ name: string }>();
      if (!gone) throw new HttpError(404, "no such approval");
      await log(ctx, orgId, kind, actionOf(kind, workspace ? "remove_workspace" : "remove"), { id: pluginId, name: gone.name }, workspace ? { workspace_ids: [workspace] } : {});
      return noContent();
    }
  }
  if (rest[0] === "requests" && rest.length === 2 && m === "POST") {
    const q = await d1.prepare(`${REQ_SELECT} WHERE q.id = ?1 AND q.org_id = ?2`).bind(rest[1], orgId).first<RequestRow>();
    if (!q || (!reach.org && (q.workspace_id === null || !reach.workspaces.includes(q.workspace_id)))) throw new HttpError(404, "no such request");
    if (q.state !== "pending") throw new HttpError(409, "this request was already answered");
    const b = await body<{ approve?: unknown; reason?: unknown; workspaceIds?: unknown }>(ctx.req);
    const approve = b.approve === true;
    const reason = typeof b.reason === "string" ? b.reason.trim().slice(0, 1000) : "";
    const ref = { pluginId: q.plugin_id, kind: q.kind, name: q.name };
    if (approve) {
      const ws = b.workspaceIds === undefined || b.workspaceIds === null ? null : await checkWorkspaces(ctx, orgId, b.workspaceIds, reach);
      if (!ws && !reach.org) throw new HttpError(403, "only organization admins can approve for the whole organization", "not_admin");
      await addApprovals(ctx, orgId, ref, ws ? { type: "workspace", ids: ws } : { type: "org" });
      await answer(ctx, orgId, q, true, "");
      await log(ctx, orgId, q.kind, actionOf(q.kind, ws ? "request_approve_workspace" : "request_approve_org"), { id: q.plugin_id, name: q.name }, { request_id: q.id, requested_by: q.requested_by, ...(ws ? { workspace_ids: ws } : {}) });
      await settleCovered(ctx, orgId, q.plugin_id, q.kind, ws ? { type: "workspace", ids: ws } : { type: "org" });
    } else {
      await answer(ctx, orgId, q, false, reason);
      await log(ctx, orgId, q.kind, actionOf(q.kind, reach.org ? "request_reject_org" : "request_reject_workspace"), { id: q.plugin_id, name: q.name }, { request_id: q.id, requested_by: q.requested_by, reason });
    }
    return json({ request: toRequest((await d1.prepare(`${REQ_SELECT} WHERE q.id = ?1`).bind(q.id).first<RequestRow>())!) });
  }
  throw new HttpError(404, "not found");
}
