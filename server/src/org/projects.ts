/**
 * Folders — Figma's "projects" until 2026-08-03; D1, the API and the activity log keep "project" (docs/multiplayer.md
 * §14.1, §14.12 "Folders"). Nested ≤ 10 levels; an owner (its creator), members who can edit (create files and
 * folders inside) or view, and Inherited ("Anyone in ‹parent› can access") or Limited ("Only people added to
 * ‹folder› can access"). Trashed with their contents; deleted for good only from the trash.
 */
import type { GrantRole, OrgRole, Principal, ProjectInfo, ProjectMember, ProjectSummary } from "../../../src/shared/org/types";
import { logActivity, projectEntity } from "../activity";
import { normalizeEmail } from "../db";
import { notifyOrg, orgNotice } from "../notifications";
import { accessibleFiles, personRef, subtree, type Access, type ProjectRow, type TeamRow } from "./db";
import { body, cleanName, EMAIL, HttpError, ID, json, noContent, randomId, type Ctx } from "./http";
import { createOrgFile, inviteEmail } from "./orgs";
import { reauth, subtreeFileKeys } from "./reauth";
import { grantGroup, groupMembers, parsePrincipal, teamMembers } from "./teams";

const MAX_DEPTH = 10;
const canWrite = (a: { ok: boolean; role?: string | null; canManage?: boolean }) => a.ok && (a.role === "owner" || a.role === "editor" || a.canManage === true);

export async function projectSummaries(acc: Access, rows: ProjectRow[]): Promise<ProjectSummary[]> {
  const out: ProjectSummary[] = [];
  for (const p of rows) {
    const a = await acc.container(p.team_id, p.id);
    if (!a.ok) continue;
    const c = await acc.d1
      .prepare(`SELECT (SELECT COUNT(*) FROM files WHERE project_id = ?1 AND trashed_at IS NULL) AS files, (SELECT COUNT(*) FROM projects WHERE parent_id = ?1 AND trashed_at IS NULL) AS folders`)
      .bind(p.id)
      .first<{ files: number; folders: number }>();
    const team = await acc.team(p.team_id);
    // `orgId` beyond §14.13's ProjectSummary (the store asked: a folder names its org)
    out.push(Object.assign({ id: p.id, teamId: p.team_id, parentId: p.parent_id, name: p.name, access: p.access, fileCount: c?.files ?? 0, folderCount: c?.folders ?? 0, updatedAt: p.updated_at, trashedAt: p.trashed_at, me: a.role } satisfies ProjectSummary, { orgId: team?.org_id ?? null }));
  }
  return out;
}

async function projectInfo(acc: Access, p: ProjectRow): Promise<ProjectInfo> {
  const [summary] = await projectSummaries(acc, [p]);
  if (!summary) throw new HttpError(404, "no such folder");
  const chain = await acc.chain(p.id);
  return { ...summary, ownerId: p.owner_id, depth: p.depth, path: chain.map((c) => ({ id: c.id, name: c.name })).reverse(), createdAt: p.created_at };
}

/** /teams/:team/projects — the folders of a team (`?parent=`), and a new one. */
export async function projectsOfTeamRoute(ctx: Ctx, team: TeamRow): Promise<Response> {
  const { parts, m, acc, deps, user } = ctx;
  if (parts.length !== 3) throw new HttpError(404, "not found");
  if (team.deleted_at !== null) throw new HttpError(404, "this team was deleted");
  if (m === "GET") {
    const parent = ctx.url.searchParams.get("parent");
    const { results } = await acc.d1
      .prepare(`SELECT * FROM projects WHERE team_id = ?1 AND parent_id ${parent ? "= ?2" : "IS NULL"} AND trashed_at IS NULL ORDER BY name`)
      .bind(team.id, ...(parent ? [parent] : []))
      .all<ProjectRow>();
    return json({ projects: await projectSummaries(acc, results) });
  }
  if (m === "POST") {
    const b = await body<{ name?: unknown; parentId?: unknown; access?: unknown }>(ctx.req);
    const name = cleanName(b.name, "name", 200);
    const access = b.access === "limited" ? "limited" : "inherited";
    let depth = 1;
    let parentId: string | null = null;
    if (typeof b.parentId === "string") {
      const parent = await acc.project(b.parentId);
      if (!parent || parent.team_id !== team.id) throw new HttpError(400, "no such parent folder");
      if (!canWrite(await acc.container(team.id, parent.id)) || parent.trashed_at !== null) throw new HttpError(403, "only people who can edit the folder can add folders to it");
      depth = parent.depth + 1;
      parentId = parent.id;
    } else if (!canWrite(await acc.container(team.id, null))) throw new HttpError(403, "only the team's editors and admins can create folders");
    if (depth > MAX_DEPTH) throw new HttpError(409, `folders nest ${MAX_DEPTH} levels at most`);
    const id = randomId();
    const now = deps.now();
    await acc.d1
      .prepare(`INSERT INTO projects (id, team_id, parent_id, depth, name, owner_id, access, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)`)
      .bind(id, team.id, parentId, depth, name, user.id, access, now)
      .run();
    await logActivity(deps, { orgId: team.org_id, action: "project_create", actor: user, entity: projectEntity({ id, name }), teamId: team.id, details: { parent_id: parentId, access }, req: ctx.req });
    await orgNotice(deps, [user.id], { what: "projects", orgId: team.org_id, teamId: team.id, parentId });
    acc.reset();
    return json({ project: await projectInfo(acc, (await acc.project(id))!) }, 201);
  }
  throw new HttpError(405, "method not allowed");
}

export async function projectsRoute(ctx: Ctx): Promise<Response> {
  const { parts, m, acc, deps, user } = ctx;
  const id = parts[1] ?? "";
  const p = ID.test(id) ? await acc.project(id) : null;
  const team = p ? await acc.team(p.team_id) : null;
  if (!p || !team) throw new HttpError(404, "no such folder");
  const a = await acc.container(team.id, p.id);
  if (!a.ok) throw new HttpError(404, "no such folder");
  const orgId = team.org_id;
  const now = deps.now();
  const write = canWrite(a);
  const trashedHere = p.trashed_at !== null;
  const log = (action: Parameters<typeof logActivity>[1]["action"], details: Record<string, unknown> = {}, name = p.name) => logActivity(deps, { orgId, action, actor: user, entity: projectEntity({ id: p.id, name }), teamId: team.id, details, req: ctx.req });
  const needWrite = () => {
    if (!write) throw new HttpError(403, "only people who can edit this folder can do that");
  };
  const notTrashed = () => {
    if (a.trashed) throw new HttpError(409, "this folder is in the trash");
  };
  const tell = () => orgNotice(deps, [user.id], { what: "projects", orgId: team.org_id, teamId: team.id, parentId: p.parent_id });

  if (parts.length === 2) {
    if (m === "GET") return json({ project: await projectInfo(acc, p) });
    if (m === "PATCH") {
      notTrashed();
      needWrite();
      const b = await body<{ name?: unknown; access?: unknown }>(ctx.req);
      if (b.name !== undefined) {
        const name = cleanName(b.name, "name", 200);
        if (name !== p.name) {
          await acc.d1.prepare(`UPDATE projects SET name = ?2, updated_at = ?3 WHERE id = ?1`).bind(p.id, name, now).run();
          await log("project_rename", { old_name: p.name }, name);
        }
      }
      if (b.access !== undefined) {
        if (b.access !== "inherited" && b.access !== "limited") throw new HttpError(400, "access is inherited or limited");
        if (b.access !== p.access) {
          await acc.d1.prepare(`UPDATE projects SET access = ?2, updated_at = ?3 WHERE id = ?1`).bind(p.id, b.access, now).run();
          await log("project_team_access_change", { from: p.access, to: b.access });
          if (b.access === "limited") await reauth(deps, await subtreeFileKeys(acc.d1, p.id));
        }
      }
      acc.reset();
      await tell();
      return json({ project: await projectInfo(acc, (await acc.project(p.id))!) });
    }
    if (m === "DELETE") {
      if (!trashedHere) throw new HttpError(409, "move the folder to the trash first");
      needWrite();
      await deleteForever(ctx, p);
      await log("project_delete");
      await tell();
      return noContent();
    }
    throw new HttpError(405, "method not allowed");
  }

  switch (parts[2]) {
    case "move": {
      if (parts.length !== 3 || m !== "POST") break;
      notTrashed();
      needWrite();
      const b = await body<{ teamId?: unknown; parentId?: unknown }>(ctx.req);
      const toTeam = typeof b.teamId === "string" ? await acc.team(b.teamId) : team;
      if (!toTeam || toTeam.org_id !== orgId || toTeam.deleted_at !== null) throw new HttpError(400, "no such team");
      let parent: ProjectRow | null = null;
      if (typeof b.parentId === "string") {
        parent = await acc.project(b.parentId);
        if (!parent || parent.team_id !== toTeam.id || parent.trashed_at !== null) throw new HttpError(400, "no such parent folder");
      }
      if (!canWrite(await acc.container(toTeam.id, parent?.id ?? null))) throw new HttpError(403, "you can't add folders there");
      const sub = await subtree(acc.d1, p.id);
      if (parent && sub.some((s) => s.id === parent.id)) throw new HttpError(409, "a folder can't move into itself");
      const newDepth = (parent?.depth ?? 0) + 1;
      const deepest = Math.max(...sub.map((s) => s.depth)) - p.depth;
      if (newDepth + deepest > MAX_DEPTH) throw new HttpError(409, `folders nest ${MAX_DEPTH} levels at most`);
      const shift = newDepth - p.depth;
      for (const s of sub) {
        await acc.d1.prepare(`UPDATE projects SET team_id = ?2, depth = depth + ?3, updated_at = ?4 WHERE id = ?1`).bind(s.id, toTeam.id, shift, now).run();
        await acc.d1.prepare(`UPDATE files SET team_id = ?2 WHERE project_id = ?1`).bind(s.id, toTeam.id).run();
      }
      await acc.d1.prepare(`UPDATE projects SET parent_id = ?2 WHERE id = ?1`).bind(p.id, parent?.id ?? null).run();
      await log("project_move", { from_team_id: team.id, to_team_id: toTeam.id, from_parent_id: p.parent_id, to_parent_id: parent?.id ?? null });
      await reauth(deps, await subtreeFileKeys(acc.d1, p.id));
      acc.reset();
      await tell();
      await orgNotice(deps, [user.id], { what: "projects", orgId: team.org_id, teamId: toTeam.id, parentId: parent?.id ?? null });
      return json({ project: await projectInfo(acc, (await acc.project(p.id))!) });
    }
    case "trash": {
      if (parts.length !== 3 || m !== "POST") break;
      notTrashed();
      needWrite();
      await acc.d1.prepare(`UPDATE projects SET trashed_at = ?2, trashed_by = ?3, updated_at = ?2 WHERE id = ?1`).bind(p.id, now, user.id).run();
      await log("project_trash");
      await reauth(deps, await subtreeFileKeys(acc.d1, p.id));
      await tell();
      return noContent();
    }
    case "restore": {
      if (parts.length !== 3 || m !== "POST") break;
      if (!trashedHere) throw new HttpError(409, "this folder isn't in the trash");
      needWrite();
      await acc.d1.prepare(`UPDATE projects SET trashed_at = NULL, trashed_by = NULL, updated_at = ?2 WHERE id = ?1`).bind(p.id, now).run();
      await log("project_restore");
      acc.reset();
      await tell();
      return json({ project: await projectInfo(acc, (await acc.project(p.id))!) });
    }
    case "files": {
      if (parts.length !== 3) break;
      if (m === "GET") return json({ files: await accessibleFiles(acc, `f.project_id = ?1 AND f.trashed_at IS NULL`, [p.id]) });
      if (m === "POST") {
        notTrashed();
        const b = await body<{ key?: unknown; name?: unknown; editorType?: unknown }>(ctx.req);
        return json({ file: await createOrgFile(ctx, { key: b.key, name: b.name, orgId, projectId: p.id, editorType: b.editorType }) }, 201);
      }
      break;
    }
    case "members": {
      if (parts.length === 3 && m === "GET") return json({ members: await projectMembers(ctx, team, p) });
      notTrashed();
      if (parts.length === 3 && m === "PUT") {
        needWrite();
        const b = await body<{ email?: unknown; groupId?: unknown; role?: unknown }>(ctx.req);
        if (b.role !== "editor" && b.role !== "viewer") throw new HttpError(400, "role is editor or viewer");
        const requestId = await putProjectMember(ctx, team, p, b.email, b.groupId, b.role);
        if (requestId) return json({ members: await projectMembers(ctx, team, p), requested: true, requestId }, 202);
        return json({ members: await projectMembers(ctx, team, p) });
      }
      if (parts.length === 4 && (m === "PATCH" || m === "DELETE")) {
        const pr = parsePrincipal(parts[3]);
        if (!write && !(m === "DELETE" && pr.kind === "u" && pr.id === user.id)) throw new HttpError(403, "only people who can edit this folder can do that");
        if (m === "PATCH") {
          const b = await body<{ role?: unknown }>(ctx.req);
          if (b.role !== "editor" && b.role !== "viewer") throw new HttpError(400, "role is editor or viewer");
          if (pr.kind === "g") await putProjectMember(ctx, team, p, undefined, pr.id, b.role);
          else {
            const row = await acc.d1.prepare(`SELECT email FROM project_members WHERE project_id = ?1 AND ${pr.kind === "u" ? "user_id" : "email"} = ?2`).bind(p.id, pr.id).first<{ email: string }>();
            if (!row) throw new HttpError(404, "no such member");
            await putProjectMember(ctx, team, p, row.email, undefined, b.role);
          }
        } else await removeProjectMember(ctx, team, p, pr);
        return json({ members: await projectMembers(ctx, team, p) });
      }
      break;
    }
  }
  throw new HttpError(404, "not found");
}

/** "Delete forever": the files under the folder (their rooms, comments, grants), then the folders. */
async function deleteForever(ctx: Ctx, p: ProjectRow): Promise<void> {
  const { acc } = ctx;
  const sub = await subtree(acc.d1, p.id);
  for (const s of [...sub].reverse()) {
    const { results } = await acc.d1.prepare(`SELECT key FROM files WHERE project_id = ?1`).bind(s.id).all<{ key: string }>();
    for (const { key } of results) await deleteFileForever(ctx, key);
    await acc.d1.prepare(`DELETE FROM group_grants WHERE resource_type = 'project' AND resource_id = ?1`).bind(s.id).run();
  }
  await acc.d1.prepare(`DELETE FROM projects WHERE id = ?1`).bind(p.id).run();
}

/** A file deleted for good: its room, comments and rows (members, requests, notifications, group grants). */
export async function deleteFileForever(ctx: Ctx, key: string): Promise<void> {
  const { acc, deps } = ctx;
  await deps.rooms.fetch(key, "/room", { method: "DELETE" });
  await acc.d1.prepare(`DELETE FROM comments WHERE file_key = ?1`).bind(key).run();
  await acc.d1.prepare(`DELETE FROM group_grants WHERE resource_type = 'file' AND resource_id = ?1`).bind(key).run();
  await deps.db.deleteFile(key);
}

async function projectMembers(ctx: Ctx, team: TeamRow, p: ProjectRow): Promise<ProjectMember[]> {
  const d1 = ctx.acc.d1;
  const chain = await ctx.acc.chain(p.id);
  const out: ProjectMember[] = [];
  const seen = new Set<string>();
  const push = (x: ProjectMember) => {
    if (seen.has(x.principal)) return;
    seen.add(x.principal);
    out.push(x);
  };
  for (const [i, folder] of chain.entries()) {
    const inherited = i > 0;
    const { results } = await d1
      .prepare(`SELECT pm.email, pm.user_id, pm.role, u.name, u.picture, m.role AS org_role FROM project_members pm LEFT JOIN users u ON u.id = pm.user_id LEFT JOIN org_members m ON m.org_id = ?2 AND m.email = pm.email WHERE pm.project_id = ?1 ORDER BY pm.created_at`)
      .bind(folder.id, team.org_id)
      .all<{ email: string; user_id: string | null; role: GrantRole; name: string | null; picture: string | null; org_role: OrgRole | null }>();
    if (!inherited) {
      const owner = await d1.prepare(`SELECT u.id, u.email, u.name, u.picture, m.role FROM users u LEFT JOIN org_members m ON m.org_id = ?2 AND m.user_id = u.id WHERE u.id = ?1`).bind(p.owner_id, team.org_id).first<{ id: string; email: string; name: string | null; picture: string | null; role: OrgRole | null }>();
      if (owner) push({ principal: `u:${owner.id}`, person: personRef(owner), group: null, email: owner.email, role: "editor", owner: true, pending: false, guest: owner.role === "guest", inherited: false });
    }
    for (const r of results)
      push({ principal: (r.user_id ? `u:${r.user_id}` : `e:${r.email}`) as Principal, person: r.user_id ? personRef({ id: r.user_id, email: r.email, name: r.name, picture: r.picture, role: r.org_role }) : null, group: null, email: r.email, role: r.role, owner: false, pending: !r.user_id, guest: r.org_role === "guest", inherited });
    for (const g of await groupMembers(ctx, "project", folder.id)) push({ ...g, inherited });
  }
  for (const t of await teamMembers(ctx, team)) {
    const { admin, ...rest } = t;
    push({ ...rest, role: admin ? "editor" : rest.role, owner: false, inherited: true });
  }
  return out;
}

async function putProjectMember(ctx: Ctx, team: TeamRow, p: ProjectRow, email: unknown, groupId: unknown, role: GrantRole): Promise<string | null> {
  const { acc, deps, user } = ctx;
  const log = (action: Parameters<typeof logActivity>[1]["action"], details: Record<string, unknown>) => logActivity(deps, { orgId: team.org_id, action, actor: user, entity: projectEntity(p), teamId: team.id, details, req: ctx.req });
  if (typeof groupId === "string") {
    const g = await grantGroup(ctx, team.org_id, "project", p.id, groupId, role);
    await log(g.was ? "project_member_permission_change" : "project_member_add", { group_id: groupId, group_name: g.name, role, from: g.was });
    if (g.was === "editor" && role === "viewer") await reauth(deps, await subtreeFileKeys(acc.d1, p.id));
    return null;
  }
  if (typeof email !== "string" || !EMAIL.test(normalizeEmail(email))) throw new HttpError(400, "email or groupId");
  const e = normalizeEmail(email);
  const existing = await acc.d1.prepare(`SELECT role, user_id FROM project_members WHERE project_id = ?1 AND email = ?2`).bind(p.id, e).first<{ role: GrantRole; user_id: string | null }>();
  if (existing) {
    await acc.d1.prepare(`UPDATE project_members SET role = ?3 WHERE project_id = ?1 AND email = ?2`).bind(p.id, e, role).run();
    await log("project_member_permission_change", { email: e, user_id: existing.user_id, role, from: existing.role });
    if (existing.user_id && existing.role === "editor" && role === "viewer") await reauth(deps, await subtreeFileKeys(acc.d1, p.id), [existing.user_id]);
    return null;
  }
  const invited = await inviteEmail(ctx, team.org_id, e, { type: "project", id: p.id, name: p.name }, role);
  if (invited.kind === "requested") return invited.requestId;
  await acc.d1.prepare(`INSERT INTO project_members (project_id, email, user_id, role, invited_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`).bind(p.id, e, invited.userId, role, user.id, deps.now()).run();
  await log("project_member_add", { email: e, user_id: invited.userId, role, guest: invited.kind === "guest" });
  if (invited.userId) {
    await notifyOrg(deps, { userId: invited.userId, kind: "project_invite", actorId: user.id, orgId: team.org_id, teamId: team.id, name: p.name, role });
    await orgNotice(deps, [invited.userId], { what: "projects", orgId: team.org_id, teamId: team.id, parentId: p.parent_id });
  }
  acc.reset();
  return null;
}

async function removeProjectMember(ctx: Ctx, team: TeamRow, p: ProjectRow, pr: { kind: "u" | "e" | "g"; id: string }): Promise<void> {
  const { acc, deps, user } = ctx;
  const log = (details: Record<string, unknown>) => logActivity(deps, { orgId: team.org_id, action: "project_member_remove", actor: user, entity: projectEntity(p), teamId: team.id, details, req: ctx.req });
  if (pr.kind === "g") {
    if (!(await acc.d1.prepare(`DELETE FROM group_grants WHERE group_id = ?1 AND resource_type = 'project' AND resource_id = ?2 RETURNING group_id`).bind(pr.id, p.id).first())) throw new HttpError(404, "no such member");
    await log({ group_id: pr.id });
    await reauth(deps, await subtreeFileKeys(acc.d1, p.id));
    return;
  }
  const row = await acc.d1.prepare(`DELETE FROM project_members WHERE project_id = ?1 AND ${pr.kind === "u" ? "user_id" : "email"} = ?2 RETURNING email, user_id`).bind(p.id, pr.id).first<{ email: string; user_id: string | null }>();
  if (!row) throw new HttpError(404, "no such member");
  await log({ email: row.email, user_id: row.user_id });
  if (row.user_id) await reauth(deps, await subtreeFileKeys(acc.d1, p.id), [row.user_id]);
  acc.reset();
}
