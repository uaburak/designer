/**
 * Home in an organization (docs/multiplayer.md §14, research docs/research/figma/R20-home-org.md): the pure parts —
 * which space is shown, Figma's words for audiences, roles, seats and access, the space switcher's menu, and the
 * messages for the server's refusals. No React, no store calls.
 */
import type { MenuEntry } from "@/ds/util/menu";
import { timeAgo } from "@/ds/util/time";
import type * as O from "@shared/org/types";
import type { SpaceId } from "@shared/store/repositories";
import { isStoreError } from "@shared/store/protocol";

/** The org shown, from `Prefs.browse.space` (absent or "local": none). */
export const orgIdOf = (space: SpaceId | undefined | null): string | null => (space && space.startsWith("org:") ? space.slice(4) : null);
export const orgSpace = (orgId: string): SpaceId => `org:${orgId}`;

/** Figma's seat names [F-seat] */
export const SEAT_LABEL: Record<O.Seat, string> = { full: "Full", dev: "Dev", collab: "Collab", view: "View" };
/** What each upgrade gives (help.figma.com 360039960434, shortened) */
export const SEAT_HINT: Record<Exclude<O.Seat, "view">, string> = {
  full: "Design, FigJam, Slides and Dev Mode",
  dev: "Dev Mode, FigJam and Slides",
  collab: "FigJam and Slides",
};

/** "can edit" / "can view" — Figma's permission words */
export const GRANT_LABEL: Record<O.GrantRole, string> = { editor: "can edit", viewer: "can view" };

/** A team member's role as the members list says it: owner, admin, can edit, can view. */
export function memberRoleLabel(m: { owner: boolean; admin?: boolean; role: O.GrantRole; pending?: boolean }): string {
  if (m.owner) return "owner";
  if (m.admin) return "admin";
  return GRANT_LABEL[m.role];
}

/** The team's "Who has access" (help.figma.com 360039970673 / 360039957674). */
export type TeamAccessChoice = "invited-visible" | "invited-hidden" | "org-viewer" | "org-editor";
export function teamAccessChoice(t: Pick<O.TeamSummary, "orgAccess" | "visibility">): TeamAccessChoice {
  if (t.orgAccess === "editor") return "org-editor";
  if (t.orgAccess === "viewer") return "org-viewer";
  return t.visibility === "hidden" ? "invited-hidden" : "invited-visible";
}
export function teamAccessPatch(c: TeamAccessChoice): O.TeamPatch {
  switch (c) {
    case "org-editor":
      return { orgAccess: "editor", visibility: "visible" };
    case "org-viewer":
      return { orgAccess: "viewer", visibility: "visible" };
    case "invited-hidden":
      return { orgAccess: "none", visibility: "hidden" };
    default:
      return { orgAccess: "none", visibility: "visible" };
  }
}
export const teamAccessOptions = (orgName: string): { value: TeamAccessChoice; label: string }[] => [
  { value: "invited-visible", label: "Only those invited · Visible" },
  { value: "invited-hidden", label: "Only those invited · Hidden" },
  { value: "org-viewer", label: `Anyone in ${orgName} can view` },
  { value: "org-editor", label: `Anyone in ${orgName} can edit` },
];
/** The audience line under a team's name: "Open to the organization" or "Only those invited" (360039957674) */
export const teamAudience = (t: Pick<O.TeamSummary, "orgAccess" | "visibility">): string => (t.orgAccess !== "none" ? "Open to the organization" : t.visibility === "hidden" ? "Only those invited · Hidden" : "Only those invited");

/** A folder's access line [F-folder]: Inherited "Anyone in ‹parent› can access", Limited "Only people added to ‹folder› can access". */
export const folderAccessLabel = (mode: O.InheritMode, parentName: string, name: string): string => (mode === "inherited" ? `Anyone in ${parentName} can access` : `Only people added to ${name} can access`);
export const INHERIT_LABEL: Record<O.InheritMode, string> = { inherited: "Inherited", limited: "Limited" };

/** A team's card and sidebar line: "3 folders · 2 members" */
export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
export const teamSubtitle = (t: Pick<O.TeamSummary, "projectCount" | "memberCount">) => `${plural(t.projectCount, "folder")} · ${plural(t.memberCount, "member")}`;
/** A folder card's line, as 1.png: "Updated 22 hours ago" */
export const folderUpdated = (p: Pick<O.ProjectSummary, "updatedAt" | "trashedAt">, now = Date.now()) => (p.trashedAt !== null ? `Deleted ${timeAgo(p.trashedAt, now)}` : `Updated ${timeAgo(p.updatedAt, now)}`);
export const orgFileSubtitle = (f: Pick<O.OrgFile, "updatedAt" | "trashedAt">, now = Date.now()) => (f.trashedAt !== null ? `Deleted ${timeAgo(f.trashedAt, now)}` : `Edited ${timeAgo(f.updatedAt, now)}`);

/** Can the person add files and folders to a team (its editors and admins, the owner, org admins — §14.2). */
export const canEditTeam = (t: Pick<O.TeamSummary, "me">, org: Pick<O.OrgSummary, "role"> | null) => org?.role === "admin" || !!t.me && (t.me.role === "editor" || t.me.admin || t.me.owner);
export const canAdminTeam = (t: Pick<O.TeamSummary, "me">, org: Pick<O.OrgSummary, "role"> | null) => org?.role === "admin" || !!t.me && (t.me.admin || t.me.owner);
export const canEditFolder = (p: Pick<O.ProjectSummary, "me">, org: Pick<O.OrgSummary, "role"> | null) => org?.role === "admin" || p.me === "owner" || p.me === "editor";
/** A View seat edits no design file (§14.3); Home offers "Ask to upgrade" where it would create one */
export const seatCanCreateDesign = (seat: O.Seat) => seat === "full";

/** The plan badge after the org's name in the sidebar (1.png "Professional"; an organization's plan here). */
export const PLAN_BADGE = "Organization";

/** The seat-capped wording (docs/multiplayer.md §6 item 7, §14.3) */
export const CAPPED_TEXT = "You can only view and comment on this file.";
/** The View-seat notice above an org's content (ours, from §14.3's wording) */
export const viewSeatNotice = (orgName: string) => `You have a View seat in ${orgName}. You can only view and comment on design files.`;

/** The space switcher (the org row's chevron, and the account menu): the local workspace, each org, Create organization… */
export function spaceMenu(spaces: { local: string; orgs: readonly O.OrgSummary[]; current: SpaceId; signedIn: boolean }): MenuEntry[] {
  const out: MenuEntry[] = [{ id: "space:local", label: spaces.local, checked: spaces.current === "local" }];
  for (const o of spaces.orgs) out.push({ id: `space:org:${o.id}`, label: o.name, checked: spaces.current === `org:${o.id}` });
  out.push("-", { id: "create-org", label: "Create organization…", disabled: !spaces.signedIn });
  return out;
}

/** The server's refusals in Figma's words (§14.6 error codes, detail `{code}`); anything else: the message. */
export function orgErrorText(e: unknown): string {
  const code = isStoreError(e) ? e.code : null;
  const detail = isStoreError(e) && e.detail && typeof e.detail === "object" ? ((e.detail as { code?: string }).code ?? null) : null;
  if (detail === "seat_required") return "Your seat can’t edit design files. Ask to upgrade.";
  if (detail === "admins_only") return "Only admins can do this in this organization.";
  if (detail === "guest_blocked") return "Guests can’t be invited to this organization.";
  if (detail === "not_admin") return "Only admins can do this.";
  if (detail === "limited") return "You don’t have access to this folder.";
  if (code === "offline") return "You’re offline. Try again when you’re back online.";
  if (code === "conflict") return e instanceof Error && e.message ? `${e.message.charAt(0).toUpperCase()}${e.message.slice(1)}` : "That name is taken.";
  if (code === "forbidden") return "You don’t have permission to do this.";
  const m = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  return m || "Something went wrong";
}

/** True for the refusal that "Ask to upgrade" answers */
export const isSeatRefusal = (e: unknown) => isStoreError(e) && !!e.detail && typeof e.detail === "object" && (e.detail as { code?: string }).code === "seat_required";
