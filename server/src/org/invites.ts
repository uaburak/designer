/**
 * Invitations that wait for an answer (docs/multiplayer.md §14.18; the owner's call, 2026-10-26). Admin › People › Add
 * people and a team's Invite make rows with `invite_pending = 1` and no `user_id`: the person has no access and doesn't
 * list the org or the team until they accept from the bell (Accept / Decline on `org_invite` and `team_invite`). One
 * answer settles everything waiting for that email in the org:
 *
 *   accept    joins the org (if they weren't in it) and every team they were invited to there
 *   decline   an org invite, or a team invite of someone not yet in the org: drops the org's row with its teams'; a team
 *             invite of someone already in the org: drops that team's row only
 *
 * The bell's Approve / Decline on a request to join a team is answered here too (teams.ts answerJoinRequest).
 */
import { logActivity, teamEntity, userEntity } from "../activity";
import type { Deps } from "../api";
import type { User } from "../db";
import { notifyOrg, orgNotice, settleInvites } from "../notifications";
import { logExternal } from "../policy/external";
import { Access, userByEmail } from "./db";
import { HttpError, type Ctx } from "./http";

interface PendingTeam {
  team_id: string;
  name: string;
  role: "editor" | "viewer";
  invited_by: string | null;
}

const pendingTeams = (deps: Deps, orgId: string, email: string) =>
  deps.db.d1
    .prepare(`SELECT m.team_id, t.name, m.role, m.invited_by FROM team_members m JOIN teams t ON t.id = m.team_id WHERE t.org_id = ?1 AND m.email = ?2 AND m.invite_pending = 1 AND t.deleted_at IS NULL`)
    .bind(orgId, email)
    .all<PendingTeam>()
    .then((r) => r.results);

/** Tells the email's account, if it has one, that the org's invite waits for it (Admin › People › Add people). */
export async function tellInvite(deps: Deps, orgId: string, email: string, actorId: string): Promise<void> {
  const d1 = deps.db.d1;
  const u = await userByEmail(d1, email);
  const org = await d1.prepare(`SELECT name FROM orgs WHERE id = ?1`).bind(orgId).first<{ name: string }>();
  if (u && org) await notifyOrg(deps, { userId: u.id, kind: "org_invite", actorId, orgId, name: org.name, state: "pending" });
}

/**
 * At sign-in: invites made before the person had an account reach their bell — a team's for each team, the org's when
 * no team came with it. Each once (a pending row already there isn't repeated).
 */
export async function tellPendingInvites(deps: Deps, user: Pick<User, "id" | "email">): Promise<void> {
  const d1 = deps.db.d1;
  const told = async (kind: string, orgId: string, teamId: string | null) =>
    !!(await d1.prepare(`SELECT 1 AS x FROM notifications WHERE user_id = ?1 AND kind = ?2 AND org_id = ?3 AND (?4 IS NULL OR team_id = ?4) AND state = 'pending' LIMIT 1`).bind(user.id, kind, orgId, teamId).first());
  const { results: orgs } = await d1
    .prepare(`SELECT m.org_id, m.invited_by, o.name FROM org_members m JOIN orgs o ON o.id = m.org_id WHERE m.email = ?1 AND m.invite_pending = 1 AND o.deleted_at IS NULL`)
    .bind(user.email)
    .all<{ org_id: string; invited_by: string | null; name: string }>();
  const { results: teams } = await d1
    .prepare(`SELECT m.team_id, t.org_id, t.name, m.role, m.invited_by FROM team_members m JOIN teams t ON t.id = m.team_id JOIN orgs o ON o.id = t.org_id WHERE m.email = ?1 AND m.invite_pending = 1 AND t.deleted_at IS NULL AND o.deleted_at IS NULL`)
    .bind(user.email)
    .all<PendingTeam & { org_id: string }>();
  for (const t of teams)
    if (!(await told("team_invite", t.org_id, t.team_id))) await notifyOrg(deps, { userId: user.id, kind: "team_invite", actorId: t.invited_by ?? user.id, orgId: t.org_id, teamId: t.team_id, name: t.name, role: t.role, state: "pending" });
  for (const o of orgs)
    if (!teams.some((t) => t.org_id === o.org_id) && !(await told("org_invite", o.org_id, null))) await notifyOrg(deps, { userId: user.id, kind: "org_invite", actorId: o.invited_by ?? user.id, orgId: o.org_id, name: o.name, state: "pending" });
}

/** The person answers their invite to the org or one of its teams (see the header). False: nothing waits. */
export async function answerInvite(deps: Deps, user: User, req: Request, orgId: string, kind: "org_invite" | "team_invite", teamId: string | null, accept: boolean): Promise<boolean> {
  const d1 = deps.db.d1;
  const inOrg = await d1.prepare(`SELECT role FROM org_members WHERE org_id = ?1 AND email = ?2 AND invite_pending = 1`).bind(orgId, user.email).first<{ role: string }>();
  const teams = await pendingTeams(deps, orgId, user.email);
  if (!inOrg && !teams.length) return false;
  let settledTeam: string | null = null;
  if (accept) {
    if (inOrg) {
      await d1.prepare(`UPDATE org_members SET user_id = ?3, invite_pending = 0 WHERE org_id = ?1 AND email = ?2 AND invite_pending = 1`).bind(orgId, user.email, user.id).run();
      await logActivity(deps, { orgId, action: "org_user_create", actor: user, entity: userEntity(user), details: { role: inOrg.role, accepted: true }, req });
      await logExternal(deps, user, orgId, "org_user_create_external", userEntity(user), { actor: user, details: { role: inOrg.role }, req });
    }
    await d1.prepare(`UPDATE team_members SET user_id = ?3, invite_pending = 0 WHERE email = ?2 AND invite_pending = 1 AND team_id IN (SELECT id FROM teams WHERE org_id = ?1)`).bind(orgId, user.email, user.id).run();
    for (const t of teams) await logExternal(deps, user, orgId, "team_member_add_external", teamEntity({ id: t.team_id, name: t.name }), { actor: user, details: { role: t.role }, req });
  } else if (inOrg || kind === "org_invite") {
    await d1.prepare(`DELETE FROM team_members WHERE email = ?2 AND invite_pending = 1 AND team_id IN (SELECT id FROM teams WHERE org_id = ?1)`).bind(orgId, user.email).run();
    await d1.prepare(`DELETE FROM org_members WHERE org_id = ?1 AND email = ?2 AND invite_pending = 1`).bind(orgId, user.email).run();
  } else if (teamId) {
    await d1.prepare(`DELETE FROM team_members WHERE team_id = ?1 AND email = ?2 AND invite_pending = 1`).bind(teamId, user.email).run();
    settledTeam = teamId;
  }
  await settleInvites(deps, user.id, orgId, accept ? "approved" : "denied", settledTeam);
  await orgNotice(deps, [user.id], { what: "orgs" });
  return true;
}

/** The bell's answer to an organization's request or invite (notifications.ts): invites by their person, a request to
 *  join a team by one of its admins. */
export async function answerOrgNotification(deps: Deps, user: User, req: Request, n: { kind: string; org_id: string; team_id: string | null; actor_id: string }, approve: boolean): Promise<void> {
  if (n.kind === "org_invite" || n.kind === "team_invite") {
    await answerInvite(deps, user, req, n.org_id, n.kind, n.team_id, approve);
    return;
  }
  if (n.kind !== "team_join_request" || !n.team_id) throw new HttpError(404, "no such request");
  const acc = new Access(deps, user, req);
  const ctx: Ctx = { req, url: new URL(req.url), deps, user, parts: [], m: req.method, acc };
  const { team, rights } = await acc.requireTeam(n.team_id);
  if (!rights.admin) throw new HttpError(403, "only the team's admins can do that");
  const { answerJoinRequest } = await import("./teams");
  await answerJoinRequest(ctx, team, n.actor_id, approve);
}
