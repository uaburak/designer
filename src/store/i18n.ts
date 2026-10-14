import { t } from "../shared/i18n";
import { ACCOUNT_SUSPENDED_TEXT, formatBytes, quotaText, type QuotaKind } from "../shared/quota";

/**
 * The store's refusals in the UI's language (src/shared/i18n). The quota refusals' English lives in src/shared/quota.ts
 * (the server says the same words); these are its templates, used only while they still fill to exactly that English —
 * a wording changed there falls back to it rather than to a stale translation.
 */
const QUOTA_TEMPLATE: Record<QuotaKind, string> = {
  shared_files: "You've reached the limit of {limit} files on the server. Delete or stop sharing a file to add another.",
  storage_bytes: "You've used your {limit} of server storage. Delete files or previews you no longer need.",
  uploads_per_day: "You've reached today's limit of {limit} uploads. Try again tomorrow.",
  previews: "You can have at most {limit} developer previews. Unpublish one first.",
  orgs_created: "You can create at most {limit} organizations.",
  invitations_per_day: "You've reached today's limit of {limit} invitations. Try again tomorrow.",
  comments_per_minute: "You're commenting too fast. Wait a minute and try again.",
  rest_calls_per_day: "You've reached today's limit of {limit} API calls.",
  signups_per_ip_per_day: "Too many new accounts were created today. Try again tomorrow.",
  signups_per_day: "Too many new accounts were created today. Try again tomorrow.",
  server_storage_bytes: "The server is out of storage. Try again later.",
};

/** `quotaText` in the UI's language */
export function quotaMessage(kind: QuotaKind, limit: number): string {
  const english = quotaText(kind, limit);
  const template = QUOTA_TEMPLATE[kind];
  if (!template) return english;
  const value = kind === "storage_bytes" || kind === "server_storage_bytes" ? formatBytes(limit) : String(limit);
  return template.replace("{limit}", value) === english ? t(template, { limit: value }) : english;
}

/** `ACCOUNT_SUSPENDED_TEXT` in the UI's language */
export const accountSuspendedMessage = (): string => t(ACCOUNT_SUSPENDED_TEXT);
