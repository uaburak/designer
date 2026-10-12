/**
 * Governance+ (docs/governance.md, Phase 7 round 14): the export restriction, the IP allowlist and network
 * restrictions, the 15-minute idle timeout, 2FA for guests (our TOTP), multiple IdPs, internal policies, key
 * management (managed only), Discovery and developer logs, guest expiration. Shared by the Worker, the store, main and
 * the views; pure, no I/O (WebCrypto only).
 */
import type { OrgRole, PersonRef } from "./types";

// ---- the add-on ----------------------------------------------------------------------------------------------------

/** Admin rows shown disabled when the add-on is off (§2.1) */
export const REQUIRES_GOVERNANCE_PLUS = "Requires Governance+";

// ---- file exporting (§1, §2.7) -------------------------------------------------------------------------------------

export type FileExporting = "all" | "guests_blocked" | "viewers_blocked";
export const FILE_EXPORTING_LABEL: Record<FileExporting, string> = {
  all: "Allow exporting by all viewers",
  guests_blocked: "Prevent exporting by guest viewers",
  viewers_blocked: "Prevent exporting for all viewers",
};
/** The Share dialog's Advanced row [copy] */
export const VIEWERS_CAN_EXPORT_LABEL = "Viewers can copy, share, and export from this file";

/** May a viewer (not an editor) export under this policy? `isOrgMember`: a member or admin of the file's org (people
 *  reaching the file through a link from outside the org count as guests, ours). Editors always export. */
export function viewerMayExport(p: { fileExporting?: FileExporting }, isOrgMember: boolean): boolean {
  const e = p.fileExporting ?? "all";
  return e === "all" || (e === "guests_blocked" && isOrgMember);
}

// ---- idle timeout (§2.8) -------------------------------------------------------------------------------------------

export const IDLE_GOVERNANCE_MIN_HOURS = 0.25;
/** `idleSessionTimeoutHours` an admin may set: with G+ any multiple of 0.25 from 0.25 to 336; without, whole hours
 *  from 12 to 336; null (Figma's default) always */
export function validIdleHours(h: number | null, governancePlus: boolean): boolean {
  if (h === null) return true;
  if (!Number.isFinite(h) || h > 336) return false;
  return governancePlus ? h >= IDLE_GOVERNANCE_MIN_HOURS && Number.isInteger(h * 4) : h >= 12 && Number.isInteger(h);
}

// ---- guest expiration (§2.13) --------------------------------------------------------------------------------------

export const GUEST_EXPIRY_WARNING_MS = 14 * 86_400_000;
export const GUEST_EXPIRY_MAX_DAYS = 3650;

// ---- IP ranges (§2.2, §2.3) ----------------------------------------------------------------------------------------

export interface IpRange { id: string; cidr: string; createdAt: number; createdBy: PersonRef | null }
export type NetworkRangeState = "testing" | "enforced" | "disabled";
export interface NetworkRange extends IpRange {
  state: NetworkRangeState;
  /** Distinct accounts the range would have blocked in the last 7 days (shadow counts) */
  wouldBlock7d: number;
}
export interface IpAllowlist { enabled: boolean; ranges: IpRange[] }
/** Network ranges can't be wider than these, so an admin can't block the internet (§2.2, ours) */
export const NETWORK_MIN_PREFIX = { 4: 16, 6: 32 } as const;

/** An IPv4 or IPv6 address → its bytes, or null */
export function parseIp(s: string): Uint8Array | null {
  const t = s.trim();
  if (t.includes(".") && !t.includes(":")) {
    const parts = t.split(".");
    if (parts.length !== 4) return null;
    const out = new Uint8Array(4);
    for (let i = 0; i < 4; i++) {
      if (!/^(0|[1-9]\d{0,2})$/.test(parts[i])) return null;
      const n = Number(parts[i]);
      if (n > 255) return null;
      out[i] = n;
    }
    return out;
  }
  if (!t.includes(":") || /[^0-9a-fA-F:.]/.test(t)) return null;
  // An IPv4 tail ("::ffff:1.2.3.4") becomes two hex groups
  let head = t;
  const lastColon = t.lastIndexOf(":");
  if (t.slice(lastColon + 1).includes(".")) {
    const v4 = parseIp(t.slice(lastColon + 1));
    if (!v4 || v4.length !== 4) return null;
    head = `${t.slice(0, lastColon + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const want = 8;
  const dbl = head.split("::");
  if (dbl.length > 2) return null;
  const left = dbl[0] ? dbl[0].split(":") : [];
  const right = dbl.length === 2 && dbl[1] ? dbl[1].split(":") : [];
  if (dbl.length === 1 && left.length !== want) return null;
  if (dbl.length === 2 && left.length + right.length >= want) return null;
  const groups: number[] = [];
  for (const g of [...left, ...(dbl.length === 2 ? Array(want - left.length - right.length).fill("0") : []), ...right]) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    groups.push(parseInt(g, 16));
  }
  if (groups.length !== 8) return null;
  const out = new Uint8Array(16);
  groups.forEach((g, i) => { out[i * 2] = g >> 8; out[i * 2 + 1] = g & 0xff; });
  return out;
}

function formatIp(b: Uint8Array): string {
  if (b.length === 4) return [...b].join(".");
  const g: number[] = [];
  for (let i = 0; i < 16; i += 2) g.push((b[i] << 8) | b[i + 1]);
  // RFC 5952: compress the longest run of ≥ 2 zero groups
  let best = -1, bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (g[i] !== 0) { i++; continue; }
    let j = i;
    while (j < 8 && g[j] === 0) j++;
    if (j - i > bestLen && j - i >= 2) { best = i; bestLen = j - i; }
    i = j;
  }
  const hex = g.map((n) => n.toString(16));
  if (best < 0) return hex.join(":");
  return `${hex.slice(0, best).join(":")}::${hex.slice(best + bestLen).join(":")}`;
}

/** "10.0.0.0/8", "1.2.3.4" (→ /32), "2001:db8::/32" (→ canonical, host bits cleared) → the canonical CIDR, or null.
 *  `kind: "network"` also refuses ranges wider than NETWORK_MIN_PREFIX. */
export function normalizeCidr(s: string, kind: "allowlist" | "network" = "allowlist"): string | null {
  const [addr, prefix, extra] = s.trim().split("/");
  if (extra !== undefined || !addr) return null;
  const b = parseIp(addr);
  if (!b) return null;
  const max = b.length * 8;
  let p = max;
  if (prefix !== undefined) {
    if (!/^\d{1,3}$/.test(prefix)) return null;
    p = Number(prefix);
    if (p > max) return null;
  }
  if (kind === "network" && p < NETWORK_MIN_PREFIX[b.length === 4 ? 4 : 6]) return null;
  for (let i = 0; i < b.length; i++) {
    const keep = Math.max(0, Math.min(8, p - i * 8));
    b[i] &= keep === 0 ? 0 : (0xff << (8 - keep)) & 0xff;
  }
  return `${formatIp(b)}/${p}`;
}

/** Is `ip` inside `cidr` (canonical or not)? An IPv4-mapped IPv6 address matches IPv4 ranges. */
export function ipInCidr(ip: string, cidr: string): boolean {
  let a = parseIp(ip);
  const [addr, prefix] = cidr.split("/");
  const b = parseIp(addr);
  if (!a || !b) return false;
  if (a.length === 16 && b.length === 4 && a.slice(0, 10).every((x) => x === 0) && a[10] === 0xff && a[11] === 0xff) a = a.slice(12);
  if (a.length !== b.length) return false;
  const p = prefix === undefined ? b.length * 8 : Number(prefix);
  for (let i = 0; i < b.length && p - i * 8 > 0; i++) {
    const bits = Math.min(8, p - i * 8);
    const mask = (0xff << (8 - bits)) & 0xff;
    if ((a[i] & mask) !== (b[i] & mask)) return false;
  }
  return true;
}

// ---- two-factor authentication (§2.4) -------------------------------------------------------------------------------

/** RFC 6238 with SHA-1 */
export const TOTP = { digits: 6, periodS: 30, window: 1 } as const;
export const RECOVERY_CODE_COUNT = 10;
/** Sign-in failures before 429 (§4) */
export const TWO_FACTOR_MAX_FAILURES = 5;
export const TWO_FACTOR_FAILURE_WINDOW_MS = 10 * 60_000;
/** A network range is enforced only after this long in testing, so its shadow hits are seen first (§2.2; ours) */
export const NETWORK_TESTING_MIN_MS = 24 * 3_600_000;
export const TWO_FACTOR_SETUP_TTL_MS = 10 * 60_000;

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function base32Encode(bytes: Uint8Array): string {
  let out = "", bits = 0, value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
/** Case- and space-insensitive, padding ignored; null on a bad character */
export function base32Decode(s: string): Uint8Array | null {
  const t = s.replace(/[\s=]/g, "").toUpperCase();
  const out: number[] = [];
  let bits = 0, value = 0;
  for (const ch of t) {
    const v = B32.indexOf(ch);
    if (v < 0) return null;
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return new Uint8Array(out);
}

/** HOTP (RFC 4226) over WebCrypto HMAC-SHA1: the 6-digit code for `counter` */
export async function totpCode(secret: Uint8Array, counter: number): Promise<string> {
  const msg = new Uint8Array(8);
  let c = counter;
  for (let i = 7; i >= 0; i--) { msg[i] = c & 0xff; c = Math.floor(c / 256); }
  const key = await crypto.subtle.importKey("raw", new Uint8Array(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const h = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
  const o = h[19] & 0x0f;
  const bin = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(bin % 10 ** TOTP.digits).padStart(TOTP.digits, "0");
}
export const totpStep = (nowMs: number): number => Math.floor(nowMs / 1000 / TOTP.periodS);
/** The step `code` matches within ±window and after `lastStep` (no replay), or null */
export async function verifyTotp(secret: Uint8Array, code: string, nowMs: number, lastStep = 0): Promise<number | null> {
  if (!/^\d{6}$/.test(code.replace(/\s/g, ""))) return null;
  const c = code.replace(/\s/g, "");
  const now = totpStep(nowMs);
  for (let d = -TOTP.window; d <= TOTP.window; d++) {
    const step = now + d;
    if (step <= lastStep) continue;
    if ((await totpCode(secret, step)) === c) return step;
  }
  return null;
}
export function otpauthUrl(secretB32: string, email: string, issuer = "Wecra"): string {
  const label = encodeURIComponent(`${issuer}:${email}`);
  return `otpauth://totp/${label}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${TOTP.digits}&period=${TOTP.periodS}`;
}
/** "xxxx-xxxx" (lower-case base32 without ambiguous letters) */
export function generateRecoveryCode(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const r = crypto.getRandomValues(new Uint8Array(8));
  const s = [...r].map((n) => alphabet[n % alphabet.length]).join("");
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

/** `GET /me/two-factor` */
export interface TwoFactorStatus { enabled: boolean; enabledAt: number | null; recoveryCodesLeft: number }
/** `POST /me/two-factor/setup`: pending for TWO_FACTOR_SETUP_TTL_MS */
export interface TwoFactorSetup { secret: string; otpauthUrl: string }
/** `POST /me/two-factor/enable` and `/recovery-codes`: shown once */
export interface TwoFactorEnabled { recoveryCodes: string[] }

// ---- internal policies (§2.6) --------------------------------------------------------------------------------------

export type PolicyAudience = "members" | "guests" | "everyone";
export type PolicyCadence = "yearly" | "once";
export const POLICY_AUDIENCE_LABEL: Record<PolicyAudience, string> = { members: "Members", guests: "Guests", everyone: "Everyone" };
export const POLICY_CADENCE_LABEL: Record<PolicyCadence, string> = { yearly: "Once a year", once: "Once per user" };
export const POLICY_TITLE_MAX = 200;
export const POLICY_TEXT_MAX = 20_000;
export const POLICY_YEAR_MS = 365 * 86_400_000;
export interface InternalPolicyInput { title: string; text: string; audience: PolicyAudience; cadence: PolicyCadence }
export interface InternalPolicy extends InternalPolicyInput {
  id: string;
  enabledAt: number | null;
  disabledAt: number | null;
  createdBy: PersonRef | null;
  createdAt: number;
  acknowledgedCount: number;
}
/** What the modal shows */
export interface PolicyPrompt { id: string; title: string; text: string }
export function policyApplies(p: { audience: PolicyAudience }, role: OrgRole): boolean {
  return p.audience === "everyone" || (p.audience === "guests" ? role === "guest" : role !== "guest");
}
export function needsAcknowledgement(p: { cadence: PolicyCadence }, lastAt: number | null, now: number): boolean {
  if (lastAt === null) return true;
  return p.cadence === "yearly" && now - lastAt >= POLICY_YEAR_MS;
}

// ---- org gates (§2.5) ----------------------------------------------------------------------------------------------

export type OrgGate = { kind: "two_factor" } | { kind: "policy"; policies: PolicyPrompt[] } | { kind: "ip"; ip: string };

// ---- key management (§2.10; managed only — owner's choice 2026-10-12: free plan, no AWS) ----------------------------

export type KeySource = "managed";
export interface EkmStatus {
  enabled: boolean;
  source: KeySource | null;
  state: "ok" | "unavailable" | null;
  checkedAt: number | null;
  files: { total: number; encrypted: number };
  /** The file this call encrypted (`encrypt-next`), or null */
  encrypting: string | null;
}
export interface EkmInput { source: KeySource }
/**
 * Each encrypted row: "DV2E" | version | iv (12) | AES-256-GCM ciphertext + tag. Version 2 (written now) binds
 * `fileKey|table` into the associated data; version 1 rows (the header alone) are still read.
 */
export const ENC_MAGIC = "DV2E";
export const ENC_VERSION = 2;
export const ENC_HEADER_BYTES = 4 + 1 + 12;
/** The room re-unwraps the DEK this often */
export const EKM_RECHECK_MS = 3_600_000;

// ---- Discovery (§1, §2.11) -----------------------------------------------------------------------------------------

export type DiscoveryTextType =
  | "in_file" | "file_comments" | "file_comment_reactions" | "developer_related_links" | "dev_mode_annotation"
  | "component_documentation_link" | "component_documentation_description" | "cursor_chat" | "user_ai_prompts";
export type DiscoveryActionType = "insert" | "update" | "delete" | "transient";
/** One row of an hourly file: Figma's flat shape, snake_case; `timestamp` in seconds */
export interface DiscoveryEvent {
  file_key: string;
  text: string;
  timestamp: number;
  action_type: DiscoveryActionType;
  file_name: string;
  file_workspace_id: string | null;
  node_id: string | null;
  text_type: DiscoveryTextType;
  resource_id: string | null;
  parent_comment_id: string | null;
  user_id: string;
  user_email: string;
  user_billing_group_id: string | null;
  feature_entrypoint: string | null;
  moderation_failure_flags: string | null;
}
/** `GET /v1/discovery` */
export interface DiscoveryResponse { error: boolean; status: number; meta: { urls: Record<string, string[]> }; i18n: null }
export const DISCOVERY_MAX_RANGE_S = 86_400;
export const DISCOVERY_MIN_AGE_S = 3_600;
export const DISCOVERY_FILE_TTL_S = { min: 60, max: 86_400, default: 86_400 } as const;
export const DISCOVERY_RETENTION_MS = 30 * 86_400_000;
/** "YYYY/MM/DD/HH" (UTC) of a time in ms */
export function discoveryHourKey(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())}/${p(d.getUTCHours())}`;
}
/** The `discovery_text` room job's answer: every text-bearing node */
export interface DiscoveryTextItem { nodeId: string; textType: Extract<DiscoveryTextType, "in_file" | "dev_mode_annotation" | "component_documentation_link" | "component_documentation_description">; text: string }
/** `POST /orgs/:org/discovery/ai-prompt` (client-reported) */
export interface AiPromptReport { fileKey: string | null; text: string; feature: string; at: number }

// ---- developer logs (§1, §2.12) ------------------------------------------------------------------------------------

export type DeveloperTokenType = "PLAN_ACCESS_TOKEN" | "PERSONAL_ACCESS_TOKEN" | "OAUTH_TOKEN";
export type DeveloperEventSource = "REST_API" | "MCP_SERVER";
export type DeveloperDateRange = "LAST_24H" | "LAST_7D" | "LAST_30D";
export interface DeveloperLogsQuery {
  token?: string;
  token_name?: string;
  user_email?: string;
  ip_address?: string;
  token_type?: DeveloperTokenType;
  event_source?: DeveloperEventSource;
  date_range?: DeveloperDateRange;
  /** 25 by default, at most 100 */
  limit?: number;
  cursor?: string;
}
export interface DeveloperLogItem {
  uuid: string;
  /** ISO with ms, "Z" */
  timestamp: string;
  action: { event_name: string; event_source: "rest_api" | "mcp_server" };
  actor: { user_id: string | null; user_name: string | null; token_name: string | null; token_type: "plan_access_token" | "personal_access_token" | "oauth_token" | "session"; user_email: string | null };
  resource: { id_or_key: string | null; name: string | null; type: string | null; org_id: string };
  context: { ip_address: string; city: string | null; country_region: string | null; country: string | null };
}
export interface DeveloperLogsResponse { status: number; error: boolean; meta: { items: DeveloperLogItem[]; cursor: string | null; has_more: boolean } }
export const DEVELOPER_LOGS_RETENTION_MS = 30 * 86_400_000;
/** `POST /orgs/:org/developer-logs/mcp`: main's batched MCP tool calls on org files */
export interface McpLogReport { calls: { tool: string; fileKey: string | null; at: number }[] }

// ---- Admin overview ------------------------------------------------------------------------------------------------

/** `GET admin/governance` */
export interface GovernanceOverview {
  governancePlus: boolean;
  ipAllowlist: IpAllowlist;
  /** The caller's address as the Worker sees it */
  callerIp: string;
  networkRanges: NetworkRange[];
  policies: InternalPolicy[];
  ekm: EkmStatus;
  /** Guests who'd be blocked if 2FA for Guests were turned on */
  guestsWithout2fa: number;
}

// ---- errors, sign-in, the activity log -----------------------------------------------------------------------------

export type GovernanceErrorCode =
  | "governance_plus_required" | "two_factor_required" | "two_factor_invalid" | "policy_acknowledgement_required"
  | "ip_not_allowed" | "network_restricted" | "key_unavailable" | "export_restricted";

export type GovernanceSignInError = "network_restricted" | "two_factor_failed";
export const GOVERNANCE_SIGN_IN_ERROR_TEXT: Record<GovernanceSignInError, string> = {
  network_restricted: "This network only allows work accounts. Log in with your work account, or switch networks.",
  two_factor_failed: "Two-factor authentication didn't work. Try again.",
};

/** §1's verified names, then ours (§3) */
export type GovernanceActivityAction =
  | "mfa_required_setting_change"
  | "ip_allowlist_setting_change" | "ip_allowlist_range_create" | "ip_allowlist_range_delete" | "ip_allowlist_rejected"
  | "ip_restriction_change" | "network_access_restriction_range_create" | "network_access_restriction_range_update" | "network_access_restriction_range_delete"
  | "org_domain_idp_mapping_change"
  | "policy_create" | "policy_update" | "policy_acknowledge"
  | "file_export_controls_setting_change" | "workspace_file_export_controls_setting_change"
  // ours
  | "governance_plus_enable" | "governance_plus_disable"
  | "org_guest_expiration_setting_change" | "org_user_guest_expiration_change"
  | "user_two_factor_enable" | "user_two_factor_disable"
  | "ekm_enable" | "ekm_key_change" | "ekm_key_unavailable" | "fig_file_encrypt"
  | "discovery_setting_change";
