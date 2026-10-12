/**
 * Teams (docs/multiplayer.md §14.1, §14.2, §14.12 "Teams"): one owner, team admins, members who can edit or view;
 * audience "‹Organization›" / "‹Workspace›" with what they can do, or "Only those invited" (Visible: members find it
 * and ask to join; Hidden). Soft-deleted, restored by org admins and the owner.
 */
import type { Audience, GrantRole, JoinRequest, OrgRole, Principal, TeamInfo, TeamMember, TeamPatch, TeamSummary } from "../../../src/shared/org/types";
import { logActivity, teamEntity } from "../activity";
import { normalizeEmail } from "../db";
import { notifyOrg, orgNotice, settleOrg } from "../notifications";
import { accessibleFiles, personRef, Q, readFirst, type MemberRow, type ProjectRow, type TeamRow } from "./db";
import { body, cleanName, EMAIL, HttpError, ID, json, noContent, randomId, type Ctx } from "./http";
import { inviteEmail, orgAdminIds } from "./orgs";
import { teamFileKeys, reauth } from "./reauth";
import { logExternal, personById, requireInside } from "../policy/external";
import { iconUrl, teamIconRoute } from "./icons";

const AUDIENCES: readonly Audience[] = ["none", "viewer", "editor"];
const audienceRank = (a: Audience) => AUDIENCES.indexOf(a);

export async function orgTeamsRoute(ctx: Ctx, orgId: string): Promise<Response> {
  const { parts, m, acc, deps, user } = ctx;
  if (parts.length !== 3) throw new HttpError(404, "not found");
  const me = await acc.requireMember(orgId, { guests: true });
  if (m === "GET") {
    const filter = ctx.url.searchParams.get("filter") === "browse" && me.role !== "guest" ? "browse" : "mine";
    return json({ teams: await listTeams(ctx, orgId, me, filter) });
  }
  if (m === "POST") {
    if (me.role === "guest") throw new HttpError(403, "guests can't create teams");
    if ((await acc.settings(orgId)).teamCreation === "admins" && me.role !== "admin") throw new HttpError(403, "only admins can create teams in this organization", "admins_only");
    const b = await body<{ name?: unknown; workspaceId?: unknown }>(ctx.req);
    const name = cleanName(b.name, "name", 100);
    await uniqueTeamName(ctx, orgId, name, null);
    let workspaceId: string | null = null;
    if (typeof b.workspaceId === "string") {
      const w = await acc.d1.prepare(`SELECT id FROM workspaces WHERE id = ?1 AND org_id = ?2`).bind(b.workspaceId, orgId).first();
      if (!w) throw new HttpError(400, "no such workspace");
      workspaceId = b.workspaceId;
    } else workspaceId = me.workspace_id;
    const id = randomId();
    const now = deps.now();
    await acc.d1.prepare(`INSERT INTO teams (id, org_id, workspace_id, name, owner_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)`).bind(id, orgId, workspaceId, name, user.id, now).run();
    await acc.d1.prepare(`INSERT INTO team_members (team_id, email, user_id, role, admin, created_at) VALUES (?1, ?2, ?3, 'editor', 1, ?4)`).bind(id, user.email, user.id, now).run();
    await logActivity(deps, { orgId, action: "team_create", actor: user, entity: teamEntity({ id, name }), teamId: id, req: ctx.req });
    await orgNotice(deps, [user.id], { what: "teams", orgId });
    acc.reset();
    return json({ team: await teamInfo(ctx, (await acc.team(id))!) }, 201);
  }
  throw new HttpError(405, "method not allowed");
}

/** Team names are unique in an org, ignoring case (409 "name taken", §14.12) */
async function uniqueTeamName(ctx: Ctx, orgId: string, name: string, except: string | null): Promise<void> {
  const taken = await ctx.acc.d1.prepare(`SELECT 1 AS x FROM teams WHERE org_id = ?1 AND lower(name) = lower(?2) AND deleted_at IS NULL AND id IS NOT ?3`).bind(orgId, name, except).first();
  if (taken) throw new HttpError(409, "a team with this name exists");
}

export async function listTeams(ctx: Ctx, orgId: string, me: MemberRow, filter: "mine" | "browse"): Promise<TeamSummary[]> {
  const { results } = await ctx.acc.d1.prepare(`SELECT * FROM teams WHERE org_id = ?1 AND deleted_at IS NULL ORDER BY name`).bind(orgId).all<TeamRow>();
  const out: TeamSummary[] = [];
  // Each team's rights and counts, all in one round trip
  await ctx.acc.prefetchTeams(results.map((t) => t.id));
  for (const t of results) {
    const r = await ctx.acc.teamRights(t);
    if (filter === "mine" ? !r.inTeam : !r.canSee || (me.role === "guest" && !r.inTeam)) continue;
    out.push(await teamSummary(ctx, t));
  }
  return out;
}

async function teamSummary(ctx: Ctx, t: TeamRow): Promise<TeamSummary> {
  const r = await ctx.acc.teamRights(t);
  const c = await readFirst<{ members: number; projects: number }>(ctx.acc.d1, Q.teamCounts(t.id));
  const summary: TeamSummary = {
    id: t.id,
    name: t.name,
    icon: t.icon,
    iconUrl: iconUrl(t.org_id, t.icon_hash),
    workspaceId: t.workspace_id,
    visibility: t.visibility,
    orgAccess: t.org_access,
    workspaceAccess: t.workspace_access,
    me: r.inTeam || r.requested ? { role: r.role, admin: r.teamAdmin || r.owner, owner: r.owner, requested: r.requested } : null,
    memberCount: c?.members ?? 0,
    projectCount: c?.projects ?? 0,
  };
  // `orgId` beyond §14.13's TeamSummary (the store asked: a team names its org)
  return Object.assign(summary, { orgId: t.org_id });
}

export async function teamInfo(ctx: Ctx, t: TeamRow): Promise<TeamInfo> {
  return { ...(await teamSummary(ctx, t)), description: t.description, ownerId: t.owner_id, createdAt: t.created_at, deletedAt: t.deleted_at };
}

/** Everyone to tell about a team's change: its people with accounts and the org's admins. */
async function teamUserIds(ctx: Ctx, t: TeamRow): Promise<string[]> {
  const { results } = await ctx.acc.d1.prepare(`SELECT user_id FROM team_members WHERE team_id = ?1 AND user_id IS NOT NULL`).bind(t.id).all<{ user_id: string }>();
  return [...results.map((r) => r.user_id), ...(await orgAdminIds(ctx.acc.d1, t.org_id))];
}

export function parsePrincipal(p: string): { kind: "u" | "e" | "g"; id: string } {
  const m = /^([ueg]):(.+)$/.exec(p);
  if (!m) throw new HttpError(400, "principal is u:<userId>, e:<email> or g:<groupId>");
  return { kind: m[1] as "u" | "e" | "g", id: m[1] === "e" ? normalizeEmail(m[2]) : m[2] };
}

export async function teamsRoute(ctx: Ctx): Promise<Response> {
  const { parts, m, acc, deps, user } = ctx;
  const teamId = parts[1] ?? "";
  if (!ID.test(teamId)) throw new HttpError(404, "no such team");
  const { team, rights } = await acc.requireTeam(teamId);
  const orgId = team.org_id;
  const now = deps.now();
  const log = (action: Parameters<typeof logActivity>[1]["action"], details: Record<string, unknown> = {}, name = team.name) => logActivity(deps, { orgId, action, actor: user, entity: teamEntity({ id: team.id, name }), teamId: team.id, details, req: ctx.req });
  const tell = async () => orgNotice(deps, await teamUserIds(ctx, team), { what: "team", orgId: team.org_id, teamId: team.id });
  const needAdmin = () => {
    if (!rights.admin) throw new HttpError(403, "only the team's admins can do that");
  };
  const live = () => {
    if (team.deleted_at !== null) throw new HttpError(404, "this team was deleted");
  };

  if (parts.length === 2) {
    if (m === "GET") return json({ team: await teamInfo(ctx, team) });
    if (m === "PATCH") {
      live();
      needAdmin();
      const b = await body<TeamPatch>(ctx.req);
      let lowered = false;
      if (b.name !== undefined) {
        const name = cleanName(b.name, "name", 100);
        if (name !== team.name) {
          await uniqueTeamName(ctx, orgId, name, team.id);
          await acc.d1.prepare(`UPDATE teams SET name = ?2, updated_at = ?3 WHERE id = ?1`).bind(team.id, name, now).run();
          await log("team_rename", { old_name: team.name }, name);
        }
      }
      if (b.description !== undefined) await acc.d1.prepare(`UPDATE teams SET description = ?2, updated_at = ?3 WHERE id = ?1`).bind(team.id, typeof b.description === "string" ? b.description.slice(0, 1000) : "", now).run();
      if (b.icon !== undefined) {
        if (b.icon !== null && (typeof b.icon !== "string" || b.icon.length > 100_000 || !/^data:image\/(png|jpeg|webp|svg\+xml);base64,/.test(b.icon))) throw new HttpError(400, "icon is a data: URL under 100 kB, or null");
        await acc.d1.prepare(`UPDATE teams SET icon = ?2, updated_at = ?3 WHERE id = ?1`).bind(team.id, b.icon, now).run();
      }
      for (const [field, col] of [
        ["orgAccess", "org_access"],
        ["workspaceAccess", "workspace_access"],
      ] as const) {
        const v = b[field];
        if (v === undefined) continue;
        if (!AUDIENCES.includes(v)) throw new HttpError(400, `${field} is none, viewer or editor`);
        const before = team[col];
        if (v === before) continue;
        await acc.d1.prepare(`UPDATE teams SET ${col} = ?2, updated_at = ?3 WHERE id = ?1`).bind(team.id, v, now).run();
        if (audienceRank(v) < audienceRank(before)) lowered = true;
        await log("team_org_access_change", { audience: field === "orgAccess" ? "org" : "workspace", from: before, to: v });
      }
      if (b.visibility !== undefined) {
        if (b.visibility !== "visible" && b.visibility !== "hidden") throw new HttpError(400, "visibility is visible or hidden");
        if (b.visibility !== team.visibility) {
          await acc.d1.prepare(`UPDATE teams SET visibility = ?2, updated_at = ?3 WHERE id = ?1`).bind(team.id, b.visibility, now).run();
          if (b.visibility === "hidden") lowered = true;
          await log("team_sharing_audience_control_change", { from: team.visibility, to: b.visibility });
        }
      }
      if (b.workspaceId !== undefined) {
        if (!rights.orgAdmin) throw new HttpError(403, "only organization admins move teams between workspaces", "not_admin");
        if (b.workspaceId !== null && !(await acc.d1.prepare(`SELECT 1 AS x FROM workspaces WHERE id = ?1 AND org_id = ?2`).bind(b.workspaceId, orgId).first())) throw new HttpError(400, "no such workspace");
        if (b.workspaceId !== team.workspace_id) {
          await acc.d1.prepare(`UPDATE teams SET workspace_id = ?2, updated_at = ?3 WHERE id = ?1`).bind(team.id, b.workspaceId, now).run();
          lowered = true;
          await log("team_workspace_change", { from: team.workspace_id, to: b.workspaceId });
        }
      }
      if (lowered) await reauth(deps, await teamFileKeys(acc.d1, team.id));
      acc.reset();
      await tell();
      return json({ team: await teamInfo(ctx, (await acc.team(team.id))!) });
    }
    if (m === "DELETE") {
      live();
      if (!rights.owner && !rights.teamAdmin && !rights.orgAdmin) throw new HttpError(403, "only the team's owner and admins can delete it");
      await acc.d1.prepare(`UPDATE teams SET deleted_at = ?2, deleted_by = ?3, updated_at = ?2 WHERE id = ?1`).bind(team.id, now, user.id).run();
      await log("team_delete");
      await reauth(deps, await teamFileKeys(acc.d1, team.id));
      await tell();
      await orgNotice(deps, await teamUserIds(ctx, team), { what: "teams", orgId });
      return noContent();
    }
    throw new HttpError(405, "method not allowed");
  }

  switch (parts[2]) {
    // "Change icon" (help.figma.com 14949911189399: admins), docs/multiplayer.md §14.16
    case "icon": {
      if (parts.length !== 3) break;
      live();
      needAdmin();
      return teamIconRoute(ctx, team, async () => teamInfo(ctx, (await acc.team(team.id))!), tell);
    }
    case "restore": {
      if (parts.length !== 3 || m !== "POST") break;
      if (!rights.orgAdmin && !rights.owner) throw new HttpError(403, "only organization admins and the team's owner can restore it");
      await acc.d1.prepare(`UPDATE teams SET deleted_at = NULL, deleted_by = NULL, updated_at = ?2 WHERE id = ?1`).bind(team.id, now).run();
      await log("team_restore");
      acc.reset();
      await orgNotice(deps, await teamUserIds(ctx, team), { what: "teams", orgId });
      return json({ team: await teamInfo(ctx, (await acc.team(team.id))!) });
    }
    case "transfer": {
      if (parts.length !== 3 || m !== "POST") break;
      live();
      if (!rights.owner) throw new HttpError(403, "only the team's owner can transfer it");
      const { userId } = await body<{ userId?: unknown }>(ctx.req);
      const to = typeof userId === "string" ? await acc.d1.prepare(`SELECT email FROM team_members WHERE team_id = ?1 AND user_id = ?2`).bind(team.id, userId).first<{ email: string }>() : null;
      const inOrg = typeof userId === "string" ? await acc.d1.prepare(`SELECT role FROM org_members WHERE org_id = ?1 AND user_id = ?2`).bind(orgId, userId).first<{ role: OrgRole }>() : null;
      if (!to || !inOrg || inOrg.role === "guest") throw new HttpError(409, "the new owner must be a member of the team");
      await acc.d1.prepare(`UPDATE teams SET owner_id = ?2, updated_at = ?3 WHERE id = ?1`).bind(team.id, userId, now).run();
      await acc.d1.prepare(`UPDATE team_members SET role = 'editor', admin = 1 WHERE team_id = ?1 AND user_id IN (?2, ?3)`).bind(team.id, userId, user.id).run();
      await log("team_member_permission_change", { user_id: userId, owner: true, previous_owner: user.id });
      acc.reset();
      await tell();
      return json({ team: await teamInfo(ctx, (await acc.team(team.id))!) });
    }
    case "members": {
      live();
      if (parts.length === 3 && m === "GET") return json({ members: await teamMembers(ctx, team) });
      if (parts.length === 3 && m === "PUT") {
        if (!rights.editor) throw new HttpError(403, "only people who can edit the team can invite");
        const b = await body<{ email?: unknown; groupId?: unknown; role?: unknown; admin?: unknown }>(ctx.req);
        if (b.role !== "editor" && b.role !== "viewer") throw new HttpError(400, "role is editor or viewer");
        const admin = b.admin === true;
        if (admin && !rights.admin) throw new HttpError(403, "only admins make admins");
        const requestId = await putTeamMember(ctx, team, b.email, b.groupId, b.role, admin, rights.admin);
        if (requestId) return json({ members: await teamMembers(ctx, team), requested: true, requestId }, 202);
        await tell();
        return json({ members: await teamMembers(ctx, team) });
      }
      if (parts.length === 4 && (m === "PATCH" || m === "DELETE")) {
        const p = parsePrincipal(parts[3]);
        const self = p.kind === "u" && p.id === user.id;
        if (!rights.admin && !(m === "DELETE" && self)) throw new HttpError(403, "only the team's admins can do that");
        if (m === "PATCH") {
          const b = await body<{ role?: unknown; admin?: unknown }>(ctx.req);
          if (b.role !== undefined && b.role !== "editor" && b.role !== "viewer") throw new HttpError(400, "role is editor or viewer");
          await patchTeamMember(ctx, team, p, b.role as GrantRole | undefined, typeof b.admin === "boolean" ? b.admin : undefined);
        } else await removeTeamMember(ctx, team, p);
        await tell();
        return json({ members: await teamMembers(ctx, team) });
      }
      break;
    }
    case "join": {
      if (parts.length !== 3 || m !== "POST") break;
      live();
      const me = rights.membership;
      if (!me || me.role === "guest") throw new HttpError(403, "guests can't join teams");
      if (rights.inTeam) return json({ status: "joined" });
      requireInside(await acc.home(), orgId, "join teams");
      if (rights.audience) {
        const role: GrantRole = team.org_access === "editor" || (team.workspace_id === me.workspace_id && team.workspace_access === "editor") ? "editor" : "viewer";
        await acc.d1.prepare(`INSERT INTO team_members (team_id, email, user_id, role, admin, created_at) VALUES (?1, ?2, ?3, ?4, 0, ?5) ON CONFLICT (team_id, email) DO NOTHING`).bind(team.id, user.email, user.id, role, now).run();
        await log("team_member_add", { user_id: user.id, email: user.email, role, joined: true });
        await tell();
        return json({ status: "joined" });
      }
      if (team.visibility !== "visible") throw new HttpError(404, "no such team");
      const r = await acc.d1.prepare(`INSERT INTO team_requests (team_id, user_id, created_at) VALUES (?1, ?2, ?3) ON CONFLICT DO NOTHING RETURNING user_id`).bind(team.id, user.id, now).first();
      if (r) for (const id of await teamAdminIds(ctx, team)) await notifyOrg(deps, { userId: id, kind: "team_join_request", actorId: user.id, orgId, teamId: team.id, name: team.name, state: "pending" });
      return json({ status: "requested" });
    }
    case "requests": {
      live();
      needAdmin();
      if (parts.length === 3 && m === "GET") return json({ requests: await joinRequests(ctx, team) });
      if (parts.length === 4 && m === "POST") {
        const { approve } = await body<{ approve?: unknown }>(ctx.req);
        const req = await acc.d1.prepare(`DELETE FROM team_requests WHERE team_id = ?1 AND user_id = ?2 RETURNING user_id`).bind(team.id, parts[3]).first();
        if (!req) throw new HttpError(404, "no such request");
        const u = await acc.d1.prepare(`SELECT u.email FROM users u JOIN org_members m ON m.user_id = u.id AND m.org_id = ?2 WHERE u.id = ?1`).bind(parts[3], orgId).first<{ email: string }>();
        if (approve === true && u) {
          // "can edit" (unverified: the role Figma gives an approved request)
          await acc.d1.prepare(`INSERT INTO team_members (team_id, email, user_id, role, admin, invited_by, created_at) VALUES (?1, ?2, ?3, 'editor', 0, ?4, ?5) ON CONFLICT (team_id, email) DO NOTHING`).bind(team.id, u.email, parts[3], user.id, now).run();
          await log("team_member_add", { user_id: parts[3], email: u.email, role: "editor", request: true });
        }
        await settleOrg(deps, "team_join_request", orgId, parts[3], approve === true ? "approved" : "denied", team.id);
        await orgNotice(deps, [parts[3]], { what: "teams", orgId });
        return json({ requests: await joinRequests(ctx, team) });
      }
      break;
    }
    case "projects": {
      const { projectsOfTeamRoute } = await import("./projects");
      return projectsOfTeamRoute(ctx, team);
    }
    case "trash": {
      if (parts.length !== 3 || m !== "GET") break;
      if (!rights.editor) throw new HttpError(403, "only the team's editors and admins see its trash");
      const { projectSummaries } = await import("./projects");
      const { results } = await acc.d1.prepare(`SELECT * FROM projects WHERE team_id = ?1 AND trashed_at IS NOT NULL ORDER BY trashed_at DESC`).bind(team.id).all<ProjectRow>();
      return json({ projects: await projectSummaries(acc, results), files: await accessibleFiles(acc, `f.team_id = ?1 AND f.trashed_at IS NOT NULL`, [team.id], { trashed: true }) });
    }
  }
  throw new HttpError(404, "not found");
}

async function teamAdminIds(ctx: Ctx, t: TeamRow): Promise<string[]> {
  const { results } = await ctx.acc.d1.prepare(`SELECT user_id FROM team_members WHERE team_id = ?1 AND admin = 1 AND user_id IS NOT NULL`).bind(t.id).all<{ user_id: string }>();
  return [...new Set([t.owner_id, ...results.map((r) => r.user_id)])];
}

async function joinRequests(ctx: Ctx, t: TeamRow): Promise<JoinRequest[]> {
  const { results } = await ctx.acc.d1
    .prepare(`SELECT r.user_id, r.created_at, u.email, u.name, u.picture, m.role FROM team_requests r JOIN users u ON u.id = r.user_id LEFT JOIN org_members m ON m.user_id = r.user_id AND m.org_id = ?2 WHERE r.team_id = ?1 ORDER BY r.created_at`)
    .bind(t.id, t.org_id)
    .all<{ user_id: string; created_at: number; email: string; name: string | null; picture: string | null; role: OrgRole | null }>();
  return results.map((r) => ({ userId: r.user_id, createdAt: r.created_at, person: personRef({ id: r.user_id, email: r.email, name: r.name, picture: r.picture, role: r.role }) }));
}

export async function teamMembers(ctx: Ctx, t: TeamRow): Promise<TeamMember[]> {
  const d1 = ctx.acc.d1;
  const { results } = await d1
    .prepare(
      `SELECT tm.email, tm.user_id, tm.role, tm.admin, u.name, u.picture, m.role AS org_role FROM team_members tm LEFT JOIN users u ON u.id = tm.user_id
       LEFT JOIN org_members m ON m.org_id = ?2 AND m.email = tm.email WHERE tm.team_id = ?1 ORDER BY tm.created_at`,
    )
    .bind(t.id, t.org_id)
    .all<{ email: string; user_id: string | null; role: GrantRole; admin: number; name: string | null; picture: string | null; org_role: OrgRole | null }>();
  const out: TeamMember[] = results.map((r) => ({
    principal: (r.user_id ? `u:${r.user_id}` : `e:${r.email}`) as Principal,
    person: r.user_id ? personRef({ id: r.user_id, email: r.email, name: r.name, picture: r.picture, role: r.org_role }) : null,
    group: null,
    email: r.email,
    role: r.role,
    admin: r.admin === 1,
    owner: r.user_id === t.owner_id,
    pending: !r.user_id,
    guest: r.org_role === "guest",
  }));
  out.push(...(await groupMembers(ctx, "team", t.id)).map((g) => ({ ...g, admin: false })));
  // The owner first
  return out.sort((a, b) => Number(b.owner) - Number(a.owner));
}

export async function groupMembers(ctx: Ctx, type: "team" | "project" | "file", id: string) {
  const { results } = await ctx.acc.d1
    .prepare(`SELECT g.id, g.name, gg.role, (SELECT COUNT(*) FROM user_group_members x WHERE x.group_id = g.id) AS n FROM group_grants gg JOIN user_groups g ON g.id = gg.group_id WHERE gg.resource_type = ?1 AND gg.resource_id = ?2 ORDER BY g.name`)
    .bind(type, id)
    .all<{ id: string; name: string; role: GrantRole; n: number }>();
  return results.map((g) => ({ principal: `g:${g.id}` as Principal, person: null, group: { id: g.id, name: g.name, memberCount: g.n }, email: null, role: g.role, owner: false, pending: false, guest: false }));
}

/** A group granted on a team, folder or file: same org; guests share only with groups they're in. */
export async function grantGroup(ctx: Ctx, orgId: string, type: "team" | "project" | "file", id: string, groupId: string, role: GrantRole): Promise<{ name: string; was: GrantRole | null }> {
  const g = await ctx.acc.d1.prepare(`SELECT id, name FROM user_groups WHERE id = ?1 AND org_id = ?2`).bind(groupId, orgId).first<{ id: string; name: string }>();
  if (!g) throw new HttpError(400, "no such group");
  if ((await ctx.acc.membership(orgId))?.role === "guest" && !(await ctx.acc.groups(orgId)).includes(groupId)) throw new HttpError(403, "guests share only with groups they're in");
  const was = await ctx.acc.d1.prepare(`SELECT role FROM group_grants WHERE group_id = ?1 AND resource_type = ?2 AND resource_id = ?3`).bind(groupId, type, id).first<{ role: GrantRole }>();
  await ctx.acc.d1
    .prepare(`INSERT INTO group_grants (group_id, resource_type, resource_id, role, granted_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT (group_id, resource_type, resource_id) DO UPDATE SET role = ?4`)
    .bind(groupId, type, id, role, ctx.user.id, ctx.deps.now())
    .run();
  return { name: g.name, was: was?.role ?? null };
}

async function putTeamMember(ctx: Ctx, t: TeamRow, email: unknown, groupId: unknown, role: GrantRole, admin: boolean, byAdmin: boolean): Promise<string | null> {
  const { acc, deps, user } = ctx;
  const log = (action: Parameters<typeof logActivity>[1]["action"], details: Record<string, unknown>) => logActivity(deps, { orgId: t.org_id, action, actor: user, entity: teamEntity(t), teamId: t.id, details, req: ctx.req });
  if (typeof groupId === "string") {
    const g = await grantGroup(ctx, t.org_id, "team", t.id, groupId, role);
    await log(g.was ? "team_member_permission_change" : "team_member_add", { group_id: groupId, group_name: g.name, role, from: g.was });
    if (g.was === "editor" && role === "viewer") await reauth(deps, await teamFileKeys(acc.d1, t.id));
    return null;
  }
  if (typeof email !== "string" || !EMAIL.test(normalizeEmail(email))) throw new HttpError(400, "email or groupId");
  const e = normalizeEmail(email);
  const existing = await acc.d1.prepare(`SELECT role, admin, user_id FROM team_members WHERE team_id = ?1 AND email = ?2`).bind(t.id, e).first<{ role: GrantRole; admin: number; user_id: string | null }>();
  if (existing) {
    if (existing.user_id === t.owner_id) throw new HttpError(409, "the owner's role can't change");
    if (!byAdmin && (existing.admin === 1 || (existing.role === "editor" && role === "viewer"))) throw new HttpError(403, "only the team's admins can lower someone");
    await acc.d1.prepare(`UPDATE team_members SET role = ?3, admin = ?4 WHERE team_id = ?1 AND email = ?2`).bind(t.id, e, role, admin ? 1 : 0).run();
    await log("team_member_permission_change", { email: e, user_id: existing.user_id, role, admin, from: existing.role, from_admin: existing.admin === 1 });
    if (existing.user_id && ((existing.role === "editor" && role === "viewer") || (existing.admin === 1 && !admin))) await reauth(deps, await teamFileKeys(acc.d1, t.id), [existing.user_id]);
    return null;
  }
  const invited = await inviteEmail(ctx, t.org_id, e, { type: "team", id: t.id, name: t.name }, role);
  if (invited.kind === "requested") return invited.requestId;
  await acc.d1
    .prepare(`INSERT INTO team_members (team_id, email, user_id, role, admin, invited_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`)
    .bind(t.id, e, invited.userId, role, admin ? 1 : 0, user.id, deps.now())
    .run();
  // The team's org logs team_member_add; a captured person's home org (another org) its external twin (§15.9).
  await log("team_member_add", { email: e, user_id: invited.userId, role, admin, ...(invited.kind === "guest" ? { guest: true } : {}) });
  const person = await personById(acc.d1, invited.userId);
  if (person) await logExternal(deps, person, t.org_id, "team_member_add_external", teamEntity(t), { actor: user, details: { role }, req: ctx.req });
  if (invited.userId) {
    await notifyOrg(deps, { userId: invited.userId, kind: "team_invite", actorId: user.id, orgId: t.org_id, teamId: t.id, name: t.name, role });
    await orgNotice(deps, [invited.userId], { what: "teams", orgId: t.org_id });
  }
  acc.reset();
  return null;
}

async function patchTeamMember(ctx: Ctx, t: TeamRow, p: { kind: "u" | "e" | "g"; id: string }, role: GrantRole | undefined, admin: boolean | undefined): Promise<void> {
  const { acc } = ctx;
  if (p.kind === "g") {
    if (!role) return;
    await putTeamMember(ctx, t, undefined, p.id, role, false, true);
    return;
  }
  const row = await acc.d1.prepare(`SELECT email, role, admin FROM team_members WHERE team_id = ?1 AND ${p.kind === "u" ? "user_id" : "email"} = ?2`).bind(t.id, p.id).first<{ email: string; role: GrantRole; admin: number }>();
  if (!row) throw new HttpError(404, "no such member");
  await putTeamMember(ctx, t, row.email, undefined, role ?? row.role, admin ?? row.admin === 1, true);
}

async function removeTeamMember(ctx: Ctx, t: TeamRow, p: { kind: "u" | "e" | "g"; id: string }): Promise<void> {
  const { acc, deps, user } = ctx;
  const log = (action: Parameters<typeof logActivity>[1]["action"], details: Record<string, unknown>) => logActivity(deps, { orgId: t.org_id, action, actor: user, entity: teamEntity(t), teamId: t.id, details, req: ctx.req });
  if (p.kind === "g") {
    const r = await acc.d1.prepare(`DELETE FROM group_grants WHERE group_id = ?1 AND resource_type = 'team' AND resource_id = ?2 RETURNING group_id`).bind(p.id, t.id).first();
    if (!r) throw new HttpError(404, "no such member");
    await log("team_member_remove", { group_id: p.id });
    await reauth(deps, await teamFileKeys(acc.d1, t.id));
    return;
  }
  const row = await acc.d1
    .prepare(`SELECT tm.email, tm.user_id, m.role AS org_role FROM team_members tm LEFT JOIN org_members m ON m.org_id = ?3 AND m.email = tm.email WHERE tm.team_id = ?1 AND ${p.kind === "u" ? "tm.user_id" : "tm.email"} = ?2`)
    .bind(t.id, p.id, t.org_id)
    .first<{ email: string; user_id: string | null; org_role: OrgRole | null }>();
  if (!row) throw new HttpError(404, "no such member");
  if (row.user_id === t.owner_id) throw new HttpError(409, "transfer the team before its owner leaves");
  await acc.d1.prepare(`DELETE FROM team_members WHERE team_id = ?1 AND email = ?2`).bind(t.id, row.email).run();
  await log("team_member_remove", { email: row.email, user_id: row.user_id, ...(row.org_role === "guest" ? { guest: true } : {}) });
  const person = await personById(ctx.acc.d1, row.user_id);
  if (person) await logExternal(deps, person, t.org_id, "team_member_remove_external", teamEntity(t), { actor: user, req: ctx.req });
  if (row.user_id) {
    await reauth(deps, await teamFileKeys(acc.d1, t.id), [row.user_id]);
    await orgNotice(deps, [row.user_id], { what: "teams", orgId: t.org_id });
  }
  acc.reset();
}
