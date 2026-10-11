/**
 * Who can see and use an org library (docs/data.md §16.4), and the admins' wider reach for Admin › Resources.
 *
 * `canUseLibrary` for one library, in order: (1) the caller can view the library's file (resolveAccess, not by its
 * link) — guests reach libraries only this way; (2) the caller is a direct member of the file's team (their own row,
 * a group invited to the team, or its owner); (3) the library is published to the org and the caller is a member or
 * admin. `via` lists what applies; in listings rule 1 is tried only when 2 and 3 don't apply (it costs queries per
 * library), so `via` there may leave out "file".
 */
import type { OrgLibraryContext } from "../../../src/shared/libraries/orgTypes";
import type { Access, MemberRow } from "../org/db";
import type { LibRow } from "./db";

export type Via = OrgLibraryContext["via"][number];

export interface Reach {
  orgId: string;
  membership: MemberRow | null;
  /** A member or an admin (not a guest) */
  member: boolean;
  orgAdmin: boolean;
  /** Teams the caller is directly in (rule 2) */
  teams: Set<string>;
  /** Teams the caller administers or owns */
  adminTeams: Set<string>;
  /** Workspaces the caller administers */
  workspaces: Set<string>;
  /** The org's teams (not deleted) and their workspaces */
  allTeams: Map<string, string | null>;
}

/** The caller's place in the org, in three queries (cached per request by `Access` where it can be). */
export async function reachOf(acc: Access, orgId: string): Promise<Reach> {
  const m = await acc.membership(orgId);
  const { results } = await acc.d1
    .prepare(
      `SELECT t.id, t.workspace_id,
              (t.owner_id = ?2 OR EXISTS (SELECT 1 FROM team_members m WHERE m.team_id = t.id AND m.user_id = ?2)
                OR EXISTS (SELECT 1 FROM group_grants g JOIN user_group_members u ON u.group_id = g.group_id WHERE g.resource_type = 'team' AND g.resource_id = t.id AND u.user_id = ?2)) AS inside,
              (t.owner_id = ?2 OR EXISTS (SELECT 1 FROM team_members m WHERE m.team_id = t.id AND m.user_id = ?2 AND m.admin = 1)) AS admin
       FROM teams t WHERE t.org_id = ?1 AND t.deleted_at IS NULL`,
    )
    .bind(orgId, acc.user.id)
    .all<{ id: string; workspace_id: string | null; inside: number; admin: number }>();
  return {
    orgId,
    membership: m,
    member: m?.role === "admin" || m?.role === "member",
    orgAdmin: m?.role === "admin",
    teams: new Set(results.filter((r) => r.inside).map((r) => r.id)),
    adminTeams: new Set(results.filter((r) => r.admin).map((r) => r.id)),
    workspaces: new Set(m ? await acc.workspaceAdminOf(orgId) : []),
    allTeams: new Map(results.map((r) => [r.id, r.workspace_id])),
  };
}

/** Rules 2 and 3 (no query) */
export function cheapVia(r: Reach, lib: Pick<LibRow, "team_id" | "scope">): Via[] {
  const via: Via[] = [];
  if (lib.team_id && r.teams.has(lib.team_id)) via.push("team");
  if (lib.scope === "org" && r.member) via.push("org");
  return via;
}

/** Rule 1: the caller can view the file (not by its link). */
export async function viewsFile(acc: Access, key: string): Promise<boolean> {
  const f = await acc.fileRow(key);
  if (!f) return false;
  const a = await acc.file(f, { viaLink: false, passOk: false });
  return a.ok;
}

/** §16.4 for one library: every rule that applies ([] = the caller can't use it). Published libraries only. */
export async function canUseLibrary(acc: Access, lib: LibRow, reach?: Reach): Promise<Via[]> {
  if (lib.status !== "published") return [];
  const r = reach ?? (await reachOf(acc, lib.org_id));
  const via: Via[] = [];
  if (await viewsFile(acc, lib.key)) via.push("file");
  return [...via, ...cheapVia(r, lib)];
}

/** The libraries of `rows` the caller can use, each with its `via` (rule 1 only where 2 and 3 don't apply). */
export async function usable(acc: Access, r: Reach, rows: LibRow[]): Promise<{ lib: LibRow; via: Via[] }[]> {
  const out: { lib: LibRow; via: Via[] }[] = [];
  for (const lib of rows) {
    if (lib.status !== "published") continue;
    let via = cheapVia(r, lib);
    if (!via.length && (await viewsFile(acc, lib.key))) via = ["file"];
    if (via.length) out.push({ lib, via });
  }
  return out;
}

/**
 * Admin listings' reach (§16.4, [L-find]): org admins every library of the org ("including ones in closed or secret
 * teams"); workspace admins their workspaces' teams' and every org-scope one; team admins their teams' and every
 * org-scope one.
 */
export function adminSees(r: Reach, lib: Pick<LibRow, "team_id" | "workspace_id" | "scope">): boolean {
  if (r.orgAdmin) return true;
  if (lib.scope === "org" && (r.workspaces.size > 0 || r.adminTeams.size > 0)) return true;
  if (lib.workspace_id && r.workspaces.has(lib.workspace_id)) return true;
  return !!lib.team_id && r.adminTeams.has(lib.team_id);
}

/**
 * What the caller may change on this library (§16.5's table): the org row (org admins), workspace rows (org admins:
 * every workspace; workspace admins: theirs), team rows (the team's admins and owner, org admins, the team's workspace
 * admins) — and a team row only for a library that team can use: its own, or one published to the org.
 */
export async function canManage(acc: Access, r: Reach, lib: Pick<LibRow, "team_id" | "scope">): Promise<{ org: boolean; workspaceIds: string[]; teamIds: string[] }> {
  let workspaceIds = [...r.workspaces];
  if (r.orgAdmin) {
    const { results } = await acc.d1.prepare(`SELECT id FROM workspaces WHERE org_id = ?1`).bind(r.orgId).all<{ id: string }>();
    workspaceIds = results.map((w) => w.id);
  }
  const teamIds: string[] = [];
  for (const [teamId, ws] of r.allTeams) {
    if (lib.scope !== "org" && lib.team_id !== teamId) continue;
    if (r.orgAdmin || r.adminTeams.has(teamId) || (ws && r.workspaces.has(ws))) teamIds.push(teamId);
  }
  return { org: r.orgAdmin, workspaceIds, teamIds };
}
