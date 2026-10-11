/**
 * The room switches (docs/multiplayer.md §15.9) [F-chat, F-audio]: cursor chat and audio are enforced by the clients,
 * so the room carries the policy — the Worker adds `x-policy` to the socket upgrade it forwards (the room puts it in
 * `welcome.policy`), and on a change posts `POST /room/policy` to every room of the org's files (the room broadcasts
 * `{t: "policy", policy}`).
 */
import type { FilePolicy, RoomPolicy } from "../../../src/shared/org/identity";
import type { Deps } from "../api";

/** The room's part of a file's policy: absent outside orgs (= everything allowed) */
export const roomPolicyOf = (p: FilePolicy | null): RoomPolicy | undefined => (p ? { cursorChat: p.cursorChat, audio: p.audio } : undefined);

/** `x-policy`'s value (and `POST /room/policy`'s body) */
export const encodeRoomPolicy = (p: RoomPolicy): string => JSON.stringify({ cursorChat: p.cursorChat, audio: p.audio });

/** `x-policy` or `POST /room/policy`'s body, read by the room; null when absent or malformed */
export function parseRoomPolicy(v: unknown): RoomPolicy | null {
  let o = v;
  if (typeof v === "string") {
    try {
      o = JSON.parse(v);
    } catch {
      return null;
    }
  }
  if (!o || typeof o !== "object") return null;
  const { cursorChat, audio } = o as Record<string, unknown>;
  return typeof cursorChat === "boolean" && typeof audio === "boolean" ? { cursorChat, audio } : null;
}

/** `POST /room/policy` to every room of the org's files (inline, as reauth) */
export async function broadcastRoomPolicy(deps: Deps, orgId: string, policy: RoomPolicy): Promise<string[]> {
  const { results } = await deps.db.d1.prepare(`SELECT key FROM files WHERE org_id = ?1`).bind(orgId).all<{ key: string }>();
  const body = encodeRoomPolicy(policy);
  for (const { key } of results) {
    try {
      await deps.rooms.fetch(key, "/room/policy", { method: "POST", body });
    } catch (e) {
      console.error("room policy: room not told", key, e);
    }
  }
  return results.map((r) => r.key);
}
