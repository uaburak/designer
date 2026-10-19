/**
 * "Create organization" (docs/multiplayer.md §14.8), with or without "Import shared files":
 *   1. the org; the caller its admin on a Full seat, OrgSettings at defaults;
 *   2. with the import, a team "‹name›" (caller owner and admin, org access none, Visible) and in it a top-level folder
 *      "Shared files" (Inherited);
 *   3. every file the caller owns outside any org moves into that folder — rooms, keys, links, members, passwords,
 *      comments and notifications stay as they are;
 *   4. everyone with a grant on those files (pending emails included) joins the org as a **member** (the owner's
 *      decision, 2026-10-11), Full if they could edit any of them, else View;
 *   5. logged with `details.migrated: true`.
 *
 * As built: sequential statements, not one D1 batch (`D1Like` has no batch). A failure part-way leaves an org that
 * can be finished by hand; the import is run once, by the owner.
 */
import { DEFAULT_ORG_SETTINGS } from "../../../src/shared/org/types";
import { fileEntity, logActivity, projectEntity, teamEntity, userEntity } from "../activity";
import type { Ctx } from "./http";
import { randomId } from "./http";

export async function createOrg(ctx: Ctx, name: string, importSharedFiles: boolean): Promise<string> {
  const { deps, user, req } = ctx;
  const d1 = deps.db.d1;
  const now = deps.now();
  const orgId = randomId();
  await d1.prepare(`INSERT INTO orgs (id, name, settings, created_by, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)`).bind(orgId, name, JSON.stringify(DEFAULT_ORG_SETTINGS), user.id, now).run();
  await d1.prepare(`INSERT INTO org_members (org_id, email, user_id, role, seat, created_at, seat_changed_at) VALUES (?1, ?2, ?3, 'admin', 'full', ?4, ?4)`).bind(orgId, user.email, user.id, now).run();
  const migrated = importSharedFiles ? { migrated: true } : {};
  await logActivity(deps, { orgId, action: "org_user_create", actor: user, entity: userEntity(user), details: { role: "admin", seat: "full", ...migrated }, req });
  if (!importSharedFiles) return orgId;

  const teamId = randomId();
  await d1
    .prepare(`INSERT INTO teams (id, org_id, name, owner_id, org_access, visibility, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'none', 'visible', ?5, ?5)`)
    .bind(teamId, orgId, name, user.id, now)
    .run();
  await d1.prepare(`INSERT INTO team_members (team_id, email, user_id, role, admin, created_at) VALUES (?1, ?2, ?3, 'editor', 1, ?4)`).bind(teamId, user.email, user.id, now).run();
  await logActivity(deps, { orgId, action: "team_create", actor: user, entity: teamEntity({ id: teamId, name }), teamId, details: migrated, req });
  const projectId = randomId();
  await d1
    .prepare(`INSERT INTO projects (id, team_id, parent_id, depth, name, owner_id, access, created_at, updated_at) VALUES (?1, ?2, NULL, 1, 'Shared files', ?3, 'inherited', ?4, ?4)`)
    .bind(projectId, teamId, user.id, now)
    .run();
  await logActivity(deps, { orgId, action: "project_create", actor: user, entity: projectEntity({ id: projectId, name: "Shared files" }), teamId, details: migrated, req });

  const { placeBranchesWith: placeBranch } = await import("../branches");
  const { results: files } = await d1
    .prepare(`SELECT key, name, editor_type, link_access, proto_link_access FROM files WHERE owner_id = ?1 AND org_id IS NULL AND NOT EXISTS (SELECT 1 FROM branches b WHERE b.key = files.key)`)
    .bind(user.id)
    .all<{ key: string; name: string; editor_type: string; link_access: string; proto_link_access: string }>();
  // Seats by the best grant each person had on the files moved.
  const people = new Map<string, { userId: string | null; editor: boolean }>();
  for (const f of files) {
    await d1.prepare(`UPDATE files SET org_id = ?2, team_id = ?3, project_id = ?4 WHERE key = ?1`).bind(f.key, orgId, teamId, projectId).run();
    // Its branches come along (docs/data.md §15.7.1); they aren't files of their own here
    await placeBranch(d1, f.key);
    await logActivity(deps, { orgId, action: "fig_file_move", actor: user, entity: fileEntity(f), teamId, details: { ...migrated, to: projectId }, req });
    const { results: grants } = await d1.prepare(`SELECT email, user_id, role FROM members WHERE file_key = ?1`).bind(f.key).all<{ email: string; user_id: string | null; role: string }>();
    for (const g of grants) {
      const had = people.get(g.email);
      people.set(g.email, { userId: g.user_id ?? had?.userId ?? null, editor: (had?.editor ?? false) || g.role === "editor" });
    }
  }
  people.delete(user.email);
  for (const [email, p] of people) {
    const seat = p.editor ? "full" : "view";
    await d1
      .prepare(`INSERT INTO org_members (org_id, email, user_id, role, seat, invited_by, created_at, seat_changed_at) VALUES (?1, ?2, ?3, 'member', ?4, ?5, ?6, ?6) ON CONFLICT (org_id, email) DO NOTHING`)
      .bind(orgId, email, p.userId, seat, user.id, now)
      .run();
    const u = p.userId ? await d1.prepare(`SELECT id, email, name FROM users WHERE id = ?1`).bind(p.userId).first<{ id: string; email: string; name: string | null }>() : null;
    await logActivity(deps, { orgId, action: u ? "org_user_create" : "org_invite_create", actor: user, entity: userEntity(u ?? { id: email, email, name: null }), details: { role: "member", seat, ...migrated }, req });
  }
  return orgId;
}
