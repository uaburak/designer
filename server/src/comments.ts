/**
 * Comments on a shared file (docs/multiplayer.md §10; migration 0006). Everyone with access reads and comments —
 * "can view" too, as in Figma; a comment is edited and deleted only by its author (R14 §permissions);
 * a thread is resolved / reopened by its author or anyone who can edit; its pin is moved by the same people. Every
 * change tells the people in the file through its room (`/room/comments`), and they read the list again.
 *
 *   GET    /files/:key/comments                        the threads, as the caller sees them (read marks)
 *   POST   /files/:key/comments                        {id?, threadId?, message, mentions?, anchor?, messageMeta?}
 *   PATCH  /files/:key/comments/:id                    {message?, mentions?, messageMeta?, resolved?, anchor?}
 *   DELETE /files/:key/comments/:id
 *   PUT    /files/:key/comments/:id/reactions          {emoji}       DELETE … ?emoji=
 *   POST   /files/:key/comments/read                   {threadIds, read}
 *
 * Every answer is the whole list, `{threads, me, canResolveAny, canDeleteAny}`.
 *
 * Rich text (Phase 6, migration 0028; docs/multiplayer.md §18.8): `messageMeta` — Figma's `message_meta` segments — is
 * kept beside the plain `message` when it says more than it; a message edited without it goes back to plain text.
 *
 * Discovery (docs/governance.md §2.11): each change's text — a comment posted, edited or deleted, a reaction added or
 * removed — is recorded with the room notice (`changed`), after the answer; nothing for orgs without Discovery.
 */
import type { Role } from "../../src/shared/multiplayer/protocol";
import { buildThreads, cleanSegments, COMMENT_ID, commentLength, MAX_COMMENT_LENGTH, type Comment, type CommentAnchor, type CommentSegment, type CommentUser } from "../../src/shared/comments";
import type { Deps } from "./api";
import type { User } from "./db";
import { forgetComments, notifyComment, notifyReaction } from "./notifications";
import { randomToken } from "./tokens";
import { recordFileText, type FileText } from "./discovery/record";

export interface CommentsContext {
  key: string;
  role: Role;
  user: User;
  /** The path's parts: ["files", key, "comments", …] */
  parts: string[];
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
const fail = (status: number, error: string) => json({ error }, status);

interface Row {
  id: string;
  thread_id: string;
  user_id: string;
  message: string;
  mentions: string;
  number: number | null;
  page_id: string | null;
  x: number | null;
  y: number | null;
  node_id: string | null;
  offset_x: number | null;
  offset_y: number | null;
  time_ms: number | null;
  message_meta?: string | null;
  created_at: number;
  edited_at: number | null;
  resolved_at: number | null;
  resolved_by: string | null;
  u_name: string | null;
  u_email: string;
  u_picture: string | null;
  r_name: string | null;
  r_email: string | null;
}

const person = (id: string, name: string | null, email: string | null, picture: string | null = null): CommentUser => ({ id, name: name || email || "Someone", email, picture });

export async function commentsRoute(req: Request, deps: Deps, ctx: CommentsContext): Promise<Response> {
  const { parts, key, user, role } = ctx;
  const m = req.method;
  const d1 = deps.db.d1;
  const editor = role !== "viewer";

  const list = async (): Promise<Response> => {
    const { results } = await d1
      .prepare(
        `SELECT c.*, u.name AS u_name, u.email AS u_email, u.picture AS u_picture, r.name AS r_name, r.email AS r_email
         FROM comments c JOIN users u ON u.id = c.user_id LEFT JOIN users r ON r.id = c.resolved_by
         WHERE c.file_key = ?1 ORDER BY c.created_at, c.id`,
      )
      .bind(key)
      .all<Row>();
    const { results: reactions } = await d1
      .prepare(
        `SELECT x.comment_id, x.emoji, x.created_at, u.id, u.name, u.email FROM comment_reactions x JOIN comments c ON c.id = x.comment_id
         JOIN users u ON u.id = x.user_id WHERE c.file_key = ?1 ORDER BY x.created_at, x.rowid`,
      )
      .bind(key)
      .all<{ comment_id: string; emoji: string; created_at: number; id: string; name: string | null; email: string }>();
    const { results: reads } = await d1
      .prepare(`SELECT r.thread_id, r.read_at FROM comment_reads r JOIN comments c ON c.id = r.thread_id WHERE c.file_key = ?1 AND r.user_id = ?2`)
      .bind(key, user.id)
      .all<{ thread_id: string; read_at: number }>();
    const byComment = new Map<string, Comment["reactions"]>();
    for (const r of reactions) {
      const list = byComment.get(r.comment_id) ?? [];
      let entry = list.find((e) => e.emoji === r.emoji);
      if (!entry) list.push((entry = { emoji: r.emoji, users: [], createdAt: r.created_at }));
      entry.users.push(person(r.id, r.name, r.email));
      byComment.set(r.comment_id, list);
    }
    const rows = results.map((r) => ({
      comment: {
        id: r.id,
        threadId: r.thread_id,
        parentId: r.thread_id === r.id ? null : r.thread_id,
        user: person(r.user_id, r.u_name, r.u_email, r.u_picture),
        message: r.message,
        mentions: parseMentions(r.mentions),
        createdAt: r.created_at,
        editedAt: r.edited_at,
        reactions: byComment.get(r.id) ?? [],
        ...metaOf(r.message_meta),
      } satisfies Comment,
      number: r.number ?? 0,
      anchor: r.page_id !== null ? anchorOf(r) : null,
      resolvedAt: r.resolved_at,
      resolvedBy: r.resolved_by ? person(r.resolved_by, r.r_name, r.r_email) : null,
    }));
    const readMap = Object.fromEntries(reads.map((r) => [r.thread_id, r.read_at]));
    return json({ threads: buildThreads(rows, readMap, user.id), me: person(user.id, user.name, user.email, user.picture), canResolveAny: editor, canDeleteAny: false });
  };

  /** Discovery's texts of this change (`changed` records them) */
  const disc: FileText[] = [];
  const changed = async (threadId: string) => {
    if (disc.length) await recordFileText(deps, key, disc.splice(0));
    try {
      await deps.rooms.fetch(key, "/room/comments", { method: "POST", body: JSON.stringify({ threadId, by: user.id }) });
    } catch (e) {
      // The comment is stored; people in the file see it on their next read.
      console.error("comments: room notice failed", e);
    }
  };

  const one = async (id: string) =>
    d1.prepare(`SELECT id, thread_id, user_id FROM comments WHERE id = ?1 AND file_key = ?2`).bind(id, key).first<{ id: string; thread_id: string; user_id: string }>();

  const markRead = (threadId: string, at: number) =>
    d1
      .prepare(`INSERT INTO comment_reads (thread_id, user_id, read_at) VALUES (?1, ?2, ?3) ON CONFLICT (thread_id, user_id) DO UPDATE SET read_at = ?3`)
      .bind(threadId, user.id, at)
      .run();

  if (parts.length === 3) {
    if (m === "GET") return list();
    if (m !== "POST") return fail(405, "method not allowed");
    const body = await readJson(req);
    if (!body) return fail(400, "expected a JSON object");
    const message = cleanMessage(body.message);
    if (message === null) return fail(400, "a comment needs some text");
    // Comments and replies a minute (docs/multiplayer.md §17): 429 quota_exceeded
    await (await import("./quota/quota")).countFor(deps, user, "comments_per_minute");
    const mentions = cleanMentions(body.mentions);
    const meta = cleanMeta(body.messageMeta);
    if (meta === undefined) return fail(400, "messageMeta");
    const id = typeof body.id === "string" && COMMENT_ID.test(body.id) ? body.id : `c_${randomToken(12)}`;
    if (await one(id)) return fail(409, "comment id taken");
    const now = deps.now();
    if (typeof body.threadId === "string" && body.threadId) {
      const thread = await one(body.threadId);
      if (!thread || thread.thread_id !== thread.id) return fail(404, "no such thread");
      await d1
        .prepare(`INSERT INTO comments (id, file_key, thread_id, user_id, message, mentions, message_meta, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`)
        .bind(id, key, thread.id, user.id, message, JSON.stringify(mentions), meta, now)
        .run();
      // Replying reads the thread.
      await markRead(thread.id, now);
      disc.push({ text: message, action: "insert", textType: "file_comments", resourceId: id, parentCommentId: thread.id, userId: user.id });
      await changed(thread.id);
      await notifyComment(deps, { key, by: user, commentId: id, threadId: thread.id, reply: true, message, mentions });
      await (await import("./webhooks/events")).commentPosted(deps, key, user, id);
      return list();
    }
    const anchor = cleanAnchor(body.anchor);
    if (!anchor) return fail(400, "a new thread needs its place");
    const next = await d1.prepare(`SELECT COALESCE(MAX(number), 0) + 1 AS n FROM comments WHERE file_key = ?1`).bind(key).first<{ n: number }>();
    await d1
      .prepare(
        `INSERT INTO comments (id, file_key, thread_id, user_id, message, mentions, number, page_id, x, y, node_id, offset_x, offset_y, time_ms, message_meta, created_at)
         VALUES (?1, ?2, ?1, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`,
      )
      .bind(id, key, user.id, message, JSON.stringify(mentions), next?.n ?? 1, anchor.pageId, anchor.x, anchor.y, anchor.nodeId ?? null, anchor.offset?.x ?? null, anchor.offset?.y ?? null, anchor.timeMs ?? null, meta, now)
      .run();
    await markRead(id, now);
    disc.push({ text: message, action: "insert", textType: "file_comments", resourceId: id, nodeId: anchor.nodeId ?? null, userId: user.id });
    await changed(id);
    await notifyComment(deps, { key, by: user, commentId: id, threadId: id, reply: false, message, mentions });
    await (await import("./webhooks/events")).commentPosted(deps, key, user, id);
    return list();
  }

  if (parts.length === 4 && parts[3] === "read" && m === "POST") {
    const body = await readJson(req);
    const ids = Array.isArray(body?.threadIds) ? body.threadIds.filter((s): s is string => typeof s === "string").slice(0, 1000) : null;
    if (!ids) return fail(400, "threadIds");
    const at = body?.read === false ? 0 : deps.now();
    for (const id of ids) {
      const t = await one(id);
      if (t && t.thread_id === t.id) await markRead(id, at);
    }
    return list();
  }

  const id = parts[3];
  if (!id || !COMMENT_ID.test(id)) return fail(404, "not found");
  const c = await one(id);
  if (!c) return fail(404, "no such comment");
  const root = c.thread_id === c.id;
  const threadAuthor = root ? c.user_id : (await one(c.thread_id))?.user_id;

  if (parts.length === 5 && parts[4] === "reactions") {
    if (m === "PUT") {
      const body = await readJson(req);
      const emoji = cleanEmoji(body?.emoji);
      if (!emoji) return fail(400, "emoji");
      const had = await d1.prepare(`SELECT 1 FROM comment_reactions WHERE comment_id = ?1 AND user_id = ?2 AND emoji = ?3`).bind(id, user.id, emoji).first();
      await d1.prepare(`INSERT INTO comment_reactions (comment_id, user_id, emoji, created_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT DO NOTHING`).bind(id, user.id, emoji, deps.now()).run();
      if (!had) await notifyReaction(deps, { key, by: user, commentId: id, threadId: c.thread_id, emoji });
      if (!had) disc.push({ text: emoji, action: "insert", textType: "file_comment_reactions", resourceId: `${id}:${emoji}`, parentCommentId: id, userId: user.id });
    } else if (m === "DELETE") {
      const emoji = cleanEmoji(new URL(req.url).searchParams.get("emoji"));
      if (!emoji) return fail(400, "emoji");
      const gone = await d1.prepare(`DELETE FROM comment_reactions WHERE comment_id = ?1 AND user_id = ?2 AND emoji = ?3 RETURNING emoji`).bind(id, user.id, emoji).first();
      if (gone) disc.push({ text: emoji, action: "delete", textType: "file_comment_reactions", resourceId: `${id}:${emoji}`, parentCommentId: id, userId: user.id });
    } else return fail(405, "method not allowed");
    await changed(c.thread_id);
    return list();
  }
  if (parts.length !== 4) return fail(404, "not found");

  if (m === "DELETE") {
    if (c.user_id !== user.id) return fail(403, "you can only delete your own comments");
    if (root) {
      // The thread goes with its first comment (its replies' reactions and read marks by cascade).
      await d1.prepare(`DELETE FROM comment_reactions WHERE comment_id IN (SELECT id FROM comments WHERE thread_id = ?1)`).bind(id).run();
      await d1.prepare(`DELETE FROM comment_reads WHERE thread_id = ?1`).bind(id).run();
      await d1.prepare(`DELETE FROM comments WHERE thread_id = ?1 AND id <> ?1`).bind(id).run();
    } else await d1.prepare(`DELETE FROM comment_reactions WHERE comment_id = ?1`).bind(id).run();
    await d1.prepare(`DELETE FROM comments WHERE id = ?1`).bind(id).run();
    disc.push({ text: "", action: "delete", textType: "file_comments", resourceId: id, parentCommentId: root ? null : c.thread_id, userId: user.id });
    await changed(c.thread_id);
    await forgetComments(deps, key, [id]);
    return list();
  }

  if (m !== "PATCH") return fail(405, "method not allowed");
  const body = await readJson(req);
  if (!body) return fail(400, "expected a JSON object");
  const now = deps.now();
  if (body.message !== undefined) {
    if (c.user_id !== user.id) return fail(403, "you can only edit your own comments");
    const message = cleanMessage(body.message);
    if (message === null) return fail(400, "a comment needs some text");
    const meta = cleanMeta(body.messageMeta);
    if (meta === undefined) return fail(400, "messageMeta");
    await d1.prepare(`UPDATE comments SET message = ?2, mentions = ?3, message_meta = ?4, edited_at = ?5 WHERE id = ?1`).bind(id, message, JSON.stringify(cleanMentions(body.mentions)), meta, now).run();
    disc.push({ text: message, action: "update", textType: "file_comments", resourceId: id, parentCommentId: root ? null : c.thread_id, userId: user.id });
  }
  if (body.resolved !== undefined) {
    if (!root) return fail(400, "resolve the thread");
    if (!editor && threadAuthor !== user.id) return fail(403, "only editors and the comment's author can resolve it");
    if (body.resolved === true) await d1.prepare(`UPDATE comments SET resolved_at = ?2, resolved_by = ?3 WHERE id = ?1`).bind(id, now, user.id).run();
    else await d1.prepare(`UPDATE comments SET resolved_at = NULL, resolved_by = NULL WHERE id = ?1`).bind(id).run();
  }
  if (body.anchor !== undefined) {
    if (!root) return fail(400, "move the thread");
    if (!editor && threadAuthor !== user.id) return fail(403, "only editors and the comment's author can move it");
    const a = cleanAnchor(body.anchor);
    if (!a) return fail(400, "anchor");
    await d1
      .prepare(`UPDATE comments SET page_id = ?2, x = ?3, y = ?4, node_id = ?5, offset_x = ?6, offset_y = ?7, time_ms = ?8 WHERE id = ?1`)
      .bind(id, a.pageId, a.x, a.y, a.nodeId ?? null, a.offset?.x ?? null, a.offset?.y ?? null, a.timeMs ?? null)
      .run();
  }
  await changed(c.thread_id);
  return list();
}

function anchorOf(r: Row): CommentAnchor {
  return { pageId: r.page_id ?? "", x: r.x ?? 0, y: r.y ?? 0, nodeId: r.node_id, offset: r.offset_x !== null && r.offset_y !== null ? { x: r.offset_x, y: r.offset_y } : null, ...(r.time_ms !== null && r.time_ms !== undefined ? { timeMs: r.time_ms } : {}) };
}

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const v = (await req.json()) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function cleanMessage(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.replace(/\s+$/, "").replace(/^\s+/, "");
  return t && commentLength(t) <= MAX_COMMENT_LENGTH ? t : null;
}

/** The largest `message_meta` kept (its JSON) */
const MAX_META_BYTES = 64 * 1024;

/** A request's `messageMeta` as stored: its JSON, null when absent or empty; undefined when it isn't segments */
function cleanMeta(v: unknown): string | null | undefined {
  if (v === undefined || v === null) return null;
  const segs = cleanSegments(v);
  if (!segs) return undefined;
  if (!segs.length) return null;
  const json = JSON.stringify(segs);
  return json.length <= MAX_META_BYTES ? json : undefined;
}

/** A row's rich segments, for the answer (none: plain text) */
function metaOf(s: string | null | undefined): { messageMeta?: CommentSegment[] } {
  if (!s) return {};
  try {
    const segs = cleanSegments(JSON.parse(s));
    return segs?.length ? { messageMeta: segs } : {};
  } catch {
    return {};
  }
}

function cleanMentions(v: unknown): string[] {
  return Array.isArray(v) ? [...new Set(v.filter((s): s is string => typeof s === "string" && s.length > 0 && s.length <= 320))].slice(0, 50) : [];
}

function parseMentions(s: string): string[] {
  try {
    return cleanMentions(JSON.parse(s));
  } catch {
    return [];
  }
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && Math.abs(v) < 1e9;

function cleanAnchor(v: unknown): CommentAnchor | null {
  if (!v || typeof v !== "object") return null;
  const a = v as Record<string, unknown>;
  if (typeof a.pageId !== "string" || !a.pageId || a.pageId.length > 64 || !finite(a.x) || !finite(a.y)) return null;
  const nodeId = typeof a.nodeId === "string" && a.nodeId.length <= 64 ? a.nodeId : null;
  const o = a.offset as Record<string, unknown> | null | undefined;
  const offset = nodeId && o && finite(o.x) && finite(o.y) ? { x: o.x, y: o.y } : null;
  // Motion's playhead time (docs/motion.md §6.8): whole ms, at most a day.
  const timeMs = finite(a.timeMs) && a.timeMs >= 0 && a.timeMs <= 86_400_000 ? Math.round(a.timeMs) : null;
  return { pageId: a.pageId, x: a.x, y: a.y, nodeId: offset ? nodeId : null, offset, ...(timeMs !== null ? { timeMs } : {}) };
}

function cleanEmoji(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 && v.length <= 32 && !/[\s<>]/.test(v) ? v : null;
}
