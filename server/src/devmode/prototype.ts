/**
 * Prototype-only access (docs/editor.md D-6; D1 `prototype_members` and `files.proto_org_link_access`, migration 0015).
 * The level itself is resolveAccess's (src/shared/org/access.ts, `prototypeOnly`); here are the invitations from Share
 * prototype and what a prototype-only caller may reach on the file's routes.
 *
 *   GET    /files/:key/prototype-members          → {members: {email, userId, name}[]}
 *   PUT    /files/:key/prototype-members {email}  → {ok}   (201 when new)
 *   DELETE /files/:key/prototype-members/:email   → 204
 *
 * Who: people who can share the file (its editors in orgs, the owner outside them) and those who manage it. An
 * invitee with an account is told ("invite", as viewer); removing one reconnects their sockets (resolved again).
 */
import type { AccessResult } from "../../../src/shared/org/access";
import type { Deps } from "../api";
import { normalizeEmail, type User } from "../db";
import { notifyInvite } from "../notifications";
import { userByEmail, type FileRow } from "../org/db";
import { body, EMAIL, HttpError, noContent } from "../org/http";
import { json, logDev } from "./common";

/**
 * The file routes a prototype-only caller reaches (api.ts guards the rest): the file's info, the unlock, the document
 * (snapshot, images, the socket — the room treats them as viewers), comments, and the client-reported activity
 * (fig_file_view_prototype, exports by `viewers_can_copy`).
 */
export function prototypeOpen(parts: readonly string[], method: string): boolean {
  if (parts.length === 2) return method === "GET";
  return parts[2] === "unlock" || parts[2] === "snapshot" || parts[2] === "blobs" || parts[2] === "comments" || parts[2] === "ws" || parts[2] === "activity";
}

const canInvite = (a: AccessResult, inOrg: boolean): boolean => a.ok && !a.trashed && !a.prototypeOnly && (inOrg ? a.canShare || a.canManage : a.canManage || a.canShare);

export async function prototypeMembersRoute(req: Request, deps: Deps, user: User, parts: string[], f: FileRow, a: AccessResult): Promise<Response> {
  const m = req.method;
  const d1 = deps.db.d1;
  if (!a.ok) throw new HttpError(404, "no such file");
  if (!canInvite(a, f.org_id !== null)) throw new HttpError(403, "only people who can share the file can invite to its prototype");
  if (parts.length === 3 && m === "GET") {
    const { results } = await d1
      .prepare(`SELECT p.email, COALESCE(p.user_id, u.id) AS user_id, u.name FROM prototype_members p LEFT JOIN users u ON u.id = p.user_id OR (p.user_id IS NULL AND u.email = p.email) WHERE p.file_key = ?1 ORDER BY p.created_at`)
      .bind(f.key)
      .all<{ email: string; user_id: string | null; name: string | null }>();
    const seen = new Set<string>();
    return json({ members: results.filter((r) => !seen.has(r.email) && seen.add(r.email)).map((r) => ({ email: r.email, userId: r.user_id, name: r.name })) });
  }
  if (parts.length === 3 && m === "PUT") {
    const b = await body<{ email?: unknown }>(req);
    const email = normalizeEmail(typeof b.email === "string" ? b.email : "");
    if (!EMAIL.test(email)) throw new HttpError(400, "bad email");
    const invitee = await userByEmail(d1, email);
    const r = await d1
      .prepare(`INSERT INTO prototype_members (file_key, email, user_id, invited_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT (file_key, email) DO NOTHING RETURNING email`)
      .bind(f.key, email, invitee?.id ?? null, user.id, deps.now())
      .first();
    if (r) {
      if (invitee && invitee.id !== user.id) await notifyInvite(deps, { key: f.key, by: user, userId: invitee.id, role: "viewer" });
      await logDev(deps, f, user, "fig_file_member_add", { email, user_id: invitee?.id ?? null, role: "prototype" }, req);
    }
    return json({ ok: true }, r ? 201 : 200);
  }
  if (parts.length === 4 && m === "DELETE") {
    const email = normalizeEmail(parts[3]);
    const r = await d1.prepare(`DELETE FROM prototype_members WHERE file_key = ?1 AND email = ?2 RETURNING user_id`).bind(f.key, email).first<{ user_id: string | null }>();
    if (r) {
      const id = r.user_id ?? (await userByEmail(d1, email))?.id ?? null;
      if (id) await deps.rooms.fetch(f.key, "/room/revoke", { method: "POST", body: JSON.stringify({ userId: id }) });
      await logDev(deps, f, user, "fig_file_member_remove", { email, user_id: id, role: "prototype" }, req);
    }
    return noContent();
  }
  throw new HttpError(405, "method not allowed");
}

/** PATCH /files/:key `protoOrgLinkAccess` (org files): the org's members with the prototype link */
export async function patchProtoOrgLink(deps: Deps, f: FileRow, value: unknown, log: (details: Record<string, unknown>) => Promise<void>): Promise<boolean> {
  if (!f.org_id) throw new HttpError(400, "protoOrgLinkAccess applies to files in an organization");
  if (value !== "none" && value !== "viewer") throw new HttpError(400, "protoOrgLinkAccess is none or viewer");
  await deps.db.d1.prepare(`UPDATE files SET proto_org_link_access = ?2, updated_at = ?3 WHERE key = ?1`).bind(f.key, value, deps.now()).run();
  await log({ link: "org", from: f.proto_org_link_access, to: value });
  return value === "none";
}
