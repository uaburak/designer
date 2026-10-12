/**
 * Public sign-up's limits (ours; docs/multiplayer.md §17): every per-account quota, the server-wide guards, the
 * operator's controls and the words the apps show. One place for the numbers — the server enforces them
 * (server/src/quota/), the apps say them (`quotaText`).
 *
 * The server runs on Cloudflare's free plan: 100,000 Worker requests and 100,000 D1 row writes a day, D1 5 GB, Durable
 * Objects' SQLite storage 5 GB for the whole account. Exhausting any of them stops the service for everyone, the
 * operator included — so each limit is generous for one person's real use and tight for abuse.
 */
import { RATE_LIMITS } from "./rest/types";

/** What can run out for one account (overridable per account by the operator) */
export type AccountQuotaKind =
  | "shared_files"
  | "storage_bytes"
  | "uploads_per_day"
  | "previews"
  | "orgs_created"
  | "invitations_per_day"
  | "comments_per_minute"
  | "rest_calls_per_day";

/** Server-wide guards (not overridable per account) */
export type ServerQuotaKind = "signups_per_ip_per_day" | "signups_per_day" | "server_storage_bytes";

export type QuotaKind = AccountQuotaKind | ServerQuotaKind;

const MB = 1024 * 1024;

/** The defaults. Overrides (`users.quota_overrides`) replace a kind's number for one account. */
export const QUOTA_LIMITS: Record<QuotaKind, number> = {
  /** Files the account owns on the server (shared files, org files and drafts, branches) */
  shared_files: 5000, // every personal draft counts since Wecra 1.1 (docs/cloud.md)
  /** Snapshots, images, thumbnails, previews and library payloads the account's files and previews keep */
  storage_bytes: 500 * MB,
  /** Uploads of bytes (snapshots, images, thumbnails, preview documents and images, library payloads, fonts) a day */
  uploads_per_day: 3000,
  /** Developer previews live or being published at once */
  previews: 20,
  /** Organizations the account created (and still exist) */
  orgs_created: 3,
  /** New people invited (to a shared file, an organization, its teams, folders and files) a day */
  invitations_per_day: 100,
  /** Comments and replies a minute */
  comments_per_minute: 20,
  /** REST API calls a day (docs/multiplayer.md §16.4's daily cap) */
  rest_calls_per_day: RATE_LIMITS.dailyCap,
  /** New accounts from one IP address a day */
  signups_per_ip_per_day: 3,
  /** New accounts a day, everyone together */
  signups_per_day: 200,
  /** Every account's stored bytes together: below the 1 GB of Durable Object storage Workers Paid includes (and the
   *  spend guard's 95% of it, src/shared/spendGuard.ts); the operator can change it (Settings › Operator) */
  server_storage_bytes: 900 * MB,
};

export const ACCOUNT_QUOTA_KINDS: readonly AccountQuotaKind[] = ["shared_files", "storage_bytes", "uploads_per_day", "previews", "orgs_created", "invitations_per_day", "comments_per_minute", "rest_calls_per_day"];
export const isAccountQuotaKind = (k: unknown): k is AccountQuotaKind => typeof k === "string" && (ACCOUNT_QUOTA_KINDS as readonly string[]).includes(k);

/** Per-account overrides: a kind's number for this account instead of the default */
export type QuotaOverrides = Partial<Record<AccountQuotaKind, number>>;
/** The largest override the operator can set (a bound, not a promise: 100 GB, or a count) */
export const MAX_QUOTA_OVERRIDE = 100 * 1024 * MB;

export const QUOTA_LABEL: Record<QuotaKind, string> = {
  shared_files: "Shared files",
  storage_bytes: "Storage",
  uploads_per_day: "Uploads a day",
  previews: "Developer previews",
  orgs_created: "Organizations created",
  invitations_per_day: "Invitations a day",
  comments_per_minute: "Comments a minute",
  rest_calls_per_day: "API calls a day",
  signups_per_ip_per_day: "New accounts a day from one network",
  signups_per_day: "New accounts a day",
  server_storage_bytes: "Server storage",
};

export const isByteQuota = (k: QuotaKind): boolean => k === "storage_bytes" || k === "server_storage_bytes";

export function formatBytes(n: number): string {
  if (n >= 1024 * MB) return `${Math.round((n / (1024 * MB)) * 10) / 10} GB`;
  if (n >= MB) return `${Math.round((n / MB) * 10) / 10} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} bytes`;
}

/** The refusal's words (403/429 `quota_exceeded` with `{kind, limit}`), the same on the server and in the apps */
export function quotaText(kind: QuotaKind, limit: number): string {
  switch (kind) {
    case "shared_files":
      return `You've reached the limit of ${limit} files on the server. Delete or stop sharing a file to add another.`;
    case "storage_bytes":
      return `You've used your ${formatBytes(limit)} of server storage. Delete files or previews you no longer need.`;
    case "uploads_per_day":
      return `You've reached today's limit of ${limit} uploads. Try again tomorrow.`;
    case "previews":
      return `You can have at most ${limit} developer previews. Unpublish one first.`;
    case "orgs_created":
      return `You can create at most ${limit} organizations.`;
    case "invitations_per_day":
      return `You've reached today's limit of ${limit} invitations. Try again tomorrow.`;
    case "comments_per_minute":
      return `You're commenting too fast. Wait a minute and try again.`;
    case "rest_calls_per_day":
      return `You've reached today's limit of ${limit} API calls.`;
    case "signups_per_ip_per_day":
    case "signups_per_day":
      return "Too many new accounts were created today. Try again tomorrow.";
    case "server_storage_bytes":
      return "The server is out of storage. Try again later.";
  }
}

/** The 403/429 body's extra fields (`{error, code: "quota_exceeded", kind, limit}`) */
export interface QuotaRefusal {
  code: "quota_exceeded";
  kind: QuotaKind;
  limit: number;
}

export const isQuotaRefusal = (d: unknown): d is QuotaRefusal => !!d && typeof d === "object" && (d as { code?: unknown }).code === "quota_exceeded" && typeof (d as { kind?: unknown }).kind === "string" && typeof (d as { limit?: unknown }).limit === "number";

// ---- accounts and sign-up ------------------------------------------------------------------------------------------

/** A suspended account: 403 `account_suspended` on every route, its sessions ended */
export const ACCOUNT_SUSPENDED_TEXT = "This account is suspended. Contact the operator of this server.";

/** Who may create an account: anyone (`open`), people invited somewhere or on the allowlist (`invite`), nobody (`closed`) */
export type SignupMode = "open" | "invite" | "closed";
export const SIGNUP_MODES: readonly SignupMode[] = ["open", "invite", "closed"];
export const DEFAULT_SIGNUP_MODE: SignupMode = "open";
export const SIGNUP_MODE_LABEL: Record<SignupMode, string> = { open: "Open to everyone", invite: "Invited people only", closed: "Closed (existing accounts only)" };

/** The sign-in's `error=` values public sign-up adds (the loopback, the web page's `auth_error`) */
export type SignupSignInError = "account_suspended" | "signup_closed" | "signup_invite_only" | "signup_limit";
export const SIGNUP_SIGN_IN_ERROR_TEXT: Record<SignupSignInError, string> = {
  account_suspended: ACCOUNT_SUSPENDED_TEXT,
  signup_closed: "New accounts can't be created on this server right now.",
  signup_invite_only: "This server only accepts people who were invited. Ask someone to share a file with you first.",
  signup_limit: "Too many new accounts were created today. Try again tomorrow.",
};

/** The operator emails when `OPERATOR_EMAILS` isn't set */
export const DEFAULT_OPERATOR_EMAILS = ["design.burakkoc@gmail.com"];

/** `GET /me/usage` */
export interface AccountUsage {
  usage: { sharedFiles: number; storageBytes: number; previews: number; orgsCreated: number };
  limits: Record<AccountQuotaKind, number>;
  operator: boolean;
}

/** One row of `GET /operator/accounts` */
export interface OperatorAccount {
  id: string;
  email: string;
  name: string | null;
  createdAt: number;
  lastSeenAt: number;
  suspendedAt: number | null;
  suspendedReason: string | null;
  operator: boolean;
  sharedFiles: number;
  storageBytes: number;
  previews: number;
  orgsCreated: number;
  overrides: QuotaOverrides;
}

/** `GET /operator/settings` */
export interface OperatorSettings {
  signupMode: SignupMode;
  allowlist: string[];
  defaults: Record<QuotaKind, number>;
  serverStorageBytes: number;
  accounts: number;
}
