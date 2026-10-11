/**
 * User groups (docs/multiplayer.md §14.1 [F-group]): any member creates them (OrgSettings.groupCreation "admins":
 * admins only); creators and org admins manage them; a group is invited to a team, folder or file and @mentioned.
 * Guests see only the groups they are in. Groups synced from an IdP (`external_id`, round 4) keep the IdP's members.
 *
 *   GET  /orgs/:org/groups · POST {name, description?, userIds?}
 *   PATCH /groups/:id {name?, description?} · POST /groups/:id/members {add?, remove?} · DELETE /groups/:id
 */
import type { OrgRole, UserGroup } from "../../../src/shared/org/types";
import { logActivity, type Entity } from "../activity";
import { orgNotice } from "../notifications";
import { personRef } from "./db";
import { body, cleanName, HttpError, json, noContent, randomId, type Ctx } from "./http";
import { orgFileKeys, reauth } from "./reauth";

interface GroupRow {
  id: string;
  org_id: string;
  name: string;
  description: string;
  created_by: string;
  external_id: string | null;
  created_at: number;
  updated_at: number;
}

const groupEntity = (g: { id: string; name: string }): Entity => ({ type: "user", id: `g:${g.id}`, name: g.name, group_id: g.id });

export async function orgGroupsRoute(ctx: Ctx, orgId: string): Promise<Response> {
  const { parts, m, acc, deps, user } = ctx;
  if (parts.length !== 3) throw new HttpError(404, "not found");
  const me = await acc.requireMember(orgId, { guests: true });
  if (m === "GET") {
    const { results } = await acc.d1
      .prepare(`SELECT * FROM user_groups WHERE org_id = ?1 ${me.role === "guest" ? `AND id IN (SELECT group_id FROM user_group_members WHERE user_id = ?2)` : ""} ORDER BY name`)
      .bind(orgId, ...(me.role === "guest" ? [user.id] : []))
      .all<GroupRow>();
    const groups: UserGroup[] = [];
    for (const g of results) groups.push(await toGroup(ctx, g, me.role));
    return json({ groups });
  }
  if (m === "POST") {
    if (me.role === "guest") throw new HttpError(403, "guests can't create groups");
    if ((await acc.settings(orgId)).groupCreation === "admins" && me.role !== "admin") throw new HttpError(403, "only admins can create groups in this organization", "admins_only");
    const b = await body<{ name?: unknown; description?: unknown; userIds?: unknown }>(ctx.req);
    const name = cleanName(b.name, "name", 100);
    const taken = await acc.d1.prepare(`SELECT 1 AS x FROM user_groups WHERE org_id = ?1 AND lower(name) = lower(?2)`).bind(orgId, name).first();
    if (taken) throw new HttpError(409, "a group with this name exists");
    const id = randomId();
    const now = deps.now();
    await acc.d1
      .prepare(`INSERT INTO user_groups (id, org_id, name, description, created_by, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)`)
      .bind(id, orgId, name, typeof b.description === "string" ? b.description.trim().slice(0, 500) : "", user.id, now)
      .run();
    await logActivity(deps, { orgId, action: "user_group_create", actor: user, entity: groupEntity({ id, name }), req: ctx.req });
    const ids = Array.isArray(b.userIds) ? b.userIds.filter((x): x is string => typeof x === "string") : [];
    const row = (await acc.d1.prepare(`SELECT * FROM user_groups WHERE id = ?1`).bind(id).first<GroupRow>())!;
    await changeMembers(ctx, row, ids, []);
    return json({ group: await toGroup(ctx, row, me.role) }, 201);
  }
  throw new HttpError(405, "method not allowed");
}

export async function groupsRoute(ctx: Ctx): Promise<Response> {
  const { parts, m, acc, deps, user } = ctx;
  const g = parts[1] ? await acc.d1.prepare(`SELECT * FROM user_groups WHERE id = ?1`).bind(parts[1]).first<GroupRow>() : null;
  const me = g ? await acc.membership(g.org_id) : null;
  if (!g || !me || (me.role === "guest" && !(await isIn(ctx, g.id)))) throw new HttpError(404, "no such group");
  const manage = me.role === "admin" || g.created_by === user.id;
  if (!manage) throw new HttpError(403, "only the group's creator and admins can change it");
  if (parts.length === 2 && m === "PATCH") {
    const b = await body<{ name?: unknown; description?: unknown }>(ctx.req);
    if (b.name !== undefined) {
      const name = cleanName(b.name, "name", 100);
      await acc.d1.prepare(`UPDATE user_groups SET name = ?2, updated_at = ?3 WHERE id = ?1`).bind(g.id, name, deps.now()).run();
      if (name !== g.name) await logActivity(deps, { orgId: g.org_id, action: "user_group_rename", actor: user, entity: groupEntity({ id: g.id, name }), details: { old_name: g.name }, req: ctx.req });
    }
    if (typeof b.description === "string") await acc.d1.prepare(`UPDATE user_groups SET description = ?2, updated_at = ?3 WHERE id = ?1`).bind(g.id, b.description.trim().slice(0, 500), deps.now()).run();
    const row = (await acc.d1.prepare(`SELECT * FROM user_groups WHERE id = ?1`).bind(g.id).first<GroupRow>())!;
    return json({ group: await toGroup(ctx, row, me.role) });
  }
  if (parts.length === 3 && parts[2] === "members" && m === "POST") {
    if (g.external_id) throw new HttpError(409, "this group's members come from your identity provider");
    const b = await body<{ add?: unknown; remove?: unknown }>(ctx.req);
    const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
    await changeMembers(ctx, g, list(b.add), list(b.remove));
    return json({ group: await toGroup(ctx, g, me.role) });
  }
  if (parts.length === 2 && m === "DELETE") {
    const { results } = await acc.d1.prepare(`SELECT user_id FROM user_group_members WHERE group_id = ?1`).bind(g.id).all<{ user_id: string }>();
    await acc.d1.prepare(`DELETE FROM group_grants WHERE group_id = ?1`).bind(g.id).run();
    await acc.d1.prepare(`DELETE FROM user_groups WHERE id = ?1`).bind(g.id).run();
    await logActivity(deps, { orgId: g.org_id, action: "user_group_delete", actor: user, entity: groupEntity(g), req: ctx.req });
    await reauth(deps, await orgFileKeys(acc.d1, g.org_id), results.map((r) => r.user_id));
    return noContent();
  }
  throw new HttpError(404, "not found");
}

async function isIn(ctx: Ctx, groupId: string): Promise<boolean> {
  return !!(await ctx.acc.d1.prepare(`SELECT 1 AS x FROM user_group_members WHERE group_id = ?1 AND user_id = ?2`).bind(groupId, ctx.user.id).first());
}

/** Adds and removes people (org members, guests too); removing lowers access, so their open files re-check. */
async function changeMembers(ctx: Ctx, g: GroupRow, add: string[], remove: string[]): Promise<void> {
  const { deps, user, acc } = ctx;
  const now = deps.now();
  for (const id of add) {
    const inOrg = await acc.d1.prepare(`SELECT u.id, u.email, u.name FROM org_members m JOIN users u ON u.id = m.user_id WHERE m.org_id = ?1 AND m.user_id = ?2`).bind(g.org_id, id).first<{ id: string; email: string; name: string | null }>();
    if (!inOrg) throw new HttpError(400, `${id} isn't in the organization`);
    const r = await acc.d1.prepare(`INSERT INTO user_group_members (group_id, user_id, added_by, created_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT DO NOTHING RETURNING user_id`).bind(g.id, id, user.id, now).first();
    if (r) await logActivity(deps, { orgId: g.org_id, action: "user_group_member_add", actor: user, entity: groupEntity(g), details: { user_id: inOrg.id, email: inOrg.email }, req: ctx.req });
  }
  const removed: string[] = [];
  for (const id of remove) {
    const r = await acc.d1.prepare(`DELETE FROM user_group_members WHERE group_id = ?1 AND user_id = ?2 RETURNING user_id`).bind(g.id, id).first();
    if (r) {
      removed.push(id);
      await logActivity(deps, { orgId: g.org_id, action: "user_group_member_remove", actor: user, entity: groupEntity(g), details: { user_id: id }, req: ctx.req });
    }
  }
  if (removed.length) await reauth(deps, await orgFileKeys(acc.d1, g.org_id), removed);
  await acc.d1.prepare(`UPDATE user_groups SET updated_at = ?2 WHERE id = ?1`).bind(g.id, now).run();
  await orgNotice(deps, [...add, ...removed], { what: "org", orgId: g.org_id });
  acc.reset();
}

async function toGroup(ctx: Ctx, g: GroupRow, myRole: OrgRole): Promise<UserGroup> {
  const { results } = await ctx.acc.d1
    .prepare(`SELECT u.id, u.email, u.name, u.picture, m.role FROM user_group_members x JOIN users u ON u.id = x.user_id LEFT JOIN org_members m ON m.org_id = ?2 AND m.user_id = u.id WHERE x.group_id = ?1 ORDER BY COALESCE(u.name, u.email)`)
    .bind(g.id, g.org_id)
    .all<{ id: string; email: string; name: string | null; picture: string | null; role: OrgRole | null }>();
  return { id: g.id, name: g.name, memberCount: results.length, description: g.description, createdBy: g.created_by, external: g.external_id !== null, members: results.map(personRef), canManage: myRole === "admin" || g.created_by === ctx.user.id };
}
