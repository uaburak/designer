/**
 * Permission resolution (docs/multiplayer.md §14.4): one pure function over plain rows, shared by the Worker (every
 * files route and the room's socket), the store (greying out actions offline) and the tests. No I/O: the server loads
 * the rows (`server/src/org/db.ts loadAccessRows`).
 *
 * As built (round 1a), beyond §14.4's pseudo-code:
 * - a trashed file resolves for its owner, its editors and admins only (§14.5 "restorable by their owner, editors and
 *   admins"), read-only (`canEdit` false, `roomRole` viewer, `trashed` true);
 * - the owner of an org file counts as owner only while they are in the org (§14.7: someone removed loses their
 *   drafts, which admins then reach as "Unassigned drafts" — `ownerInOrg: false`);
 * - an expired link (`link_expires_at`) stops the org link as well as the public one; someone who would have been let
 *   in only by an expired link gets `gone` (HTTP 410), by a link behind a password they have no pass for
 *   `password_required` (403);
 * - a soft-deleted team's content resolves for org admins only.
 *
 * Round 4 (docs/multiplayer.md §15.9): the public link (step 4) yields to the file's sharing policy (public links off;
 * passwords required and none set); the external cap (step 5) applies to files outside the user's home org — files
 * outside any org included, so a restricted member's own drafts elsewhere become view-only.
 */
import type { FilePolicy } from "./identity";
import type { Audience, EditorType, FileAccess, GrantRole, InheritMode, Level, OrgRole, Seat } from "./types";

/** A grant row: a person (by user id, or by email while the invite is pending) or a user group. */
export interface Grant {
  userId: string | null;
  email: string | null;
  groupId: string | null;
  role: GrantRole;
  /** Team rows only: "Admin" */
  admin?: boolean;
}

export interface AccessRows {
  /** null: not signed in (embeds, previews) */
  user: { id: string; email: string } | null;
  file: {
    key: string;
    ownerId: string;
    orgId: string | null;
    teamId: string | null;
    projectId: string | null;
    editorType: EditorType;
    access: InheritMode;
    linkAccess: Audience;
    orgLinkAccess: Audience;
    linkExpiresAt: number | null;
    viewersCanCopy: boolean;
    passwordProtected: boolean;
    trashedAt: number | null;
  };
  /** members rows (user or pending email) + group_grants on the file */
  fileGrants: Grant[];
  /** Nearest first, to the top */
  folders: { id: string; ownerId: string; access: InheritMode; grants: Grant[] }[];
  team: { id: string; ownerId: string; workspaceId: string | null; orgAccess: Audience; workspaceAccess: Audience; visibility: "visible" | "hidden"; deletedAt: number | null; grants: Grant[] } | null;
  /** The user in file.orgId */
  membership: { role: OrgRole; seat: Seat; workspaceId: string | null } | null;
  workspaceAdminOf: string[];
  /** Groups the user is in (same org) */
  userGroups: string[];
  /** The request names the file by its link */
  viaLink: boolean;
  /** A valid x-file-pass for the current password (§6 item 8) */
  passOk: boolean;
  /** Round 4: the user's home org (§15.9) restricts external content; the cap applies to files outside `homeOrgId` */
  externalRestricted: boolean;
  /** Round 4: the org whose verified domain matches the user's email, with capture on and the user a member there */
  homeOrgId?: string | null;
  /** Round 4: the file's sharing policy (§15.6; null or absent outside orgs) */
  policy?: FilePolicy | null;
  now: number;
  /** Is the file's owner still in its org? (default true; false: an unassigned draft, §14.7) */
  ownerInOrg?: boolean;
}

export type AccessGranted = { ok: true; roomRole: Level; canView: true; trashed: boolean } & FileAccess;
export type AccessDenied = { ok: false; reason: "none" | "password_required" | "gone"; role: Level | null };
export type AccessResult = AccessGranted | AccessDenied;
type Via = FileAccess["via"][number];

const RANK: Record<Level, number> = { viewer: 1, editor: 2, owner: 3 };
export const levelRank = (l: Level | null | undefined): number => (l ? RANK[l] : 0);
export const maxLevel = (a: Level | null, b: Level | Audience | null | undefined): Level | null => {
  const bb = b === "none" || b === undefined ? null : b;
  return levelRank(bb) > levelRank(a) ? bb : a;
};

/** What each seat may edit (§14.3; Dev Mode is `canDevMode`). Sites and Make: Full only (the drafts trial is not modelled). */
export function seatCanEdit(seat: Seat, t: EditorType): boolean {
  if (seat === "full") return true;
  if (seat === "view") return false;
  if (t === "design" || t === "sites" || t === "make") return false;
  return true; // figjam, slides, buzz: Dev and Collab edit
}

/** The least seat that edits this kind of file (`seat_required`'s `seat`) */
export const seatNeeded = (t: EditorType): Seat => (t === "design" || t === "sites" || t === "make" ? "full" : "collab");

/** The highest role among the user's own rows and those of their groups. */
export function grantOf(gs: readonly Grant[], user: { id: string; email: string } | null, groups: readonly string[]): { role: GrantRole | null; admin: boolean } {
  let role: Level | null = null;
  let admin = false;
  if (!user) return { role: null, admin };
  for (const g of gs) {
    const mine = (g.userId !== null && g.userId === user.id) || (g.userId === null && g.email !== null && g.email === user.email) || (g.groupId !== null && groups.includes(g.groupId));
    if (!mine) continue;
    role = maxLevel(role, g.role);
    if (g.admin && g.groupId === null) admin = true;
  }
  return { role: role as GrantRole | null, admin };
}

export function resolveAccess(r: AccessRows): AccessResult {
  return r.file.orgId === null ? legacy(r) : org(r);
}

const linkLive = (r: AccessRows) => r.file.linkExpiresAt === null || r.now < r.file.linkExpiresAt;

/** The policy lets the public link work (§15.9): public links on, and a password set when passwords are required */
export const publicLinkAllowed = (r: Pick<AccessRows, "policy" | "file">): boolean => !r.policy || (r.policy.publicLinks && (!r.policy.passwordRequired || r.file.passwordProtected));

/** The external cap applies: the user's home org restricts and the file isn't in it */
const isExternal = (r: AccessRows): boolean => r.externalRestricted && (r.homeOrgId == null || r.file.orgId !== r.homeOrgId);

/** §3 exactly as today: owner, members, "Anyone with the link" (+ its password); expiry applies too. */
function legacy(r: AccessRows): AccessResult {
  const via: Via[] = [];
  let role: Level | null = null;
  if (r.user && r.user.id === r.file.ownerId) {
    role = "owner";
    via.push("file");
  }
  const g = grantOf(r.fileGrants, r.user, []);
  if (g.role) {
    role = maxLevel(role, g.role);
    if (!via.includes("file")) via.push("file");
  }
  const link = linkStep(r, role, via);
  if (link) return link;
  role = maxLevel(role, r.user && r.file.linkAccess !== "none" && linkLive(r) ? r.file.linkAccess : null);
  if (!role) return { ok: false, reason: "none", role: null };
  if (r.file.trashedAt !== null && role === "viewer") return { ok: false, reason: "none", role: null };
  const trashed = r.file.trashedAt !== null;
  // Round 4: a restricted member's files outside any org are view-only — their own drafts there too [F-external].
  const external = isExternal(r);
  const canEdit = !trashed && role !== "viewer" && !external;
  return {
    ok: true,
    role,
    roomRole: canEdit ? role : "viewer",
    canView: true,
    trashed,
    canEdit,
    canComment: !trashed && !external,
    canExport: canEdit || r.file.viewersCanCopy,
    canDevMode: true,
    canShare: role !== "viewer" && !external,
    canManage: role === "owner",
    capped: external ? "external" : null,
    prototypeOnly: false,
    via,
  };
}

/**
 * The public link's step (shared by both paths): pushes "link" when it raises the role; returns a refusal when the
 * link alone would let the caller in but its password or expiry stops them.
 */
function linkStep(r: AccessRows, role: Level | null, via: Via[]): AccessDenied | null {
  if (!r.user || r.file.linkAccess === "none") return null;
  if (r.file.orgId !== null && !r.viaLink) return null;
  if (!publicLinkAllowed(r)) return null;
  if (!linkLive(r)) return role === null ? { ok: false, reason: "gone", role: null } : null;
  if (r.file.passwordProtected && !r.passOk && role === null) return { ok: false, reason: "password_required", role: r.file.linkAccess };
  if (levelRank(r.file.linkAccess) > levelRank(role)) via.push("link");
  return null;
}

function org(r: AccessRows): AccessResult {
  const { file, user, membership } = r;
  const via: Via[] = [];
  const add = (v: Via) => {
    if (!via.includes(v)) via.push(v);
  };
  let role: Level | null = null;
  let teamAdmin = false;
  const isOrgAdmin = membership?.role === "admin";
  const teamGone = r.team !== null && r.team.deletedAt !== null;
  if (teamGone && !isOrgAdmin) return { ok: false, reason: "none", role: null };

  // 1. individual roles (never reduced downwards)
  if (user && user.id === file.ownerId && membership) {
    role = "owner";
    add("file");
  }
  const fg = grantOf(r.fileGrants, user, r.userGroups);
  if (fg.role) {
    role = maxLevel(role, fg.role);
    add("file");
  }
  for (const f of r.folders) {
    const g = grantOf(f.grants, user, r.userGroups);
    const own = user !== null && f.ownerId === user.id ? "editor" : null;
    const got = maxLevel(own, g.role);
    if (got) {
      role = maxLevel(role, got);
      add("folder");
    }
  }
  if (r.team && !teamGone) {
    const t = grantOf(r.team.grants, user, r.userGroups);
    teamAdmin = t.admin || (user !== null && r.team.ownerId === user.id);
    const got = maxLevel(t.role, teamAdmin ? "editor" : null);
    if (got) {
      role = maxLevel(role, got);
      add("team");
    }
  }
  // 2. admins (§14.2 rule 4); never on someone else's draft while they are in the org
  const unassigned = file.projectId === null && r.ownerInOrg === false;
  let orgAdmin = false;
  let wsAdmin = false;
  if (file.projectId !== null || unassigned) {
    if (isOrgAdmin) {
      orgAdmin = true;
      role = maxLevel(role, "editor");
      add("org-admin");
    }
    if (r.team && r.team.workspaceId !== null && r.workspaceAdminOf.includes(r.team.workspaceId) && r.team.visibility !== "hidden" && !teamGone) {
      wsAdmin = true;
      role = maxLevel(role, "editor");
      add("workspace-admin");
    }
  }
  // 3. audience (members only; stops at the first Limited level, the file's own counted)
  if (membership && (membership.role === "admin" || membership.role === "member") && !teamGone) {
    let a: Level | null = r.viaLink && linkLive(r) ? maxLevel(null, file.orgLinkAccess) : null;
    if (file.access === "inherited" && r.folders.every((f) => f.access === "inherited") && r.team) {
      if (r.team.orgAccess !== "none") a = maxLevel(a, r.team.orgAccess);
      if (r.team.workspaceAccess !== "none" && membership.workspaceId !== null && membership.workspaceId === r.team.workspaceId) a = maxLevel(a, r.team.workspaceAccess);
    }
    if (levelRank(a) > levelRank(role)) {
      role = a;
      add("audience");
    }
  }
  // 4. public link (anyone signed in, guests included)
  const refused = linkStep(r, role, via);
  if (refused) return refused;
  if (via.includes("link")) role = maxLevel(role, file.linkAccess);
  if (!role) {
    // An org link that has expired: "gone" to someone it alone would have let in.
    if (r.viaLink && !linkLive(r) && file.orgLinkAccess !== "none" && membership && membership.role !== "guest") return { ok: false, reason: "gone", role: null };
    return { ok: false, reason: "none", role: null };
  }
  const canManage = role === "owner" || orgAdmin || wsAdmin || teamAdmin;
  const trashed = file.trashedAt !== null;
  if (trashed && role === "viewer" && !canManage) return { ok: false, reason: "none", role: null };

  // 5. caps
  let capped: FileAccess["capped"] = null;
  let canEdit = role === "owner" || role === "editor";
  if (canEdit && membership && !seatCanEdit(membership.seat, file.editorType)) {
    canEdit = false;
    capped = "seat";
  }
  const external = isExternal(r);
  if (canEdit && external) {
    canEdit = false;
    capped = "external";
  }
  if (external && !capped) capped = "external";
  if (trashed) canEdit = false;
  return {
    ok: true,
    role,
    roomRole: canEdit ? role : "viewer",
    canView: true,
    trashed,
    canEdit,
    canComment: capped !== "external" && !trashed,
    canExport: canEdit || file.viewersCanCopy,
    canDevMode: !membership || membership.seat === "full" || membership.seat === "dev",
    canShare: (role === "owner" || role === "editor") && capped !== "external",
    canManage,
    capped,
    prototypeOnly: false,
    via,
  };
}

/**
 * Access to a folder or a team (listings, folder routes): the same resolution on a file with no rows of its own,
 * Inherited, in that folder (or directly in the team). Admin rights count as for the folder's files.
 */
export function resolveContainer(r: Omit<AccessRows, "file" | "fileGrants" | "viaLink" | "passOk" | "externalRestricted"> & { orgId: string; teamId: string; projectId: string | null }): AccessResult {
  return resolveAccess({
    ...r,
    file: { key: "", ownerId: "", orgId: r.orgId, teamId: r.teamId, projectId: r.projectId ?? "", editorType: "design", access: "inherited", linkAccess: "none", orgLinkAccess: "none", linkExpiresAt: null, viewersCanCopy: true, passwordProtected: false, trashedAt: null },
    fileGrants: [],
    viaLink: false,
    passOk: false,
    externalRestricted: false,
  });
}
