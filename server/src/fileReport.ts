/**
 * File settings (ours — Figma has no such screen; docs/home.md "File settings [ours]", docs/multiplayer.md §17): what
 * the server knows about one file, for Home's "File settings…" dialog.
 *
 *   GET /files/:key/report                                    can view   → FileServerReport
 *   GET /files/:key/activity?cursor=&limit=&kinds=a,b         can view   → FileActivityPage (newest first)
 *
 * Nothing new is stored: the report reads the file's row, its owner, its stored bytes (`stored_items` under
 * `f:<key>:` and its previews' `p:<id>:`), its branches, comments and previews, the org's activity log (org files) and
 * the room's version history. The log is put together from the same records — the org's audit rows where there are
 * any, else the file's creation and its invitations — with comments, branches, previews and versions for every file.
 */
import type { Deps } from "./api";
import type { User } from "./db";
import type { FileRow } from "./org/db";
import { HttpError } from "./org/http";
import { accountUsage } from "./quota/usage";
import { ACTIVITY_PAGE, FILE_ACTIVITY_KINDS, type FileActivityEvent, type FileActivityKind, type FileActivityPage, type FileServerReport, type StoragePart } from "../../src/shared/store/fileSettings";

/** The caller's access as `acc.file` gave it */
export interface ReportAccess {
  role: string;
  canManage: boolean;
  canShare: boolean;
}

const ROWS = 500;

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

export async function fileReportRoute(deps: Deps, f: FileRow, a: ReportAccess, user: User, parts: string[], m: string, url: URL): Promise<Response> {
  if (parts.length !== 3 || m !== "GET") throw new HttpError(405, "method not allowed");
  if (parts[2] === "report") return json(await fileReport(deps, f, a, user));
  const kinds = (url.searchParams.get("kinds") ?? "").split(",").filter((k): k is FileActivityKind => (FILE_ACTIVITY_KINDS as readonly string[]).includes(k));
  const cursor = Math.max(0, Math.floor(Number(url.searchParams.get("cursor")) || 0));
  const limit = Math.min(200, Math.max(1, Math.floor(Number(url.searchParams.get("limit")) || ACTIVITY_PAGE)));
  return json(pageOf(await fileActivity(deps, f, a, user), kinds, cursor, limit));
}

/** One page of the log: `cursor` is how many came before (the log is put together again on every call) */
export function pageOf(events: FileActivityEvent[], kinds: readonly FileActivityKind[], cursor: number, limit: number): FileActivityPage {
  const wanted = kinds.length ? events.filter((e) => kinds.includes(e.kind)) : events;
  const page = wanted.slice(cursor, cursor + limit);
  return { events: page, next: cursor + page.length < wanted.length ? cursor + page.length : null };
}

/** Which part of a file's bytes a `stored_items` row is (quota/quota.ts names them) */
export function storedKind(item: string): StoragePart["kind"] {
  const rest = item.slice(item.indexOf(":", 2) + 1);
  if (item.startsWith("p:")) return "previews";
  if (rest === "snap" || rest === "base") return "document";
  if (rest === "thumb") return "thumbnail";
  if (rest.startsWith("b:")) return "images";
  if (rest.startsWith("v:")) return "versions";
  return "other";
}

async function fileReport(deps: Deps, f: FileRow, a: ReportAccess, user: User): Promise<FileServerReport> {
  const d1 = deps.db.d1;
  const owner = await d1.prepare(`SELECT id, name, email, picture FROM users WHERE id = ?1`).bind(f.owner_id).first<{ id: string; name: string | null; email: string; picture: string | null }>();
  const place = f.org_id
    ? await d1
        .prepare(`SELECT (SELECT name FROM orgs WHERE id = ?1) AS org, (SELECT name FROM teams WHERE id = ?2) AS team, (SELECT name FROM projects WHERE id = ?3) AS project`)
        .bind(f.org_id, f.team_id, f.project_id)
        .first<{ org: string | null; team: string | null; project: string | null }>()
    : null;
  const previews = (await d1.prepare(`SELECT id FROM previews WHERE file_key = ?1 AND (expires_at IS NULL OR expires_at > ?2)`).bind(f.key, deps.now()).all<{ id: string }>()).results;
  const stored = (await d1.prepare(`SELECT item, bytes FROM stored_items WHERE item >= ?1 AND item < ?2`).bind(`f:${f.key}:`, `f:${f.key};`).all<{ item: string; bytes: number }>()).results;
  for (const p of previews) stored.push(...(await d1.prepare(`SELECT item, bytes FROM stored_items WHERE item >= ?1 AND item < ?2`).bind(`p:${p.id}:`, `p:${p.id};`).all<{ item: string; bytes: number }>()).results);
  const parts = new Map<StoragePart["kind"], StoragePart>();
  for (const s of stored) {
    const kind = storedKind(s.item);
    const p = parts.get(kind) ?? { kind, bytes: 0, count: 0 };
    p.bytes += s.bytes;
    p.count! += 1;
    parts.set(kind, p);
  }
  const storage: StoragePart[] = (["document", "images", "media", "versions", "previews", "thumbnail", "other"] as const)
    .map((kind) => parts.get(kind) ?? { kind, bytes: 0, count: 0 })
    .filter((p) => p.kind !== "other" || p.bytes > 0)
    .map((p) => (p.kind === "document" || p.kind === "thumbnail" ? { kind: p.kind, bytes: p.bytes } : p.kind === "previews" ? { ...p, count: previews.length } : p));
  const counts = await d1
    .prepare(
      `SELECT (SELECT COUNT(*) FROM branches WHERE main_key = ?1 AND status = 'active') AS branches,
         (SELECT COUNT(*) FROM comments WHERE file_key = ?1 AND id = thread_id) AS threads,
         (SELECT COUNT(*) FROM comments WHERE file_key = ?1 AND id = thread_id AND resolved_at IS NULL) AS open`,
    )
    .bind(f.key)
    .first<{ branches: number; threads: number; open: number }>();
  const versions = await roomVersions(deps, f.key, user);
  const lastEdit = versions.find((v) => v.editors?.length);
  const visitors = f.org_id
    ? (
        await d1
          .prepare(
            `SELECT l.actor_id AS userId, MAX(l.at) AS lastAt, COUNT(*) AS opens, u.name, u.email, u.picture FROM activity_log l JOIN users u ON u.id = l.actor_id
             WHERE l.org_id = ?1 AND l.entity_id = ?2 AND l.action IN ('fig_file_view', 'fig_file_view_external', 'fig_file_view_prototype') GROUP BY l.actor_id ORDER BY lastAt DESC LIMIT 50`,
          )
          .bind(f.org_id, f.key)
          .all<{ userId: string; lastAt: number; opens: number; name: string | null; email: string; picture: string | null }>()
      ).results
    : [];
  const usage = a.role === "owner" ? await accountUsage(deps, user) : null;
  return {
    key: f.key,
    name: f.name,
    owner: owner ? { id: owner.id, name: owner.name, email: owner.email, picture: owner.picture } : null,
    createdAt: f.created_at,
    updatedAt: f.updated_at,
    lastEditedBy: lastEdit ? editorNames(lastEdit) : null,
    role: a.role,
    place: { kind: f.org_id ? "org" : f.space === "personal" ? "drafts" : "shared", orgName: place?.org ?? null, teamName: place?.team ?? null, projectName: place?.project ?? null },
    storage,
    totalBytes: storage.reduce((n, p) => n + p.bytes, 0),
    versions: versions.length,
    branches: counts?.branches ?? 0,
    comments: { threads: counts?.threads ?? 0, open: counts?.open ?? 0 },
    previews: previews.length,
    visitors,
    quota: usage
      ? {
          storageBytes: usage.usage.storageBytes,
          storageLimit: usage.limits.storage_bytes,
          files: usage.usage.sharedFiles,
          filesLimit: usage.limits.shared_files,
          previews: usage.usage.previews,
          previewsLimit: usage.limits.previews,
        }
      : null,
  };
}

interface RoomVersion {
  id: string;
  kind: string;
  title: string | null;
  createdAt: number;
  libraryVersion?: number | null;
  editors?: { id: string; name: string | null }[];
}

const editorNames = (v: RoomVersion): string | null => (v.editors?.length ? v.editors.map((e) => e.name || e.id).join(", ") : null);

/** The room's version history (newest first); a room that doesn't answer has none to show */
async function roomVersions(deps: Deps, key: string, user: User): Promise<RoomVersion[]> {
  try {
    const res = await deps.rooms.fetch(key, "/room/versions", { method: "GET", identity: { userId: user.id, name: user.name, role: "viewer" } });
    if (!res.ok) return [];
    const body = (await res.json()) as { versions?: RoomVersion[] };
    return Array.isArray(body.versions) ? body.versions : [];
  } catch {
    return [];
  }
}

/** The audit log's file actions as the dialog's kinds and the action it names */
const AUDIT: Record<string, [FileActivityKind, string]> = {
  fig_file_create: ["created", "created"],
  fig_file_duplicate: ["created", "duplicated"],
  fig_file_rename: ["edited", "renamed"],
  fig_file_move: ["edited", "moved"],
  fig_file_trash: ["edited", "trashed"],
  fig_file_restore: ["edited", "untrashed"],
  fig_file_view: ["opened", "opened"],
  fig_file_view_external: ["opened", "opened"],
  fig_file_view_prototype: ["opened", "prototype"],
  fig_file_export: ["exported", "exported"],
  fig_file_save_as: ["exported", "saved-copy"],
  fig_file_member_add: ["access", "member-added"],
  fig_file_member_permission_change: ["access", "role-changed"],
  fig_file_member_remove: ["access", "member-removed"],
  fig_file_link_access_change: ["shared", "link-changed"],
  fig_file_link_expiration_change: ["shared", "link-expiry"],
  fig_file_proto_link_access_change: ["shared", "prototype-link"],
  fig_file_set_password: ["shared", "password-set"],
  fig_file_unset_password: ["shared", "password-removed"],
  fig_file_viewer_access_change: ["shared", "viewers-copy"],
};

const VERSION_KIND: Record<string, [FileActivityKind, string]> = {
  named: ["version", "named"],
  restore: ["restored", "restored"],
  publish: ["published", "published"],
  import: ["imported", "imported"],
  branch: ["branch", "branch-created"],
  merge: ["merged", "merged"],
  update: ["merged", "updated"],
  autosave: ["edited", "autosave"],
};

/** Everything the server can say about the file, newest first */
export async function fileActivity(deps: Deps, f: FileRow, a: ReportAccess, user: User): Promise<FileActivityEvent[]> {
  const d1 = deps.db.d1;
  const out: FileActivityEvent[] = [];
  const ev = (id: string, at: number, kind: FileActivityKind, action: string, actor: string | null, detail: string | null = null): FileActivityEvent => ({ id: `s:${id}`, at, kind, action, actor, detail, source: "server" });
  let audited = false;
  if (f.org_id) {
    const rows = (
      await d1
        .prepare(`SELECT id, at, action, actor_name, actor_email, details FROM activity_log WHERE org_id = ?1 AND entity_id = ?2 ORDER BY at DESC LIMIT ${ROWS}`)
        .bind(f.org_id, f.key)
        .all<{ id: number; at: number; action: string; actor_name: string | null; actor_email: string | null; details: string }>()
    ).results;
    for (const r of rows) {
      const map = AUDIT[r.action];
      if (!map) continue;
      audited = true;
      let details: Record<string, unknown> = {};
      try {
        details = JSON.parse(r.details) as Record<string, unknown>;
      } catch {
        // kept empty
      }
      // Who was given access and as what — people sharing it see; viewers see that it changed
      const who = a.canShare ? [details.email, details.role ?? details.to].filter((x): x is string => typeof x === "string").join(" · ") || null : null;
      out.push(ev(`a:${r.id}`, r.at, map[0], map[1], r.actor_name || r.actor_email, who));
    }
  }
  if (!audited) {
    // No audit rows (outside orgs): the file's creation and its invitations
    const owner = await d1.prepare(`SELECT name, email FROM users WHERE id = ?1`).bind(f.owner_id).first<{ name: string | null; email: string }>();
    out.push(ev("created", f.created_at, "created", "created", owner?.name || owner?.email || null));
    const members = (await d1.prepare(`SELECT m.email, m.role, m.created_at, u.name AS by FROM members m LEFT JOIN users u ON u.id = m.invited_by WHERE m.file_key = ?1 LIMIT ${ROWS}`).bind(f.key).all<{ email: string; role: string; created_at: number; by: string | null }>()).results;
    for (const m of members) out.push(ev(`m:${m.email}`, m.created_at, "access", "member-added", m.by, a.canShare ? `${m.email} · ${m.role}` : null));
  }
  const comments = (
    await d1
      .prepare(`SELECT c.id, c.thread_id, c.message, c.created_at, c.resolved_at, u.name, u.email FROM comments c JOIN users u ON u.id = c.user_id WHERE c.file_key = ?1 ORDER BY c.created_at DESC LIMIT ${ROWS}`)
      .bind(f.key)
      .all<{ id: string; thread_id: string; message: string; created_at: number; resolved_at: number | null; name: string | null; email: string }>()
  ).results;
  for (const c of comments) {
    const text = c.message.length > 80 ? `${c.message.slice(0, 79)}…` : c.message;
    out.push(ev(`c:${c.id}`, c.created_at, "comment", c.id === c.thread_id ? "comment" : "reply", c.name || c.email, text));
    if (c.id === c.thread_id && c.resolved_at) out.push(ev(`r:${c.id}`, c.resolved_at, "comment", "resolved", null, text));
  }
  const branches = (
    await d1
      .prepare(`SELECT b.key, b.name, b.created_at, b.merged_at, u.name AS by, m.name AS merger FROM branches b LEFT JOIN users u ON u.id = b.created_by LEFT JOIN users m ON m.id = b.merged_by WHERE b.main_key = ?1 LIMIT ${ROWS}`)
      .bind(f.key)
      .all<{ key: string; name: string; created_at: number; merged_at: number | null; by: string | null; merger: string | null }>()
  ).results;
  for (const b of branches) {
    out.push(ev(`b:${b.key}`, b.created_at, "branch", "branch-created", b.by, b.name));
    if (b.merged_at) out.push(ev(`bm:${b.key}`, b.merged_at, "merged", "merged", b.merger, b.name));
  }
  const previews = (await d1.prepare(`SELECT id, published_at FROM previews WHERE file_key = ?1 AND published_at IS NOT NULL LIMIT ${ROWS}`).bind(f.key).all<{ id: string; published_at: number }>()).results;
  for (const p of previews) out.push(ev(`p:${p.id}`, p.published_at, "preview", "preview", null));
  for (const v of await roomVersions(deps, f.key, user)) {
    const map = VERSION_KIND[v.kind];
    // The branch's own "Branch created" / "Branch merged" versions are said by the branches above
    if (!map || v.kind === "branch" || v.kind === "merge") continue;
    out.push(ev(`v:${v.id}`, v.createdAt, map[0], map[1], editorNames(v), v.title || (v.kind === "publish" && v.libraryVersion != null ? `v${v.libraryVersion}` : null)));
  }
  return out.sort((x, y) => y.at - x.at || x.id.localeCompare(y.id));
}
