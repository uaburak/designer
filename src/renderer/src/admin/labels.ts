/**
 * The Admin location's words (Figma's, docs/research/figma/R19-admin.md): seats, roles, the activity log's events and
 * their groups, dates. Pure: the fake's CSV and the views share them.
 */
import type { ActivityAction, ActivityLog, AdminPerson, AdminTeam, OrgRole, OrgSettings, Seat } from "@shared/org/types";

export const SEATS: Seat[] = ["full", "dev", "collab", "view"];
export const SEAT_LABEL: Record<Seat, string> = { full: "Full", dev: "Dev", collab: "Collab", view: "View" };
/** [F-seat] what each seat is for (help.figma.com 360039960434) */
export const SEAT_DESCRIPTION: Record<Seat, string> = {
  full: "Access to all Figma products, including Figma Design, Dev Mode, FigJam, Figma Slides and Figma Buzz",
  dev: "Access to Dev Mode, FigJam, Figma Slides and Figma Buzz",
  collab: "Access to FigJam, Figma Slides and Figma Buzz",
  view: "View and comment in all files",
};
export const ROLE_LABEL: Record<OrgRole, string> = { admin: "Admin", member: "Member", guest: "Guest" };

/** The People table's "User type" (Figma's filter: Admin, Member, Guest, Pending) */
export function userType(p: Pick<AdminPerson, "role" | "pending">): string {
  return p.pending ? "Pending" : ROLE_LABEL[p.role];
}

export const SEAT_APPROVAL_LABEL: Record<OrgSettings["seatApproval"]["full"], string> = {
  manual: "Manually approve seats",
  manual_unless_available: "Manually approve, unless seat is available",
  auto: "Auto-approve seats",
};
export const GUEST_MEMBERSHIP_LABEL: Record<OrgSettings["guestMembership"], string> = {
  allow: "External users can join the organization",
  approval: "External users can only join with admin approval",
  block: "No external users can join the organization",
};
export const TEAM_CREATION_LABEL: Record<OrgSettings["teamCreation"], string> = { anyone: "Anyone", admins: "Admins only" };

/** A team's access as one word (the teams CSV's "access setting"): Open / Closed / Hidden — ours from the audience fields */
export function teamAccess(t: Pick<AdminTeam, "visibility" | "orgAccess" | "workspaceAccess">): string {
  if (t.visibility === "hidden") return "Hidden";
  if (t.orgAccess !== "none" || t.workspaceAccess !== "none") return "Open";
  return "Closed";
}

/** Figma's Activity event groups (help.figma.com 360040449533) with the actions round 1 writes, in its order. */
export const EVENT_GROUPS: { name: string; actions: ActivityAction[] }[] = [
  { name: "Members", actions: ["org_user_create", "org_user_create_external", "org_user_delete", "org_user_delete_external", "org_user_permission_change", "org_invite_create", "org_join_request_create", "org_join_request_approve", "roster_exported"] },
  { name: "Files", actions: ["fig_file_create", "fig_file_duplicate", "fig_file_move", "fig_file_rename", "fig_file_trash", "fig_file_restore", "fig_file_permanent_delete", "fig_file_member_add", "fig_file_member_permission_change", "fig_file_member_remove", "fig_file_link_access_change", "fig_file_link_expiration_change", "fig_file_proto_link_access_change", "fig_file_set_password", "fig_file_unset_password", "fig_file_viewer_access_change", "fig_file_view", "fig_file_view_external", "fig_file_view_prototype", "fig_file_export", "fig_file_save_as"] },
  { name: "Branches", actions: ["branch_create", "branch_archive", "branch_unarchive", "branch_delete", "branch_member_add", "branch_member_permission_change", "branch_member_remove", "repo_merge_to_source", "repo_merge_from_source"] },
  { name: "Folders", actions: ["project_create", "project_rename", "project_move", "project_trash", "project_restore", "project_delete", "project_member_add", "project_member_permission_change", "project_member_remove", "project_team_access_change"] },
  { name: "Teams", actions: ["team_create", "team_rename", "team_delete", "team_restore", "team_member_add", "team_member_add_external", "team_member_permission_change", "team_member_remove", "team_member_remove_external", "team_org_access_change", "team_sharing_audience_control_change", "team_workspace_change", "team_license_group_change"] },
  { name: "Organizations", actions: ["org_team_creation_controls", "org_team_csv_exported", "org_default_license_type_change", "org_guest_invite_setting_change", "public_link_setting_change"] },
  { name: "Seat changes", actions: ["org_user_account_type_change", "org_user_account_type_change_to_full", "org_user_account_type_upgrade_requested", "org_user_account_type_upgrade_approved", "org_user_account_type_upgrade_denied"] },
  { name: "Workspaces", actions: ["workspace_create", "workspace_rename", "workspace_delete", "workspace_member_add", "workspace_member_remove", "workspace_admins_add", "workspace_admins_remove", "workspace_visibility_setting_change", "workspace_team_csv_exported"] },
  { name: "Billing groups", actions: ["license_group_create", "license_group_rename", "license_group_delete", "license_group_admins_add", "license_group_admins_remove", "license_group_membership_change"] },
  { name: "Libraries", actions: ["org_library_approve", "org_library_unapprove", "org_library_setting_change", "workspace_library_approve", "workspace_library_unapprove", "workspace_library_setting_change"] },
  { name: "Users", actions: ["user_sign_in", "user_sign_out", "personal_access_token_create", "personal_access_token_delete", "user_group_create", "user_group_rename", "user_group_delete", "user_group_member_add", "user_group_member_remove"] },
];

/** A sentence per action for the Event column (ours: Figma's in-app wording per event is unpublished, R19 §7) */
export const ACTION_LABEL: Record<ActivityAction, string> = {
  fig_file_create: "Created file",
  fig_file_duplicate: "Duplicated file",
  fig_file_move: "Moved file",
  fig_file_rename: "Renamed file",
  fig_file_trash: "Moved file to trash",
  fig_file_restore: "Restored file",
  fig_file_permanent_delete: "Permanently deleted file",
  fig_file_member_add: "Added file member",
  fig_file_member_permission_change: "Changed file member permission",
  fig_file_member_remove: "Removed file member",
  fig_file_link_access_change: "Changed file link access",
  fig_file_link_expiration_change: "Changed file link expiration",
  fig_file_proto_link_access_change: "Changed prototype link access",
  fig_file_set_password: "Set file password",
  fig_file_unset_password: "Removed file password",
  fig_file_viewer_access_change: "Changed viewer access to copy, save and export",
  fig_file_view: "Viewed file",
  fig_file_view_external: "Viewed file (external)",
  fig_file_view_prototype: "Viewed prototype",
  fig_file_export: "Exported from file",
  fig_file_save_as: "Saved local copy",
  project_create: "Created folder",
  project_rename: "Renamed folder",
  project_move: "Moved folder",
  project_trash: "Moved folder to trash",
  project_restore: "Restored folder",
  project_delete: "Deleted folder",
  project_member_add: "Added folder member",
  project_member_permission_change: "Changed folder member permission",
  project_member_remove: "Removed folder member",
  project_team_access_change: "Changed folder access",
  team_create: "Created team",
  team_rename: "Renamed team",
  team_delete: "Deleted team",
  team_restore: "Restored team",
  team_member_add: "Added team member",
  team_member_add_external: "Added external team member",
  team_member_permission_change: "Changed team member permission",
  team_member_remove: "Removed team member",
  team_member_remove_external: "Removed external team member",
  team_org_access_change: "Changed team access",
  team_sharing_audience_control_change: "Changed team visibility",
  team_workspace_change: "Moved team to workspace",
  team_license_group_change: "Changed team billing group",
  org_team_creation_controls: "Changed team creation setting",
  org_team_csv_exported: "Exported teams CSV",
  org_user_create: "Added member",
  org_user_create_external: "Added guest",
  org_user_delete: "Removed member",
  org_user_delete_external: "Removed guest",
  org_user_permission_change: "Changed organization role",
  org_user_account_type_change: "Changed seat",
  org_user_account_type_change_to_full: "Changed seat to Full",
  org_user_account_type_upgrade_requested: "Requested seat upgrade",
  org_user_account_type_upgrade_approved: "Approved seat upgrade",
  org_user_account_type_upgrade_denied: "Denied seat upgrade",
  org_invite_create: "Invited to organization",
  org_join_request_create: "Requested to join organization",
  org_join_request_approve: "Approved request to join organization",
  roster_exported: "Exported people CSV",
  org_default_license_type_change: "Changed default seat",
  org_guest_invite_setting_change: "Changed guest membership setting",
  public_link_setting_change: "Changed public link setting",
  workspace_create: "Created workspace",
  workspace_rename: "Renamed workspace",
  workspace_delete: "Deleted workspace",
  workspace_member_add: "Added workspace member",
  workspace_member_remove: "Removed workspace member",
  workspace_admins_add: "Added workspace admin",
  workspace_admins_remove: "Removed workspace admin",
  workspace_visibility_setting_change: "Changed workspace visibility",
  workspace_team_csv_exported: "Exported workspace teams CSV",
  license_group_create: "Created billing group",
  license_group_rename: "Renamed billing group",
  license_group_delete: "Deleted billing group",
  license_group_admins_add: "Added billing group admin",
  license_group_admins_remove: "Removed billing group admin",
  license_group_membership_change: "Changed billing group membership",
  user_sign_in: "Signed in",
  user_sign_out: "Signed out",
  personal_access_token_create: "Created personal access token",
  personal_access_token_delete: "Deleted personal access token",
  user_group_create: "Created user group",
  user_group_rename: "Renamed user group",
  user_group_delete: "Deleted user group",
  user_group_member_add: "Added user group member",
  user_group_member_remove: "Removed user group member",
  branch_create: "Created branch",
  branch_archive: "Archived branch",
  branch_unarchive: "Unarchived branch",
  branch_delete: "Deleted branch",
  branch_member_add: "Added branch member",
  branch_member_permission_change: "Changed branch member permission",
  branch_member_remove: "Removed branch member",
  repo_merge_to_source: "Merged branch",
  repo_merge_from_source: "Updated branch from main",
  org_library_approve: "Approved library",
  org_library_unapprove: "Unapproved library",
  org_library_setting_change: "Changed library settings",
  workspace_library_approve: "Approved library for workspace",
  workspace_library_unapprove: "Unapproved library for workspace",
  workspace_library_setting_change: "Changed workspace library settings",
};

/** The Product column: the file's editor type for file events, else empty (Figma: "the related product, when applicable") */
const PRODUCT_LABEL: Record<string, string> = { design: "Figma Design", figjam: "FigJam", slides: "Figma Slides", buzz: "Figma Buzz", sites: "Figma Sites", make: "Figma Make" };
export function productOf(row: ActivityLog): string {
  const t = row.entity.editor_type;
  return t ? PRODUCT_LABEL[t] ?? "" : "";
}

/** "Oct 11, 2026, 14:05" in UTC (the Activity page shows UTC) */
export function formatUtc(seconds: number): string {
  const d = new Date(seconds * 1000);
  const month = d.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${month} ${d.getUTCDate()}, ${d.getUTCFullYear()}, ${hh}:${mm}`;
}

/** "Oct 11, 2026" (local) */
export function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** Last active: "Today", "Yesterday", "3 days ago", "2 months ago", "Never" */
export function formatAgo(ms: number | null, now = Date.now()): string {
  if (ms === null) return "Never";
  const days = Math.floor((now - ms) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return months === 1 ? "1 month ago" : `${months} months ago`;
  const years = Math.floor(days / 365);
  return years <= 1 ? "1 year ago" : `${years} years ago`;
}

/** One CSV field (RFC 4180) */
export function csvField(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export function toCsv(header: string[], rows: unknown[][]): string {
  return [header, ...rows].map((r) => r.map(csvField).join(",")).join("\n") + "\n";
}
