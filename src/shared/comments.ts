/**
 * Comments (docs/multiplayer.md §10): threads pinned on a file's canvas, with replies, reactions, @mentions, resolve and
 * read state — Figma Design's model (research R14-comments.md; Figma's REST `Comment`: id, parent_id, user, created_at,
 * resolved_at, message, order_id, client_meta, reactions). A shared file keeps them on the server (D1, migration 0006,
 * server/src/comments.ts) and its room tells the people in it when they change; a local file keeps them in the store.
 * The store's `comments` repository serves both the same way.
 */
import type { FileKey } from "./store/types";

export interface CommentUser {
  id: string;
  /** "You" for a local file's comments when nobody is logged in */
  name: string;
  email?: string | null;
  picture?: string | null;
}

/**
 * Where a thread sits (Figma's client_meta): a point on a page, in page coordinates — or, attached to a layer (Figma's
 * FrameOffset: the top-level frame under the click), that layer's top-left plus `offset`, so the pin moves with it.
 * `x` / `y` are always the last known page point (used when the layer is gone).
 */
export interface CommentAnchor {
  pageId: string;
  x: number;
  y: number;
  nodeId?: string | null;
  offset?: { x: number; y: number } | null;
  /** Motion (docs/motion.md §6.8): the playhead's time when the comment was placed in Motion mode; the pin shows near it. Round 8g. */
  timeMs?: number | null;
}

export interface CommentReaction {
  emoji: string;
  users: CommentUser[];
  createdAt: number;
}

export interface Comment {
  id: string;
  /** The thread's first comment's id; equal to `id` for that first comment */
  threadId: string;
  /** null for the first comment of a thread */
  parentId: string | null;
  user: CommentUser;
  message: string;
  /** User ids (or emails of pending people) @mentioned in the message */
  mentions: string[];
  createdAt: number;
  editedAt: number | null;
  reactions: CommentReaction[];
  /** Images and videos posted with it (Figma's `attachments`, up to 5); absent on comments written before them */
  attachments?: CommentAttachment[];
  /** The message as Figma's rich segments (`message_meta`); absent: `message` is plain text */
  messageMeta?: CommentSegment[];
}

/**
 * Figma's `message_meta` (atlas 16 §2.6): a message as segments — text with its styles (bold, italic, strikethrough),
 * a link, an @mention (`user_id`, its text "@Name"), a numbered or bulleted list of items. `message` stays the plain
 * text (search, notifications, a shared file's server, which keeps no segments yet).
 */
export type CommentStyle = "b" | "i" | "s";
export type CommentSegment =
  | { t: string; styles?: CommentStyle[]; link?: string }
  | { t: string; user_id: string }
  | { styles: ["ol" | "ul"]; children: { children: CommentSegment[] }[] };

export const isListSegment = (s: CommentSegment): s is Extract<CommentSegment, { children: unknown }> => "children" in s;
export const isMentionSegment = (s: CommentSegment): s is Extract<CommentSegment, { user_id: string }> => "user_id" in s;

/** The plain text of segments, as Figma exports it: lists one item a line, "1. " numbered, "* " bulleted */
export function segmentsText(segments: CommentSegment[]): string {
  let out = "";
  for (const s of segments) {
    if (isListSegment(s)) {
      if (out && !out.endsWith("\n")) out += "\n";
      s.children.forEach((item, i) => (out += `${s.styles[0] === "ol" ? `${i + 1}. ` : "* "}${segmentsText(item.children)}\n`));
    } else out += s.t;
  }
  return out;
}

const SEGMENTS_MAX = 2000;
const STYLES = new Set(["b", "i", "s"]);

/** Segments as they come over the port: known shapes only, lists one level deep, http(s) / mailto links; else null */
export function cleanSegments(v: unknown, depth = 0): CommentSegment[] | null {
  if (!Array.isArray(v) || v.length > SEGMENTS_MAX) return null;
  const out: CommentSegment[] = [];
  for (const raw of v) {
    const s = raw as Record<string, unknown>;
    if (!s || typeof s !== "object") return null;
    if (Array.isArray(s.children)) {
      const kind = Array.isArray(s.styles) ? s.styles[0] : null;
      if (depth > 0 || (kind !== "ol" && kind !== "ul")) return null;
      const items: { children: CommentSegment[] }[] = [];
      for (const item of s.children as { children?: unknown }[]) {
        const children = cleanSegments(item?.children, depth + 1);
        if (!children) return null;
        items.push({ children });
      }
      out.push({ styles: [kind], children: items });
      continue;
    }
    if (typeof s.t !== "string") return null;
    if (typeof s.user_id === "string") {
      out.push({ t: s.t, user_id: s.user_id });
      continue;
    }
    const seg: { t: string; styles?: CommentStyle[]; link?: string } = { t: s.t };
    if (Array.isArray(s.styles)) {
      const styles = [...new Set(s.styles.filter((x): x is CommentStyle => typeof x === "string" && STYLES.has(x)))];
      if (styles.length) seg.styles = styles;
    }
    if (typeof s.link === "string" && /^(https?:|mailto:)/i.test(s.link) && s.link.length <= 2048) seg.link = s.link;
    out.push(seg);
  }
  return out;
}

/**
 * A file posted with a comment (atlas 16 §2.7): its bytes in the store's blobs, as images are. A local file's comments
 * only for now (a shared file's would need the server to keep them — Phase 6).
 */
export interface CommentAttachment {
  id: string;
  name: string;
  /** One of ATTACHMENT_IMAGE_TYPES or ATTACHMENT_VIDEO_TYPES */
  mime: string;
  size: number;
  /** The bytes' SHA-1 in the store's blobs */
  sha1: string;
  width: number;
  height: number;
  /** A video's picture (PNG, its frame 1 s in), SHA-1 */
  thumb?: string | null;
  /** The file's lastModified: Figma's duplicate check is name and lastModified */
  lastModified?: number;
}

/** Figma's upload rules (the upload-validation module): 5 files, images up to 30 MB, videos up to 100 MB */
export const MAX_ATTACHMENTS = 5;
export const MAX_ATTACHMENT_IMAGE_BYTES = 30_000_000;
export const MAX_ATTACHMENT_VIDEO_BYTES = 100_000_000;
/** PNG, JPEG and GIF (whether WebP / HEIC are taken for comments is open, atlas 16 §8) */
export const ATTACHMENT_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif"] as const;
/** The video types are open (atlas 16 §8): the ones a browser plays */
export const ATTACHMENT_VIDEO_TYPES = ["video/mp4", "video/quicktime", "video/webm"] as const;

/** Figma's upload error enum, in its order */
export type AttachmentError = "INVALID_FILE_TYPE" | "DUPLICATE_FILE_UPLOAD" | "MAX_VIDEO_SIZE_EXCEEDED" | "MAX_IMAGE_SIZE_EXCEEDED" | "MAX_UPLOADS_EXCEEDED" | "FAILED_TO_UPLOAD";

export const isAttachmentVideo = (mime: string) => (ATTACHMENT_VIDEO_TYPES as readonly string[]).includes(mime);

/**
 * Which of `files` may join the `attached` ones, and why the others can't: a type outside the lists, the same name and
 * lastModified as one attached already, an image past 30 MB or a video past 100 MB, or more than 5 in all.
 */
export function checkAttachments<F extends { name: string; type: string; size: number; lastModified?: number }>(
  attached: { name: string; lastModified?: number }[],
  files: F[],
): { ok: F[]; errors: { error: AttachmentError; names: string[] }[] } {
  const ok: F[] = [];
  const errors = new Map<AttachmentError, string[]>();
  const fail = (error: AttachmentError, name: string) => errors.set(error, [...(errors.get(error) ?? []), name]);
  for (const f of files) {
    const video = isAttachmentVideo(f.type);
    if (!video && !(ATTACHMENT_IMAGE_TYPES as readonly string[]).includes(f.type)) fail("INVALID_FILE_TYPE", f.name);
    else if ([...attached, ...ok].some((a) => a.name === f.name && a.lastModified === f.lastModified)) fail("DUPLICATE_FILE_UPLOAD", f.name);
    else if (video && f.size > MAX_ATTACHMENT_VIDEO_BYTES) fail("MAX_VIDEO_SIZE_EXCEEDED", f.name);
    else if (!video && f.size > MAX_ATTACHMENT_IMAGE_BYTES) fail("MAX_IMAGE_SIZE_EXCEEDED", f.name);
    else if (attached.length + ok.length >= MAX_ATTACHMENTS) fail("MAX_UPLOADS_EXCEEDED", f.name);
    else ok.push(f);
  }
  return { ok, errors: [...errors].map(([error, names]) => ({ error, names })) };
}

export interface CommentThread {
  id: string;
  /** Figma's order_id: the thread's number in the file (1, 2, …) */
  number: number;
  anchor: CommentAnchor;
  /** The first comment, then the replies oldest first */
  comments: Comment[];
  resolvedAt: number | null;
  resolvedBy: CommentUser | null;
  /** Something in it the caller hasn't read (comments by others after their last read) */
  unread: boolean;
  /** When the caller last read it (0 = never) */
  readAt: number;
}

export interface CommentsState {
  fileKey: FileKey;
  /** Kept on the server (the file is shared) or in the store */
  shared: boolean;
  /** Who the caller is: the signed-in user, or "You" */
  me: CommentUser;
  /** The caller can resolve anyone's thread (Figma: editors and the file owner); everyone resolves their own */
  canResolveAny: boolean;
  /** The caller can delete others' comments (Figma: the file owner) */
  canDeleteAny: boolean;
  threads: CommentThread[];
  /** Offline / not loaded: the last copy is shown */
  error?: string | null;
}

export interface NewComment {
  /** A thread's id to reply to it; absent for a new thread (then `anchor` is required) */
  threadId?: string | null;
  message: string;
  mentions?: string[];
  anchor?: CommentAnchor;
  /** Files already put in the store's blobs */
  attachments?: CommentAttachment[];
  /** The message's rich segments (bold, italic, strikethrough, links, lists, mentions); `message` is their plain text */
  messageMeta?: CommentSegment[];
}

/** People who can be @mentioned: those with access to the file (members of a shared file) */
export interface MentionCandidate {
  id: string;
  name: string;
  email: string;
  picture?: string | null;
}

export interface CommentsEvent {
  fileKey: FileKey;
}

export interface CommentsRepository {
  list(fileKey: FileKey): Promise<CommentsState>;
  add(fileKey: FileKey, input: NewComment): Promise<CommentsState>;
  edit(fileKey: FileKey, commentId: string, message: string, mentions?: string[], messageMeta?: CommentSegment[] | null): Promise<CommentsState>;
  /** A thread's first comment deletes the thread; a reply only itself */
  remove(fileKey: FileKey, commentId: string): Promise<CommentsState>;
  setResolved(fileKey: FileKey, threadId: string, resolved: boolean): Promise<CommentsState>;
  setRead(fileKey: FileKey, threadIds: string[], read: boolean): Promise<CommentsState>;
  react(fileKey: FileKey, commentId: string, emoji: string, on: boolean): Promise<CommentsState>;
  /** Drag a pin: a new place (and layer) for the thread */
  move(fileKey: FileKey, threadId: string, anchor: CommentAnchor): Promise<CommentsState>;
  mentionable(fileKey: FileKey): Promise<MentionCandidate[]>;
  /** Comments of a file changed (someone else's, or ours in another view) */
  watch(listener: (e: CommentsEvent) => void): () => void;
}

/** Figma's reaction picker's quick row (inferred from the live UI; any emoji is accepted) */
export const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🎉"] as const;

/** Figma's `maxCommentLength`: 2,000, counted in grapheme clusters after trailing whitespace is trimmed (`commentLength`) */
export const MAX_COMMENT_LENGTH = 2_000;
export const COMMENT_ID = /^[A-Za-z0-9_-]{6,64}$/;

/** A message's length as Figma counts it: grapheme clusters (an emoji with its modifiers is one), trailing whitespace left out */
export function commentLength(message: string): number {
  const text = message.replace(/\s+$/u, "");
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    let n = 0;
    for (const _ of new Intl.Segmenter().segment(text)) n++;
    return n;
  }
  return [...text].length;
}

/** Threads as the caller sees them from flat comments + resolve state + their read marks (server and local store). */
export function buildThreads(
  rows: { comment: Comment; anchor?: CommentAnchor | null; number?: number; resolvedAt?: number | null; resolvedBy?: CommentUser | null }[],
  reads: Record<string, number>,
  meId: string,
): CommentThread[] {
  const threads = new Map<string, CommentThread>();
  for (const r of rows) {
    if (r.comment.parentId !== null) continue;
    threads.set(r.comment.id, {
      id: r.comment.id,
      number: r.number ?? 0,
      anchor: r.anchor ?? { pageId: "", x: 0, y: 0 },
      comments: [r.comment],
      resolvedAt: r.resolvedAt ?? null,
      resolvedBy: r.resolvedBy ?? null,
      unread: false,
      readAt: reads[r.comment.id] ?? 0,
    });
  }
  for (const r of rows) {
    if (r.comment.parentId === null) continue;
    threads.get(r.comment.threadId)?.comments.push(r.comment);
  }
  for (const t of threads.values()) {
    t.comments.sort((a, b) => (a.parentId === null ? -1 : b.parentId === null ? 1 : a.createdAt - b.createdAt || a.id.localeCompare(b.id)));
    t.unread = t.comments.some((c) => c.user.id !== meId && c.createdAt > t.readAt);
  }
  return [...threads.values()].sort((a, b) => a.number - b.number);
}

/** The @mentions written in a message ("@Name" of a candidate), as their ids. */
export function mentionsIn(message: string, people: MentionCandidate[]): string[] {
  const out: string[] = [];
  let rest = message.toLowerCase();
  // Longest names first, each match taken out ("@Bob Builder" isn't also "@Bob"); a name ends at a non-letter.
  for (const p of [...people].sort((a, b) => b.name.length - a.name.length)) {
    const tag = `@${p.name.toLowerCase()}`;
    let at = rest.indexOf(tag);
    while (at >= 0 && /[\p{L}\p{N}]/u.test(rest.charAt(at + tag.length))) at = rest.indexOf(tag, at + 1);
    if (at < 0) continue;
    if (!out.includes(p.id)) out.push(p.id);
    rest = rest.split(tag).join(" ");
  }
  return out;
}
