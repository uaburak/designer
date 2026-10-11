/**
 * SCIM Groups (docs/multiplayer.md §15.5; [F-scim]): a group links by its exact `displayName` to the org's workspace,
 * else its billing group, else a user group made for it (`user_groups.external_id` = the SCIM group's id). Its members
 * then get that workspace (and its default teams), billing group or user group membership; a removed member loses it
 * only while it still is that value. A rename or a delete unlinks the same way.
 */
import { SCIM_GROUP_SCHEMA } from "../../../../src/shared/org/identity";
import { logActivity, orgEntity } from "../../activity";
import { randomId } from "../../org/http";
import { joinDefaultTeams, orgAdminIds } from "../../org/orgs";
import { orgNotice } from "../../notifications";
import { ScimError, iso, listResponse, paging, parseFilter, patchOps, readBody, scimJson, str, type ScimCtx } from "./common";

type TargetType = "workspace" | "billing_group" | "user_group";
interface GroupRow {
  id: string;
  org_id: string;
  display_name: string;
  external_id: string | null;
  target_type: TargetType;
  target_id: string;
  created_at: number;
  updated_at: number;
}

const group = (ctx: ScimCtx, id: string) => ctx.deps.db.d1.prepare(`SELECT * FROM scim_groups WHERE id = ?1 AND org_id = ?2`).bind(id, ctx.orgId).first<GroupRow>();
const memberIds = async (ctx: ScimCtx, id: string) => (await ctx.deps.db.d1.prepare(`SELECT user_id FROM scim_group_members WHERE group_id = ?1 ORDER BY user_id`).bind(id).all<{ user_id: string }>()).results.map((r) => r.user_id);

async function resource(ctx: ScimCtx, g: GroupRow) {
  const { results } = await ctx.deps.db.d1
    .prepare(`SELECT u.id, u.email, u.name FROM scim_group_members m JOIN users u ON u.id = m.user_id WHERE m.group_id = ?1 ORDER BY u.email`)
    .bind(g.id)
    .all<{ id: string; email: string; name: string | null }>();
  return {
    schemas: [SCIM_GROUP_SCHEMA],
    id: g.id,
    displayName: g.display_name,
    ...(g.external_id ? { externalId: g.external_id } : {}),
    members: results.map((r) => ({ value: r.id, display: r.name ?? r.email, $ref: `${ctx.base}/Users/${r.id}` })),
    meta: { resourceType: "Group", created: iso(g.created_at), lastModified: iso(g.updated_at), location: `${ctx.base}/Groups/${g.id}` },
  };
}

/** What a name links to; a user group is made only when `make` (with this SCIM group's id as its external id) */
async function target(ctx: ScimCtx, name: string, groupId: string, make: boolean): Promise<{ type: TargetType; id: string } | null> {
  const d1 = ctx.deps.db.d1;
  const ws = await d1.prepare(`SELECT id FROM workspaces WHERE org_id = ?1 AND name = ?2 ORDER BY created_at LIMIT 1`).bind(ctx.orgId, name).first<{ id: string }>();
  if (ws) return { type: "workspace", id: ws.id };
  const bg = await d1.prepare(`SELECT id FROM billing_groups WHERE org_id = ?1 AND name = ?2 ORDER BY created_at LIMIT 1`).bind(ctx.orgId, name).first<{ id: string }>();
  if (bg) return { type: "billing_group", id: bg.id };
  if (!make) return null;
  const id = randomId();
  const creator = ctx.tokenCreator ?? (await orgAdminIds(d1, ctx.orgId))[0];
  const now = ctx.deps.now();
  await d1.prepare(`INSERT INTO user_groups (id, org_id, name, description, created_by, external_id, created_at, updated_at) VALUES (?1, ?2, ?3, '', ?4, ?5, ?6, ?6)`).bind(id, ctx.orgId, name, creator, groupId, now).run();
  return { type: "user_group", id };
}

/** A member gains (or loses) what the group links to — only when they are in the org (not deactivated, not a guest) */
async function effect(ctx: ScimCtx, g: Pick<GroupRow, "target_type" | "target_id">, userId: string, on: boolean): Promise<void> {
  const d1 = ctx.deps.db.d1;
  const m = await d1.prepare(`SELECT email, role, workspace_id, billing_group_id FROM org_members WHERE org_id = ?1 AND user_id = ?2`).bind(ctx.orgId, userId).first<{ email: string; role: string; workspace_id: string | null; billing_group_id: string | null }>();
  if (!m || m.role === "guest") return;
  if (g.target_type === "workspace") {
    if (on && m.workspace_id !== g.target_id) {
      await d1.prepare(`UPDATE org_members SET workspace_id = ?3 WHERE org_id = ?1 AND user_id = ?2`).bind(ctx.orgId, userId, g.target_id).run();
      await joinDefaultTeams(ctx.deps, g.target_id, m.email, userId, null);
    } else if (!on && m.workspace_id === g.target_id) await d1.prepare(`UPDATE org_members SET workspace_id = NULL WHERE org_id = ?1 AND user_id = ?2`).bind(ctx.orgId, userId).run();
  } else if (g.target_type === "billing_group") {
    if (on && m.billing_group_id !== g.target_id) await d1.prepare(`UPDATE org_members SET billing_group_id = ?3 WHERE org_id = ?1 AND user_id = ?2`).bind(ctx.orgId, userId, g.target_id).run();
    else if (!on && m.billing_group_id === g.target_id) await d1.prepare(`UPDATE org_members SET billing_group_id = NULL WHERE org_id = ?1 AND user_id = ?2`).bind(ctx.orgId, userId).run();
  } else if (on) await d1.prepare(`INSERT INTO user_group_members (group_id, user_id, created_at) VALUES (?1, ?2, ?3) ON CONFLICT DO NOTHING`).bind(g.target_id, userId, ctx.deps.now()).run();
  else await d1.prepare(`DELETE FROM user_group_members WHERE group_id = ?1 AND user_id = ?2`).bind(g.target_id, userId).run();
}

/** A reactivated user gets back what their groups link to */
export async function applyGroupsOf(ctx: ScimCtx, userId: string): Promise<void> {
  const { results } = await ctx.deps.db.d1
    .prepare(`SELECT g.target_type, g.target_id FROM scim_group_members m JOIN scim_groups g ON g.id = m.group_id WHERE m.user_id = ?1 AND g.org_id = ?2 ORDER BY g.created_at`)
    .bind(userId, ctx.orgId)
    .all<Pick<GroupRow, "target_type" | "target_id">>();
  for (const g of results) await effect(ctx, g, userId, true);
}

const log = (ctx: ScimCtx, action: "idp_group_create" | "idp_group_rename" | "idp_group_delete" | "idp_group_connection_add" | "idp_group_connection_remove", g: Pick<GroupRow, "id" | "display_name" | "target_type" | "target_id">, details: Record<string, unknown> = {}) =>
  ctx.deps.db.d1
    .prepare(`SELECT id, name FROM orgs WHERE id = ?1`)
    .bind(ctx.orgId)
    .first<{ id: string; name: string }>()
    .then((org) => logActivity(ctx.deps, { orgId: ctx.orgId, action, actor: null, entity: orgEntity(org ?? { id: ctx.orgId, name: "" }), details: { group_id: g.id, display_name: g.display_name, target_type: g.target_type, target_id: g.target_id, ...details }, req: ctx.req }));
const connects = (t: TargetType) => t === "workspace" || t === "billing_group";

/** Member ids sent by the IdP: users provisioned in (or members of) this org */
async function checkMembers(ctx: ScimCtx, v: unknown): Promise<string[]> {
  if (v === undefined || v === null) return [];
  const list = Array.isArray(v) ? v : [v];
  const ids: string[] = [];
  for (const x of list) {
    const id = x && typeof x === "object" ? (x as { value?: unknown }).value : x;
    if (typeof id !== "string") throw new ScimError(400, "members are {value: <user id>}", "invalidValue");
    const known = await ctx.deps.db.d1.prepare(`SELECT 1 AS x FROM scim_users WHERE org_id = ?1 AND user_id = ?2 UNION SELECT 1 FROM org_members WHERE org_id = ?1 AND user_id = ?2`).bind(ctx.orgId, id).first();
    if (!known) throw new ScimError(400, `no user ${id} in this organization`, "invalidValue");
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

async function setMembers(ctx: ScimCtx, g: GroupRow, next: string[]): Promise<void> {
  const d1 = ctx.deps.db.d1;
  const cur = await memberIds(ctx, g.id);
  for (const id of cur.filter((x) => !next.includes(x))) {
    await d1.prepare(`DELETE FROM scim_group_members WHERE group_id = ?1 AND user_id = ?2`).bind(g.id, id).run();
    await effect(ctx, g, id, false);
  }
  for (const id of next.filter((x) => !cur.includes(x))) {
    await d1.prepare(`INSERT INTO scim_group_members (group_id, user_id) VALUES (?1, ?2) ON CONFLICT DO NOTHING`).bind(g.id, id).run();
    await effect(ctx, g, id, true);
  }
  if (cur.length !== next.length || cur.some((x) => !next.includes(x))) await orgNotice(ctx.deps, [...cur, ...next], { what: "org", orgId: ctx.orgId });
}

/** A new name: relinked (a SCIM user group is renamed in place when the name links to nothing else) */
async function rename(ctx: ScimCtx, g: GroupRow, name: string): Promise<GroupRow> {
  if (name === g.display_name) return g;
  const d1 = ctx.deps.db.d1;
  const now = ctx.deps.now();
  const to = await target(ctx, name, g.id, false);
  const members = await memberIds(ctx, g.id);
  if (!to && g.target_type === "user_group") {
    await d1.prepare(`UPDATE user_groups SET name = ?2, updated_at = ?3 WHERE id = ?1`).bind(g.target_id, name, now).run();
    await d1.prepare(`UPDATE scim_groups SET display_name = ?2, updated_at = ?3 WHERE id = ?1`).bind(g.id, name, now).run();
    await log(ctx, "idp_group_rename", { ...g, display_name: name }, { from: g.display_name });
    return (await group(ctx, g.id))!;
  }
  // Unlink from the old target, link to the new one
  for (const id of members) await effect(ctx, g, id, false);
  if (connects(g.target_type)) await log(ctx, "idp_group_connection_remove", g);
  if (g.target_type === "user_group") await d1.prepare(`DELETE FROM user_groups WHERE id = ?1 AND external_id = ?2`).bind(g.target_id, g.id).run();
  const t = to ?? (await target(ctx, name, g.id, true))!;
  await d1.prepare(`UPDATE scim_groups SET display_name = ?2, target_type = ?3, target_id = ?4, updated_at = ?5 WHERE id = ?1`).bind(g.id, name, t.type, t.id, now).run();
  const next = (await group(ctx, g.id))!;
  for (const id of members) await effect(ctx, next, id, true);
  await log(ctx, "idp_group_rename", next, { from: g.display_name });
  if (connects(t.type)) await log(ctx, "idp_group_connection_add", next);
  return next;
}

const displayName = (v: unknown) => {
  const s = str(v, "displayName", 255);
  if (!s || !s.trim()) throw new ScimError(400, "displayName is required", "invalidValue");
  return s.trim();
};

async function checkExternal(ctx: ScimCtx, externalId: string | null, self: string | null) {
  if (!externalId) return;
  const r = await ctx.deps.db.d1.prepare(`SELECT id FROM scim_groups WHERE org_id = ?1 AND external_id = ?2`).bind(ctx.orgId, externalId).first<{ id: string }>();
  if (r && r.id !== self) throw new ScimError(409, `externalId ${externalId} is already provisioned`, "uniqueness");
}

export async function groupsRoute(ctx: ScimCtx, url: URL, rest: string[]): Promise<Response> {
  const { deps, orgId, req } = ctx;
  const d1 = deps.db.d1;
  const m = req.method;
  const now = deps.now();
  if (!rest.length) {
    if (m === "GET") {
      const f = parseFilter(url.searchParams.get("filter"), ["displayName", "externalId"]);
      const { offset, count, startIndex } = paging(url);
      const where = f ? (f.attr === "displayName" ? `AND display_name = ?2` : `AND external_id = ?2`) : "";
      const args = f ? [orgId, f.value] : [orgId];
      const total = (await d1.prepare(`SELECT COUNT(*) AS n FROM scim_groups WHERE org_id = ?1 ${where}`).bind(...args).first<{ n: number }>())?.n ?? 0;
      const { results } = await d1.prepare(`SELECT * FROM scim_groups WHERE org_id = ?1 ${where} ORDER BY created_at, rowid LIMIT ${count} OFFSET ${offset}`).bind(...args).all<GroupRow>();
      const resources = [];
      for (const g of results) resources.push(await resource(ctx, g));
      return scimJson(listResponse(resources, total, startIndex));
    }
    if (m === "POST") {
      const b = await readBody(req);
      const name = displayName(b.displayName);
      const externalId = str(b.externalId, "externalId", 255);
      await checkExternal(ctx, externalId, null);
      const members = await checkMembers(ctx, b.members);
      const id = `g_${randomId()}`;
      const t = (await target(ctx, name, id, true))!;
      await d1.prepare(`INSERT INTO scim_groups (id, org_id, display_name, external_id, target_type, target_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)`).bind(id, orgId, name, externalId, t.type, t.id, now).run();
      const g = (await group(ctx, id))!;
      await log(ctx, "idp_group_create", g);
      if (connects(t.type)) await log(ctx, "idp_group_connection_add", g);
      await setMembers(ctx, g, members);
      return scimJson(await resource(ctx, g), 201);
    }
    throw new ScimError(405, "method not allowed");
  }
  if (rest.length !== 1) throw new ScimError(404, "not found");
  let g = await group(ctx, rest[0]);
  if (!g) throw new ScimError(404, `no group ${rest[0]}`);
  if (m === "GET") return scimJson(await resource(ctx, g));
  if (m === "PUT") {
    const b = await readBody(req);
    const externalId = str(b.externalId, "externalId", 255);
    await checkExternal(ctx, externalId, g.id);
    const members = await checkMembers(ctx, b.members ?? []);
    g = await rename(ctx, g, displayName(b.displayName));
    if (externalId !== g.external_id) await d1.prepare(`UPDATE scim_groups SET external_id = ?2, updated_at = ?3 WHERE id = ?1`).bind(g.id, externalId, now).run();
    await setMembers(ctx, g, members);
    return scimJson(await resource(ctx, (await group(ctx, g.id))!));
  }
  if (m === "PATCH") {
    for (const op of patchOps(await readBody(req))) g = await patchGroup(ctx, g, op.op, op.path, op.value);
    await d1.prepare(`UPDATE scim_groups SET updated_at = ?2 WHERE id = ?1`).bind(g.id, now).run();
    return scimJson(await resource(ctx, (await group(ctx, g.id))!));
  }
  if (m === "DELETE") {
    for (const id of await memberIds(ctx, g.id)) await effect(ctx, g, id, false);
    if (connects(g.target_type)) await log(ctx, "idp_group_connection_remove", g);
    if (g.target_type === "user_group") await d1.prepare(`DELETE FROM user_groups WHERE id = ?1 AND external_id = ?2`).bind(g.target_id, g.id).run();
    await d1.prepare(`DELETE FROM scim_groups WHERE id = ?1`).bind(g.id).run();
    await log(ctx, "idp_group_delete", g);
    return new Response(null, { status: 204 });
  }
  throw new ScimError(405, "method not allowed");
}

/** One PatchOp operation on a group: displayName / externalId replace, members add / remove / replace (Okta, Entra) */
async function patchGroup(ctx: ScimCtx, g: GroupRow, op: "add" | "replace" | "remove", path: string | null, value: unknown): Promise<GroupRow> {
  if (path === null) {
    if (op === "remove") throw new ScimError(400, "remove needs a path", "noTarget");
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new ScimError(400, "an operation without a path needs an object value", "invalidValue");
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) if (!["schemas", "id", "meta"].includes(k)) g = await patchGroup(ctx, g, op, k, v);
    return g;
  }
  const p = path.toLowerCase().replace(/\s+/g, " ");
  if (p === "displayname") {
    if (op === "remove") throw new ScimError(400, "displayName can't be removed", "mutability");
    return rename(ctx, g, displayName(value));
  }
  if (p === "externalid") {
    const externalId = op === "remove" ? null : str(value, "externalId", 255);
    await checkExternal(ctx, externalId, g.id);
    await ctx.deps.db.d1.prepare(`UPDATE scim_groups SET external_id = ?2 WHERE id = ?1`).bind(g.id, externalId).run();
    return (await group(ctx, g.id))!;
  }
  const cur = await memberIds(ctx, g.id);
  if (p === "members") {
    if (op === "add") await setMembers(ctx, g, [...cur, ...(await checkMembers(ctx, value)).filter((id) => !cur.includes(id))]);
    else if (op === "replace") await setMembers(ctx, g, await checkMembers(ctx, value));
    else {
      // Entra: path "members" with the values to remove; none → all
      const gone = value === undefined || value === null ? cur : (Array.isArray(value) ? value : [value]).map((x) => (x && typeof x === "object" ? String((x as { value?: unknown }).value) : String(x)));
      await setMembers(ctx, g, cur.filter((id) => !gone.includes(id)));
    }
    return g;
  }
  const one = /^members\[value eq "((?:[^"\\]|\\.)*)"\]$/.exec(path.trim().replace(/^members\[\s*value\s+eq\s+/i, 'members[value eq ').replace(/\s*\]$/, "]"));
  if (one && op === "remove") {
    await setMembers(ctx, g, cur.filter((id) => id !== one[1]));
    return g;
  }
  throw new ScimError(400, `unknown attribute ${path}`, "invalidPath");
}
