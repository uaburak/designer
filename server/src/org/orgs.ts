/**
 * Organizations and their people (docs/multiplayer.md §14.1, §14.7, §14.12 "Organization and people"):
 *
 *   GET    /orgs                              {orgs: OrgSummary[]}
 *   POST   /orgs {name, importSharedFiles?}   {org: OrgInfo}            "Create organization" (§14.8, migrate.ts)
 *   GET    /orgs/:org                         {org: OrgInfo}
 *   GET    /orgs/:org/people?text=&limit=     {people, groups}
 *   GET    /orgs/:org/drafts · POST {key, name, editorType?}
 *   GET    /orgs/:org/search?text=            OrgSearchResult
 *   POST   /orgs/:org/seat-requests           {seat, note?} → {request}  "Ask to upgrade"
 *   DELETE /orgs/:org/me                      leave (the last admin can't)
 *   DELETE /orgs/:org {confirmName}           {org}  "Delete organization" (admins; deletion.ts, §14.17)
 *   POST   /orgs/:org/restore                 {org}  within the grace period (admins)
 *   GET    /orgs/:org/drafts?trashed=1        {files} the caller's drafts in the trash
 *   …/groups → groups.ts, …/teams → teams.ts, …/admin → admin.ts
 *
 * And what the other routes share: adding people (with workspaces' default teams), inviting an email into the org's
 * content (members, guests, guest requests), removing someone (§14.7), creating an org file.
 */
import { seatCanEdit, seatNeeded } from "../../../src/shared/org/access";
import type { EditorType, GrantRole, OrgInfo, OrgRole, OrgSummary, PersonRef, Seat, SeatRequest } from "../../../src/shared/org/types";
import { fileEntity, logActivity, userEntity } from "../activity";
import type { Deps } from "../api";
import { normalizeEmail, type D1Like, type User } from "../db";
import { notifyOrg, orgNotice } from "../notifications";
import { accessibleFiles, FILE_COLS, personRef, toOrgFile, userByEmail, type Access, type FileRow, type MemberRow } from "./db";
import { body, cleanName, EMAIL, HttpError, json, noContent, randomId, type Ctx } from "./http";
import { createOrg } from "./migrate";
import { orgFileKeys, reauth } from "./reauth";
import { emailDomain } from "../../../src/shared/org/identity";
import { homeOrgOf, logExternal, requireInside } from "../policy/external";
import { gateCols, gateFor, type GateRow } from "../governance/gate";
import { guestExpiryOnJoin } from "../governance/guests";
import { iconUrl } from "./icons";

export const EDITOR_TYPES: readonly EditorType[] = ["design", "figjam", "slides", "buzz", "sites", "make"];
export const SEATS: readonly Seat[] = ["full", "dev", "collab", "view"];
export const FILE_KEY = /^[A-Za-z0-9_-]{6,64}$/;

export async function orgsRoute(ctx: Ctx): Promise<Response> {
  const { parts, m, deps, user, acc } = ctx;
  if (parts.length === 1) {
    if (m === "GET") return json({ orgs: await orgSummaries(deps, user, ctx.req) });
    if (m === "POST") {
      const b = await body<{ name?: unknown; importSharedFiles?: unknown }>(ctx.req);
      // A member whose org restricts external content can't create another one (§15.6) [F-external].
      requireInside(await acc.home(), null, "create organizations");
      // The `orgs_created` quota (docs/multiplayer.md §17)
      await (await import("../quota/quota")).requireOrgSlot(deps, user);
      const id = await createOrg(ctx, cleanName(b.name, "name", 100), b.importSharedFiles === true);
      acc.reset();
      return json({ org: await orgInfo(acc, id) }, 201);
    }
    throw new HttpError(405, "method not allowed");
  }
  const orgId = parts[1];
  // Name and icon (docs/multiplayer.md §14.16): org admins
  if ((parts.length === 2 && m === "PATCH") || parts[2] === "icon") return (await import("./icons")).orgSettingsRoute(ctx, orgId, orgInfo);
  if (parts[2] === "groups") return (await import("./groups")).orgGroupsRoute(ctx, orgId);
  if (parts[2] === "teams") return (await import("./teams")).orgTeamsRoute(ctx, orgId);
  if (parts[2] === "admin") return (await import("./admin")).adminRoute(ctx, orgId);
  // Internal policies' prompts and agreement (docs/governance.md §4): open while the caller is gated
  if (parts[2] === "policies") return (await import("../governance/policies")).memberPoliciesRoute(ctx, orgId);
  // Delete organization and Restore (§14.17, deletion.ts): org admins
  if ((parts.length === 2 && m === "DELETE") || (parts.length === 3 && parts[2] === "restore")) return (await import("./deletion")).orgDeletionRoute(ctx, orgId, orgInfo);
  if (parts.length === 2 && m === "GET") {
    // Not gated: OrgInfo carries the gate (docs/governance.md §2.5), so Home can prompt. A deleted org: its admins only.
    await acc.requireMember(orgId, { guests: true, gate: false, deleted: true });
    return json({ org: await orgInfo(acc, orgId) });
  }
  switch (parts[2]) {
    case "people": {
      if (parts.length !== 3 || m !== "GET") break;
      const me = await acc.requireMember(orgId, { guests: true });
      return json(await people(acc, orgId, me, ctx.url.searchParams.get("text") ?? "", Math.min(200, Number(ctx.url.searchParams.get("limit")) || 50)));
    }
    case "drafts": {
      if (parts.length !== 3) break;
      if (m === "GET") {
        await acc.requireMember(orgId, { guests: true });
        // ?trashed=1: the caller's drafts in the trash (Home's Trash, where they're restored or deleted forever)
        if (ctx.url.searchParams.get("trashed") === "1") return json({ files: await accessibleFiles(acc, `f.org_id = ?1 AND f.project_id IS NULL AND f.owner_id = ?2 AND f.trashed_at IS NOT NULL`, [orgId, user.id], { trashed: true }) });
        return json({ files: await accessibleFiles(acc, `f.org_id = ?1 AND f.project_id IS NULL AND f.owner_id = ?2 AND f.trashed_at IS NULL`, [orgId, user.id]) });
      }
      if (m === "POST") {
        const b = await body<{ key?: unknown; name?: unknown; editorType?: unknown }>(ctx.req);
        return json({ file: await createOrgFile(ctx, { key: b.key, name: b.name, orgId, projectId: null, editorType: b.editorType }) }, 201);
      }
      break;
    }
    case "files": {
      // Home's All projects: every file in the org the caller can open — their drafts and every team's folders
      if (parts.length !== 3 || m !== "GET") break;
      await acc.requireMember(orgId, { guests: true });
      return json({ files: await accessibleFiles(acc, `f.org_id = ?1 AND f.trashed_at IS NULL AND (f.project_id IS NOT NULL OR f.owner_id = ?2)`, [orgId, user.id]) });
    }
    case "search": {
      if (parts.length !== 3 || m !== "GET") break;
      const me = await acc.requireMember(orgId, { guests: true });
      return json(await search(ctx, orgId, me, (ctx.url.searchParams.get("text") ?? "").trim()));
    }
    case "seat-requests": {
      if (parts.length !== 3 || m !== "POST") break;
      const me = await acc.requireMember(orgId, { guests: true });
      const b = await body<{ seat?: unknown; note?: unknown }>(ctx.req);
      if (b.seat !== "full" && b.seat !== "dev" && b.seat !== "collab") throw new HttpError(400, "seat is full, dev or collab");
      const note = typeof b.note === "string" ? b.note.trim().slice(0, 500) : "";
      return json({ request: await requestSeat(ctx, orgId, me, b.seat, note) }, 201);
    }
    case "me": {
      if (parts.length !== 3 || m !== "DELETE") break;
      // Leaving is never gated
      const me = await acc.requireMember(orgId, { guests: true, gate: false });
      if (me.role === "admin" && (await adminCount(deps.db.d1, orgId)) <= 1) throw new HttpError(409, "make someone else an admin before you leave");
      await removeFromOrg(deps, orgId, user.id, user, ctx.req);
      return noContent();
    }
  }
  throw new HttpError(404, "not found");
}

/**
 * `GET /orgs`: the caller's orgs (expired guests left out, docs/governance.md §2.13), each with its gate (§2.5) and a
 * guest's expiry — one query for all of them (the gate's columns are skipped for orgs without Governance+).
 */
export async function orgSummaries(deps: Deps, user: User, req: Request | null): Promise<OrgSummary[]> {
  const { results } = await deps.db.d1
    .prepare(
      `SELECT o.id, o.name, o.settings, o.icon_hash, o.deleted_at, o.purge_at, m.role, m.seat, m.workspace_id, m.expires_at, ${gateCols("?1")} FROM org_members m JOIN orgs o ON o.id = m.org_id
       WHERE m.user_id = ?1 AND (m.expires_at IS NULL OR o.governance_plus = 0 OR m.expires_at > ?2) AND (o.deleted_at IS NULL OR m.role = 'admin') ORDER BY o.name`,
    )
    .bind(user.id, deps.now())
    .all<GateRow & { id: string; name: string; settings: string; icon_hash: string | null; deleted_at: number | null; purge_at: number | null; role: OrgRole; seat: Seat; workspace_id: string | null; expires_at: number | null }>();
  const out: OrgSummary[] = [];
  for (const r of results) {
    const gate = r.g_plus && !r.deleted_at ? await gateFor(deps, { orgId: r.id, settings: r.settings, role: r.role, user, req, row: r }) : null;
    out.push({
      id: r.id, name: r.name, iconUrl: iconUrl(r.id, r.icon_hash), role: r.role, seat: r.seat, workspaceId: r.workspace_id,
      ...(gate ? { gate } : {}), ...(r.g_plus && r.role === "guest" ? { guestExpiresAt: r.expires_at ?? null } : {}),
      // A deleted org (§14.17) lists for its admins only, to restore it
      ...(r.deleted_at ? { deletedAt: r.deleted_at, purgeAt: r.purge_at } : {}),
    });
  }
  return out;
}

export async function orgInfo(acc: Access, orgId: string): Promise<OrgInfo> {
  const org = await acc.org(orgId);
  const me = await acc.membership(orgId);
  if (!org || !me) throw new HttpError(404, "no such organization");
  const c = await acc.d1
    .prepare(
      `SELECT (SELECT COUNT(*) FROM org_members WHERE org_id = ?1 AND role <> 'guest') AS members, (SELECT COUNT(*) FROM org_members WHERE org_id = ?1 AND role = 'guest') AS guests,
              (SELECT COUNT(*) FROM teams WHERE org_id = ?1 AND deleted_at IS NULL) AS teams`,
    )
    .bind(orgId)
    .first<{ members: number; guests: number; teams: number }>();
  const gate = await acc.gate(orgId);
  const info: OrgInfo & { governancePlus: boolean } = {
    id: org.id,
    name: org.name,
    iconUrl: iconUrl(org.id, org.icon_hash),
    role: me.role,
    seat: me.seat,
    workspaceId: me.workspace_id,
    createdAt: org.created_at,
    workspaceAdminOf: await acc.workspaceAdminOf(orgId),
    billingGroupAdminOf: await acc.billingAdminOf(orgId),
    counts: { members: c?.members ?? 0, guests: c?.guests ?? 0, teams: c?.teams ?? 0 },
    settings: await acc.settings(orgId),
    dataRegion: org.data_region === "eu" ? "eu" : "default",
    // Round 14 (docs/governance.md §2.1, §2.5, §2.13)
    governancePlus: !!org.governance_plus,
    ...(gate ? { gate } : {}),
    ...(org.governance_plus && me.role === "guest" ? { guestExpiresAt: me.expires_at ?? null } : {}),
    ...(org.deleted_at ? { deletedAt: org.deleted_at, purgeAt: org.purge_at ?? null } : {}),
  };
  return info;
}

export async function adminCount(d1: D1Like, orgId: string): Promise<number> {
  return (await d1.prepare(`SELECT COUNT(*) AS n FROM org_members WHERE org_id = ?1 AND role = 'admin' AND user_id IS NOT NULL`).bind(orgId).first<{ n: number }>())?.n ?? 0;
}

export async function orgAdminIds(d1: D1Like, orgId: string): Promise<string[]> {
  const { results } = await d1.prepare(`SELECT user_id FROM org_members WHERE org_id = ?1 AND role = 'admin' AND user_id IS NOT NULL`).bind(orgId).all<{ user_id: string }>();
  return results.map((r) => r.user_id);
}

export async function orgUserIds(d1: D1Like, orgId: string): Promise<string[]> {
  const { results } = await d1.prepare(`SELECT user_id FROM org_members WHERE org_id = ?1 AND user_id IS NOT NULL`).bind(orgId).all<{ user_id: string }>();
  return results.map((r) => r.user_id);
}

/** The people the caller may share with or @mention, and the groups (guests: only people of what they're in, their groups). */
async function people(acc: Access, orgId: string, me: MemberRow, text: string, limit: number): Promise<{ people: PersonRef[]; groups: { id: string; name: string; memberCount: number }[] }> {
  const like = `%${text.toLowerCase()}%`;
  const guest = me.role === "guest";
  const { results } = await acc.d1
    .prepare(
      `SELECT u.id, u.email, u.name, u.picture, m.role FROM org_members m JOIN users u ON u.id = m.user_id
       WHERE m.org_id = ?1 AND (lower(u.email) LIKE ?2 OR lower(COALESCE(u.name, '')) LIKE ?2)
       ${
         guest
           ? `AND (u.id = ?3 OR u.id IN (SELECT tm.user_id FROM team_members tm WHERE tm.team_id IN (SELECT team_id FROM team_members WHERE user_id = ?3))
              OR u.id IN (SELECT pm.user_id FROM project_members pm WHERE pm.project_id IN (SELECT project_id FROM project_members WHERE user_id = ?3))
              OR u.id IN (SELECT fm.user_id FROM members fm WHERE fm.file_key IN (SELECT file_key FROM members WHERE user_id = ?3))
              OR u.id IN (SELECT f.owner_id FROM files f JOIN members x ON x.file_key = f.key WHERE x.user_id = ?3 AND f.org_id = ?1))`
           : ""
       }
       ORDER BY COALESCE(u.name, u.email) LIMIT ${limit}`,
    )
    .bind(orgId, like, ...(guest ? [acc.user.id] : []))
    .all<{ id: string; email: string; name: string | null; picture: string | null; role: OrgRole }>();
  const { results: groups } = await acc.d1
    .prepare(
      `SELECT g.id, g.name, (SELECT COUNT(*) FROM user_group_members x WHERE x.group_id = g.id) AS n FROM user_groups g
       WHERE g.org_id = ?1 AND lower(g.name) LIKE ?2 ${guest ? `AND g.id IN (SELECT group_id FROM user_group_members WHERE user_id = ?3)` : ""} ORDER BY g.name LIMIT ${limit}`,
    )
    .bind(orgId, like, ...(guest ? [acc.user.id] : []))
    .all<{ id: string; name: string; n: number }>();
  return { people: results.map(personRef), groups: groups.map((g) => ({ id: g.id, name: g.name, memberCount: g.n })) };
}

async function search(ctx: Ctx, orgId: string, me: MemberRow, text: string) {
  const { acc } = ctx;
  if (!text) return { files: [], projects: [], teams: [], people: [] };
  const like = `%${text.toLowerCase()}%`;
  const files = (await accessibleFiles(acc, `f.org_id = ?1 AND lower(f.name) LIKE ?2 AND f.trashed_at IS NULL`, [orgId, like])).slice(0, 50);
  const { listTeams } = await import("./teams");
  const teams = (await listTeams(ctx, orgId, me, me.role === "guest" ? "mine" : "browse")).filter((t) => t.name.toLowerCase().includes(text.toLowerCase()));
  const { projectSummaries } = await import("./projects");
  const { results: folders } = await acc.d1
    .prepare(`SELECT p.* FROM projects p JOIN teams t ON t.id = p.team_id WHERE t.org_id = ?1 AND t.deleted_at IS NULL AND p.trashed_at IS NULL AND lower(p.name) LIKE ?2 LIMIT 100`)
    .bind(orgId, like)
    .all<import("./db").ProjectRow>();
  const projects = await projectSummaries(acc, folders);
  return { files, projects, teams, people: (await people(acc, orgId, me, text, 20)).people };
}

/** "Ask to upgrade" (§14.3): approved at once under `auto` and — unlimited seats — `manual_unless_available`. */
async function requestSeat(ctx: Ctx, orgId: string, me: MemberRow, seat: Exclude<Seat, "view">, note: string): Promise<SeatRequest> {
  const { deps, user, acc } = ctx;
  const d1 = deps.db.d1;
  const now = deps.now();
  const id = randomId();
  const approval = (await acc.settings(orgId)).seatApproval[seat];
  const auto = approval !== "manual" || me.seat === seat || me.seat === "full";
  await d1
    .prepare(`INSERT INTO seat_requests (id, org_id, user_id, seat, note, state, created_at, answered_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`)
    .bind(id, orgId, user.id, seat, note, auto ? "approved" : "pending", now, auto ? now : null)
    .run();
  const org = (await acc.org(orgId))!;
  await logActivity(deps, { orgId, action: "org_user_account_type_upgrade_requested", actor: user, entity: userEntity(user), details: { seat, note }, req: ctx.req });
  if (auto) {
    if (me.seat !== "full") await setSeat(deps, orgId, user.id, seat, null, ctx.req);
    await logActivity(deps, { orgId, action: "org_user_account_type_upgrade_approved", actor: null, entity: userEntity(user), details: { seat, automatic: true }, req: ctx.req });
  } else {
    for (const admin of await seatAnswerers(d1, orgId, me)) await notifyOrg(deps, { userId: admin, kind: "seat_request", actorId: user.id, orgId, name: org.name, text: note || null, role: seat, state: "pending" });
  }
  return (await seatRequest(d1, id))!;
}

/** Org admins, the person's workspace admins and billing group admins (§14.2). */
export async function seatAnswerers(d1: D1Like, orgId: string, m: Pick<MemberRow, "workspace_id" | "billing_group_id">): Promise<string[]> {
  const ids = new Set(await orgAdminIds(d1, orgId));
  if (m.workspace_id) for (const r of (await d1.prepare(`SELECT user_id FROM workspace_admins WHERE workspace_id = ?1`).bind(m.workspace_id).all<{ user_id: string }>()).results) ids.add(r.user_id);
  if (m.billing_group_id) for (const r of (await d1.prepare(`SELECT user_id FROM billing_group_admins WHERE billing_group_id = ?1`).bind(m.billing_group_id).all<{ user_id: string }>()).results) ids.add(r.user_id);
  return [...ids];
}

export async function seatRequest(d1: D1Like, id: string): Promise<SeatRequest | null> {
  const r = await d1
    .prepare(`SELECT s.*, u.email, u.name, u.picture, m.role FROM seat_requests s JOIN users u ON u.id = s.user_id LEFT JOIN org_members m ON m.org_id = s.org_id AND m.user_id = s.user_id WHERE s.id = ?1`)
    .bind(id)
    .first<{ id: string; org_id: string; user_id: string; seat: Exclude<Seat, "view">; note: string; state: SeatRequest["state"]; created_at: number; answered_at: number | null; answered_by: string | null; email: string; name: string | null; picture: string | null; role: OrgRole | null }>();
  return r
    ? { id: r.id, orgId: r.org_id, userId: r.user_id, person: personRef({ id: r.user_id, email: r.email, name: r.name, picture: r.picture, role: r.role }), seat: r.seat, note: r.note, state: r.state, createdAt: r.created_at, answeredAt: r.answered_at, answeredBy: r.answered_by }
    : null;
}

/** A seat change, logged (Figma's two actions for a change to Full); lowering re-checks the person's open files. */
export async function setSeat(deps: Deps, orgId: string, userId: string, seat: Seat, by: User | null, req: Request | null): Promise<boolean> {
  const d1 = deps.db.d1;
  const before = await d1.prepare(`SELECT seat FROM org_members WHERE org_id = ?1 AND user_id = ?2`).bind(orgId, userId).first<{ seat: Seat }>();
  if (!before || before.seat === seat) return false;
  await d1.prepare(`UPDATE org_members SET seat = ?3, seat_changed_at = ?4 WHERE org_id = ?1 AND user_id = ?2`).bind(orgId, userId, seat, deps.now()).run();
  const person = await d1.prepare(`SELECT id, email, name FROM users WHERE id = ?1`).bind(userId).first<{ id: string; email: string; name: string | null }>();
  if (person) {
    await logActivity(deps, { orgId, action: "org_user_account_type_change", actor: by, entity: userEntity(person), details: { from: before.seat, to: seat }, req });
    if (seat === "full") await logActivity(deps, { orgId, action: "org_user_account_type_change_to_full", actor: by, entity: userEntity(person), details: { from: before.seat }, req });
  }
  if (SEATS.indexOf(seat) > SEATS.indexOf(before.seat)) await reauth(deps, await orgFileKeys(d1, orgId), [userId]);
  await orgNotice(deps, [userId], { what: "orgs" });
  return true;
}

/**
 * Adds an email to the org (an account's row, or a pending one by email). Existing people keep their row. A member
 * joining a workspace joins its default teams (§14.1; "can edit" — unverified).
 */
export async function addPerson(deps: Deps, orgId: string, email: string, role: OrgRole, seat: Seat, opts: { by: User | null; workspaceId?: string | null; billingGroupId?: string | null; req?: Request | null; details?: Record<string, unknown> }): Promise<{ userId: string | null; created: boolean }> {
  const d1 = deps.db.d1;
  const e = normalizeEmail(email);
  const u = await userByEmail(d1, e);
  const had = await d1.prepare(`SELECT user_id FROM org_members WHERE org_id = ?1 AND email = ?2`).bind(orgId, e).first<{ user_id: string | null }>();
  if (had) return { userId: had.user_id, created: false };
  // Someone new invited by a person counts against that person's daily invitations (docs/multiplayer.md §17)
  if (opts.by) await (await import("../quota/quota")).countFor(deps, opts.by, "invitations_per_day");
  const now = deps.now();
  // A guest's access ends after the org's default duration (Governance+, docs/governance.md §2.13)
  const expiresAt = role === "guest" ? await guestExpiryOnJoin(d1, orgId, now) : null;
  await d1
    .prepare(`INSERT INTO org_members (org_id, email, user_id, role, seat, workspace_id, billing_group_id, invited_by, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`)
    .bind(orgId, e, u?.id ?? null, role, seat, opts.workspaceId ?? null, opts.billingGroupId ?? null, opts.by?.id ?? null, now, expiresAt)
    .run();
  const entity = userEntity(u ?? { id: e, email: e, name: null });
  // The org logs org_user_create (guests too); the person's home org, when captured and another, its external twin
  // (docs/multiplayer.md §15.9, §15.11 — corrected in round 4).
  await logActivity(deps, { orgId, action: !u ? "org_invite_create" : "org_user_create", actor: opts.by, entity, details: { role, seat, ...(opts.details ?? {}) }, req: opts.req });
  if (u) await logExternal(deps, u, orgId, "org_user_create_external", entity, { actor: opts.by, details: { role }, req: opts.req });
  if (opts.workspaceId && role !== "guest") await joinDefaultTeams(deps, opts.workspaceId, e, u?.id ?? null, opts.by);
  if (u) await orgNotice(deps, [u.id], { what: "orgs" });
  return { userId: u?.id ?? null, created: true };
}

export async function joinDefaultTeams(deps: Deps, workspaceId: string, email: string, userId: string | null, by: User | null): Promise<void> {
  const d1 = deps.db.d1;
  const { results } = await d1.prepare(`SELECT team_id FROM workspace_default_teams WHERE workspace_id = ?1`).bind(workspaceId).all<{ team_id: string }>();
  for (const { team_id } of results)
    await d1
      .prepare(`INSERT INTO team_members (team_id, email, user_id, role, admin, invited_by, created_at) VALUES (?1, ?2, ?3, 'editor', 0, ?4, ?5) ON CONFLICT (team_id, email) DO NOTHING`)
      .bind(team_id, email, userId, by?.id ?? null, deps.now())
      .run();
}

export type InviteOutcome = { kind: "member" | "guest"; userId: string | null; email: string } | { kind: "requested"; requestId: string; email: string };

/**
 * An email invited to a team, folder or file of the org (§14.1 "People"): an org member stays one; anyone else
 * becomes a guest — Guest membership "Allow" — or waits for an admin ("Require admin approval": a guest request) or is
 * refused ("Block", `guest_blocked`).
 */
export async function inviteEmail(ctx: Ctx, orgId: string, email: string, resource: { type: "team" | "project" | "file"; id: string; name: string }, role: GrantRole): Promise<InviteOutcome> {
  const { deps, user, acc } = ctx;
  const d1 = deps.db.d1;
  const e = normalizeEmail(email);
  if (!EMAIL.test(e)) throw new HttpError(400, "bad email");
  const row = await d1.prepare(`SELECT user_id, role FROM org_members WHERE org_id = ?1 AND email = ?2`).bind(orgId, e).first<{ user_id: string | null; role: OrgRole }>();
  if (row) return { kind: row.role === "guest" ? "guest" : "member", userId: row.user_id, email: e };
  // Someone whose own org restricts external content can't accept an outside invite (§15.6) [F-external].
  const invitee = await userByEmail(d1, e);
  const theirs = invitee ? await homeOrgOf(d1, invitee) : null;
  if (theirs?.restricted && theirs.orgId !== orgId) throw new HttpError(403, `${e}'s organization doesn't allow them to join content outside it`, "external_restricted");
  const settings = await acc.settings(orgId);
  const me = await acc.membership(orgId);
  // An email on any of the org's domains (verified or not) joins as a member [F-domain] (§15.7).
  const domain = emailDomain(e);
  const onDomain = !!domain && !!(await d1.prepare(`SELECT 1 AS x FROM org_domains WHERE org_id = ?1 AND domain = ?2`).bind(orgId, domain).first());
  // An org admin inviting someone adds them as a member (the owner's decision, 2026-10-11: friends are members;
  // admins add anyone as a member by hand). Everyone else's outside invites make guests (§14.1).
  if (me?.role === "admin" || onDomain) {
    const added = await addPerson(deps, orgId, e, "member", settings.defaultSeat, { by: user, req: ctx.req, details: { via: resource.type } });
    return { kind: "member", userId: added.userId, email: e };
  }
  if (settings.guestMembership === "block") throw new HttpError(403, "people outside the organization can't be invited", "guest_blocked");

  if (settings.guestMembership === "approval") {
    const id = randomId();
    await d1
      .prepare(`INSERT INTO guest_requests (id, org_id, email, invited_by, resource_type, resource_id, role, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`)
      .bind(id, orgId, e, user.id, resource.type, resource.id, role, deps.now())
      .run();
    const org = (await acc.org(orgId))!;
    // Requests go to the resource's workspace admins, or to org admins outside workspaces [F-guestctl].
    for (const admin of await guestAnswerers(d1, orgId, resource)) await notifyOrg(deps, { userId: admin, kind: "guest_request", actorId: user.id, orgId, name: org.name, text: `${e} · ${resource.name}`, role, state: "pending" });
    return { kind: "requested", requestId: id, email: e };
  }
  const added = await addPerson(deps, orgId, e, "guest", settings.defaultSeat, { by: user, req: ctx.req, details: { via: resource.type } });
  return { kind: "guest", userId: added.userId, email: e };
}

/** The workspace of a team, folder or file (null: outside workspaces) */
export async function resourceWorkspace(d1: D1Like, resource: { type: "team" | "project" | "file"; id: string }): Promise<string | null> {
  const sql =
    resource.type === "team"
      ? `SELECT workspace_id AS w FROM teams WHERE id = ?1`
      : resource.type === "project"
        ? `SELECT t.workspace_id AS w FROM projects p JOIN teams t ON t.id = p.team_id WHERE p.id = ?1`
        : `SELECT t.workspace_id AS w FROM files f JOIN teams t ON t.id = f.team_id WHERE f.key = ?1`;
  return (await d1.prepare(sql).bind(resource.id).first<{ w: string | null }>())?.w ?? null;
}

/** Who answers a guest request [F-guestctl]: the resource's workspace admins, else the org's admins */
export async function guestAnswerers(d1: D1Like, orgId: string, resource: { type: "team" | "project" | "file"; id: string }): Promise<string[]> {
  const ws = await resourceWorkspace(d1, resource);
  if (ws) {
    const { results } = await d1.prepare(`SELECT user_id FROM workspace_admins WHERE workspace_id = ?1`).bind(ws).all<{ user_id: string }>();
    if (results.length) return results.map((r) => r.user_id);
  }
  return orgAdminIds(d1, orgId);
}

/**
 * Someone leaves or is removed (§14.7): their org row, team / folder / file grants in the org, group memberships,
 * workspace and billing admin rows and pending requests go; their sockets in the org's files close. Their drafts stay
 * (owner_id kept) and list as "Unassigned drafts".
 */
export async function removeFromOrg(deps: Deps, orgId: string, userId: string, by: User | null, req: Request | null, details: Record<string, unknown> = {}): Promise<boolean> {
  const d1 = deps.db.d1;
  const row = await d1.prepare(`SELECT m.email, m.role, u.name FROM org_members m LEFT JOIN users u ON u.id = m.user_id WHERE m.org_id = ?1 AND m.user_id = ?2`).bind(orgId, userId).first<{ email: string; role: OrgRole; name: string | null }>();
  if (!row) return false;
  const inOrgTeams = `SELECT id FROM teams WHERE org_id = ?1`;
  const inOrgProjects = `SELECT p.id FROM projects p JOIN teams t ON t.id = p.team_id WHERE t.org_id = ?1`;
  await d1.prepare(`DELETE FROM team_members WHERE (user_id = ?2 OR email = ?3) AND team_id IN (${inOrgTeams})`).bind(orgId, userId, row.email).run();
  await d1.prepare(`DELETE FROM team_requests WHERE user_id = ?2 AND team_id IN (${inOrgTeams})`).bind(orgId, userId).run();
  await d1.prepare(`DELETE FROM project_members WHERE (user_id = ?2 OR email = ?3) AND project_id IN (${inOrgProjects})`).bind(orgId, userId, row.email).run();
  await d1.prepare(`DELETE FROM members WHERE (user_id = ?2 OR email = ?3) AND file_key IN (SELECT key FROM files WHERE org_id = ?1)`).bind(orgId, userId, row.email).run();
  await d1.prepare(`DELETE FROM user_group_members WHERE user_id = ?2 AND group_id IN (SELECT id FROM user_groups WHERE org_id = ?1)`).bind(orgId, userId).run();
  await d1.prepare(`DELETE FROM workspace_admins WHERE user_id = ?2 AND workspace_id IN (SELECT id FROM workspaces WHERE org_id = ?1)`).bind(orgId, userId).run();
  await d1.prepare(`DELETE FROM billing_group_admins WHERE user_id = ?2 AND billing_group_id IN (SELECT id FROM billing_groups WHERE org_id = ?1)`).bind(orgId, userId).run();
  await d1.prepare(`DELETE FROM seat_requests WHERE org_id = ?1 AND user_id = ?2 AND state = 'pending'`).bind(orgId, userId).run();
  await d1.prepare(`DELETE FROM org_members WHERE org_id = ?1 AND user_id = ?2`).bind(orgId, userId).run();
  const person = { id: userId, email: row.email, name: row.name };
  await logActivity(deps, { orgId, action: "org_user_delete", actor: by, entity: userEntity(person), details: { role: row.role, ...details }, req });
  await logExternal(deps, person, orgId, "org_user_delete_external", userEntity(person), { actor: by, req });
  await reauth(deps, await orgFileKeys(d1, orgId), [userId]);
  await orgNotice(deps, [userId], { what: "orgs" });
  return true;
}

/**
 * A file created in (or moved into, from outside any org) a folder or the caller's drafts: `POST /files {orgId,
 * projectId}`, `POST /orgs/:org/drafts`, `POST /projects/:id/files`. The room is made by the snapshot upload after it.
 */
export async function createOrgFile(ctx: Ctx, input: { key: unknown; name: unknown; orgId: string; projectId: string | null; editorType?: unknown }) {
  const { deps, user, acc } = ctx;
  const d1 = deps.db.d1;
  const key = typeof input.key === "string" ? input.key : "";
  if (!FILE_KEY.test(key)) throw new HttpError(400, "bad file key");
  const name = typeof input.name === "string" && input.name.trim() ? input.name.trim().slice(0, 200) : "Untitled";
  const editorType = (input.editorType ?? "design") as EditorType;
  if (!EDITOR_TYPES.includes(editorType)) throw new HttpError(400, "editorType");
  const me = await acc.requireMember(input.orgId, { guests: input.projectId !== null });
  // A member whose org restricts external content creates files there only (§15.6, §15.9).
  requireInside(await acc.home(), input.orgId, "create files");
  let teamId: string | null = null;
  if (input.projectId !== null) {
    const p = await acc.project(input.projectId);
    const team = p ? await acc.team(p.team_id) : null;
    if (!p || !team || team.org_id !== input.orgId) throw new HttpError(404, "no such folder");
    const a = await acc.container(team.id, p.id);
    if (!a.ok) throw new HttpError(404, "no such folder");
    if (a.trashed || (a.role !== "owner" && a.role !== "editor")) throw new HttpError(403, "only people who can edit this folder can add files");
    teamId = team.id;
  }
  if (!seatCanEdit(me.seat, editorType)) throw new HttpError(403, `your ${me.seat} seat can't create this kind of file`, "seat_required", { seat: seatNeeded(editorType), current: me.seat });
  const now = deps.now();
  const had = await acc.fileRow(key);
  // The `shared_files` quota (docs/multiplayer.md §17): a file moved in from outside the org is no new file
  if (had?.owner_id !== user.id) await (await import("../quota/quota")).requireFileSlot(deps, user);
  let action: "fig_file_create" | "fig_file_move" = "fig_file_create";
  if (had) {
    if (had.owner_id !== user.id || had.org_id !== null) throw new HttpError(409, "file key taken");
    // "Move to…" a file shared outside any org — a personal draft (docs/cloud.md §2) — into the org (§14.6): the file
    // keeps its room, members and link, and leaves its owner's Drafts.
    await d1.prepare(`UPDATE files SET org_id = ?2, team_id = ?3, project_id = ?4, editor_type = ?5, name = ?6, updated_at = ?7, space = NULL WHERE key = ?1`).bind(key, input.orgId, teamId, input.projectId, editorType, name, now).run();
    action = "fig_file_move";
  } else {
    await d1
      // In an org whose data is in the EU, the room is made there (§15.10): before the first snapshot upload.
      .prepare(
        `INSERT INTO files (key, owner_id, name, created_at, updated_at, org_id, team_id, project_id, editor_type, jurisdiction)
         VALUES (?1, ?2, ?3, ?4, ?4, ?5, ?6, ?7, ?8, (SELECT CASE data_region WHEN 'eu' THEN 'eu' END FROM orgs WHERE id = ?5))`,
      )
      .bind(key, user.id, name, now, input.orgId, teamId, input.projectId, editorType)
      .run();
  }
  acc.reset();
  const f = (await d1.prepare(`SELECT ${FILE_COLS}, u.name AS owner_name, u.email AS owner_email FROM files f LEFT JOIN users u ON u.id = f.owner_id WHERE f.key = ?1`).bind(key).first<FileRow & { owner_name: string | null; owner_email: string | null }>())!;
  await logActivity(deps, { orgId: input.orgId, action, actor: user, entity: fileEntity(f), teamId, details: action === "fig_file_move" ? { from: null, to: input.projectId } : {}, req: ctx.req });
  if (action === "fig_file_move") await reauth(deps, [key]);
  await orgNotice(deps, [user.id], { what: "files", orgId: input.orgId, projectId: input.projectId });
  // Its access reads in one round trip (requestD1.ts)
  await acc.prefetchFile(f);
  const a = await acc.file(f);
  if (!a.ok) throw new HttpError(500, "the new file can't be opened");
  return toOrgFile(f, a);
}

