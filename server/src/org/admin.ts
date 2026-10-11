/**
 * Admin (docs/multiplayer.md §14.12 "Admin"; `/orgs/:org/admin/…`): org admins; workspace admins for their
 * workspaces' people and teams; billing group admins for their groups' people and seat requests.
 */
import type { AddPeopleInput, AdminDashboard, AdminPerson, AdminTeam, BillingGroup, GuestRequest, OrgRole, OrgSettings, OrgWorkspace, Seat, UnassignedDrafts, UpdatePeopleInput, WorkspacePatch } from "../../../src/shared/org/types";
import { ACTIVITY_CSV_HEADER, activityCsvRows, activityPage, fileEntity, logActivity, projectEntity, teamEntity, userEntity, workspaceEntity, type Entity } from "../activity";
import { normalizeEmail, type User } from "../db";
import { notifyOrg, orgNotice, settleOrg } from "../notifications";
import { FILE_COLS, personRef, settingsOf, toOrgFile, type FileRow, type MemberRow, type TeamRow } from "./db";
import { body, cleanName, csv, EMAIL, HttpError, json, nextCursor, noContent, paging, placeholders, randomId, type Ctx } from "./http";
import { addPerson, adminCount, joinDefaultTeams, orgUserIds, removeFromOrg, SEATS, seatRequest, setSeat } from "./orgs";
import { deleteFileForever } from "./projects";
import { orgFileKeys, reauth } from "./reauth";

interface Scope {
  me: MemberRow;
  org: boolean;
  workspaces: string[];
  billing: string[];
}

const ROLES: readonly OrgRole[] = ["admin", "member", "guest"];

export async function adminRoute(ctx: Ctx, orgId: string): Promise<Response> {
  const { parts, m, acc, url } = ctx;
  const me = await acc.requireMember(orgId, { guests: true });
  const scope: Scope = { me, org: me.role === "admin", workspaces: await acc.workspaceAdminOf(orgId), billing: await acc.billingAdminOf(orgId) };
  if (!scope.org && !scope.workspaces.length && !scope.billing.length) throw new HttpError(403, "only admins can open Admin", "not_admin");
  const orgOnly = () => {
    if (!scope.org) throw new HttpError(403, "only organization admins can do that", "not_admin");
  };
  const section = parts[3];
  const rest = parts.slice(4);

  switch (section) {
    case "dashboard":
      if (m === "GET" && !rest.length) return json(await dashboard(ctx, orgId));
      break;
    case "people": {
      if (!rest.length && m === "GET") return people(ctx, orgId, scope);
      if (!rest.length && m === "POST") {
        orgOnly();
        return json({ people: await addPeople(ctx, orgId, await body<AddPeopleInput>(ctx.req)) }, 201);
      }
      if (!rest.length && m === "PATCH") return json({ people: await updatePeople(ctx, orgId, scope, await body<UpdatePeopleInput>(ctx.req)) });
      if (rest[0] === "remove" && rest.length === 1 && m === "POST") {
        orgOnly();
        const { userIds } = await body<{ userIds?: unknown }>(ctx.req);
        const ids = strings(userIds);
        const admins = await adminCount(acc.d1, orgId);
        const { results } = await acc.d1.prepare(`SELECT COUNT(*) AS n FROM org_members WHERE org_id = ?1 AND role = 'admin' AND user_id IN (${placeholders(ids.length, 2)})`).bind(orgId, ...ids).all<{ n: number }>();
        if (ids.length && (results[0]?.n ?? 0) >= admins) throw new HttpError(409, "an organization needs at least one admin");
        for (const id of ids) await removeFromOrg(ctx.deps, orgId, id, ctx.user, ctx.req);
        return noContent();
      }
      break;
    }
    case "seat-requests": {
      if (!rest.length && m === "GET") return json({ requests: await seatRequests(ctx, orgId, scope, url.searchParams.get("state")) });
      if (rest.length === 1 && m === "POST") {
        const { approve } = await body<{ approve?: unknown }>(ctx.req);
        return json({ request: await answerSeat(ctx, orgId, scope, rest[0], approve === true) });
      }
      break;
    }
    case "guest-requests": {
      orgOnly();
      if (!rest.length && m === "GET") return json({ requests: await guestRequests(ctx, orgId) });
      if (rest.length === 1 && m === "POST") {
        const { approve } = await body<{ approve?: unknown }>(ctx.req);
        return json({ request: await answerGuest(ctx, orgId, rest[0], approve === true) });
      }
      break;
    }
    case "teams":
      if (!rest.length && m === "GET") return teams(ctx, orgId, scope);
      break;
    case "workspaces":
      return workspaces(ctx, orgId, scope, rest);
    case "billing-groups":
      orgOnly();
      return billingGroups(ctx, orgId, rest);
    case "activity": {
      orgOnly();
      if (rest.length || m !== "GET") break;
      const q = url.searchParams;
      const num = (k: string) => (q.get(k) !== null && q.get(k) !== "" && Number.isFinite(Number(q.get(k))) ? Number(q.get(k)) : undefined);
      const query = {
        events: q.get("events")?.split(",").map((s) => s.trim()).filter(Boolean),
        email: q.get("email") ?? undefined,
        teamId: q.get("team") ?? undefined,
        startTime: num("start_time"),
        endTime: num("end_time"),
        order: q.get("order") === "asc" ? ("asc" as const) : ("desc" as const),
        cursor: q.get("cursor") ?? undefined,
        limit: q.get("format") === "csv" ? 1000 : num("limit"),
      };
      const page = await activityPage(ctx.deps, orgId, query);
      if (q.get("format") === "csv") return csv(ACTIVITY_CSV_HEADER, activityCsvRows(page.activity_logs));
      return json(page);
    }
    case "settings": {
      orgOnly();
      if (rest.length) break;
      if (m === "GET") return json(await acc.settings(orgId));
      if (m === "PATCH") return json(await patchSettings(ctx, orgId, await body<Partial<OrgSettings>>(ctx.req)));
      break;
    }
    case "drafts": {
      orgOnly();
      if (!rest.length && m === "GET") return json({ owners: await unassignedDrafts(ctx, orgId) });
      if (rest[0] === "move" && m === "POST") {
        await moveDrafts(ctx, orgId, await body(ctx.req));
        return noContent();
      }
      if (rest[0] === "delete" && m === "POST") {
        const { fileKeys } = await body<{ fileKeys?: unknown }>(ctx.req);
        for (const f of await unassignedFiles(ctx, orgId, { fileKeys: strings(fileKeys) })) {
          await deleteFileForever(ctx, f.key);
          await logActivity(ctx.deps, { orgId, action: "fig_file_permanent_delete", actor: ctx.user, entity: fileEntity(f), details: { unassigned_draft: true }, req: ctx.req });
        }
        return noContent();
      }
      break;
    }
  }
  throw new HttpError(404, "not found");
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 500) : []);

async function dashboard(ctx: Ctx, orgId: string): Promise<AdminDashboard> {
  const d1 = ctx.acc.d1;
  const c = await d1
    .prepare(
      `SELECT SUM(role <> 'guest') AS members, SUM(role = 'guest') AS guests, SUM(seat = 'full') AS full, SUM(seat = 'dev') AS dev, SUM(seat = 'collab') AS collab, SUM(seat = 'view') AS view,
              SUM(last_active_at >= ?2) AS active,
              (SELECT COUNT(*) FROM seat_requests WHERE org_id = ?1 AND state = 'pending') AS seat_requests,
              (SELECT COUNT(*) FROM guest_requests WHERE org_id = ?1 AND state = 'pending') AS guest_requests,
              (SELECT COUNT(*) FROM teams WHERE org_id = ?1 AND deleted_at IS NULL) AS teams,
              (SELECT COUNT(*) FROM workspaces WHERE org_id = ?1) AS workspaces
       FROM org_members WHERE org_id = ?1`,
    )
    .bind(orgId, ctx.deps.now() - 30 * 86_400_000)
    .first<Record<string, number | null>>();
  const n = (k: string) => c?.[k] ?? 0;
  return { members: n("members"), guests: n("guests"), seats: { full: n("full"), dev: n("dev"), collab: n("collab"), view: n("view") }, pendingSeatRequests: n("seat_requests"), pendingGuestRequests: n("guest_requests"), teams: n("teams"), workspaces: n("workspaces"), activeLast30Days: n("active") };
}

interface PersonRow {
  email: string;
  user_id: string | null;
  role: OrgRole;
  seat: Seat;
  workspace_id: string | null;
  billing_group_id: string | null;
  last_active_at: number | null;
  created_at: number;
  name: string | null;
  picture: string | null;
  teams: number;
}

const toAdminPerson = (r: PersonRow): AdminPerson => ({
  // A pending invite has no account yet: its email stands for its id.
  id: r.user_id ?? r.email,
  email: r.email,
  name: r.name,
  picture: r.picture,
  role: r.role,
  seat: r.seat,
  workspaceId: r.workspace_id,
  billingGroupId: r.billing_group_id,
  lastActiveAt: r.last_active_at,
  joinedAt: r.created_at,
  pending: !r.user_id,
  teams: r.teams,
});

const PERSON_SELECT = `SELECT m.email, m.user_id, m.role, m.seat, m.workspace_id, m.billing_group_id, m.last_active_at, m.created_at, u.name, u.picture,
  (SELECT COUNT(*) FROM team_members tm JOIN teams t ON t.id = tm.team_id WHERE t.org_id = m.org_id AND tm.email = m.email AND t.deleted_at IS NULL) AS teams
  FROM org_members m LEFT JOIN users u ON u.id = m.user_id`;

/** The people a scope reaches: everyone (org admins), their workspaces' and billing groups' people. */
function scopeWhere(scope: Scope, args: unknown[]): string {
  if (scope.org) return "1";
  const parts: string[] = [];
  if (scope.workspaces.length) {
    parts.push(`m.workspace_id IN (${scope.workspaces.map((w) => (args.push(w), `?${args.length}`)).join(", ")})`);
  }
  if (scope.billing.length) {
    parts.push(`m.billing_group_id IN (${scope.billing.map((b) => (args.push(b), `?${args.length}`)).join(", ")})`);
  }
  return parts.length ? `(${parts.join(" OR ")})` : "0";
}

async function people(ctx: Ctx, orgId: string, scope: Scope): Promise<Response> {
  const q = ctx.url.searchParams;
  const args: unknown[] = [orgId];
  const where = [`m.org_id = ?1`, scopeWhere(scope, args)];
  const add = (sql: string, v: unknown) => {
    args.push(v);
    where.push(sql.replace("?", `?${args.length}`));
  };
  const text = q.get("text")?.trim().toLowerCase();
  if (text) {
    args.push(`%${text}%`);
    where.push(`(lower(m.email) LIKE ?${args.length} OR lower(COALESCE(u.name, '')) LIKE ?${args.length})`);
  }
  const role = q.get("role");
  if (role && ROLES.includes(role as OrgRole)) add(`m.role = ?`, role);
  const seat = q.get("seat");
  if (seat && SEATS.includes(seat as Seat)) add(`m.seat = ?`, seat);
  const ws = q.get("workspace");
  if (ws === "none") where.push(`m.workspace_id IS NULL`);
  else if (ws) add(`m.workspace_id = ?`, ws);
  const bg = q.get("billingGroup");
  if (bg === "none") where.push(`m.billing_group_id IS NULL`);
  else if (bg) add(`m.billing_group_id = ?`, bg);
  const before = Number(q.get("activeBefore"));
  if (before > 0) add(`(m.last_active_at IS NULL OR m.last_active_at < ?)`, before);
  const sql = `${PERSON_SELECT} WHERE ${where.join(" AND ")} ORDER BY COALESCE(u.name, m.email)`;
  const { results } = await ctx.acc.d1.prepare(sql).bind(...args).all<PersonRow>();
  if (q.get("format") === "csv") {
    await logActivity(ctx.deps, { orgId, action: "roster_exported", actor: ctx.user, entity: await orgEntityOf(ctx, orgId), details: { count: results.length }, req: ctx.req });
    return csv(
      ["name", "email", "role", "seat", "workspace_id", "billing_group_id", "teams", "last_active", "joined", "pending"],
      results.map((r) => [r.name ?? "", r.email, r.role, r.seat, r.workspace_id ?? "", r.billing_group_id ?? "", r.teams, r.last_active_at ? new Date(r.last_active_at).toISOString() : "", new Date(r.created_at).toISOString(), !r.user_id]),
    );
  }
  const { offset, limit } = paging(ctx.url);
  return json({ items: results.slice(offset, offset + limit).map(toAdminPerson), cursor: nextCursor(offset, limit, results.length), total: results.length });
}

const orgEntityOf = async (ctx: Ctx, orgId: string): Promise<Entity> => ({ type: "org", id: orgId, name: (await ctx.acc.org(orgId))?.name ?? "" });

async function peopleByIds(ctx: Ctx, orgId: string, ids: string[]): Promise<AdminPerson[]> {
  if (!ids.length) return [];
  const { results } = await ctx.acc.d1
    .prepare(`${PERSON_SELECT} WHERE m.org_id = ?1 AND (m.user_id IN (${placeholders(ids.length, 2)}) OR m.email IN (${placeholders(ids.length, 2 + ids.length)}))`)
    .bind(orgId, ...ids, ...ids)
    .all<PersonRow>();
  return results.map(toAdminPerson);
}

async function addPeople(ctx: Ctx, orgId: string, input: AddPeopleInput): Promise<AdminPerson[]> {
  const emails = strings(input.emails).map(normalizeEmail);
  if (!emails.length || emails.some((e) => !EMAIL.test(e))) throw new HttpError(400, "emails");
  if (!ROLES.includes(input.role)) throw new HttpError(400, "role is admin, member or guest");
  const settings = await ctx.acc.settings(orgId);
  const seat = input.seat ?? settings.defaultSeat;
  if (!SEATS.includes(seat)) throw new HttpError(400, "seat");
  const ws = input.workspaceId ?? null;
  if (ws && !(await ctx.acc.d1.prepare(`SELECT 1 AS x FROM workspaces WHERE id = ?1 AND org_id = ?2`).bind(ws, orgId).first())) throw new HttpError(400, "no such workspace");
  const bg = input.billingGroupId ?? null;
  if (bg && !(await ctx.acc.d1.prepare(`SELECT 1 AS x FROM billing_groups WHERE id = ?1 AND org_id = ?2`).bind(bg, orgId).first())) throw new HttpError(400, "no such billing group");
  for (const e of emails) await addPerson(ctx.deps, orgId, e, input.role, seat, { by: ctx.user, workspaceId: input.role === "guest" ? null : ws, billingGroupId: bg, req: ctx.req });
  return peopleByIds(ctx, orgId, emails);
}

async function updatePeople(ctx: Ctx, orgId: string, scope: Scope, input: UpdatePeopleInput): Promise<AdminPerson[]> {
  const { deps, user, acc } = ctx;
  const d1 = acc.d1;
  const ids = strings(input.userIds);
  const rows: (MemberRow & { name: string | null })[] = [];
  for (const id of ids) {
    const r = await d1.prepare(`SELECT m.*, u.name FROM org_members m LEFT JOIN users u ON u.id = m.user_id WHERE m.org_id = ?1 AND (m.user_id = ?2 OR (m.user_id IS NULL AND m.email = ?2))`).bind(orgId, id).first<MemberRow & { name: string | null }>();
    if (!r) throw new HttpError(404, `${id} isn't in the organization`);
    const reach = scope.org || (r.workspace_id !== null && scope.workspaces.includes(r.workspace_id)) || (r.billing_group_id !== null && scope.billing.includes(r.billing_group_id));
    if (!reach) throw new HttpError(403, "outside your admin reach", "not_admin");
    rows.push(r);
  }
  if ((input.role !== undefined || input.workspaceId !== undefined || input.billingGroupId !== undefined) && !scope.org) throw new HttpError(403, "only organization admins can change roles, workspaces and billing groups", "not_admin");
  if (input.role !== undefined) {
    if (!ROLES.includes(input.role)) throw new HttpError(400, "role is admin, member or guest");
    const losing = rows.filter((r) => r.role === "admin" && input.role !== "admin" && r.user_id).length;
    if (losing && losing >= (await adminCount(d1, orgId))) throw new HttpError(409, "an organization needs at least one admin");
  }
  if (input.seat !== undefined && !SEATS.includes(input.seat)) throw new HttpError(400, "seat");
  for (const r of rows) {
    const entity = userEntity({ id: r.user_id ?? r.email, email: r.email, name: r.name });
    if (input.role !== undefined && input.role !== r.role) {
      await d1.prepare(`UPDATE org_members SET role = ?3 WHERE org_id = ?1 AND email = ?2`).bind(orgId, r.email, input.role).run();
      await logActivity(deps, { orgId, action: "org_user_permission_change", actor: user, entity, details: { from: r.role, to: input.role }, req: ctx.req });
      if (r.user_id && (r.role === "admin" || input.role === "guest")) await reauth(deps, await orgFileKeys(d1, orgId), [r.user_id]);
    }
    if (input.seat !== undefined && input.seat !== r.seat) {
      if (r.user_id) await setSeat(deps, orgId, r.user_id, input.seat, user, ctx.req);
      else await d1.prepare(`UPDATE org_members SET seat = ?3, seat_changed_at = ?4 WHERE org_id = ?1 AND email = ?2`).bind(orgId, r.email, input.seat, deps.now()).run();
    }
    if (input.workspaceId !== undefined && input.workspaceId !== r.workspace_id) {
      const w = input.workspaceId ? await d1.prepare(`SELECT id, name FROM workspaces WHERE id = ?1 AND org_id = ?2`).bind(input.workspaceId, orgId).first<{ id: string; name: string }>() : null;
      if (input.workspaceId && !w) throw new HttpError(400, "no such workspace");
      await setWorkspace(ctx, orgId, r, w);
    }
    if (input.billingGroupId !== undefined && input.billingGroupId !== r.billing_group_id) {
      if (input.billingGroupId && !(await d1.prepare(`SELECT 1 AS x FROM billing_groups WHERE id = ?1 AND org_id = ?2`).bind(input.billingGroupId, orgId).first())) throw new HttpError(400, "no such billing group");
      await d1.prepare(`UPDATE org_members SET billing_group_id = ?3 WHERE org_id = ?1 AND email = ?2`).bind(orgId, r.email, input.billingGroupId).run();
      await logActivity(deps, { orgId, action: "license_group_membership_change", actor: user, entity, details: { from: r.billing_group_id, to: input.billingGroupId }, req: ctx.req });
    }
    if (r.user_id) await orgNotice(deps, [r.user_id], { type: "orgs.changed" });
  }
  return peopleByIds(ctx, orgId, ids);
}

async function setWorkspace(ctx: Ctx, orgId: string, r: MemberRow & { name: string | null }, w: { id: string; name: string } | null): Promise<void> {
  const { deps, user, acc } = ctx;
  await acc.d1.prepare(`UPDATE org_members SET workspace_id = ?3 WHERE org_id = ?1 AND email = ?2`).bind(orgId, r.email, w?.id ?? null).run();
  const details = { user_id: r.user_id, email: r.email };
  if (r.workspace_id) {
    const old = await acc.d1.prepare(`SELECT id, name FROM workspaces WHERE id = ?1`).bind(r.workspace_id).first<{ id: string; name: string }>();
    if (old) await logActivity(deps, { orgId, action: "workspace_member_remove", actor: user, entity: workspaceEntity(old), details, req: ctx.req });
    if (r.user_id) await reauth(deps, await orgFileKeys(acc.d1, orgId), [r.user_id]);
  }
  if (w) {
    await logActivity(deps, { orgId, action: "workspace_member_add", actor: user, entity: workspaceEntity(w), details, req: ctx.req });
    if (r.role !== "guest") await joinDefaultTeams(deps, w.id, r.email, r.user_id, user);
  }
}

async function seatRequests(ctx: Ctx, orgId: string, scope: Scope, state: string | null) {
  const args: unknown[] = [orgId];
  const where = scopeWhere(scope, args);
  args.push(state === "approved" || state === "denied" || state === "all" ? state : "pending");
  const { results } = await ctx.acc.d1
    .prepare(`SELECT s.id FROM seat_requests s LEFT JOIN org_members m ON m.org_id = s.org_id AND m.user_id = s.user_id WHERE s.org_id = ?1 AND ${where} AND (?${args.length} = 'all' OR s.state = ?${args.length}) ORDER BY s.created_at DESC`)
    .bind(...args)
    .all<{ id: string }>();
  const out = [];
  for (const r of results) out.push((await seatRequest(ctx.acc.d1, r.id))!);
  return out;
}

async function answerSeat(ctx: Ctx, orgId: string, scope: Scope, id: string, approve: boolean) {
  const { deps, user, acc } = ctx;
  const req = await seatRequest(acc.d1, id);
  if (!req || req.orgId !== orgId) throw new HttpError(404, "no such request");
  const m = await acc.d1.prepare(`SELECT * FROM org_members WHERE org_id = ?1 AND user_id = ?2`).bind(orgId, req.userId).first<MemberRow>();
  const reach = scope.org || (m?.workspace_id && scope.workspaces.includes(m.workspace_id)) || (m?.billing_group_id && scope.billing.includes(m.billing_group_id));
  if (!reach) throw new HttpError(404, "no such request");
  if (req.state !== "pending") return req;
  await acc.d1.prepare(`UPDATE seat_requests SET state = ?2, answered_by = ?3, answered_at = ?4 WHERE id = ?1`).bind(id, approve ? "approved" : "denied", user.id, deps.now()).run();
  const entity = userEntity({ id: req.userId, email: req.person.email, name: req.person.name });
  if (approve && m) await setSeat(deps, orgId, req.userId, req.seat, user, ctx.req);
  await logActivity(deps, { orgId, action: approve ? "org_user_account_type_upgrade_approved" : "org_user_account_type_upgrade_denied", actor: user, entity, details: { seat: req.seat }, req: ctx.req });
  const org = (await acc.org(orgId))!;
  await settleOrg(deps, "seat_request", orgId, req.userId, approve ? "approved" : "denied");
  await notifyOrg(deps, { userId: req.userId, kind: approve ? "seat_request_approved" : "seat_request_denied", actorId: user.id, orgId, name: org.name, role: req.seat });
  return (await seatRequest(acc.d1, id))!;
}

interface GuestRow {
  id: string;
  email: string;
  invited_by: string;
  resource_type: "team" | "project" | "file";
  resource_id: string;
  role: "editor" | "viewer";
  state: "pending" | "approved" | "denied";
  created_at: number;
  i_email: string;
  i_name: string | null;
  i_picture: string | null;
  i_role: OrgRole | null;
}

async function guestRequest(ctx: Ctx, orgId: string, r: GuestRow): Promise<GuestRequest> {
  const table = r.resource_type === "team" ? `SELECT name FROM teams WHERE id = ?1` : r.resource_type === "project" ? `SELECT name FROM projects WHERE id = ?1` : `SELECT name FROM files WHERE key = ?1`;
  const res = await ctx.acc.d1.prepare(table).bind(r.resource_id).first<{ name: string }>();
  return { id: r.id, email: r.email, invitedBy: personRef({ id: r.invited_by, email: r.i_email, name: r.i_name, picture: r.i_picture, role: r.i_role }), resource: { type: r.resource_type, id: r.resource_id, name: res?.name ?? "" }, role: r.role, state: r.state, createdAt: r.created_at };
}

const GUEST_SELECT = `SELECT g.*, u.email AS i_email, u.name AS i_name, u.picture AS i_picture, m.role AS i_role FROM guest_requests g JOIN users u ON u.id = g.invited_by LEFT JOIN org_members m ON m.org_id = g.org_id AND m.user_id = g.invited_by`;

async function guestRequests(ctx: Ctx, orgId: string): Promise<GuestRequest[]> {
  const state = ctx.url.searchParams.get("state");
  const { results } = await ctx.acc.d1
    .prepare(`${GUEST_SELECT} WHERE g.org_id = ?1 AND (?2 = 'all' OR g.state = ?2) ORDER BY g.created_at DESC`)
    .bind(orgId, state === "approved" || state === "denied" || state === "all" ? state : "pending")
    .all<GuestRow>();
  const out: GuestRequest[] = [];
  for (const r of results) out.push(await guestRequest(ctx, orgId, r));
  return out;
}

/** An admin answers a guest invite held for approval: approved, the email joins as a guest with the grant it was given. */
async function answerGuest(ctx: Ctx, orgId: string, id: string, approve: boolean): Promise<GuestRequest> {
  const { deps, user, acc } = ctx;
  const d1 = acc.d1;
  const r = await d1.prepare(`${GUEST_SELECT} WHERE g.id = ?1 AND g.org_id = ?2`).bind(id, orgId).first<GuestRow>();
  if (!r) throw new HttpError(404, "no such request");
  if (r.state === "pending") {
    await d1.prepare(`UPDATE guest_requests SET state = ?2, answered_by = ?3, answered_at = ?4 WHERE id = ?1`).bind(id, approve ? "approved" : "denied", user.id, deps.now()).run();
    if (approve) {
      const added = await addPerson(deps, orgId, r.email, "guest", (await acc.settings(orgId)).defaultSeat, { by: user, req: ctx.req, details: { guest_request: id } });
      const now = deps.now();
      if (r.resource_type === "team") await d1.prepare(`INSERT INTO team_members (team_id, email, user_id, role, invited_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT DO NOTHING`).bind(r.resource_id, r.email, added.userId, r.role, r.invited_by, now).run();
      else if (r.resource_type === "project") await d1.prepare(`INSERT INTO project_members (project_id, email, user_id, role, invited_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT DO NOTHING`).bind(r.resource_id, r.email, added.userId, r.role, r.invited_by, now).run();
      else await d1.prepare(`INSERT INTO members (file_key, email, user_id, role, invited_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT DO NOTHING`).bind(r.resource_id, r.email, added.userId, r.role, r.invited_by, now).run();
      await logActivity(deps, { orgId, action: "org_join_request_approve", actor: user, entity: userEntity({ id: added.userId ?? r.email, email: r.email, name: null }), details: { resource_type: r.resource_type, resource_id: r.resource_id, role: r.role }, req: ctx.req });
    }
    await settleOrg(deps, "guest_request", orgId, r.invited_by, approve ? "approved" : "denied");
  }
  return guestRequest(ctx, orgId, (await d1.prepare(`${GUEST_SELECT} WHERE g.id = ?1`).bind(id).first<GuestRow>())!);
}

async function teams(ctx: Ctx, orgId: string, scope: Scope): Promise<Response> {
  const q = ctx.url.searchParams;
  const args: unknown[] = [orgId];
  const where = [`t.org_id = ?1`];
  if (!scope.org) {
    if (!scope.workspaces.length) throw new HttpError(403, "only organization and workspace admins see teams", "not_admin");
    where.push(`t.workspace_id IN (${scope.workspaces.map((w) => (args.push(w), `?${args.length}`)).join(", ")})`);
  }
  const text = q.get("text")?.trim().toLowerCase();
  if (text) {
    args.push(`%${text}%`);
    where.push(`lower(t.name) LIKE ?${args.length}`);
  }
  const ws = q.get("workspace");
  if (ws === "none") where.push(`t.workspace_id IS NULL`);
  else if (ws) {
    args.push(ws);
    where.push(`t.workspace_id = ?${args.length}`);
  }
  if (q.get("includeHidden") !== "1") where.push(`t.visibility = 'visible'`);
  if (q.get("includeDeleted") !== "1") where.push(`t.deleted_at IS NULL`);
  const { results } = await ctx.acc.d1
    .prepare(
      `SELECT t.*, u.name AS owner_name, u.email AS owner_email,
              (SELECT COUNT(*) FROM team_members WHERE team_id = t.id) AS members, (SELECT COUNT(*) FROM team_members WHERE team_id = t.id AND admin = 1) AS admins,
              (SELECT COUNT(*) FROM projects WHERE team_id = t.id AND parent_id IS NULL AND trashed_at IS NULL) AS projects,
              (SELECT COUNT(*) FROM files WHERE team_id = t.id AND trashed_at IS NULL) AS files, (SELECT MAX(updated_at) FROM files WHERE team_id = t.id) AS last_edit
       FROM teams t LEFT JOIN users u ON u.id = t.owner_id WHERE ${where.join(" AND ")} ORDER BY t.name`,
    )
    .bind(...args)
    .all<TeamRow & { owner_name: string | null; owner_email: string | null; members: number; admins: number; projects: number; files: number; last_edit: number | null }>();
  const items: AdminTeam[] = results.map((t) => ({
    id: t.id,
    name: t.name,
    icon: t.icon,
    workspaceId: t.workspace_id,
    visibility: t.visibility,
    orgAccess: t.org_access,
    workspaceAccess: t.workspace_access,
    me: null,
    memberCount: t.members,
    projectCount: t.projects,
    description: t.description,
    ownerId: t.owner_id,
    createdAt: t.created_at,
    deletedAt: t.deleted_at,
    ownerName: t.owner_name || t.owner_email,
    adminCount: t.admins,
    fileCount: t.files,
    lastEditedAt: t.last_edit,
  }));
  if (q.get("format") === "csv") {
    await logActivity(ctx.deps, { orgId, action: scope.org ? "org_team_csv_exported" : "workspace_team_csv_exported", actor: ctx.user, entity: await orgEntityOf(ctx, orgId), details: { count: items.length }, req: ctx.req });
    return csv(
      ["name", "owner", "workspace_id", "visibility", "org_access", "members", "admins", "folders", "files", "last_edited", "deleted"],
      items.map((t) => [t.name, t.ownerName ?? "", t.workspaceId ?? "", t.visibility, t.orgAccess, t.memberCount, t.adminCount, t.projectCount, t.fileCount, t.lastEditedAt ? new Date(t.lastEditedAt).toISOString() : "", t.deletedAt ? new Date(t.deletedAt).toISOString() : ""]),
    );
  }
  const { offset, limit } = paging(ctx.url);
  return json({ items: items.slice(offset, offset + limit), cursor: nextCursor(offset, limit, items.length), total: items.length });
}

async function workspaceOf(ctx: Ctx, orgId: string, id: string): Promise<OrgWorkspace | null> {
  const d1 = ctx.acc.d1;
  const w = await d1.prepare(`SELECT * FROM workspaces WHERE id = ?1 AND org_id = ?2`).bind(id, orgId).first<{ id: string; name: string; hidden: number; created_at: number }>();
  if (!w) return null;
  const { results: admins } = await d1
    .prepare(`SELECT u.id, u.email, u.name, u.picture, m.role FROM workspace_admins a JOIN users u ON u.id = a.user_id LEFT JOIN org_members m ON m.org_id = ?2 AND m.user_id = u.id WHERE a.workspace_id = ?1`)
    .bind(id, orgId)
    .all<{ id: string; email: string; name: string | null; picture: string | null; role: OrgRole | null }>();
  const { results: defaults } = await d1.prepare(`SELECT team_id FROM workspace_default_teams WHERE workspace_id = ?1`).bind(id).all<{ team_id: string }>();
  const c = await d1.prepare(`SELECT (SELECT COUNT(*) FROM org_members WHERE workspace_id = ?1) AS members, (SELECT COUNT(*) FROM teams WHERE workspace_id = ?1 AND deleted_at IS NULL) AS teams`).bind(id).first<{ members: number; teams: number }>();
  return { id: w.id, name: w.name, hidden: w.hidden === 1, admins: admins.map(personRef), defaultTeamIds: defaults.map((d) => d.team_id), memberCount: c?.members ?? 0, teamCount: c?.teams ?? 0, createdAt: w.created_at };
}

async function workspaces(ctx: Ctx, orgId: string, scope: Scope, rest: string[]): Promise<Response> {
  const { m, acc, deps, user } = ctx;
  const d1 = acc.d1;
  const now = deps.now();
  if (!rest.length && m === "GET") {
    const { results } = await d1.prepare(`SELECT id FROM workspaces WHERE org_id = ?1 ORDER BY name`).bind(orgId).all<{ id: string }>();
    const out: OrgWorkspace[] = [];
    for (const r of results) if (scope.org || scope.workspaces.includes(r.id)) out.push((await workspaceOf(ctx, orgId, r.id))!);
    return json({ workspaces: out });
  }
  if (!rest.length && m === "POST") {
    if (!scope.org) throw new HttpError(403, "only organization admins create workspaces", "not_admin");
    const b = await body<{ name?: unknown; adminIds?: unknown; hidden?: unknown }>(ctx.req);
    const name = cleanName(b.name, "name", 100);
    const adminIds = strings(b.adminIds);
    if (!adminIds.length) throw new HttpError(400, "a workspace needs at least one admin");
    await requireOrgUsers(ctx, orgId, adminIds);
    const id = randomId();
    await d1.prepare(`INSERT INTO workspaces (id, org_id, name, hidden, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)`).bind(id, orgId, name, b.hidden === true ? 1 : 0, now).run();
    await logActivity(deps, { orgId, action: "workspace_create", actor: user, entity: workspaceEntity({ id, name }), req: ctx.req });
    await setWorkspaceAdmins(ctx, orgId, { id, name }, adminIds);
    return json({ workspace: await workspaceOf(ctx, orgId, id) }, 201);
  }
  const w = rest[0] ? await d1.prepare(`SELECT id, name, hidden FROM workspaces WHERE id = ?1 AND org_id = ?2`).bind(rest[0], orgId).first<{ id: string; name: string; hidden: number }>() : null;
  if (!w || rest.length !== 1 || (!scope.org && !scope.workspaces.includes(w.id))) throw new HttpError(404, "no such workspace");
  const log = (action: Parameters<typeof logActivity>[1]["action"], details: Record<string, unknown> = {}, name = w.name) => logActivity(deps, { orgId, action, actor: user, entity: workspaceEntity({ id: w.id, name }), details, req: ctx.req });
  if (m === "PATCH") {
    const b = await body<WorkspacePatch>(ctx.req);
    if ((b.adminIds !== undefined || b.hidden !== undefined || b.teams !== undefined) && !scope.org) throw new HttpError(403, "only organization admins can do that", "not_admin");
    if (b.name !== undefined) {
      const name = cleanName(b.name, "name", 100);
      if (name !== w.name) {
        await d1.prepare(`UPDATE workspaces SET name = ?2, updated_at = ?3 WHERE id = ?1`).bind(w.id, name, now).run();
        await log("workspace_rename", { old_name: w.name }, name);
      }
    }
    if (b.hidden !== undefined && (b.hidden ? 1 : 0) !== w.hidden) {
      await d1.prepare(`UPDATE workspaces SET hidden = ?2, updated_at = ?3 WHERE id = ?1`).bind(w.id, b.hidden ? 1 : 0, now).run();
      await log("workspace_visibility_setting_change", { hidden: !!b.hidden });
    }
    if (b.adminIds !== undefined) {
      const ids = strings(b.adminIds);
      if (!ids.length) throw new HttpError(400, "a workspace needs at least one admin");
      await requireOrgUsers(ctx, orgId, ids);
      await setWorkspaceAdmins(ctx, orgId, w, ids);
    }
    if (b.teams) {
      for (const t of strings(b.teams.add)) await moveTeamToWorkspace(ctx, orgId, t, w.id);
      for (const t of strings(b.teams.remove)) await moveTeamToWorkspace(ctx, orgId, t, null, w.id);
    }
    if (b.defaultTeamIds !== undefined) {
      const ids = strings(b.defaultTeamIds);
      for (const t of ids) if (!(await d1.prepare(`SELECT 1 AS x FROM teams WHERE id = ?1 AND org_id = ?2`).bind(t, orgId).first())) throw new HttpError(400, `no such team ${t}`);
      await d1.prepare(`DELETE FROM workspace_default_teams WHERE workspace_id = ?1`).bind(w.id).run();
      for (const t of ids) await d1.prepare(`INSERT INTO workspace_default_teams (workspace_id, team_id) VALUES (?1, ?2)`).bind(w.id, t).run();
      // Existing members join the new default teams (§14.1), never its guests.
      const { results } = await d1.prepare(`SELECT email, user_id FROM org_members WHERE org_id = ?1 AND workspace_id = ?2 AND role <> 'guest'`).bind(orgId, w.id).all<{ email: string; user_id: string | null }>();
      for (const r of results) await joinDefaultTeams(deps, w.id, r.email, r.user_id, user);
    }
    if (b.members) {
      for (const id of strings(b.members.add)) {
        const r = await d1.prepare(`SELECT m.*, u.name FROM org_members m LEFT JOIN users u ON u.id = m.user_id WHERE m.org_id = ?1 AND m.user_id = ?2`).bind(orgId, id).first<MemberRow & { name: string | null }>();
        if (!r) throw new HttpError(400, `${id} isn't in the organization`);
        if (r.workspace_id !== w.id) await setWorkspace(ctx, orgId, r, w);
      }
      for (const id of strings(b.members.remove)) {
        const r = await d1.prepare(`SELECT m.*, u.name FROM org_members m LEFT JOIN users u ON u.id = m.user_id WHERE m.org_id = ?1 AND m.user_id = ?2 AND m.workspace_id = ?3`).bind(orgId, id, w.id).first<MemberRow & { name: string | null }>();
        if (r) await setWorkspace(ctx, orgId, r, null);
      }
    }
    return json({ workspace: await workspaceOf(ctx, orgId, w.id) });
  }
  if (m === "DELETE") {
    if (!scope.org) throw new HttpError(403, "only organization admins delete workspaces", "not_admin");
    await d1.prepare(`DELETE FROM workspaces WHERE id = ?1`).bind(w.id).run();
    await log("workspace_delete");
    // Its teams and people are unassigned (ON DELETE SET NULL): workspace audiences and admins lapse.
    await reauth(deps, await orgFileKeys(d1, orgId));
    await orgNotice(deps, await orgUserIds(d1, orgId), { type: "org.updated", orgId });
    return noContent();
  }
  throw new HttpError(405, "method not allowed");
}

async function requireOrgUsers(ctx: Ctx, orgId: string, ids: string[]): Promise<void> {
  for (const id of ids) if (!(await ctx.acc.d1.prepare(`SELECT 1 AS x FROM org_members WHERE org_id = ?1 AND user_id = ?2 AND role <> 'guest'`).bind(orgId, id).first())) throw new HttpError(400, `${id} isn't a member of the organization`);
}

async function setWorkspaceAdmins(ctx: Ctx, orgId: string, w: { id: string; name: string }, ids: string[]): Promise<void> {
  const d1 = ctx.acc.d1;
  const { results } = await d1.prepare(`SELECT user_id FROM workspace_admins WHERE workspace_id = ?1`).bind(w.id).all<{ user_id: string }>();
  const had = new Set(results.map((r) => r.user_id));
  const add = ids.filter((i) => !had.has(i));
  const remove = [...had].filter((i) => !ids.includes(i));
  for (const id of add) await d1.prepare(`INSERT INTO workspace_admins (workspace_id, user_id) VALUES (?1, ?2)`).bind(w.id, id).run();
  for (const id of remove) await d1.prepare(`DELETE FROM workspace_admins WHERE workspace_id = ?1 AND user_id = ?2`).bind(w.id, id).run();
  if (add.length) await logActivity(ctx.deps, { orgId, action: "workspace_admins_add", actor: ctx.user, entity: workspaceEntity(w), details: { user_ids: add }, req: ctx.req });
  if (remove.length) {
    await logActivity(ctx.deps, { orgId, action: "workspace_admins_remove", actor: ctx.user, entity: workspaceEntity(w), details: { user_ids: remove }, req: ctx.req });
    await reauth(ctx.deps, await orgFileKeys(d1, orgId), remove);
  }
  await orgNotice(ctx.deps, [...add, ...remove], { type: "orgs.changed" });
}

async function moveTeamToWorkspace(ctx: Ctx, orgId: string, teamId: string, to: string | null, from?: string): Promise<void> {
  const t = await ctx.acc.d1.prepare(`SELECT * FROM teams WHERE id = ?1 AND org_id = ?2`).bind(teamId, orgId).first<TeamRow>();
  if (!t) throw new HttpError(400, `no such team ${teamId}`);
  if (from !== undefined && t.workspace_id !== from) return;
  if (t.workspace_id === to) return;
  await ctx.acc.d1.prepare(`UPDATE teams SET workspace_id = ?2, updated_at = ?3 WHERE id = ?1`).bind(teamId, to, ctx.deps.now()).run();
  await logActivity(ctx.deps, { orgId, action: "team_workspace_change", actor: ctx.user, entity: teamEntity(t), teamId, details: { from: t.workspace_id, to }, req: ctx.req });
  await reauth(ctx.deps, (await ctx.acc.d1.prepare(`SELECT key FROM files WHERE team_id = ?1`).bind(teamId).all<{ key: string }>()).results.map((r) => r.key));
}

async function billingGroupOf(ctx: Ctx, orgId: string, id: string): Promise<BillingGroup | null> {
  const d1 = ctx.acc.d1;
  const b = await d1.prepare(`SELECT id, name FROM billing_groups WHERE id = ?1 AND org_id = ?2`).bind(id, orgId).first<{ id: string; name: string }>();
  if (!b) return null;
  const { results: admins } = await d1
    .prepare(`SELECT u.id, u.email, u.name, u.picture, m.role FROM billing_group_admins a JOIN users u ON u.id = a.user_id LEFT JOIN org_members m ON m.org_id = ?2 AND m.user_id = u.id WHERE a.billing_group_id = ?1`)
    .bind(id, orgId)
    .all<{ id: string; email: string; name: string | null; picture: string | null; role: OrgRole | null }>();
  const c = await d1.prepare(`SELECT COUNT(*) AS n FROM org_members WHERE billing_group_id = ?1`).bind(id).first<{ n: number }>();
  return { id: b.id, name: b.name, admins: admins.map(personRef), memberCount: c?.n ?? 0 };
}

async function billingGroups(ctx: Ctx, orgId: string, rest: string[]): Promise<Response> {
  const { m, acc, deps, user } = ctx;
  const d1 = acc.d1;
  const entity = (b: { id: string; name: string }): Entity => ({ type: "org", id: `bg:${b.id}`, name: b.name, license_group_id: b.id });
  const log = (action: Parameters<typeof logActivity>[1]["action"], b: { id: string; name: string }, details: Record<string, unknown> = {}) => logActivity(deps, { orgId, action, actor: user, entity: entity(b), details, req: ctx.req });
  const setAdmins = async (b: { id: string; name: string }, ids: string[]) => {
    await requireOrgUsers(ctx, orgId, ids);
    const { results } = await d1.prepare(`SELECT user_id FROM billing_group_admins WHERE billing_group_id = ?1`).bind(b.id).all<{ user_id: string }>();
    const had = new Set(results.map((r) => r.user_id));
    const add = ids.filter((i) => !had.has(i));
    const remove = [...had].filter((i) => !ids.includes(i));
    for (const id of add) await d1.prepare(`INSERT INTO billing_group_admins (billing_group_id, user_id) VALUES (?1, ?2)`).bind(b.id, id).run();
    for (const id of remove) await d1.prepare(`DELETE FROM billing_group_admins WHERE billing_group_id = ?1 AND user_id = ?2`).bind(b.id, id).run();
    if (add.length) await log("license_group_admins_add", b, { user_ids: add });
    if (remove.length) await log("license_group_admins_remove", b, { user_ids: remove });
  };
  if (!rest.length && m === "GET") {
    const { results } = await d1.prepare(`SELECT id FROM billing_groups WHERE org_id = ?1 ORDER BY name`).bind(orgId).all<{ id: string }>();
    const out: BillingGroup[] = [];
    for (const r of results) out.push((await billingGroupOf(ctx, orgId, r.id))!);
    return json({ billingGroups: out });
  }
  if (!rest.length && m === "POST") {
    const b = await body<{ name?: unknown; adminIds?: unknown }>(ctx.req);
    const name = cleanName(b.name, "name", 100);
    const id = randomId();
    await d1.prepare(`INSERT INTO billing_groups (id, org_id, name, created_at) VALUES (?1, ?2, ?3, ?4)`).bind(id, orgId, name, deps.now()).run();
    await log("license_group_create", { id, name });
    await setAdmins({ id, name }, strings(b.adminIds));
    return json({ billingGroup: await billingGroupOf(ctx, orgId, id) }, 201);
  }
  const bg = rest.length === 1 ? await billingGroupOf(ctx, orgId, rest[0]) : null;
  if (!bg) throw new HttpError(404, "no such billing group");
  if (m === "PATCH") {
    const b = await body<{ name?: unknown; adminIds?: unknown; members?: { add?: unknown; remove?: unknown } }>(ctx.req);
    if (b.name !== undefined) {
      const name = cleanName(b.name, "name", 100);
      if (name !== bg.name) {
        await d1.prepare(`UPDATE billing_groups SET name = ?2 WHERE id = ?1`).bind(bg.id, name).run();
        await log("license_group_rename", { id: bg.id, name }, { old_name: bg.name });
      }
    }
    if (b.adminIds !== undefined) await setAdmins(bg, strings(b.adminIds));
    if (b.members) {
      for (const id of strings(b.members.add)) {
        const r = await d1.prepare(`UPDATE org_members SET billing_group_id = ?3 WHERE org_id = ?1 AND user_id = ?2 RETURNING email`).bind(orgId, id, bg.id).first();
        if (!r) throw new HttpError(400, `${id} isn't in the organization`);
        await log("license_group_membership_change", bg, { user_id: id, added: true });
      }
      for (const id of strings(b.members.remove)) {
        const r = await d1.prepare(`UPDATE org_members SET billing_group_id = NULL WHERE org_id = ?1 AND user_id = ?2 AND billing_group_id = ?3 RETURNING email`).bind(orgId, id, bg.id).first();
        if (r) await log("license_group_membership_change", bg, { user_id: id, removed: true });
      }
    }
    return json({ billingGroup: await billingGroupOf(ctx, orgId, bg.id) });
  }
  if (m === "DELETE") {
    await d1.prepare(`DELETE FROM billing_groups WHERE id = ?1`).bind(bg.id).run();
    await log("license_group_delete", bg);
    return noContent();
  }
  throw new HttpError(405, "method not allowed");
}

async function patchSettings(ctx: Ctx, orgId: string, patch: Partial<OrgSettings>): Promise<OrgSettings> {
  const { deps, user, acc } = ctx;
  const org = (await acc.org(orgId))!;
  const before = settingsOf(org);
  const next: OrgSettings = { ...before };
  const pick = <K extends keyof OrgSettings>(k: K, ok: (v: unknown) => boolean) => {
    if (patch[k] === undefined) return;
    if (!ok(patch[k])) throw new HttpError(400, `${k}`);
    next[k] = patch[k] as OrgSettings[K];
  };
  pick("teamCreation", (v) => v === "anyone" || v === "admins");
  pick("groupCreation", (v) => v === "anyone" || v === "admins");
  pick("guestMembership", (v) => v === "allow" || v === "approval" || v === "block");
  pick("defaultSeat", (v) => SEATS.includes(v as Seat));
  pick("publicLinks", (v) => typeof v === "boolean");
  pick("linkExpiryMaxHours", (v) => v === null || (typeof v === "number" && v > 0 && v <= 24 * 365));
  pick("passwordRequired", (v) => typeof v === "boolean");
  pick("cursorChat", (v) => typeof v === "boolean");
  pick("audio", (v) => typeof v === "boolean");
  if (patch.seatApproval !== undefined) {
    const s = patch.seatApproval as Record<string, unknown>;
    if (!s || typeof s !== "object") throw new HttpError(400, "seatApproval");
    const approval = { ...before.seatApproval };
    for (const k of ["full", "dev", "collab"] as const) {
      const v = s[k];
      if (v === undefined) continue;
      if (v !== "manual" && v !== "manual_unless_available" && v !== "auto") throw new HttpError(400, `seatApproval.${k}`);
      approval[k] = v;
    }
    next.seatApproval = approval;
  }
  await acc.d1.prepare(`UPDATE orgs SET settings = ?2, updated_at = ?3 WHERE id = ?1`).bind(orgId, JSON.stringify(next), deps.now()).run();
  // Each changed key its Figma action (where Figma names one)
  const actions: Partial<Record<keyof OrgSettings, Parameters<typeof logActivity>[1]["action"]>> = { teamCreation: "org_team_creation_controls", guestMembership: "org_guest_invite_setting_change", defaultSeat: "org_default_license_type_change", publicLinks: "public_link_setting_change" };
  for (const k of Object.keys(actions) as (keyof OrgSettings)[]) {
    if (JSON.stringify(before[k]) !== JSON.stringify(next[k])) await logActivity(deps, { orgId, action: actions[k]!, actor: user, entity: { type: "org", id: orgId, name: org.name }, details: { setting: k, from: before[k], to: next[k] }, req: ctx.req });
  }
  acc.reset();
  await orgNotice(deps, await orgUserIds(acc.d1, orgId), { type: "org.updated", orgId });
  return next;
}

/** Drafts whose owner is no longer in the org (§14.7). */
async function unassignedFiles(ctx: Ctx, orgId: string, by: { fileKeys?: string[]; ownerId?: string }) {
  const args: unknown[] = [orgId];
  let extra = "";
  if (by.fileKeys) {
    if (!by.fileKeys.length) return [];
    extra = `AND f.key IN (${placeholders(by.fileKeys.length, 2)})`;
    args.push(...by.fileKeys);
  } else if (by.ownerId) {
    args.push(by.ownerId);
    extra = `AND f.owner_id = ?2`;
  }
  const { results } = await ctx.acc.d1
    .prepare(
      `SELECT ${FILE_COLS}, u.name AS owner_name, u.email AS owner_email FROM files f LEFT JOIN users u ON u.id = f.owner_id
       WHERE f.org_id = ?1 AND f.project_id IS NULL AND f.trashed_at IS NULL AND NOT EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = ?1 AND m.user_id = f.owner_id) ${extra}
       ORDER BY f.updated_at DESC`,
    )
    .bind(...args)
    .all<FileRow & { owner_name: string | null; owner_email: string | null }>();
  return results;
}

async function unassignedDrafts(ctx: Ctx, orgId: string): Promise<UnassignedDrafts[]> {
  const files = await unassignedFiles(ctx, orgId, {});
  const by = new Map<string, UnassignedDrafts>();
  for (const f of files) {
    let o = by.get(f.owner_id);
    if (!o) {
      const removed = await ctx.acc.d1.prepare(`SELECT MAX(at) AS at FROM activity_log WHERE org_id = ?1 AND entity_id = ?2 AND action IN ('org_user_delete', 'org_user_delete_external')`).bind(orgId, f.owner_id).first<{ at: number | null }>();
      o = { owner: { id: f.owner_id, email: f.owner_email ?? "", name: f.owner_name, removedAt: removed?.at ?? 0 }, files: [] };
      by.set(f.owner_id, o);
    }
    const a = await ctx.acc.file(f);
    if (a.ok) o.files.push(toOrgFile(f, a));
  }
  return [...by.values()];
}

/**
 * Unassigned drafts moved into a folder, or into a team — a new folder named after the person (unverified). The moving
 * admin becomes their owner (ours: the org owns them; someone has to answer for them).
 */
async function moveDrafts(ctx: Ctx, orgId: string, b: Record<string, unknown>): Promise<void> {
  const { acc, deps, user } = ctx;
  const d1 = acc.d1;
  const files = await unassignedFiles(ctx, orgId, Array.isArray(b.fileKeys) ? { fileKeys: strings(b.fileKeys) } : typeof b.ownerId === "string" ? { ownerId: b.ownerId } : { fileKeys: [] });
  if (!files.length) return;
  const to = (b.to ?? {}) as { projectId?: unknown; teamId?: unknown };
  const now = deps.now();
  const target = new Map<string, { projectId: string; teamId: string }>();
  if (typeof to.projectId === "string") {
    const p = await acc.project(to.projectId);
    const t = p ? await acc.team(p.team_id) : null;
    if (!p || !t || t.org_id !== orgId) throw new HttpError(400, "no such folder");
    for (const f of files) target.set(f.key, { projectId: p.id, teamId: t.id });
  } else if (typeof to.teamId === "string") {
    const t = await acc.team(to.teamId);
    if (!t || t.org_id !== orgId) throw new HttpError(400, "no such team");
    const folders = new Map<string, string>();
    for (const f of files) {
      let pid = folders.get(f.owner_id);
      if (!pid) {
        pid = randomId();
        const name = f.owner_name || f.owner_email || "Unassigned drafts";
        await d1.prepare(`INSERT INTO projects (id, team_id, parent_id, depth, name, owner_id, access, created_at, updated_at) VALUES (?1, ?2, NULL, 1, ?3, ?4, 'inherited', ?5, ?5)`).bind(pid, t.id, name, user.id, now).run();
        await logActivity(deps, { orgId, action: "project_create", actor: user, entity: projectEntity({ id: pid, name }), teamId: t.id, details: { unassigned_drafts_of: f.owner_id }, req: ctx.req });
        folders.set(f.owner_id, pid);
      }
      target.set(f.key, { projectId: pid, teamId: t.id });
    }
  } else throw new HttpError(400, "to is {projectId} or {teamId}");
  for (const f of files) {
    const dest = target.get(f.key)!;
    await d1.prepare(`UPDATE files SET project_id = ?2, team_id = ?3, owner_id = ?4, updated_at = ?5 WHERE key = ?1`).bind(f.key, dest.projectId, dest.teamId, user.id, now).run();
    await logActivity(deps, { orgId, action: "fig_file_move", actor: user, entity: fileEntity(f), teamId: dest.teamId, details: { unassigned_draft: true, previous_owner: f.owner_id, to: dest.projectId }, req: ctx.req });
  }
  await reauth(deps, files.map((f) => f.key));
}

export type { User };
