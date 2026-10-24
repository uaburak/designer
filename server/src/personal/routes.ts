/**
 * Personal Drafts on the server (docs/cloud.md §2, Wecra 1.1): every account's Drafts are files with `org_id` NULL,
 * `owner_id` the person and `space = 'personal'` (migration 0023). Figma's personal Drafts are flat — no folders.
 *
 *   GET  /me/drafts[?trashed=1]          the caller's drafts (or their trash), newest change first; branches left out
 *   POST /me/drafts {key?, name?}         a new draft: its row (the client uploads its document next, as a share does)
 *   PATCH /files/:key {space}             "personal" — an org draft its owner takes back to their Drafts;
 *                                         {orgId, projectId|null} — a draft into an org's folder or the owner's org drafts
 *
 * Rename, trash, restore and delete forever are the file routes' (api.ts): for a personal draft only its owner.
 * Trashed drafts are deleted for good after 30 days by the daily cron (`purgePersonalTrash`), as Figma's trash.
 */
import type { Deps } from "../api";
import type { Caller } from "../account";
import { HttpError, json, body as readBody, randomId, type Ctx } from "../org/http";
import { Access, type FileRow } from "../org/db";
import { reauth } from "../org/reauth";
import { requireActive, requireFileSlot } from "../quota/quota";
import type { PersonalFile } from "../../../src/shared/store/cloud";

/** Figma keeps a trashed file 30 days */
export const PERSONAL_TRASH_DAYS = 30;
const DAY = 86_400_000;
const FILE_KEY = /^[A-Za-z0-9_-]{6,64}$/;
/** Files purged per cron run (each is a room call and a few rows) */
const PURGE_BATCH = 200;

interface DraftRow {
  key: string;
  name: string;
  editor_type: string;
  created_at: number;
  updated_at: number;
  trashed_at: number | null;
}

const draftOf = (r: DraftRow): PersonalFile => ({
  key: r.key,
  name: r.name,
  editorType: r.editor_type === "design" ? "design" : (r.editor_type as PersonalFile["editorType"]),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  trashedAt: r.trashed_at,
});

/** `/me/drafts…` (sessions only: a personal access token reads files through the REST API) */
export async function personalRoute(req: Request, url: URL, deps: Deps, caller: Caller, parts: string[]): Promise<Response> {
  if (caller.scopes) throw new HttpError(403, "a personal access token can't do that");
  const user = caller.user;
  const m = req.method;
  if (parts.length !== 2) throw new HttpError(404, "not found");
  if (m === "GET") {
    const trashed = url.searchParams.get("trashed") === "1";
    const { results } = await deps.db.d1
      .prepare(
        `SELECT f.key, f.name, f.editor_type, f.created_at, f.updated_at, f.trashed_at FROM files f
         WHERE f.owner_id = ?1 AND f.space = 'personal' AND f.org_id IS NULL AND f.trashed_at IS ${trashed ? "NOT NULL" : "NULL"}
           AND NOT EXISTS (SELECT 1 FROM branches b WHERE b.key = f.key)
         ORDER BY ${trashed ? "f.trashed_at" : "f.updated_at"} DESC`,
      )
      .bind(user.id)
      .all<DraftRow>();
    return json({ files: results.map(draftOf) });
  }
  if (m === "POST") {
    const b = await readBody<{ key?: unknown; name?: unknown; editorType?: unknown }>(req);
    const key = b.key === undefined ? `d${randomId(21)}` : typeof b.key === "string" ? b.key : "";
    if (!FILE_KEY.test(key)) throw new HttpError(400, "bad file key");
    // A Social file (Figma's Buzz, docs/social.md §18) is a draft of its own kind, kept on the server (§27)
    if (b.editorType !== undefined && b.editorType !== "design" && b.editorType !== "buzz") throw new HttpError(400, "editorType: personal drafts are design or buzz files");
    const editorType = b.editorType === "buzz" ? "buzz" : "design";
    const name = typeof b.name === "string" && b.name.trim() ? b.name.trim().slice(0, 200) : "Untitled";
    requireActive(user);
    // A member whose org restricts external content creates files there only (docs/multiplayer.md §15.6, §15.9).
    (await import("../policy/external")).requireInside(await new Access(deps, user).home(), null, "create files");
    const had = await deps.db.d1.prepare(`SELECT owner_id, org_id, space FROM files WHERE key = ?1`).bind(key).first<{ owner_id: string; org_id: string | null; space: string | null }>();
    if (had) {
      // Registering again after a lost answer (the store retries): the same draft answers again
      if (had.owner_id !== user.id || had.org_id !== null) throw new HttpError(409, "file key taken");
      if (had.space !== "personal") await deps.db.d1.prepare(`UPDATE files SET space = 'personal' WHERE key = ?1`).bind(key).run();
    } else {
      await requireFileSlot(deps, user);
      const now = deps.now();
      await deps.db.d1
        .prepare(`INSERT INTO files (key, owner_id, name, created_at, updated_at, space, editor_type) VALUES (?1, ?2, ?3, ?4, ?4, 'personal', ?5) ON CONFLICT (key) DO NOTHING`)
        .bind(key, user.id, name, now, editorType)
        .run();
    }
    const row = await deps.db.d1.prepare(`SELECT key, name, editor_type, created_at, updated_at, trashed_at FROM files WHERE key = ?1 AND owner_id = ?2`).bind(key, user.id).first<DraftRow>();
    if (!row) throw new HttpError(409, "file key taken");
    return json({ key, name: row.name, role: "owner", file: draftOf(row) }, had ? 200 : 201);
  }
  throw new HttpError(405, "method not allowed");
}

/**
 * `PATCH /files/:key {space}` (docs/cloud.md §2): between the owner's Drafts and an organization. Into an org it is
 * Home's "Move to…" (the org's `createOrgFile` moves the row in, its checks and log included); out of one, only the
 * file's owner takes a draft of theirs (no folder) back to their personal Drafts.
 */
export async function patchSpace(ctx: Ctx, f: FileRow, space: unknown): Promise<Response> {
  const { deps, user } = ctx;
  if (space === "personal") {
    if (f.space === "personal") return json({ ok: true, space: "personal" });
    if (f.owner_id !== user.id) throw new HttpError(403, "only the owner can move a file to their drafts");
    if (f.org_id === null) {
      await deps.db.d1.prepare(`UPDATE files SET space = 'personal', updated_at = ?2 WHERE key = ?1`).bind(f.key, deps.now()).run();
      return json({ ok: true, space: "personal" });
    }
    if (f.project_id !== null) throw new HttpError(400, "move the file to your drafts in the organization first");
    if ((await ctx.acc.branch(f.key)) !== null) throw new HttpError(400, "a branch stays with its main file");
    await deps.db.d1
      .prepare(`UPDATE files SET org_id = NULL, team_id = NULL, project_id = NULL, access = 'inherited', org_link_access = 'none', proto_org_link_access = 'none', space = 'personal', updated_at = ?2 WHERE key = ?1`)
      .bind(f.key, deps.now())
      .run();
    const { logActivity, fileEntity } = await import("../activity");
    await logActivity(deps, { orgId: f.org_id, action: "fig_file_move", actor: user, entity: fileEntity(f), teamId: f.team_id, details: { from: f.project_id, to: "personal" }, req: ctx.req });
    await reauth(deps, [f.key]);
    return json({ ok: true, space: "personal" });
  }
  if (space && typeof space === "object" && typeof (space as { orgId?: unknown }).orgId === "string") {
    const s = space as { orgId: string; projectId?: unknown };
    const projectId = typeof s.projectId === "string" ? s.projectId : null;
    if (f.org_id !== null) throw new HttpError(400, "the file is in an organization already; move it within it");
    if (f.owner_id !== user.id) throw new HttpError(403, "only the owner can move a file into an organization");
    const file = await (await import("../org/orgs")).createOrgFile(ctx, { key: f.key, name: f.name, orgId: s.orgId, projectId, editorType: f.editor_type });
    return json({ ok: true, space: { orgId: s.orgId, projectId }, file });
  }
  throw new HttpError(400, `space is "personal" or {orgId, projectId}`);
}

/** The daily cron: personal drafts in the trash for more than 30 days are deleted for good — room, rows, branches. */
export async function purgePersonalTrash(deps: Deps): Promise<number> {
  const before = deps.now() - PERSONAL_TRASH_DAYS * DAY;
  const { results } = await deps.db.d1
    .prepare(`SELECT key FROM files WHERE space = 'personal' AND org_id IS NULL AND trashed_at IS NOT NULL AND trashed_at < ?1 LIMIT ?2`)
    .bind(before, PURGE_BATCH)
    .all<{ key: string }>();
  const { deleteBranchesOf } = await import("../branches");
  let n = 0;
  for (const { key } of results) {
    try {
      await deleteBranchesOf(deps, key);
      await deps.rooms.fetch(key, "/room", { method: "DELETE" });
      await deps.db.deleteFile(key);
      n++;
    } catch (e) {
      console.error(`personal trash: couldn't delete ${key}`, e);
    }
  }
  return n;
}
