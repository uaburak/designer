/**
 * Identity and security (docs/multiplayer.md §15, Phase 7 round 4): SAML SSO, SCIM, domains, sharing policies, the
 * idle session timeout, data storage localization. Shared by the Worker, the store, main and the views; pure, no I/O.
 */
import type { EditorType, OrgRole, OrgSettings, PersonRef } from "./types";

// ---- sign-in -------------------------------------------------------------------------------------------------------

/** Admin › Settings › Authentication [F-auth]: "Members may log in with any method…" (default) / "…with a Google account" / "…with SAML SSO" */
export type AuthMethod = "any" | "google" | "saml";
/** How a session was signed in (sessions.auth_method) */
export type SessionAuth = "google" | "saml" | "dev";
/** `error=` values the loopback (or the web page's `auth_error`) can receive, besides Google's own */
export type SignInError = "access_denied" | "google_failed" | "sso_failed" | "sso_domain" | "google_required";
export const SIGN_IN_ERROR_TEXT: Record<SignInError, string> = {
  access_denied: "Sign-in was cancelled.",
  google_failed: "Google sign-in didn't work. Try again.",
  sso_failed: "Single sign-on didn't work. Try again, or ask your organization's admin.",
  sso_domain: "Your email isn't on a verified domain of this organization. Ask your organization's admin.",
  google_required: "Your organization requires you to log in with a Google account.",
};
/** `POST /auth/sso {email}` (JSON) */
export interface SsoLookup { tenantId: string; orgName: string }
/** `GET /me`'s `session` (null for a personal access token) */
export interface SessionIdle { id: string; auth: SessionAuth; activeAt: number; idleLimitMs: number | null }

// ---- SAML ----------------------------------------------------------------------------------------------------------

export type IdpProvider = "okta" | "entra" | "onelogin" | "google" | "custom";
export const IDP_PROVIDER_LABEL: Record<IdpProvider, string> = { okta: "Okta", entra: "Microsoft Entra ID", onelogin: "OneLogin", google: "Google Workspace", custom: "Other" };
export interface IdpCertificateInfo { sha256: string; subject: string; notAfter: number }
export interface IdpConfig {
  tenantId: string;
  provider: IdpProvider;
  idpEntityId: string;
  ssoUrl: string;
  /** The PEMs stay on the server */
  certificates: IdpCertificateInfo[];
  metadataUrl: string | null;
  signing: "assertion" | "assertion_or_response";
  /** Figma's "SP Entity ID" (also the SP metadata), "SP ACS URL", the start URL */
  spEntityId: string;
  spAcsUrl: string;
  startUrl: string;
  /** The first successful sign-in through this configuration; "Members must log in with SAML SSO" needs it */
  testedAt: number | null;
  updatedAt: number;
}
/** `PUT admin/identity/saml`: the metadata (a URL or the XML) or the three values by hand [F-adfs] */
export interface IdpConfigInput {
  provider: IdpProvider;
  metadataUrl?: string;
  metadataXml?: string;
  idpEntityId?: string;
  ssoUrl?: string;
  /** PEM, or base64 DER as IdPs show it */
  certificate?: string;
  signing?: IdpConfig["signing"];
}

// ---- SCIM ----------------------------------------------------------------------------------------------------------

export const SCIM_USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
export const SCIM_ENTERPRISE_SCHEMA = "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User";
/** Figma's own extension [F-scim-api] (its one attribute: figmaAdmin) */
export const SCIM_FIGMA_SCHEMA = "urn:ietf:params:scim:schemas:extension:figma:enterprise:2.0:User";
export const SCIM_GROUP_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Group";
export const SCIM_SEAT_VALUE = { full: "Full", dev: "Dev", collab: "Collab", view: "View" } as const;
export interface ScimTokenInfo { id: string; createdAt: number; createdBy: PersonRef | null; lastUsedAt: number | null }
/** `POST admin/identity/scim-token`: the token is shown once */
export interface ScimTokenCreated { token: string; info: ScimTokenInfo }
/** What SAML / SCIM told us about a member (Admin › People's metadata columns) */
export interface IdpAttributes {
  provisionedBy: "scim" | "jit" | null;
  /** SCIM's `active`; null when not SCIM-managed */
  scimActive: boolean | null;
  externalId?: string;
  title?: string;
  employeeNumber?: string;
  costCenter?: string;
  organization?: string;
  division?: string;
  department?: string;
  managerValue?: string;
  managerDisplayName?: string;
}

// ---- domains -------------------------------------------------------------------------------------------------------

export const DOMAIN_TXT_PREFIX = "designerv2-domain-verification=";
export interface OrgDomain { domain: string; verified: boolean; verifiedAt: number | null; txtRecord: string; createdAt: number }
/** `GET admin/identity`: Admin › Settings › Login and provisioning in one read */
export interface IdentityOverview {
  authMethod: AuthMethod;
  idp: IdpConfig | null;
  scim: { baseUrl: string; token: ScimTokenInfo | null } | null;
  domains: OrgDomain[];
  domainCapture: boolean;
}

/** The part of an email after its last "@", lower case; null when there is none */
export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  const d = at < 0 ? "" : email.slice(at + 1).trim().toLowerCase();
  return d && !d.includes("@") ? d : null;
}

/** A domain as an admin typed it → "acme.com", or null (scheme, path, port, "www." are not stripped silently: only a
 *  scheme and a trailing dot or slash are). Hostname rules: labels 1–63 of [a-z0-9-], not starting or ending with "-",
 *  at least two labels, ≤ 253 characters. */
export function normalizeDomain(input: string): string | null {
  const d = input.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "").replace(/\.$/, "");
  if (d.length === 0 || d.length > 253 || /[/:?#@\s]/.test(d)) return null;
  const labels = d.split(".");
  if (labels.length < 2) return null;
  for (const l of labels) if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l)) return null;
  return d;
}

// ---- sharing policies ----------------------------------------------------------------------------------------------

/** Admin › Public sharing › Custom settings for workspaces [F-share]: each present key overrides the org's */
export interface WorkspaceSharingSettings { publicLinks?: boolean; passwordRequired?: boolean; linkExpiryMaxHours?: number | null }
/** A file's effective policy (`GET /files/:key` → `policy`; null outside orgs) */
export interface FilePolicy {
  publicLinks: boolean;
  passwordRequired: boolean;
  passwordMode: "any" | "autogenerated";
  linkExpiryMaxHours: number | null;
  cursorChat: boolean;
  audio: boolean;
  openSessions: boolean;
}
export const LINK_EXPIRY_MAX_HOURS = 744; // Figma: 1 hour to 31 days

export function filePolicy(s: OrgSettings, ws: WorkspaceSharingSettings | null, editorType: EditorType): FilePolicy {
  const linkExpiryMaxHours = ws && ws.linkExpiryMaxHours !== undefined ? ws.linkExpiryMaxHours : s.linkExpiryMaxHours;
  const publicLinks = (ws?.publicLinks ?? s.publicLinks) && !(editorType === "figjam" && linkExpiryMaxHours !== null);
  return {
    publicLinks,
    passwordRequired: ws?.passwordRequired ?? s.passwordRequired,
    passwordMode: s.passwordMode,
    linkExpiryMaxHours,
    cursorChat: s.cursorChat,
    audio: s.audio,
    openSessions: s.openSessions,
  };
}

/** The room's part of the policy (`welcome.policy`, `{t: "policy"}`) */
export interface RoomPolicy { cursorChat: boolean; audio: boolean }

/** Four random words, Figma's "Autogenerated passwords" (the Share dialog's Generate; moved here from ShareDialog.tsx) */
export const PASSWORD_WORDS: readonly string[] = "amber anchor apple arrow autumn bamboo beacon berry bloom breeze canyon cedar cloud comet coral cotton crystal dawn delta desert echo ember falcon fern forest frost galaxy garden glacier harbor hazel horizon island ivory jade jasmine juniper lagoon lemon lily lotus maple meadow meteor mint moss nebula oasis ocean olive orbit orchid pebble pepper pine planet plum prairie quartz rain raven reef river robin saffron sage sand shadow silver sky spruce star stone storm summer sunset thunder tide timber topaz tulip valley velvet violet willow winter".split(" ");
export function generateLinkPassword(): string {
  const r = crypto.getRandomValues(new Uint32Array(4));
  return [...r].map((n) => PASSWORD_WORDS[n % PASSWORD_WORDS.length]).join("-");
}
export function isGeneratedPassword(p: string): boolean {
  const words = p.split("-");
  return words.length === 4 && words.every((w) => PASSWORD_WORDS.includes(w));
}

// ---- idle session timeout ------------------------------------------------------------------------------------------

export const IDLE_DEFAULT_HOURS = 504; // 21 days [F-idle]
export const IDLE_MIN_HOURS = 12;
export const IDLE_MAX_HOURS = 336; // 14 days
/** The idle limit of a person: the shortest over the orgs where they are a member or admin (guests: none); null: no org */
export function idleLimitMs(orgs: { role: OrgRole; settings: Pick<OrgSettings, "idleSessionTimeoutHours"> }[]): number | null {
  let hours: number | null = null;
  for (const o of orgs) {
    if (o.role === "guest") continue;
    const h = o.settings.idleSessionTimeoutHours ?? IDLE_DEFAULT_HOURS;
    hours = hours === null ? h : Math.min(hours, h);
  }
  return hours === null ? null : hours * 3_600_000;
}
/** The prompt shows this long before the logout [F-idle] */
export const IDLE_WARNING_MS = 60_000;

// ---- data storage localization -------------------------------------------------------------------------------------

export type DataRegion = "default" | "eu";
export const DATA_REGION_LABEL: Record<DataRegion, string> = { default: "Default", eu: "European Union" };
export interface DataRegionStatus {
  region: DataRegion;
  files: { total: number; moved: number };
  libraries: { total: number; moved: number };
  /** The file or library key being moved by this call, or null */
  moving: string | null;
  /** False when Cloudflare refused a jurisdiction-restricted object (§15.10) */
  available: boolean;
}

// ---- errors and the activity log -----------------------------------------------------------------------------------

/** New `code`s of §14.12's error bodies */
export type IdentityErrorCode =
  | "sso_not_found" | "idle_timeout" | "external_restricted" | "domain_unverified" | "domain_taken"
  | "password_policy" | "link_expiry_policy" | "public_links_off" | "moving";

/** Round 4's activity actions (§15.11): Figma's names, then ours */
export type IdentityActivityAction =
  | "google_sso_auth_change" | "saml_sso_auth_change" | "idp_config_create" | "idp_config_update" | "idp_config_delete"
  | "scim_token_generate" | "scim_token_revoke"
  | "idp_user_create" | "idp_user_update" | "idp_user_activate" | "idp_user_deactivate" | "idp_user_delete"
  | "idp_group_create" | "idp_group_rename" | "idp_group_delete" | "idp_group_connection_add" | "idp_group_connection_remove"
  | "org_domain_add" | "org_domain_verify" | "org_domain_remove" | "org_domain_capture_change"
  | "user_idle_session_timeout" | "idle_timeout_setting_change" | "cursor_chat_setting_change" | "open_sessions_setting_change"
  | "external_collaboration_controls_setting_change" | "autogen_password_controls_setting_change" | "workspace_public_link_setting_change"
  | "fig_file_view_prototype_external"
  // ours
  | "audio_setting_change" | "data_storage_localization_change" | "fig_file_region_move";
