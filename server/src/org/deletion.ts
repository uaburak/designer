/**
 * Delete organization (docs/multiplayer.md §14.17). Figma deletes an organization through its support; ours is
 * Admin › Settings › Delete organization, for org admins, confirmed by typing the organization's name:
 *
 *   DELETE /orgs/:org {confirmName}   204   deleted for good at once (the owner's call, 2026-10-26: no grace period,
 *                                           nothing left taking space on the server)
 *
 * The org is first marked deleted (hidden from everyone, its files read-only, every route 404), its people told, then
 * `purgeOrg` deletes it after the answer: every file (its room, comments, branches, library, stored bytes), the org's
 * fonts and icons (its FontObject, the `o:<orgId>:` stored items), its governance logs, then the org row — which
 * cascades to its teams, folders, people, groups, settings, libraries' rows, plugins, tokens and activity log. Each
 * person's quota is released with what they stored there. A purge cut short is finished by the 5-minute cron.
 */
import { orgEntity, logActivity } from "../activity";
import type { Deps } from "../api";
import { notifyOrgDeleted, orgNotice } from "../notifications";
import { body, HttpError, noContent, type Ctx } from "./http";
import { orgFileKeys, reauth } from "./reauth";

/** Orgs deleted for good per cron run (each may hold many files: their rooms are deleted one by one) */
const PURGE_BATCH = 5;

export async function orgDeletionRoute(ctx: Ctx, orgId: string): Promise<Response> {
  const { parts, m, deps, user, acc } = ctx;
  if (parts.length !== 2 || m !== "DELETE") throw new HttpError(405, "method not allowed");
  // Gates (§2.5) don't stand between an admin and deleting
  const me = await acc.requireMember(orgId, { guests: true, gate: false, deleted: true });
  if (me.role !== "admin") throw new HttpError(403, "only organization admins can do that", "not_admin");
  const org = (await acc.org(orgId))!;
  if (org.deleted_at) throw new HttpError(409, "this organization is already deleted");
  const b = await body<{ confirmName?: unknown }>(ctx.req);
  if (typeof b.confirmName !== "string" || b.confirmName.trim() !== org.name.trim()) throw new HttpError(400, "type the organization’s name to delete it");
  const d1 = deps.db.d1;
  const now = deps.now();
  await d1.prepare(`UPDATE orgs SET deleted_at = ?2, deleted_by = ?3, purge_at = ?2, updated_at = ?2 WHERE id = ?1`).bind(orgId, now, user.id).run();
  await logActivity(deps, { orgId, action: "org_delete", actor: user, entity: orgEntity(org), details: { purge_at: now }, req: ctx.req });
  acc.reset();
  // Open files go read-only at once (their sockets reconnect as viewers), until the purge closes their rooms
  await reauth(deps, await orgFileKeys(d1, orgId));
  const ids = (await d1.prepare(`SELECT user_id FROM org_members WHERE org_id = ?1 AND user_id IS NOT NULL`).bind(orgId).all<{ user_id: string }>()).results.map((r) => r.user_id);
  for (const userId of ids) await notifyOrgDeleted(deps, { userId, actorId: user.id, name: org.name, purgeAt: now });
  await orgNotice(deps, ids, { what: "orgs" });
  const purge = purgeOrg(deps, orgId).catch((e: unknown) => console.error("orgs: a deleted organization wasn't purged; the cron finishes it", orgId, e));
  if (deps.waitUntil) deps.waitUntil(purge);
  else await purge;
  return noContent();
}

/** The 5-minute cron: deleted organizations a purge didn't finish (and those deleted before purges were immediate). */
export async function purgeDeletedOrgs(deps: Deps): Promise<string[]> {
  const d1 = deps.db.d1;
  const { results } = await d1.prepare(`SELECT id FROM orgs WHERE deleted_at IS NOT NULL ORDER BY deleted_at LIMIT ?1`).bind(PURGE_BATCH).all<{ id: string }>();
  const done: string[] = [];
  for (const { id } of results) {
    try {
      await purgeOrg(deps, id);
      done.push(id);
    } catch (e) {
      console.error("orgs: a deleted organization wasn't purged", id, e);
    }
  }
  return done;
}

/** One organization deleted for good (see the header). */
export async function purgeOrg(deps: Deps, orgId: string): Promise<void> {
  const d1 = deps.db.d1;
  const { deleteFileForever } = await import("./projects");
  const { deleteBranchesOf } = await import("../branches");
  const ctx = { deps, acc: { d1 } };
  // Files first: files.org_id / team_id / project_id don't cascade
  const { results } = await d1.prepare(`SELECT key FROM files WHERE org_id = ?1`).bind(orgId).all<{ key: string }>();
  for (const { key } of results) {
    await deleteBranchesOf(deps, key);
    await deleteFileForever(ctx, key);
  }
  // Fonts and icons live in the org's FontObject; their bytes were charged as o:<orgId>:…
  try {
    const { fontObjects, objectFetch } = await import("../libraries/db");
    if (fontObjects(deps)) await objectFetch(fontObjects(deps), orgId, "/delete", { method: "POST" });
  } catch (e) {
    console.error("orgs: a deleted organization's fonts object wasn't emptied", orgId, e);
  }
  const { releaseStorage } = await import("../quota/quota");
  await releaseStorage(d1, `o:${orgId}:`);
  // Tables without a foreign key to the org
  await d1.prepare(`DELETE FROM discovery_events WHERE org_id = ?1`).bind(orgId).run();
  await d1.prepare(`DELETE FROM developer_logs WHERE org_id = ?1`).bind(orgId).run();
  await d1.prepare(`DELETE FROM orgs WHERE id = ?1`).bind(orgId).run();
}
