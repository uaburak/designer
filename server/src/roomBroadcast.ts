/**
 * Non-stored notices to everyone in a file's room (`POST /room/broadcast {t, …}`): something about the file that lives
 * outside its document changed, and open copies read it again. Kinds: `dev-resources` (docs/editor.md D-3) and
 * `code-connect` (D-1). Never fails the write that raised it.
 */
import type { Deps } from "./api";

export const BROADCAST_KINDS = ["dev-resources", "code-connect"] as const;
export type BroadcastKind = (typeof BROADCAST_KINDS)[number];

export async function roomBroadcast(deps: Deps, fileKey: string, t: BroadcastKind, extra: Record<string, unknown> = {}): Promise<void> {
  try {
    await deps.rooms.fetch(fileKey, "/room/broadcast", { method: "POST", body: JSON.stringify({ ...extra, t }) });
  } catch (e) {
    console.error("room broadcast failed", fileKey, t, e);
  }
}
