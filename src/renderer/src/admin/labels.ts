/**
 * The Admin location's words (Figma's, docs/research/figma/R19-admin.md): seats, roles, the activity log's events and
 * their groups, dates. Pure: the fake's CSV and the views share them.
 */
import type { ActivityAction, ActivityLog, AdminPerson, AdminTeam, OrgRole, OrgSettings, Seat } from "@shared/org/types";
import { FILE_EXPORTING_LABEL, type FileExporting, type NetworkRangeState } from "@shared/org/governance";
import { intlLocale, t, tp, tx } from "@/i18n";

export const SEATS: Seat[] = ["full", "dev", "collab", "view"];
export const SEAT_LABEL: Record<Seat, string> = { full: "Full", dev: "Dev", collab: "Collab", view: "View" };
/** A seat's name in the UI's language ("View" the seat, not the menu: `seat|View`). */
export const seatLabel = (s: Seat): string => tx("seat", SEAT_LABEL[s]);
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
  return p.pending ? t("Pending") : t(ROLE_LABEL[p.role]);
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
/** Network access restrictions' range states (ours: Figma runs its shadow test through Support, §2.2) */
export const NETWORK_STATE_LABEL: Record<NetworkRangeState, string> = { testing: "Testing", enforced: "Enforced", disabled: "Disabled" };
export const TEAM_CREATION_LABEL: Record<OrgSettings["teamCreation"], string> = { anyone: "Anyone", admins: "Admins only" };

/** A team's access as one word (the teams CSV's "access setting"): Open / Closed / Hidden — ours from the audience fields */
export function teamAccess(team: Pick<AdminTeam, "visibility" | "orgAccess" | "workspaceAccess">): string {
  if (team.visibility === "hidden") return t("Hidden");
  if (team.orgAccess !== "none" || team.workspaceAccess !== "none") return tx("access", "Open");
  return t("Closed");
}

/** Figma's Activity event groups (help.figma.com 360040449533) with the actions round 1 writes, in its order. */
export const EVENT_GROUPS: { name: string; actions: ActivityAction[] }[] = [
  { name: "Members", actions: ["org_user_create", "org_user_create_external", "org_user_delete", "org_user_delete_external", "org_user_permission_change", "org_invite_create", "org_join_request_create", "org_join_request_approve", "roster_exported"] },
  { name: "Files", actions: ["fig_file_create", "fig_file_duplicate", "fig_file_move", "fig_file_rename", "fig_file_trash", "fig_file_restore", "fig_file_permanent_delete", "fig_file_member_add", "fig_file_member_permission_change", "fig_file_member_remove", "fig_file_link_access_change", "fig_file_link_expiration_change", "fig_file_proto_link_access_change", "fig_file_set_password", "fig_file_unset_password", "fig_file_viewer_access_change", "fig_file_view", "fig_file_view_external", "fig_file_view_prototype", "fig_file_export", "fig_file_save_as", "fig_file_region_move"] },
  { name: "Branches", actions: ["branch_create", "branch_archive", "branch_unarchive", "branch_delete", "branch_member_add", "branch_member_permission_change", "branch_member_remove", "repo_merge_to_source", "repo_merge_from_source"] },
  { name: "Folders", actions: ["project_create", "project_rename", "project_move", "project_trash", "project_restore", "project_delete", "project_member_add", "project_member_permission_change", "project_member_remove", "project_team_access_change"] },
  { name: "Teams", actions: ["team_create", "team_rename", "team_icon_change", "team_delete", "team_restore", "team_member_add", "team_member_add_external", "team_member_permission_change", "team_member_remove", "team_member_remove_external", "team_org_access_change", "team_sharing_audience_control_change", "team_workspace_change", "team_license_group_change"] },
  { name: "Organizations", actions: ["org_team_creation_controls", "org_team_csv_exported", "org_default_license_type_change", "org_guest_invite_setting_change", "public_link_setting_change", "idle_timeout_setting_change", "cursor_chat_setting_change", "open_sessions_setting_change", "external_collaboration_controls_setting_change", "autogen_password_controls_setting_change", "data_storage_localization_change", "org_ai_setting_change", "org_rename", "org_icon_change", "org_delete", "org_restore"] },
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
  { name: "SCIM provisioning", actions: ["idp_user_create", "idp_user_update", "idp_user_activate", "idp_user_deactivate", "idp_user_delete"] },  // Round 5 (docs/multiplayer.md §16.11)
  { name: "Plugins", actions: ["private_plugin_publish", "private_plugin_update", "private_plugin_delete", "plugin_approvelist_enable", "plugin_approvelist_disable", "plugin_approvelist_add", "plugin_approvelist_add_workspace", "plugin_approvelist_remove", "plugin_approvelist_remove_workspace", "plugin_approvelist_request_org", "plugin_approvelist_request_approve_org", "plugin_approvelist_request_reject_org", "plugin_approvelist_request_approve_workspace", "plugin_approvelist_request_reject_workspace"] },
  { name: "Widgets", actions: ["private_widget_publish", "private_widget_update", "private_widget_delete", "widgets_enabled", "widgets_disable", "widget_approvelist_add", "widget_approvelist_add_workspace", "widget_approvelist_remove", "widget_approvelist_remove_workspace", "widget_approvelist_request_org", "widget_approvelist_request_approve_org", "widget_approvelist_request_reject_org", "widget_approvelist_request_approve_workspace", "widget_approvelist_request_reject_workspace"] },
  { name: "Developer platform", actions: ["plan_access_token_create", "plan_access_token_delete", "webhook_create", "webhook_update", "webhook_delete", "file_variables_update", "dev_resource_create", "dev_resource_delete", "code_connect_publish", "code_connect_unpublish"] },
  // Round 14 (docs/governance.md §1, §3): Figma publishes the actions, not the groups they're listed under — ours
  { name: "Governance+", actions: ["governance_plus_enable", "governance_plus_disable", "mfa_required_setting_change", "file_export_controls_setting_change", "workspace_file_export_controls_setting_change", "org_guest_expiration_setting_change", "org_user_guest_expiration_change", "discovery_setting_change", "org_domain_idp_mapping_change", "user_two_factor_enable", "user_two_factor_disable"] },
  { name: "IP allowlist", actions: ["ip_allowlist_setting_change", "ip_allowlist_range_create", "ip_allowlist_range_delete", "ip_allowlist_rejected"] },
  { name: "Network access", actions: ["ip_restriction_change", "network_access_restriction_range_create", "network_access_restriction_range_update", "network_access_restriction_range_delete"] },
  { name: "Internal policies", actions: ["policy_create", "policy_update", "policy_acknowledge"] },
  { name: "Key management", actions: ["ekm_enable", "ekm_key_change", "ekm_key_unavailable", "fig_file_encrypt"] },
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
  team_icon_change: "Changed the team's icon",
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
  // Round 5 (docs/multiplayer.md §16.11): Figma's description of each action (developers.figma.com
  // activity-logs-action-types, read 2026-10-11) said as the column's past-tense phrase; the entity line under it names
  // the plugin. The Dev Mode and variables actions below aren't Figma's (ours).
  private_plugin_publish: "Published a plugin privately to the organization",
  private_plugin_update: "Updated a plugin published privately to the organization",
  private_plugin_delete: "Deleted a plugin published privately to the organization",
  private_widget_publish: "Published a widget privately to the organization",
  private_widget_update: "Updated a widget published privately to the organization",
  private_widget_delete: "Deleted a widget published privately to the organization",
  plugin_approvelist_enable: "Turned on the setting that allows only plugins on the approved plugin list",
  plugin_approvelist_disable: "Turned off the setting that allows only plugins on the approved plugin list",
  plugin_approvelist_add: "Added a plugin to the approved plugin list",
  plugin_approvelist_add_workspace: "Added a plugin to the approved plugin list for a workspace",
  plugin_approvelist_remove: "Removed a plugin from the approved plugin list",
  plugin_approvelist_remove_workspace: "Removed a plugin from the approved plugin list for a workspace",
  plugin_approvelist_request_org: "Requested a plugin for the approved plugin list",
  plugin_approvelist_request_approve_org: "Approved a plugin request for the organization",
  plugin_approvelist_request_reject_org: "Rejected a plugin request for the organization",
  plugin_approvelist_request_approve_workspace: "Approved a plugin request for a workspace",
  plugin_approvelist_request_reject_workspace: "Rejected a plugin request for a workspace",
  widgets_enabled: "Turned on the setting that allows only widgets on the approved widget list",
  widgets_disable: "Turned off the setting that allows only widgets on the approved widget list",
  widget_approvelist_add: "Added a widget to the approved widget list",
  widget_approvelist_add_workspace: "Added a widget to the approved widget list for a workspace",
  widget_approvelist_remove: "Removed a widget from the approved widget list",
  widget_approvelist_remove_workspace: "Removed a widget from the approved widget list for a workspace",
  widget_approvelist_request_org: "Requested a widget for the approved widget list",
  widget_approvelist_request_approve_org: "Approved a widget request for the organization",
  widget_approvelist_request_reject_org: "Rejected a widget request for the organization",
  widget_approvelist_request_approve_workspace: "Approved a widget request for a workspace",
  widget_approvelist_request_reject_workspace: "Rejected a widget request for a workspace",
  plan_access_token_create: "Created a new plan access token",
  plan_access_token_delete: "Revoked a plan access token",
  webhook_create: "Created a webhook for a resource",
  webhook_update: "Updated a webhook for a resource",
  webhook_delete: "Deleted a webhook for a resource",
  file_variables_update: "Changed variables through the REST API",
  dev_resource_create: "Added dev resource",
  dev_resource_delete: "Removed dev resource",
  code_connect_publish: "Published Code Connect",
  code_connect_unpublish: "Unpublished Code Connect",
  org_ai_setting_change: "Changed AI settings for the organization",
  org_rename: "Renamed the organization",
  org_icon_change: "Changed the organization's icon",
  org_delete: "Deleted the organization",
  org_restore: "Restored the organization",
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
  // Round 14 (docs/governance.md §1, §3): Figma's description of each action [F-log] said as the column's phrase; the
  // ones Figma doesn't publish (§3) are ours. `eventText` adds the new value where the row's details carry it.
  mfa_required_setting_change: "Changed whether guests must use two-factor authentication",
  ip_allowlist_setting_change: "Turned the IP allowlist on or off",
  ip_allowlist_range_create: "Added an IP range to the IP allowlist",
  ip_allowlist_range_delete: "Removed an IP range from the IP allowlist",
  ip_allowlist_rejected: "Was denied access by the IP allowlist",
  ip_restriction_change: "Changed network access restrictions",
  network_access_restriction_range_create: "Added a network access restriction range",
  network_access_restriction_range_update: "Changed a network access restriction range",
  network_access_restriction_range_delete: "Removed a network access restriction range",
  org_domain_idp_mapping_change: "Changed which identity provider a domain uses",
  policy_create: "Created an internal policy",
  policy_update: "Changed an internal policy",
  policy_acknowledge: "Agreed to an internal policy",
  file_export_controls_setting_change: "Changed file exporting for the organization",
  workspace_file_export_controls_setting_change: "Changed file exporting for a workspace",
  governance_plus_enable: "Added Governance+",
  governance_plus_disable: "Removed Governance+",
  org_guest_expiration_setting_change: "Changed the default duration for guest access",
  org_user_guest_expiration_change: "Changed a guest's access expiration date",
  user_two_factor_enable: "Turned on two-factor authentication",
  user_two_factor_disable: "Turned off two-factor authentication",
  ekm_enable: "Turned on key management",
  ekm_key_change: "Changed the encryption key",
  ekm_key_unavailable: "The encryption key became unavailable",
  fig_file_encrypt: "Encrypted a file's content with the organization's key",
  discovery_setting_change: "Turned Discovery on or off",
};

// ---- Round 4: Settings' words (docs/multiplayer.md §15.1; help.figma.com, R19 §7) ----

/** [F-auth] Authentication's three options */
export const AUTH_METHOD_LABEL: Record<OrgSettings["authMethod"], string> = {
  any: "Members may log in with any method, including email and password",
  google: "Members must log in with a Google account",
  saml: "Members must log in with SAML SSO",
};
export const AUTH_METHOD_SHORT: Record<OrgSettings["authMethod"], string> = { any: "Any method", google: "Google account", saml: "SAML SSO" };

/** "21 days", "12 hours", "1 day", "15 minutes" — whole days when the hours divide; minutes below a whole hour */
export function formatHours(h: number): string {
  if (!Number.isInteger(h)) return tp(Math.round(h * 60), "{n} minute", "{n} minutes");
  if (h % 24 === 0) return tp(h / 24, "{n} day", "{n} days");
  return tp(h, "{n} hour", "{n} hours");
}

/**
 * The Event column's sentence: the action's phrase, or — for a setting whose details carry the new value — what it
 * was changed to ("Turned cursor chat off", "Changed the idle session timeout to 7 days"). In the UI's language.
 */
export function eventText(row: Pick<ActivityLog, "action">): string {
  const { type, details } = row.action;
  const to = (details as { to?: unknown }).to;
  const has = "to" in details;
  const fallback = t(ACTION_LABEL[type] ?? type);
  switch (type) {
    case "cursor_chat_setting_change": return has ? (to ? t("Turned cursor chat on") : t("Turned cursor chat off")) : fallback;
    case "audio_setting_change": return has ? (to ? t("Turned audio on") : t("Turned audio off")) : fallback;
    case "org_ai_setting_change": {
      const setting = (details as { setting?: unknown }).setting;
      if (setting === "aiEnabled") return to ? t("Turned AI features on") : t("Turned AI features off");
      if (setting === "aiCreditLimit") return to === null ? t("Removed the AI credit limit") : typeof to === "number" ? t("Set the AI credit limit to {credits} credits a month", { credits: to.toLocaleString(intlLocale()) }) : fallback;
      return fallback;
    }
    case "open_sessions_setting_change": return has ? (to ? t("Turned FigJam open sessions on") : t("Turned FigJam open sessions off")) : fallback;
    case "org_domain_capture_change": return has ? (to ? t("Turned domain capture on") : t("Turned domain capture off")) : fallback;
    case "idle_timeout_setting_change": return has ? t("Changed the idle session timeout to {time}", { time: formatHours(typeof to === "number" ? to : 504) }) : fallback;
    case "google_sso_auth_change":
    case "saml_sso_auth_change":
      return to === "any" ? t("Let members log in with any method") : to === "google" ? t("Required members to log in with a Google account") : to === "saml" ? t("Required members to log in with SAML SSO") : fallback;
    case "external_collaboration_controls_setting_change": return to === "restricted" ? t("Restricted access to external content") : to === "allowed" ? t("Allowed access to external content") : fallback;
    case "autogen_password_controls_setting_change": return to === "autogenerated" ? t("Allowed only autogenerated passwords on files") : to === "any" ? t("Allowed any password on files") : fallback;
    // Settings › Extensions: a change of the request switch alone is logged under its kind's approval action (§10.3a)
    case "plugin_approvelist_enable":
    case "plugin_approvelist_disable":
    case "widgets_enabled":
    case "widgets_disable": {
      const setting = (details as { setting?: unknown }).setting;
      const plugins = type.startsWith("plugin");
      if (setting === "pluginRequests" || setting === "widgetRequests")
        return to ? (plugins ? t("Allowed members to request plugins") : t("Allowed members to request widgets")) : plugins ? t("Stopped members from requesting plugins") : t("Stopped members from requesting widgets");
      return fallback;
    }
    case "data_storage_localization_change": {
      const label = (details as { to_label?: unknown }).to_label;
      return typeof label === "string" ? t("Changed data storage localization to {region}", { region: label }) : fallback;
    }
    case "org_domain_add":
    case "org_domain_verify":
    case "org_domain_remove": {
      const domain = (details as { domain?: unknown }).domain;
      if (typeof domain !== "string") return fallback;
      return type === "org_domain_add" ? t("Added {domain} to the organization", { domain }) : type === "org_domain_verify" ? t("Verified {domain}", { domain }) : t("Removed {domain} from the organization", { domain });
    }
    // Round 14 (docs/governance.md §3): the server's details — `{setting, from, to}` for settings, `{range}` for ranges
    case "mfa_required_setting_change": return has ? (to ? t("Required guests to use two-factor authentication") : t("Stopped requiring two-factor authentication for guests")) : fallback;
    case "ip_allowlist_setting_change": return has ? (to ? t("Turned the IP allowlist on") : t("Turned the IP allowlist off")) : fallback;
    case "ip_restriction_change": return has ? (to ? t("Turned network access restrictions on") : t("Turned network access restrictions off")) : fallback;
    case "discovery_setting_change": return has ? (to ? t("Turned Discovery on") : t("Turned Discovery off")) : fallback;
    case "ip_allowlist_range_create":
    case "ip_allowlist_range_delete":
    case "network_access_restriction_range_create":
    case "network_access_restriction_range_delete": {
      const range = (details as { range?: unknown }).range;
      if (typeof range !== "string") return fallback;
      const allowlist = type.startsWith("ip_allowlist");
      if (type.endsWith("create")) return allowlist ? t("Added {range} to the IP allowlist", { range }) : t("Added {range} to network access restrictions", { range });
      return allowlist ? t("Removed {range} from the IP allowlist", { range }) : t("Removed {range} from network access restrictions", { range });
    }
    case "network_access_restriction_range_update": {
      const range = (details as { range?: unknown }).range;
      return typeof range === "string" && typeof to === "string" && to in NETWORK_STATE_LABEL ? t("Set {range} to {state}", { range, state: t(NETWORK_STATE_LABEL[to as NetworkRangeState]) }) : fallback;
    }
    case "file_export_controls_setting_change":
    case "workspace_file_export_controls_setting_change": {
      const ws = type.startsWith("workspace");
      if (typeof to === "string" && to in FILE_EXPORTING_LABEL) {
        const choice = t(FILE_EXPORTING_LABEL[to as FileExporting]);
        return ws ? t("Changed file exporting for a workspace to “{choice}”", { choice }) : t("Changed file exporting to “{choice}”", { choice });
      }
      return ws && has && to === null ? t("Made a workspace use the organization's file exporting") : fallback;
    }
    case "org_guest_expiration_setting_change": return has ? (typeof to === "number" ? t("Set the default duration for guest access to {time}", { time: tp(to, "{n} day", "{n} days") }) : t("Removed the default duration for guest access")) : fallback;
    case "org_user_guest_expiration_change": return has ? (typeof to === "number" ? t("Changed a guest's access expiration date to {date}", { date: formatDate(to) }) : t("Removed a guest's access expiration date")) : fallback;
    case "policy_update": {
      const enabled = (details as { enabled?: unknown }).enabled;
      return enabled === true ? t("Enabled an internal policy") : enabled === false ? t("Disabled an internal policy") : fallback;
    }
    default: return fallback;
  }
}

/** The Product column: the file's editor type for file events, else empty (Figma: "the related product, when applicable") */
const PRODUCT_LABEL: Record<string, string> = { design: "Figma Design", figjam: "FigJam", slides: "Figma Slides", buzz: "Figma Buzz", sites: "Figma Sites", make: "Figma Make" };
export function productOf(row: ActivityLog): string {
  const editor = row.entity.editor_type;
  return editor ? PRODUCT_LABEL[editor] ?? "" : "";
}

/** "Oct 11, 2026, 14:05" in UTC (the Activity page shows UTC) */
export function formatUtc(seconds: number): string {
  const d = new Date(seconds * 1000);
  const date = d.toLocaleDateString(intlLocale(), { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${date}, ${hh}:${mm}`;
}

/** "Oct 11, 2026" (local) */
export function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString(intlLocale(), { month: "short", day: "numeric", year: "numeric" });
}

/** Last active: "Today", "Yesterday", "3 days ago", "2 months ago", "Never" */
export function formatAgo(ms: number | null, now = Date.now()): string {
  if (ms === null) return t("Never");
  const days = Math.floor((now - ms) / 86_400_000);
  if (days <= 0) return t("Today");
  if (days === 1) return t("Yesterday");
  if (days < 30) return tp(days, "{n} day ago", "{n} days ago");
  const months = Math.floor(days / 30);
  if (months < 12) return tp(months, "{n} month ago", "{n} months ago");
  const years = Math.floor(days / 365);
  return tp(Math.max(1, years), "{n} year ago", "{n} years ago");
}

/** One CSV field (RFC 4180) */
export function csvField(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export function toCsv(header: string[], rows: unknown[][]): string {
  return [header, ...rows].map((r) => r.map(csvField).join(",")).join("\n") + "\n";
}
