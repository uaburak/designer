/**
 * Changes that can lower someone's access end with a reauthorization (docs/multiplayer.md §14.9): the affected rooms
 * close those users' sockets (everyone's, when no users are named) with 4003, the clients reconnect and the Worker
 * resolves their role again. Raising access needs nothing.
 *
 * As built: every room is told inline (Deps has no `ctx.waitUntil`; a few people, a few hundred files at most).
 */
import type { Deps } from "../api";
import type { D1Like } from "../db";
import { subtree } from "./db";

export async function reauth(deps: Deps, keys: Iterable<string>, userIds?: string[]): Promise<void> {
  if (userIds && !userIds.length) return;
  const body = JSON.stringify(userIds ? { userIds } : {});
  for (const key of new Set(keys)) {
    try {
      await deps.rooms.fetch(key, "/room/reauth", { method: "POST", body });
    } catch (e) {
      console.error("reauth: room not told", key, e);
    }
  }
}

const keysOf = async (d1: D1Like, sql: string, ...args: unknown[]) => (await d1.prepare(sql).bind(...args).all<{ key: string }>()).results.map((r) => r.key);

export const orgFileKeys = (d1: D1Like, orgId: string) => keysOf(d1, `SELECT key FROM files WHERE org_id = ?1`, orgId);
export const teamFileKeys = (d1: D1Like, teamId: string) => keysOf(d1, `SELECT key FROM files WHERE team_id = ?1`, teamId);

export async function subtreeFileKeys(d1: D1Like, projectId: string): Promise<string[]> {
  const ids = (await subtree(d1, projectId)).map((p) => p.id);
  const out: string[] = [];
  for (const id of ids) out.push(...(await keysOf(d1, `SELECT key FROM files WHERE project_id = ?1`, id)));
  return out;
}
