/**
 * Webhooks V2's events (docs/multiplayer.md §16.9, §16.10): the server pieces outside `rest/` call `emitWebhook` when
 * something happens to a file. A stub before round 5: 5a fills it (find the hooks whose context reaches the file, queue
 * a delivery per hook, send through `waitUntil`); 5c calls it.
 */
import type { WebhookEvent } from "../../../src/shared/rest/types";
import type { Deps } from "../api";

export type WebhookEventInput = Exclude<WebhookEvent, { event_type: "PING" }>;

export async function emitWebhook(
  deps: Deps,
  event: WebhookEventInput,
  ctx: { fileKey: string; orgId: string | null; teamId: string | null; projectId: string | null },
  waitUntil: (p: Promise<unknown>) => void,
): Promise<void> {
  void deps;
  void event;
  void ctx;
  void waitUntil;
}
