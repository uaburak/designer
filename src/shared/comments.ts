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
  edit(fileKey: FileKey, commentId: string, message: string, mentions?: string[]): Promise<CommentsState>;
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

export const MAX_COMMENT_LENGTH = 10_000;
export const COMMENT_ID = /^[A-Za-z0-9_-]{6,64}$/;

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
