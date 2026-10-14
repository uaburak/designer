/**
 * The signed-in account (docs/multiplayer.md §2): who the user is on the multiplayer server. Main holds the session
 * token (safeStorage) and never hands it to a view; views see this state only.
 */

import type { RestScope } from "./rest/types";
import { t, tp } from "./i18n";

export interface AccountUser {
  id: string;
  email: string;
  name: string | null;
  picture: string | null;
}

export interface AccountState {
  /** The server signed in to (or that sign-in would use) */
  server: string;
  user: AccountUser | null;
  /** Every account signed in on this computer (docs/desktop.md §18.7), the current one included, in the order they
   *  were added — the account menu lists them when there is more than one. Absent: only `user` (a browser). */
  accounts?: AccountUser[];
  /** A sign-in is waiting for the browser (or the sign-in sheet) */
  signingIn: boolean;
  /** The kept session is still being read (the keychain may be asking): neither signed in nor out yet — the welcome
   *  window shows its splash, never the welcome page (docs/desktop.md §18.6). Absent: known. */
  loading?: boolean;
}

/** The welcome page's two ways in (docs/desktop.md §18.6): Google, or the server's single sign-on page (SAML) */
export type SignInMethod = "google" | "sso";

/**
 * What the signed-out welcome window shows (docs/desktop.md §18.6), from the account as last heard: the splash while
 * the kept session loads and while a signed-in window takes over (never a flash of the welcome page for someone
 * signed in), the welcome page otherwise — "signing-in" while a sign-in waits.
 */
export function welcomeScreen(state: AccountState | null): "splash" | "welcome" | "signing-in" {
  if (!state || state.loading || state.user) return "splash";
  return state.signingIn ? "signing-in" : "welcome";
}

export type SignInResult = { ok: true; state: AccountState } | { ok: false; error: "cancelled" | "timeout" | "failed"; message?: string; state: AccountState };

/** The production server; `DESIGNER_SERVER` overrides it (e.g. http://localhost:8787 for `npm --prefix server run dev`). */
export const DEFAULT_SERVER = "https://wecra.app";

/**
 * The production server's address up to 1.0.3 (docs/multiplayer.md §7): the same Worker, which still answers there for
 * apps not yet updated. Sessions are bearer tokens, not cookies, so one signed in there keeps working at wecra.app.
 */
export const FORMER_SERVERS: readonly string[] = ["https://designer.burak-kc-sp.workers.dev"];

/** Whether something kept for `stored` (a session, a cache) belongs to `current`: the same address, or a former
 *  address of the default server while the default server is the one in use. */
export function sameServer(stored: unknown, current: string): boolean {
  if (typeof stored !== "string") return false;
  const a = stored.replace(/\/+$/, "");
  const b = current.replace(/\/+$/, "");
  return a === b || (b === DEFAULT_SERVER && FORMER_SERVERS.includes(a));
}

// ── Settings (docs/multiplayer.md §13; docs/research/figma/R17-settings.md) ──────────────────────────────────────────

/** Figma's work roles (Settings › Account › Role; the onboarding's "What kind of work do you do?"). */
export const ROLES = ["Design", "Development", "Product management", "User research", "Marketing", "Data analytics", "Education", "Student", "Other"] as const;

/** Settings kept with the account (Figma keeps them per account, not per machine). */
export interface AccountPrefs {
  /** Unused: the UI's language is the machine's (settings.json, src/shared/i18n), so it reaches the signed-out window */
  language?: string;
  /** New features › Closed captions: "Enable closed captioning when using audio inside your files." */
  closedCaptions?: boolean;
  /** View history: false = "Off" — opening a file isn't recorded for others to see */
  viewHistory?: boolean;
  /** "Answer API requests for my files while Wecra is open" (the desktop's render helper, docs/multiplayer.md §16.6): absent = on */
  restHelper?: boolean;
}

/** Settings › Community: the Community profile (help.figma.com 360038510833, 4404108672663). */
export interface CommunityProfile {
  /** "@handle": 1–15 letters, digits or _ ; unique */
  handle?: string;
  bio?: string;
  location?: string;
  website?: string;
  x?: string;
  instagram?: string;
}

export const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;
export const MAX_BIO = 160;

/** `GET /me/profile`: the account as Settings shows it. */
export interface AccountProfile extends AccountUser {
  role: string | null;
  community: CommunityProfile;
  prefs: AccountPrefs;
  /** Signed in with Google: email and password are Google's ("Managed by Google") */
  provider: "google" | "dev";
}

/** `PATCH /me/profile` */
export interface ProfilePatch {
  name?: string;
  /** A data:image/(png|jpeg|webp);base64 URL ≤ 300 kB, or null to go back to Google's photo */
  picture?: string | null;
  role?: string | null;
  community?: CommunityProfile;
  prefs?: AccountPrefs;
}

export const MAX_PICTURE_CHARS = 300_000;

/** A row of Settings › Security › Sessions (`GET /me/sessions`). */
export interface SessionInfo {
  id: string;
  /** "app": the desktop app — "App · ip"; "login": a browser — "Login · ip" */
  kind: "app" | "login";
  os: string | null;
  browser: string | null;
  ip: string | null;
  city: string | null;
  country: string | null;
  createdAt: number;
  lastSeenAt: number;
  /** The session making the request: "Current" instead of "Sign out" */
  current: boolean;
}

/**
 * Personal access tokens' scopes: Figma's REST scope names (developers.figma.com/docs/rest-api/scopes), the ones our
 * API serves. A token only reads (and writes comments); never the account, sharing or the rooms' sockets.
 */
export const TOKEN_SCOPES = [
  { id: "current_user:read", group: "Users", label: "Read your name, email, and profile image." },
  { id: "file_content:read", group: "Files", label: "Read the contents of files, such as nodes and the editor type." },
  { id: "file_metadata:read", group: "Files", label: "Read metadata of files." },
  { id: "file_comments:read", group: "Comments", label: "Read the comments for files." },
  { id: "file_comments:write", group: "Comments", label: "Post and delete comments and comment reactions in files." },
  { id: "file_versions:read", group: "Files", label: "Read the version history for files you can access." },
  { id: "file_dev_resources:read", group: "Dev resources", label: "Read dev resources in files." },
  { id: "file_dev_resources:write", group: "Dev resources", label: "Write dev resources to files." },
  { id: "file_variables:read", group: "Variables", label: "Read variables in files." },
  { id: "file_variables:write", group: "Variables", label: "Write variables and collections in files." },
  { id: "file_code_connect:write", group: "Code Connect", label: "Publish and unpublish Code Connect." },
  { id: "library_assets:read", group: "Libraries", label: "Read data of individual published components and styles." },
  { id: "library_content:read", group: "Libraries", label: "Read published components and styles of files." },
  { id: "team_library_content:read", group: "Libraries", label: "Read published components and styles of teams." },
  { id: "library_analytics:read", group: "Libraries", label: "Read your design system analytics." },
  { id: "folders:read", group: "Folders", label: "List folders and files in folders." },
  { id: "folder_metadata:read", group: "Folders", label: "Read metadata of folders." },
  { id: "webhooks:read", group: "Webhooks", label: "Read metadata of webhooks." },
  { id: "webhooks:write", group: "Webhooks", label: "Create and manage webhooks." },
  { id: "org:activity_log_read", group: "Organization", label: "Read organization activity logs." },
  { id: "org:ai_metering_usage_read", group: "Organization", label: "Read organization AI usage." },
  { id: "org:discovery_read", group: "Organization", label: "Read organization discovery data." },
  { id: "org:developer_log_read", group: "Organization", label: "Read organization developer logs." },
] as const satisfies readonly { id: RestScope; group: string; label: string }[];
export type TokenScope = (typeof TOKEN_SCOPES)[number]["id"];
export const isTokenScope = (s: unknown): s is TokenScope => TOKEN_SCOPES.some((t) => t.id === s);

/** Expiration choices (Figma removed non-expiring tokens in 2025; 90 days at most). */
export const TOKEN_EXPIRATIONS = [
  { days: 1, label: "1 day" },
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
] as const;

/** Our tokens' prefix (Figma's are "figd_") */
export const TOKEN_PREFIX = "dsgn_";

/** A personal access token as listed (`GET /me/tokens`); the token itself is shown once, at `POST /me/tokens`. */
export interface AccessTokenInfo {
  id: string;
  description: string;
  scopes: TokenScope[];
  /** "plan": a plan access token of an org (docs/multiplayer.md §16.3) */
  kind: "personal" | "plan";
  orgId: string | null;
  createdAt: number;
  expiresAt: number | null;
  lastUsedAt: number | null;
}

/** What a view may ask the server through main (`account:request`): the caller's own account (and its quota usage),
 *  and the operator's routes (docs/multiplayer.md §17; the server refuses them to anyone else), nothing else. */
export const ACCOUNT_PATH =
  /^(\/me(\/(profile|sessions|tokens|usage)(\/[A-Za-z0-9_-]{1,64})?)?|\/operator\/(settings|spend-guard(\/check)?|accounts(\?[A-Za-z0-9_=&%.+-]{0,200})?|accounts\/[A-Za-z0-9_-]{1,64}\/(suspend|unsuspend|quota)))$/;
export type AccountMethod = "GET" | "POST" | "PATCH" | "DELETE";

export interface AccountResponse<T = unknown> {
  status: number;
  body: T;
}

/** Figma's "Last accessed" / "Created …" / "Connected …" wording: "Just now", "16 hours ago", "2 months ago". */
export function timeAgo(then: number, now: number): string {
  const s = Math.max(0, Math.round((now - then) / 1000));
  if (s < 60) return t("Just now");
  const m = Math.floor(s / 60);
  if (m < 60) return tp(m, "{n} minute ago", "{n} minutes ago");
  const h = Math.floor(m / 60);
  if (h < 24) return tp(h, "{n} hour ago", "{n} hours ago");
  const d = Math.floor(h / 24);
  if (d < 30) return tp(d, "{n} day ago", "{n} days ago");
  const mo = Math.floor(d / 30);
  if (mo < 12) return tp(mo, "{n} month ago", "{n} months ago");
  return tp(Math.floor(d / 365), "{n} year ago", "{n} years ago");
}

/** Parses a User-Agent for Sessions' "OS & Browser" (the desktop app sends `DesignerV2-Desktop/<version> (<os>)`). */
export function deviceFromUserAgent(ua: string | null): { kind: "app" | "login"; os: string | null; browser: string | null } {
  const s = ua ?? "";
  const app = /DesignerV2-Desktop\/[\w.-]+(?: \(([^)]*)\))?/.exec(s);
  if (app) return { kind: "app", os: app[1] || null, browser: "Wecra Desktop" };
  const os = /iPhone/.test(s) ? "iOS (iPhone)" : /iPad/.test(s) ? "iOS (iPad)" : /Android/.test(s) ? "Android" : /CrOS/.test(s) ? "ChromeOS" : /Mac OS X|Macintosh/.test(s) ? "macOS" : /Windows/.test(s) ? "Windows" : /Linux/.test(s) ? "Linux" : null;
  const browser = /Edg(e|A|iOS)?\//.test(s) ? "Edge" : /OPR\//.test(s) ? "Opera" : /Firefox\/|FxiOS/.test(s) ? "Firefox" : /Chrome\/|CriOS/.test(s) ? "Chrome" : /Safari\//.test(s) ? "Safari" : null;
  return { kind: "login", os, browser };
}
