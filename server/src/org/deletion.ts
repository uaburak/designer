/**
 * Delete organization (docs/multiplayer.md §14.17). Figma deletes an organization through its support; ours is
 * Admin › Settings › Delete organization, for org admins, confirmed by typing the organization's name:
 *
 *   DELETE /orgs/:org {confirmName}   {org}   soft delete: hidden from its people (only its admins still list it, to
 *                                             restore it), its files read-only for whoever could open them, nothing
 *                                             created or changed in it; `purge_at` = now + 14 days (ours)
 *   POST   /orgs/:org/restore         {org}   back as it was, until `purge_at`
 *
 * The daily cron's `purgeDeletedOrgs` then deletes each org past its `purge_at` for good: every file (its room,
 * comments, branches, library, stored bytes), the org's fonts and icons (its FontObject, the `o:<orgId>:` stored
 * items), its governance logs, then the org row — which cascades to its teams, folders, people, groups, settings,
 * libraries' rows, plugins, tokens and activity log. Each person's quota is released with what they stored there.
 */
import { orgEntity, logActivity } from "../activity";
import type { Deps } from "../api";
import { notifyOrgDeleted, orgNotice } from "../notifications";
import type { OrgInfo } from "../../../src/shared/org/types";
import type { Access } from "./db";
import { body, HttpError, json, type Ctx } from "./http";
import { orgFileKeys, reauth } from "./reauth";

const DAY = 86_400_000;
/** How long a deleted organization can be restored (ours: Figma's support handles it; a deleted team's link is 28 days) */
export const ORG_DELETE_GRACE_MS = 14 * DAY;
/** Orgs deleted for good per cron run (each may hold many files: their rooms are deleted one by one) */
const PURGE_BATCH = 5;

export async function orgDeletionRoute(ctx: Ctx, orgId: string, info: (acc: Access, orgId: string) => Promise<OrgInfo>): Promise<Response> {
  const { parts, m, deps, user, acc } = ctx;
  // Gates (§2.5) don't stand between an admin and deleting or restoring
  const me = await acc.requireMember(orgId, { guests: true, gate: false, deleted: true });
  if (me.role !== "admin") throw new HttpError(403, "only organization admins can do that", "not_admin");
  const org = (await acc.org(orgId))!;
  const d1 = deps.db.d1;
  const people = async () => (await d1.prepare(`SELECT user_id FROM org_members WHERE org_id = ?1 AND user_id IS NOT NULL`).bind(orgId).all<{ user_id: string }>()).results.map((r) => r.user_id);

  if (parts.length === 2 && m === "DELETE") {
    if (org.deleted_at) throw new HttpError(409, "this organization is already deleted");
    const b = await body<{ confirmName?: unknown }>(ctx.req);
    if (typeof b.confirmName !== "string" || b.confirmName.trim() !== org.name.trim()) throw new HttpError(400, "type the organization’s name to delete it");
    const now = deps.now();
    const purgeAt = now + ORG_DELETE_GRACE_MS;
    await d1.prepare(`UPDATE orgs SET deleted_at = ?2, deleted_by = ?3, purge_at = ?4, updated_at = ?2 WHERE id = ?1`).bind(orgId, now, user.id, purgeAt).run();
    await logActivity(deps, { orgId, action: "org_delete", actor: user, entity: orgEntity(org), details: { purge_at: purgeAt }, req: ctx.req });
    acc.reset();
    // Open files go read-only at once (their sockets reconnect as viewers)
    await reauth(deps, await orgFileKeys(d1, orgId));
    const ids = await people();
    for (const userId of ids) await notifyOrgDeleted(deps, { userId, actorId: user.id, name: org.name, purgeAt });
    await orgNotice(deps, ids, { what: "orgs" });
    return json({ org: await info(acc, orgId) });
  }

  if (parts.length === 3 && parts[2] === "restore" && m === "POST") {
    if (!org.deleted_at) throw new HttpError(409, "this organization isn’t deleted");
    const now = deps.now();
    await d1.prepare(`UPDATE orgs SET deleted_at = NULL, deleted_by = NULL, purge_at = NULL, updated_at = ?2 WHERE id = ?1`).bind(orgId, now).run();
    await logActivity(deps, { orgId, action: "org_restore", actor: user, entity: orgEntity(org), req: ctx.req });
    acc.reset();
    await reauth(deps, await orgFileKeys(d1, orgId));
    await orgNotice(deps, await people(), { what: "orgs" });
    return json({ org: await info(acc, orgId) });
  }
  throw new HttpError(405, "method not allowed");
}

/** The daily cron: organizations past their `purge_at`, deleted for good (a few per run; the rest next day). */
export async function purgeDeletedOrgs(deps: Deps): Promise<string[]> {
  const d1 = deps.db.d1;
  const { results } = await d1.prepare(`SELECT id FROM orgs WHERE purge_at IS NOT NULL AND purge_at <= ?1 ORDER BY purge_at LIMIT ?2`).bind(deps.now(), PURGE_BATCH).all<{ id: string }>();
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
