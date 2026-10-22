/** A failed library publish in words, and whether it offers Retry (the Publish dialog's and the background run's). */
import { t } from "@/i18n";

/** A failed publish, in words (the store's codes; an org library's server refusals come as `forbidden` with their code). */
export function publishErrorText(e: unknown): string {
  const code = (e as { code?: string }).code;
  const detail = ((e as { detail?: { code?: string } }).detail ?? {}).code;
  if (code === "draft-cannot-publish" || detail === "draft_cannot_publish") return t("Move this file to a folder to publish it");
  if (code === "branch-cannot-publish" || detail === "branch_cannot_publish") return t("Libraries can only be published from the main file");
  if (detail === "seat_required") return t("You need a Full seat to publish a library");
  if (code === "conflict") return t("Someone else published this library. Review the changes and publish again");
  if (code === "offline") return t("You're offline. Publish again when you're back online");
  // Figma's `publish_failed {reason: payload_too_large}` (HTTP 413).
  if (code === "too-large") return t("The library couldn't be published: it's too large");
  return t("The library couldn't be published");
}

/**
 * Which failures offer Retry (atlas 12 §3.8: Figma's offline `cant_publish` and its generic and partial errors do; a
 * file that can't publish, a seat, a conflict or a payload too large don't — retrying wouldn't change them).
 */
export function publishRetryable(e: unknown): boolean {
  const code = (e as { code?: string }).code;
  const detail = ((e as { detail?: { code?: string } }).detail ?? {}).code;
  if (detail === "draft_cannot_publish" || detail === "branch_cannot_publish" || detail === "seat_required") return false;
  return !["draft-cannot-publish", "branch-cannot-publish", "conflict", "too-large", "forbidden", "read-only"].includes(code ?? "");
}
