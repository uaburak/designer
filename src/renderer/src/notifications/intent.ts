/**
 * Where a notification row opens its file (docs/multiplayer.md §12, docs/editor.md D-4): a comment at its thread; a Dev
 * Mode status row in Dev Mode on the ready-for-dev view (`OpenIntent.devMode = "ready"`, as the desktop notification's
 * `designer://open?…&m=dev&dev=ready` link); anything else the file as it opens.
 */
import { isCommentKind, isDevStatusKind, type NotificationItem } from "@shared/notifications";
import type { OpenIntent } from "@shared/multiplayer/types";

export function notificationIntent(n: Pick<NotificationItem, "kind" | "threadId">): OpenIntent {
  if (isDevStatusKind(n.kind)) return { mode: "dev", devMode: "ready" };
  if (isCommentKind(n.kind) && n.threadId) return { commentId: n.threadId };
  return {};
}
