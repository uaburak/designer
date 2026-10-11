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
  { name: "Files", actions: ["fig_file_create", "fig_file_duplicate", "fig_file_move", "fig_file_rename", "fig_file_trash", "fig_file_restore", "fig_file_permanent_delete", "fig_file_member_add", "fig_file_member_permission_change", "fig_file_member_remove", "fig_file_link_access_change", "fig_file_link_expiration_change", "fig_file_proto_link_access_change", "fig_file_set_password", "fig_file_unset_password", "fig_file_viewer_access_change", "fig_file_view", "fig_file_view_external", "fig_file_view_prototype", "fig_file_export", "fig_file_save_as", "fig_file_region_move"] },
  { name: "Branches", actions: ["branch_create", "branch_archive", "branch_unarchive", "branch_delete", "branch_member_add", "branch_member_permission_change", "branch_member_remove", "repo_merge_to_source", "repo_merge_from_source"] },
  { name: "Folders", actions: ["project_create", "project_rename", "project_move", "project_trash", "project_restore", "project_delete", "project_member_add", "project_member_permission_change", "project_member_remove", "project_team_access_change"] },
  { name: "Teams", actions: ["team_create", "team_rename", "team_delete", "team_restore", "team_member_add", "team_member_add_external", "team_member_permission_change", "team_member_remove", "team_member_remove_external", "team_org_access_change", "team_sharing_audience_control_change", "team_workspace_change", "team_license_group_change"] },
  { name: "Organizations", actions: ["org_team_creation_controls", "org_team_csv_exported", "org_default_license_type_change", "org_guest_invite_setting_change", "public_link_setting_change", "idle_timeout_setting_change", "cursor_chat_setting_change", "open_sessions_setting_change", "external_collaboration_controls_setting_change", "autogen_password_controls_setting_change", "data_storage_localization_change"] },
  { name: "Seat changes", actions: ["org_user_account_type_change", "org_user_account_type_change_to_full", "org_user_account_type_upgrade_requested", "org_user_account_type_upgrade_approved", "org_user_account_type_upgrade_denied"] },
  { name: "Workspaces", actions: ["workspace_create", "workspace_rename", "workspace_delete", "workspace_member_add", "workspace_member_remove", "workspace_admins_add", "workspace_admins_remove", "workspace_visibility_setting_change", "workspace_public_link_setting_change", "workspace_team_csv_exported"] },
  { name: "Billing groups", actions: ["license_group_create", "license_group_rename", "license_group_delete", "license_group_admins_add", "license_group_admins_remove", "license_group_membership_change"] },
  { name: "Libraries", actions: ["org_library_approve", "org_library_unapprove", "org_library_setting_change", "workspace_library_approve", "workspace_library_unapprove", "workspace_library_setting_change"] },
  { name: "Users", actions: ["user_sign_in", "user_sign_out", "user_idle_session_timeout", "personal_access_token_create", "personal_access_token_delete", "user_group_create", "user_group_rename", "user_group_delete", "user_group_member_add", "user_group_member_remove"] },
  // Round 4 (docs/multiplayer.md §15.11), Figma's group names [F-act]
  { name: "External access", actions: ["fig_file_view_prototype_external"] },
  { name: "SCIM groups", actions: ["idp_group_create", "idp_group_rename", "idp_group_delete", "idp_group_connection_add", "idp_group_connection_remove"] },
  { name: "SSO Authentications", actions: ["google_sso_auth_change", "saml_sso_auth_change", "idp_config_create", "idp_config_update", "idp_config_delete", "scim_token_generate", "scim_token_revoke"] },
  { name: "Audio", actions: ["audio_setting_change"] },
  { name: "Domain management", actions: ["org_domain_add", "org_domain_verify", "org_domain_remove", "org_domain_capture_change"] },
  { name: "SCIM provisioning", actions: ["idp_user_create", "idp_user_update", "idp_user_activate", "idp_user_deactivate", "idp_user_delete"] },
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
  // Round 4: identity and security (docs/multiplayer.md §15.11) — Figma's description of each action
  // (developers.figma.com activity-logs-action-types, read 2026-10-11) said as the column's past-tense phrase;
  // `eventText` adds the new value where the row's details carry it
  google_sso_auth_change: "Changed members' login method through Google SSO",
  saml_sso_auth_change: "Changed members' login method through SAML SSO",
  idp_config_create: "Created an IdP configuration",
  idp_config_update: "Updated the IdP configuration",
  idp_config_delete: "Deleted the IdP configuration",
  scim_token_generate: "Generated a token for the IdP to call SCIM",
  scim_token_revoke: "Revoked the IdP's SCIM token",
  idp_user_create: "Added user to the organization via SCIM",
  idp_user_update: "Updated user's paid status via SCIM",
  idp_user_activate: "Activated user via SCIM",
  idp_user_deactivate: "Deactivated user via SCIM",
  idp_user_delete: "Deleted user from the organization via SCIM",
  idp_group_create: "Created IdP group via SCIM",
  idp_group_rename: "Renamed IdP group via SCIM",
  idp_group_delete: "Deleted IdP group via SCIM",
  idp_group_connection_add: "Added workspace or billing group to IdP group",
  idp_group_connection_remove: "Removed workspace or billing group from IdP group",
  org_domain_add: "Added domain to the organization",
  org_domain_verify: "Verified domain",
  org_domain_remove: "Removed domain from the organization",
  org_domain_capture_change: "Changed domain capture",
  user_idle_session_timeout: "Signed out automatically for inactivity",
  idle_timeout_setting_change: "Changed how long people can be idle before they're logged out",
  cursor_chat_setting_change: "Changed cursor chat for the organization",
  open_sessions_setting_change: "Turned open sessions on or off",
  external_collaboration_controls_setting_change: "Changed access to external content",
  autogen_password_controls_setting_change: "Changed which passwords can be added to files",
  workspace_public_link_setting_change: "Changed a workspace's public link settings",
  fig_file_view_prototype_external: "Viewed prototype outside the organization",
  audio_setting_change: "Changed audio for the organization",
  data_storage_localization_change: "Changed data storage localization",
  fig_file_region_move: "Moved file content to the data storage region",
};

// ---- Round 4: Settings' words (docs/multiplayer.md §15.1; help.figma.com, R19 §7) ----

/** [F-auth] Authentication's three options */
export const AUTH_METHOD_LABEL: Record<OrgSettings["authMethod"], string> = {
  any: "Members may log in with any method, including email and password",
  google: "Members must log in with a Google account",
  saml: "Members must log in with SAML SSO",
};
export const AUTH_METHOD_SHORT: Record<OrgSettings["authMethod"], string> = { any: "Any method", google: "Google account", saml: "SAML SSO" };

/** "21 days", "12 hours", "1 day" — whole days when the hours divide */
export function formatHours(h: number): string {
  if (h % 24 === 0) return h === 24 ? "1 day" : `${h / 24} days`;
  return h === 1 ? "1 hour" : `${h} hours`;
}
const onOff = (v: unknown) => (v ? "on" : "off");

/**
 * The Event column's sentence: the action's phrase, or — for a setting whose details carry the new value — what it
 * was changed to ("Turned cursor chat off", "Changed the idle session timeout to 7 days").
 */
export function eventText(row: Pick<ActivityLog, "action">): string {
  const { type, details } = row.action;
  const to = (details as { to?: unknown }).to;
  const has = "to" in details;
  switch (type) {
    case "cursor_chat_setting_change": return has ? `Turned cursor chat ${onOff(to)}` : ACTION_LABEL[type];
    case "audio_setting_change": return has ? `Turned audio ${onOff(to)}` : ACTION_LABEL[type];
    case "open_sessions_setting_change": return has ? `Turned FigJam open sessions ${onOff(to)}` : ACTION_LABEL[type];
    case "org_domain_capture_change": return has ? `Turned domain capture ${onOff(to)}` : ACTION_LABEL[type];
    case "idle_timeout_setting_change": return has ? `Changed the idle session timeout to ${formatHours(typeof to === "number" ? to : 504)}` : ACTION_LABEL[type];
    case "google_sso_auth_change":
    case "saml_sso_auth_change":
      return to === "any" ? "Let members log in with any method" : to === "google" ? "Required members to log in with a Google account" : to === "saml" ? "Required members to log in with SAML SSO" : ACTION_LABEL[type];
    case "external_collaboration_controls_setting_change": return to === "restricted" ? "Restricted access to external content" : to === "allowed" ? "Allowed access to external content" : ACTION_LABEL[type];
    case "autogen_password_controls_setting_change": return to === "autogenerated" ? "Allowed only autogenerated passwords on files" : to === "any" ? "Allowed any password on files" : ACTION_LABEL[type];
    case "data_storage_localization_change": {
      const label = (details as { to_label?: unknown }).to_label;
      return typeof label === "string" ? `Changed data storage localization to ${label}` : ACTION_LABEL[type];
    }
    case "org_domain_add":
    case "org_domain_verify":
    case "org_domain_remove": {
      const d = (details as { domain?: unknown }).domain;
      return typeof d === "string" ? `${ACTION_LABEL[type].replace(/^(\w+) domain/, `$1 ${d}`)}` : ACTION_LABEL[type];
    }
    default: return ACTION_LABEL[type] ?? type;
  }
}

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
