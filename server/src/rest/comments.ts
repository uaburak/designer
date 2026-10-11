/**
 * Comments over REST (docs/multiplayer.md §16.7 "Comments"), on `server/src/comments.ts`: reads straight from D1 in
 * Figma's `Comment` shape; writes go through `commentsRoute` (the room is told, mentions are notified, FILE_COMMENT is
 * emitted — all as from the app).
 *
 *   GET    /v1/files/:key/comments?as_md                    {comments: Comment[]}
 *   POST   /v1/files/:key/comments {message, comment_id?, client_meta?}   the Comment
 *   DELETE /v1/files/:key/comments/:id                      {status: 200, error: false} (the author only)
 *   GET    /v1/files/:key/comments/:id/reactions?cursor     {reactions, pagination}
 *   POST   … {emoji} · DELETE …?emoji=                      {status: 200, error: false}
 *
 * Emoji are Figma's `:shortcode:`s; we store the character, so the common ones are mapped both ways (others pass as they
 * are). `client_meta` maps to our anchor: a Vector `{x, y}` or Region is a point on the file's first page (REST names
 * no page: ours, `client_meta.page_id` picks one), a FrameOffset `{node_id, node_offset}` pins to that layer.
 */
import { COMMENT_ID, type CommentAnchor } from "../../../src/shared/comments";
import { commentsRoute } from "../comments";
import { fileFor } from "./access";
import { RestError, iso, readBody, restJson, restUser, type RestCtx } from "./http";
import { randomToken } from "../tokens";

/** Figma's shortcodes for the reactions people use most (ours: the list Figma's picker offers first) */
const SHORTCODES: Record<string, string> = {
  ":+1:": "👍", ":thumbsup:": "👍", ":-1:": "👎", ":heart:": "❤️", ":joy:": "😂", ":open_mouth:": "😮", ":cry:": "😢", ":tada:": "🎉",
  ":fire:": "🔥", ":eyes:": "👀", ":white_check_mark:": "✅", ":raised_hands:": "🙌", ":clap:": "👏", ":rocket:": "🚀", ":100:": "💯",
  ":thinking_face:": "🤔", ":smile:": "😄", ":pray:": "🙏", ":star:": "⭐", ":heart_eyes:": "😍",
};
const CHAR_TO_CODE = new Map(Object.entries(SHORTCODES).filter(([k]) => k !== ":thumbsup:").map(([k, v]) => [v, k]));

export const toShortcode = (emoji: string): string => CHAR_TO_CODE.get(emoji) ?? emoji;
export const fromShortcode = (code: string): string => SHORTCODES[code] ?? code;

/** REST names no page: a pin goes on this page unless `client_meta.page_id` says otherwise (ours) */
const DEFAULT_PAGE = "0:1";

interface Row {
  id: string;
  thread_id: string;
  user_id: string;
  message: string;
  number: number | null;
  page_id: string | null;
  x: number | null;
  y: number | null;
  node_id: string | null;
  offset_x: number | null;
  offset_y: number | null;
  created_at: number;
  resolved_at: number | null;
  u_name: string | null;
  u_email: string;
}

const SELECT = `SELECT c.id, c.thread_id, c.user_id, c.message, c.number, c.page_id, c.x, c.y, c.node_id, c.offset_x, c.offset_y, c.created_at, c.resolved_at,
  u.name AS u_name, u.email AS u_email FROM comments c JOIN users u ON u.id = c.user_id`;

function clientMeta(r: Row): Record<string, unknown> | null {
  if (r.thread_id !== r.id || r.page_id === null) return null;
  if (r.node_id && r.offset_x !== null && r.offset_y !== null) return { node_id: r.node_id, node_offset: { x: r.offset_x, y: r.offset_y } };
  return { x: r.x ?? 0, y: r.y ?? 0 };
}

async function reactionsOf(ctx: RestCtx, ids: string[]) {
  if (!ids.length) return new Map<string, { user: ReturnType<typeof restUser>; emoji: string; created_at: string | null }[]>();
  const { results } = await ctx.deps.db.d1
    .prepare(`SELECT x.comment_id, x.emoji, x.created_at, u.id, u.name, u.email FROM comment_reactions x JOIN users u ON u.id = x.user_id WHERE x.comment_id IN (SELECT value FROM json_each(?1)) ORDER BY x.created_at, x.rowid`)
    .bind(JSON.stringify(ids))
    .all<{ comment_id: string; emoji: string; created_at: number; id: string; name: string | null; email: string }>();
  const out = new Map<string, { user: ReturnType<typeof restUser>; emoji: string; created_at: string | null }[]>();
  for (const r of results) {
    const list = out.get(r.comment_id) ?? [];
    list.push({ user: restUser(r), emoji: toShortcode(r.emoji), created_at: iso(r.created_at) });
    out.set(r.comment_id, list);
  }
  return out;
}

async function toComments(ctx: RestCtx, key: string, rows: Row[]) {
  const reactions = await reactionsOf(ctx, rows.map((r) => r.id));
  return rows.map((r) => ({
    id: r.id,
    file_key: key,
    parent_id: r.thread_id === r.id ? "" : r.thread_id,
    user: restUser({ id: r.user_id, name: r.u_name, email: r.u_email }),
    created_at: iso(r.created_at),
    resolved_at: r.thread_id === r.id ? iso(r.resolved_at) : null,
    message: r.message,
    client_meta: clientMeta(r),
    order_id: r.thread_id === r.id && r.number !== null ? String(r.number) : null,
    reactions: reactions.get(r.id) ?? [],
  }));
}

/** client_meta → our anchor */
function anchorOf(meta: unknown): CommentAnchor {
  const m = (meta && typeof meta === "object" ? meta : {}) as Record<string, unknown>;
  const pageId = typeof m.page_id === "string" && m.page_id ? m.page_id : DEFAULT_PAGE;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const off = m.node_offset as Record<string, unknown> | undefined;
  if (typeof m.node_id === "string" && off && typeof off === "object") return { pageId, x: num(off.x), y: num(off.y), nodeId: m.node_id, offset: { x: num(off.x), y: num(off.y) } };
  return { pageId, x: num(m.x), y: num(m.y) };
}

/** A write through the app's own route, as the caller */
async function viaApp(ctx: RestCtx, key: string, role: "owner" | "editor" | "viewer", method: string, sub: string[], body?: unknown, query = ""): Promise<Response> {
  const req = new Request(`${ctx.url.origin}/files/${key}/comments${sub.length ? `/${sub.join("/")}` : ""}${query}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const res = await commentsRoute(req, ctx.deps, { key, role, user: ctx.caller.user, parts: ["files", key, "comments", ...sub] });
  if (!res.ok) {
    const e = (await res.json().catch(() => ({}))) as { error?: string };
    throw new RestError(res.status, e.error ?? "Couldn't change the comment");
  }
  return res;
}

export async function commentsRestRoute(ctx: RestCtx): Promise<Response> {
  const { parts, m, deps, url } = ctx;
  const key = parts[1];
  const fa = await fileFor(ctx, key, m === "GET" ? "view" : "comment");
  const role = fa.a.role === "owner" ? "owner" : fa.a.canEdit ? "editor" : "viewer";
  const d1 = deps.db.d1;

  if (parts.length === 3 && m === "GET") {
    const { results } = await d1.prepare(`${SELECT} WHERE c.file_key = ?1 ORDER BY c.created_at, c.rowid`).bind(key).all<Row>();
    return restJson({ comments: await toComments(ctx, key, results) });
  }
  if (parts.length === 3 && m === "POST") {
    const b = await readBody<{ message?: unknown; comment_id?: unknown; client_meta?: unknown }>(ctx.req);
    if (typeof b.message !== "string" || !b.message.trim()) throw new RestError(400, "message is required");
    const id = `c_${randomToken(12)}`;
    if (b.comment_id !== undefined) {
      if (typeof b.comment_id !== "string" || !COMMENT_ID.test(b.comment_id)) throw new RestError(400, "Invalid comment_id");
      await viaApp(ctx, key, role, "POST", [], { id, threadId: b.comment_id, message: b.message });
    } else await viaApp(ctx, key, role, "POST", [], { id, message: b.message, anchor: anchorOf(b.client_meta) });
    const row = await d1.prepare(`${SELECT} WHERE c.id = ?1`).bind(id).first<Row>();
    return restJson((await toComments(ctx, key, row ? [row] : []))[0] ?? null);
  }
  const id = parts[3];
  if (!COMMENT_ID.test(id)) throw new RestError(404, "Comment not found");
  const exists = await d1.prepare(`SELECT id FROM comments WHERE id = ?1 AND file_key = ?2`).bind(id, key).first();
  if (!exists) throw new RestError(404, "Comment not found");
  if (parts.length === 4 && m === "DELETE") {
    await viaApp(ctx, key, role, "DELETE", [id]);
    return restJson({ status: 200, error: false });
  }
  if (parts.length === 5 && parts[4] === "reactions") {
    if (m === "GET") {
      const all = (await reactionsOf(ctx, [id])).get(id) ?? [];
      const offset = Math.max(0, Number(url.searchParams.get("cursor")) || 0);
      const page = all.slice(offset, offset + 100);
      return restJson({ reactions: page, pagination: offset + 100 < all.length ? { next_page: `${url.origin}/v1/files/${key}/comments/${id}/reactions?cursor=${offset + 100}` } : {} });
    }
    if (m === "POST") {
      const b = await readBody<{ emoji?: unknown }>(ctx.req);
      if (typeof b.emoji !== "string" || !b.emoji) throw new RestError(400, "emoji is required");
      await viaApp(ctx, key, role, "PUT", [id, "reactions"], { emoji: fromShortcode(b.emoji) });
      return restJson({ status: 200, error: false });
    }
    if (m === "DELETE") {
      const emoji = url.searchParams.get("emoji");
      if (!emoji) throw new RestError(400, "emoji is required");
      await viaApp(ctx, key, role, "DELETE", [id, "reactions"], undefined, `?emoji=${encodeURIComponent(fromShortcode(emoji))}`);
      return restJson({ status: 200, error: false });
    }
  }
  throw new RestError(404, "Not found");
}
