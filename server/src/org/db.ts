/**
 * The organization's queries (docs/multiplayer.md §14.4–§14.5): the rows `resolveAccess` needs, loaded per request and
 * cached for it (`Access`), and the shapes the routes answer with. Every query is by index; the only recursive one is
 * a folder's chain (≤ 10 levels).
 */
import { resolveAccess, resolveContainer, type AccessGranted, type AccessResult, type AccessRows, type Grant } from "../../../src/shared/org/access";
import { DEFAULT_ORG_SETTINGS, type Audience, type EditorType, type FileAccess, type GrantRole, type InheritMode, type OrgFile, type OrgRole, type OrgSettings, type PersonRef, type Seat } from "../../../src/shared/org/types";
import type { Deps } from "../api";
import type { D1Like, User } from "../db";
import { branchAccess, type BranchRow } from "../branchAccess";
import { HttpError, placeholders } from "./http";
import { emailDomain, type FilePolicy } from "../../../src/shared/org/identity";
import { homeOrgOf, type HomeOrg } from "../policy/external";
import { policyOfFile } from "../policy/sharing";
import type { OrgGate } from "../../../src/shared/org/governance";
import { gateCols, gateError, gateFor, type GateRow } from "../governance/gate";

export interface FileRow {
  key: string;
  name: string;
  owner_id: string;
  org_id: string | null;
  team_id: string | null;
  project_id: string | null;
  editor_type: EditorType;
  access: InheritMode;
  link_access: Audience;
  org_link_access: Audience;
  proto_link_access: "none" | "viewer";
  /** 0015 (docs/editor.md D-6): the org's members with the prototype link */
  proto_org_link_access: "none" | "viewer";
  link_expires_at: number | null;
  viewers_can_copy: number;
  link_password: string | null;
  link_password_version: number;
  trashed_at: number | null;
  trashed_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface TeamRow {
  id: string;
  org_id: string;
  workspace_id: string | null;
  name: string;
  description: string;
  icon: string | null;
  owner_id: string;
  org_access: Audience;
  workspace_access: Audience;
  visibility: "visible" | "hidden";
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  deleted_by: string | null;
}

export interface ProjectRow {
  id: string;
  team_id: string;
  parent_id: string | null;
  depth: number;
  name: string;
  owner_id: string;
  access: InheritMode;
  created_at: number;
  updated_at: number;
  trashed_at: number | null;
  trashed_by: string | null;
}

export interface MemberRow {
  org_id: string;
  email: string;
  user_id: string | null;
  role: OrgRole;
  seat: Seat;
  workspace_id: string | null;
  billing_group_id: string | null;
  invited_by: string | null;
  created_at: number;
  seat_changed_at: number | null;
  last_active_at: number | null;
  /** 0018 (docs/governance.md §2.13): a guest's access ends then (ms); null: never */
  expires_at?: number | null;
}

export interface OrgRow {
  id: string;
  name: string;
  settings: string;
  /** Data storage localization (0013, docs/multiplayer.md §15.10) */
  data_region?: "default" | "eu";
  /** 0018 (docs/governance.md §2.1): the Governance+ add-on */
  governance_plus?: number;
  created_by: string;
  created_at: number;
  updated_at: number;
}

export const FILE_COLS = `f.key, f.name, f.owner_id, f.org_id, f.team_id, f.project_id, f.editor_type, f.access, f.link_access, f.org_link_access, f.proto_link_access, f.proto_org_link_access,
  f.link_expires_at, f.viewers_can_copy, f.link_password, f.link_password_version, f.trashed_at, f.trashed_by, f.created_at, f.updated_at`;

export function settingsOf(row: Pick<OrgRow, "settings"> | null): OrgSettings {
  let s: Partial<OrgSettings> = {};
  try {
    s = JSON.parse(row?.settings ?? "{}") as Partial<OrgSettings>;
  } catch {
    // defaults
  }
  return { ...DEFAULT_ORG_SETTINGS, ...s, seatApproval: { ...DEFAULT_ORG_SETTINGS.seatApproval, ...(s.seatApproval ?? {}) } };
}

/** Rows of one principal kind into `Grant`s */
const toGrants = (rows: { user_id?: string | null; email?: string | null; group_id?: string | null; role: GrantRole; admin?: number }[]): Grant[] =>
  rows.map((r) => ({ userId: r.user_id ?? null, email: r.email ?? null, groupId: r.group_id ?? null, role: r.role, ...(r.admin ? { admin: true } : {}) }));

/**
 * The caller's access, resolved with rows loaded once per request. Grants are loaded for the caller only (their own
 * rows, by user id or pending email, and their groups').
 */
export class Access {
  private cache = new Map<string, Promise<unknown>>();
  readonly d1: D1Like;

  constructor(
    readonly deps: Deps,
    readonly user: User,
    /** The request, for the Governance+ gates' IP allowlist (docs/governance.md §2.5); null: not checked */
    readonly req: Request | null = null,
  ) {
    this.d1 = deps.db.d1;
  }

  private once<T>(key: string, fn: () => Promise<T>): Promise<T> {
    let p = this.cache.get(key) as Promise<T> | undefined;
    if (!p) {
      p = fn();
      this.cache.set(key, p);
    }
    return p;
  }

  /** The caller's home org (docs/multiplayer.md §15.9; external.ts) */
  home(): Promise<HomeOrg | null> {
    return this.once(`home`, () => homeOrgOf(this.d1, this.user));
  }

  /** A file's sharing policy (§15.6; null outside orgs), its org's settings and workspace read once per request */
  policy(f: Pick<FileRow, "org_id" | "team_id" | "editor_type">): Promise<FilePolicy | null> {
    return policyOfFile(this.d1, f, (k, fn) => this.once(k, fn));
  }

  /** Forget what was read (after a write in the same request) */
  reset(): void {
    this.cache.clear();
  }

  /** The caller's row in the org. A guest whose access expired (with Governance+, docs/governance.md §2.13) has none. */
  membership(orgId: string): Promise<MemberRow | null> {
    return this.once(`m:${orgId}`, () =>
      this.d1
        .prepare(
          `SELECT m.* FROM org_members m JOIN orgs o ON o.id = m.org_id WHERE m.org_id = ?1 AND (m.user_id = ?2 OR (m.user_id IS NULL AND m.email = ?3))
           AND (m.expires_at IS NULL OR o.governance_plus = 0 OR m.expires_at > ?4)`,
        )
        .bind(orgId, this.user.id, this.user.email, this.deps.now())
        .first<MemberRow>(),
    );
  }

  /**
   * What blocks the caller in the org (docs/governance.md §2.5), once per request: nothing (no query) without the add-on
   * or outside the org; otherwise one query (gate.ts `gateCols`).
   */
  gate(orgId: string): Promise<OrgGate | null> {
    return this.once(`gate:${orgId}`, async () => {
      const org = await this.org(orgId);
      if (!org?.governance_plus) return null;
      const m = await this.membership(orgId);
      if (!m) return null;
      const row = await this.d1.prepare(`SELECT ${gateCols("?2")} FROM orgs o WHERE o.id = ?1`).bind(orgId, this.user.id).first<GateRow>();
      return row ? gateFor(this.deps, { orgId, settings: org.settings, role: m.role, user: this.user, req: this.req, row }) : null;
    });
  }

  /** 403 `{error, code, gate}` when the caller is gated in the org */
  async checkGate(orgId: string): Promise<void> {
    const g = await this.gate(orgId);
    if (g) throw gateError(g, (await this.org(orgId))?.name ?? "");
  }

  org(orgId: string): Promise<OrgRow | null> {
    return this.once(`o:${orgId}`, () => this.d1.prepare(`SELECT * FROM orgs WHERE id = ?1`).bind(orgId).first<OrgRow>());
  }

  async settings(orgId: string): Promise<OrgSettings> {
    return settingsOf(await this.org(orgId));
  }

  groups(orgId: string): Promise<string[]> {
    return this.once(`g:${orgId}`, async () => {
      const { results } = await this.d1.prepare(`SELECT m.group_id FROM user_group_members m JOIN user_groups g ON g.id = m.group_id WHERE m.user_id = ?1 AND g.org_id = ?2`).bind(this.user.id, orgId).all<{ group_id: string }>();
      return results.map((r) => r.group_id);
    });
  }

  workspaceAdminOf(orgId: string): Promise<string[]> {
    return this.once(`wa:${orgId}`, async () => {
      const { results } = await this.d1.prepare(`SELECT a.workspace_id FROM workspace_admins a JOIN workspaces w ON w.id = a.workspace_id WHERE a.user_id = ?1 AND w.org_id = ?2`).bind(this.user.id, orgId).all<{ workspace_id: string }>();
      return results.map((r) => r.workspace_id);
    });
  }

  billingAdminOf(orgId: string): Promise<string[]> {
    return this.once(`ba:${orgId}`, async () => {
      const { results } = await this.d1.prepare(`SELECT a.billing_group_id FROM billing_group_admins a JOIN billing_groups b ON b.id = a.billing_group_id WHERE a.user_id = ?1 AND b.org_id = ?2`).bind(this.user.id, orgId).all<{ billing_group_id: string }>();
      return results.map((r) => r.billing_group_id);
    });
  }

  team(teamId: string): Promise<TeamRow | null> {
    return this.once(`t:${teamId}`, () => this.d1.prepare(`SELECT * FROM teams WHERE id = ?1`).bind(teamId).first<TeamRow>());
  }

  teamGrants(teamId: string): Promise<Grant[]> {
    return this.once(`tg:${teamId}`, async () => {
      const { results: people } = await this.d1
        .prepare(`SELECT user_id, email, role, admin FROM team_members WHERE team_id = ?1 AND (user_id = ?2 OR (user_id IS NULL AND email = ?3))`)
        .bind(teamId, this.user.id, this.user.email)
        .all<{ user_id: string | null; email: string; role: GrantRole; admin: number }>();
      return [...toGrants(people), ...(await this.groupGrants("team", teamId))];
    });
  }

  private async groupGrants(type: "team" | "project" | "file", id: string): Promise<Grant[]> {
    const { results } = await this.d1
      .prepare(`SELECT group_id, role FROM group_grants WHERE resource_type = ?1 AND resource_id = ?2 AND group_id IN (SELECT group_id FROM user_group_members WHERE user_id = ?3)`)
      .bind(type, id, this.user.id)
      .all<{ group_id: string; role: GrantRole }>();
    return toGrants(results);
  }

  project(id: string): Promise<ProjectRow | null> {
    return this.once(`p:${id}`, () => this.d1.prepare(`SELECT * FROM projects WHERE id = ?1`).bind(id).first<ProjectRow>());
  }

  /** The folder and its parents, nearest first */
  chain(projectId: string): Promise<ProjectRow[]> {
    return this.once(`c:${projectId}`, () => folderChain(this.d1, projectId));
  }

  private folderRows(projectId: string): Promise<AccessRows["folders"]> {
    return this.once(`cf:${projectId}`, async () => {
      const chain = await this.chain(projectId);
      if (!chain.length) return [];
      const ids = chain.map((p) => p.id);
      const { results: people } = await this.d1
        .prepare(`SELECT project_id, user_id, email, role FROM project_members WHERE project_id IN (${placeholders(ids.length, 3)}) AND (user_id = ?1 OR (user_id IS NULL AND email = ?2))`)
        .bind(this.user.id, this.user.email, ...ids)
        .all<{ project_id: string; user_id: string | null; email: string; role: GrantRole }>();
      const { results: groups } = await this.d1
        .prepare(
          `SELECT resource_id AS project_id, group_id, role FROM group_grants WHERE resource_type = 'project' AND resource_id IN (${placeholders(ids.length, 2)})
           AND group_id IN (SELECT group_id FROM user_group_members WHERE user_id = ?1)`,
        )
        .bind(this.user.id, ...ids)
        .all<{ project_id: string; group_id: string; role: GrantRole }>();
      return chain.map((p) => ({
        id: p.id,
        ownerId: p.owner_id,
        access: p.access,
        grants: [...toGrants(people.filter((g) => g.project_id === p.id)), ...toGrants(groups.filter((g) => g.project_id === p.id))],
      }));
    });
  }

  fileRow(key: string): Promise<FileRow | null> {
    return this.once(`f:${key}`, () => this.d1.prepare(`SELECT ${FILE_COLS} FROM files f WHERE f.key = ?1`).bind(key).first<FileRow>());
  }

  private async fileGrants(f: FileRow): Promise<Grant[]> {
    const { results } = await this.d1
      .prepare(`SELECT user_id, email, role FROM members WHERE file_key = ?1 AND (user_id = ?2 OR (user_id IS NULL AND email = ?3))`)
      .bind(f.key, this.user.id, this.user.email)
      .all<{ user_id: string | null; email: string; role: GrantRole }>();
    return [...toGrants(results), ...(f.org_id ? await this.groupGrants("file", f.key) : [])];
  }

  /** Invited from Share prototype (docs/editor.md D-6; 0015 prototype_members), by user id or email */
  private prototypeMember(key: string): Promise<boolean> {
    return this.once(`pm:${key}`, async () => !!(await this.d1.prepare(`SELECT 1 AS x FROM prototype_members WHERE file_key = ?1 AND (user_id = ?2 OR email = ?3) LIMIT 1`).bind(key, this.user.id, this.user.email).first()));
  }

  /** Is someone (by id) in the org? Drafts of people removed are "Unassigned drafts" (§14.7). */
  ownerInOrg(orgId: string, userId: string): Promise<boolean> {
    return this.once(`oi:${orgId}:${userId}`, async () => !!(await this.d1.prepare(`SELECT 1 AS x FROM org_members WHERE org_id = ?1 AND user_id = ?2`).bind(orgId, userId).first()));
  }

  async rowsFor(f: FileRow, opts: { viaLink: boolean; passOk: boolean }): Promise<AccessRows> {
    const orgId = f.org_id;
    const folders = f.project_id ? await this.folderRows(f.project_id) : [];
    const chain = f.project_id ? await this.chain(f.project_id) : [];
    const team = f.team_id ? await this.team(f.team_id) : null;
    // A file in a trashed folder is in the trash with it.
    const trashedAt = f.trashed_at ?? chain.find((p) => p.trashed_at !== null)?.trashed_at ?? null;
    const m = orgId ? await this.membership(orgId) : null;
    const home = await this.home();
    return {
      user: { id: this.user.id, email: this.user.email },
      file: {
        key: f.key,
        ownerId: f.owner_id,
        orgId,
        teamId: f.team_id,
        projectId: f.project_id,
        editorType: f.editor_type,
        access: f.access,
        linkAccess: f.link_access,
        orgLinkAccess: f.org_link_access,
        linkExpiresAt: f.link_expires_at,
        viewersCanCopy: f.viewers_can_copy !== 0,
        passwordProtected: f.link_password !== null,
        trashedAt,
        protoLinkAccess: f.proto_link_access,
        protoOrgLinkAccess: f.proto_org_link_access,
      },
      prototypeMember: await this.prototypeMember(f.key),
      fileGrants: await this.fileGrants(f),
      folders,
      team: team ? { id: team.id, ownerId: team.owner_id, workspaceId: team.workspace_id, orgAccess: team.org_access, workspaceAccess: team.workspace_access, visibility: team.visibility, deletedAt: team.deleted_at, grants: await this.teamGrants(team.id) } : null,
      membership: m ? { role: m.role, seat: m.seat, workspaceId: m.workspace_id } : null,
      workspaceAdminOf: orgId ? await this.workspaceAdminOf(orgId) : [],
      userGroups: orgId ? await this.groups(orgId) : [],
      viaLink: opts.viaLink,
      passOk: opts.passOk,
      externalRestricted: home?.restricted ?? false,
      homeOrgId: home?.orgId ?? null,
      policy: await this.policy(f),
      now: this.deps.now(),
      ownerInOrg: orgId && !f.project_id ? await this.ownerInOrg(orgId, f.owner_id) : true,
    };
  }

  /** The file's `branches` row when it is a branch (docs/data.md §15.7), else null */
  branch(key: string): Promise<BranchRow | null> {
    return this.once(`b:${key}`, () => this.d1.prepare(`SELECT * FROM branches WHERE key = ?1`).bind(key).first<BranchRow>());
  }

  async file(f: FileRow, opts: { viaLink: boolean; passOk: boolean } = { viaLink: false, passOk: false }): Promise<AccessResult> {
    // A branch resolves through its main file (§15.7; branchAccess.ts).
    const b = await this.branch(f.key);
    if (b) {
      const main = await this.fileRow(b.main_key);
      if (!main) return { ok: false, reason: "none", role: null };
      return branchAccess(resolveAccess(await this.rowsFor(main, opts)), b, this.user.id);
    }
    return resolveAccess(await this.rowsFor(f, opts));
  }

  /**
   * `file` for a route that serves this one file (by its key): once it opens, the org's Governance+ gates (§2.5) apply
   * to the org's people — 403 `{error, code, gate}`. Link visitors from outside the org have no membership, so no gate;
   * no query without the add-on. Listings keep `file` (a gated org's files aren't errors there).
   */
  async openFile(f: FileRow, opts: { viaLink: boolean; passOk: boolean } = { viaLink: true, passOk: false }): Promise<AccessResult> {
    const a = await this.file(f, opts);
    if (a.ok && f.org_id) await this.checkGate(f.org_id);
    return a;
  }

  /** A team's or a folder's access: an Inherited file with no rows of its own inside it. */
  async container(teamId: string, projectId: string | null): Promise<AccessResult> {
    const team = await this.team(teamId);
    if (!team) return { ok: false, reason: "none", role: null };
    const m = await this.membership(team.org_id);
    const chainTrashed = projectId ? (await this.chain(projectId)).some((p) => p.trashed_at !== null) : false;
    const r = resolveContainer({
      user: { id: this.user.id, email: this.user.email },
      orgId: team.org_id,
      teamId,
      projectId,
      folders: projectId ? await this.folderRows(projectId) : [],
      team: { id: team.id, ownerId: team.owner_id, workspaceId: team.workspace_id, orgAccess: team.org_access, workspaceAccess: team.workspace_access, visibility: team.visibility, deletedAt: team.deleted_at, grants: await this.teamGrants(team.id) },
      membership: m ? { role: m.role, seat: m.seat, workspaceId: m.workspace_id } : null,
      workspaceAdminOf: await this.workspaceAdminOf(team.org_id),
      userGroups: await this.groups(team.org_id),
      now: this.deps.now(),
    });
    // A folder in the trash: its editors and admins still see it (to restore), read-only.
    if (r.ok && chainTrashed) return r.role === "viewer" && !r.canManage ? { ok: false, reason: "none", role: null } : { ...r, trashed: true, canEdit: false };
    return r;
  }

  /** The caller's membership, or 404 (an org they aren't in doesn't exist for them). */
  /** The caller's membership, or 404; gated (§2.5) unless `gate: false` (the gate's own routes). */
  async requireMember(orgId: string, opts: { guests?: boolean; gate?: boolean } = {}): Promise<MemberRow> {
    const m = await this.membership(orgId);
    if (!m || !(await this.org(orgId))) throw new HttpError(404, "no such organization");
    if (opts.gate !== false) await this.checkGate(orgId);
    if (!opts.guests && m.role === "guest") throw new HttpError(403, "guests can't do that");
    return m;
  }

  async requireOrgAdmin(orgId: string): Promise<MemberRow> {
    const m = await this.requireMember(orgId, { guests: true });
    if (m.role !== "admin") throw new HttpError(403, "only organization admins can do that", "not_admin");
    return m;
  }

  /** The caller's place in a team (§14.2): their own row, admin rights, and whether they may see it. */
  async teamRights(team: TeamRow) {
    const m = await this.membership(team.org_id);
    const grants = await this.teamGrants(team.id);
    let role: GrantRole | null = null;
    let teamAdmin = false;
    for (const g of grants) {
      if (role !== "editor") role = g.role === "editor" ? "editor" : (role ?? g.role);
      if (g.admin && !g.groupId) teamAdmin = true;
    }
    const owner = team.owner_id === this.user.id;
    const orgAdmin = m?.role === "admin";
    const wsAdmin = !!team.workspace_id && team.visibility !== "hidden" && (await this.workspaceAdminOf(team.org_id)).includes(team.workspace_id);
    const deleted = team.deleted_at !== null;
    const memberLike = m !== null && m.role !== "guest";
    const audience = memberLike && (team.org_access !== "none" || (team.workspace_access !== "none" && m!.workspace_id !== null && m!.workspace_id === team.workspace_id));
    const inTeam = role !== null || owner;
    const canSee = !!m && (orgAdmin || (deleted ? owner : inTeam || wsAdmin || (memberLike && (team.visibility === "visible" || audience))));
    const admin = !deleted && (teamAdmin || owner || orgAdmin || wsAdmin);
    const requested = !!(await this.d1.prepare(`SELECT 1 AS x FROM team_requests WHERE team_id = ?1 AND user_id = ?2`).bind(team.id, this.user.id).first());
    return { membership: m, role, teamAdmin, owner, orgAdmin, wsAdmin, admin, canSee, inTeam, audience, requested, editor: admin || role === "editor" };
  }

  /** A team the caller can see, or 404 */
  async requireTeam(teamId: string) {
    const team = await this.team(teamId);
    if (!team) throw new HttpError(404, "no such team");
    const rights = await this.teamRights(team);
    if (!rights.canSee) throw new HttpError(404, "no such team");
    if (rights.membership) await this.checkGate(team.org_id);
    return { team, rights };
  }
}

/** A folder and its parents, nearest first. */
export async function folderChain(d1: D1Like, projectId: string): Promise<ProjectRow[]> {
  const { results } = await d1
    .prepare(
      `WITH RECURSIVE chain(id, n) AS (SELECT id, 0 FROM projects WHERE id = ?1
         UNION ALL SELECT p.parent_id, c.n + 1 FROM chain c JOIN projects p ON p.id = c.id WHERE p.parent_id IS NOT NULL AND c.n < 11)
       SELECT p.* FROM chain c JOIN projects p ON p.id = c.id ORDER BY c.n`,
    )
    .bind(projectId)
    .all<ProjectRow>();
  return results;
}

/** Every folder under `projectId`, itself included. */
export async function subtree(d1: D1Like, projectId: string): Promise<ProjectRow[]> {
  const { results } = await d1
    .prepare(
      `WITH RECURSIVE sub(id, n) AS (SELECT id, 0 FROM projects WHERE id = ?1
         UNION ALL SELECT p.id, s.n + 1 FROM projects p JOIN sub s ON p.parent_id = s.id WHERE s.n < 11)
       SELECT p.* FROM sub s JOIN projects p ON p.id = s.id ORDER BY s.n`,
    )
    .bind(projectId)
    .all<ProjectRow>();
  return results;
}

export const fileAccessOf = (a: AccessGranted): FileAccess => ({ role: a.role, canEdit: a.canEdit, canComment: a.canComment, canExport: a.canExport, canDevMode: a.canDevMode, canShare: a.canShare, canManage: a.canManage, capped: a.capped, prototypeOnly: a.prototypeOnly, via: a.via });

export function toOrgFile(f: FileRow & { owner_name?: string | null; owner_email?: string | null; branch_count?: number | null }, a: AccessGranted): OrgFile {
  return {
    // Active branches (docs/data.md §15.7; Home's tile): only when there are some
    ...(f.branch_count ? { branchCount: Number(f.branch_count) } : {}),
    key: f.key,
    name: f.name,
    editorType: f.editor_type,
    ownerId: f.owner_id,
    ownerName: f.owner_name || f.owner_email || null,
    orgId: f.org_id!,
    teamId: f.team_id,
    projectId: f.project_id,
    updatedAt: f.updated_at,
    createdAt: f.created_at,
    trashedAt: f.trashed_at,
    thumbnailUrl: null,
    access: fileAccessOf(a),
    fileKey: null,
  };
}

/** Files (with their owner's name) the caller can open, of those `where` selects. */
export async function accessibleFiles(acc: Access, where: string, args: unknown[], opts: { trashed?: boolean } = {}): Promise<OrgFile[]> {
  const { results } = await acc.d1
    // Branches are listed under their main file (docs/data.md §15.7), not as files of their own.
    // Home's file tiles show how many active branches a main file has (round 2d, help.figma.com "View and manage branches").
    .prepare(
      `SELECT ${FILE_COLS}, u.name AS owner_name, u.email AS owner_email, (SELECT COUNT(*) FROM branches bc WHERE bc.main_key = f.key AND bc.status = 'active') AS branch_count FROM files f LEFT JOIN users u ON u.id = f.owner_id WHERE (${where}) AND NOT EXISTS (SELECT 1 FROM branches b WHERE b.key = f.key) ORDER BY f.updated_at DESC`,
    )
    .bind(...args)
    .all<FileRow & { owner_name: string | null; owner_email: string | null; branch_count: number }>();
  const out: OrgFile[] = [];
  for (const f of results) {
    const a = await acc.file(f);
    // Prototype-only files aren't listed (they open from their link: docs/editor.md D-6)
    if (!a.ok || a.prototypeOnly || (!opts.trashed && a.trashed)) continue;
    out.push(toOrgFile(f, a));
  }
  return out;
}

export function personRef(r: { id: string; email: string; name: string | null; picture: string | null; role?: OrgRole | null }): PersonRef {
  return { id: r.id, email: r.email, name: r.name, picture: r.picture, role: r.role ?? "member" };
}

/** A user by id with their role in the org (null: no such user) */
export async function personIn(d1: D1Like, orgId: string, userId: string): Promise<PersonRef | null> {
  const r = await d1
    .prepare(`SELECT u.id, u.email, u.name, u.picture, m.role FROM users u LEFT JOIN org_members m ON m.user_id = u.id AND m.org_id = ?2 WHERE u.id = ?1`)
    .bind(userId, orgId)
    .first<{ id: string; email: string; name: string | null; picture: string | null; role: OrgRole | null }>();
  return r ? personRef(r) : null;
}

/** Invites waiting for this email (org, team, folder rows) become this user's — at sign-in, as 0001's members. */
export async function claimInvites(d1: D1Like, user: { id: string; email: string }): Promise<void> {
  // A member whose home org restricts external content doesn't accept outside invites (§15.6) [F-external]: those
  // stay pending by email. The would-be home org's invite (an org owning the email's verified domain) is claimed first.
  const domain = emailDomain(user.email);
  if (domain) await d1.prepare(`UPDATE org_members SET user_id = ?1 WHERE email = ?2 AND user_id IS NULL AND org_id IN (SELECT org_id FROM org_domains WHERE domain = ?3 AND verified_at IS NOT NULL)`).bind(user.id, user.email, domain).run();
  const home = await homeOrgOf(d1, user);
  if (home?.restricted) {
    await d1.prepare(`UPDATE org_members SET user_id = ?1 WHERE email = ?2 AND user_id IS NULL AND org_id = ?3`).bind(user.id, user.email, home.orgId).run();
    await d1.prepare(`UPDATE team_members SET user_id = ?1 WHERE email = ?2 AND user_id IS NULL AND team_id IN (SELECT id FROM teams WHERE org_id = ?3)`).bind(user.id, user.email, home.orgId).run();
    await d1.prepare(`UPDATE project_members SET user_id = ?1 WHERE email = ?2 AND user_id IS NULL AND project_id IN (SELECT p.id FROM projects p JOIN teams t ON t.id = p.team_id WHERE t.org_id = ?3)`).bind(user.id, user.email, home.orgId).run();
    return;
  }
  for (const t of ["org_members", "team_members", "project_members"]) await d1.prepare(`UPDATE ${t} SET user_id = ?1 WHERE email = ?2 AND user_id IS NULL`).bind(user.id, user.email).run();
}

export async function userByEmail(d1: D1Like, email: string): Promise<{ id: string; email: string; name: string | null } | null> {
  return d1.prepare(`SELECT id, email, name FROM users WHERE email = ?1 ORDER BY created_at LIMIT 1`).bind(email).first();
}

export async function orgMembership(d1: D1Like, orgId: string, userId: string): Promise<MemberRow | null> {
  return d1.prepare(`SELECT * FROM org_members WHERE org_id = ?1 AND user_id = ?2`).bind(orgId, userId).first<MemberRow>();
}

/** Re-exported for the files routes */
export { resolveAccess };

/** Can this person open the file now (by its link, past any password)? "Only people who can open the file are told" (§12, §14.9). */
export async function canOpen(deps: Deps, key: string, userId: string): Promise<AccessGranted | null> {
  const user = await deps.db.user(userId);
  if (!user) return null;
  const acc = new Access(deps, user);
  const f = await acc.fileRow(key);
  if (!f) return null;
  const a = await acc.file(f, { viaLink: true, passOk: true });
  return a.ok && !a.trashed ? a : null;
}
