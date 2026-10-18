/**
 * The store's `comments` repository (docs/multiplayer.md §10). A shared file's comments live on the server
 * (server/src/comments.ts) and its room says when they change; a local file's live in the store, one record per file,
 * written by the person at this computer ("You", or their name when logged in). No Node or DOM imports: the desktop
 * store and the browser's dev store both run it.
 */
import {
  ATTACHMENT_IMAGE_TYPES,
  buildThreads,
  COMMENT_ID,
  commentLength,
  isAttachmentVideo,
  MAX_ATTACHMENT_IMAGE_BYTES,
  MAX_ATTACHMENT_VIDEO_BYTES,
  MAX_ATTACHMENTS,
  MAX_COMMENT_LENGTH,
  type Comment,
  type CommentAttachment,
  type CommentAnchor,
  type CommentsRepository,
  type CommentsState,
  type CommentUser,
  type MentionCandidate,
  type NewComment,
} from "../../shared/comments";
import { StoreError } from "../../shared/store/protocol";
import type { Unsubscribe } from "../../shared/store/repositories";
import { isSha1, type FileKey } from "../../shared/store/types";
import type { MultiplayerService } from "../multiplayer/service";
import { t as tr } from "../../shared/i18n";

export interface CommentsHost {
  /** The file's local comments record (null when it has none) */
  load(fileKey: FileKey): Promise<unknown>;
  save(fileKey: FileKey, record: LocalComments): Promise<void>;
  now(): number;
  random(): number;
}

interface StoredComment extends Comment {
  anchor?: CommentAnchor;
  number?: number;
  resolvedAt?: number | null;
}

export interface LocalComments {
  v: 1;
  comments: StoredComment[];
  reads: Record<string, number>;
}

/** Reads of a shared file's comments asked for within this long of one answer share it (opening a file asked 2–3 times) */
export const READ_FRESH_MS = 2000;

/** The author of a local file's comments */
export const LOCAL_ID = "you";

export class CommentsService {
  private listeners = new Set<(fileKey: FileKey) => void>();
  private cache = new Map<FileKey, CommentsState>();
  private me: CommentUser | null = null;
  private meAt = 0;
  private offs: Unsubscribe[] = [];
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private host: CommentsHost,
    private mp: MultiplayerService,
  ) {
    // The room says they changed: the next read goes to the server.
    this.offs.push(
      mp.onComments((fileKey) => {
        this.reads.delete(fileKey);
        this.emit(fileKey);
      }),
    );
    const live = new Map<FileKey, string>();
    this.offs.push(
      mp.onFileState((fileKey, s) => {
        // Back online (or newly shared): read the server's list again — unless a read just answered (opening a file
        // reads its comments, then its link comes up a moment later: one read, not two).
        if (s.connection === "live" && live.get(fileKey) !== "live") this.emit(fileKey);
        live.set(fileKey, s.connection);
      }),
    );
  }

  close(): void {
    for (const off of this.offs) off();
  }

  onChange(listener: (fileKey: FileKey) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** A shared file's server reads in flight or answered within READ_FRESH_MS (the room's change notice drops it) */
  private reads = new Map<FileKey, { p: Promise<CommentsState>; doneAt: number | null }>();

  async list(fileKey: FileKey): Promise<CommentsState> {
    const key = await this.sharedKey(fileKey);
    if (!key) return this.localState(fileKey, await this.loadLocal(fileKey));
    try {
      const hit = this.reads.get(fileKey);
      if (hit && (hit.doneAt === null || this.host.now() - hit.doneAt < READ_FRESH_MS)) return await hit.p;
      const entry: { p: Promise<CommentsState>; doneAt: number | null } = { p: this.mp.call("GET", `/files/${key}/comments`).then((body) => this.fromServer(fileKey, body)), doneAt: null };
      this.reads.set(fileKey, entry);
      entry.p.then(
        () => void (entry.doneAt = this.host.now()),
        () => void (this.reads.get(fileKey) === entry && this.reads.delete(fileKey)),
      );
      return await entry.p;
    } catch (e) {
      const last = this.cache.get(fileKey);
      const error = e instanceof Error ? e.message : String(e);
      if (last) return { ...last, error };
      return { fileKey, shared: true, me: await this.whoAmI(), canResolveAny: false, canDeleteAny: false, threads: [], error };
    }
  }

  async add(fileKey: FileKey, input: NewComment): Promise<CommentsState> {
    const attachments = cleanAttachments(input?.attachments);
    // A comment of files alone needs no text (Figma sends it with an empty message).
    const message = cleanMessage(input?.message, attachments.length > 0);
    const mentions = cleanMentions(input?.mentions);
    const threadId = typeof input?.threadId === "string" && input.threadId ? input.threadId : null;
    if (!threadId && !validAnchor(input?.anchor)) throw new StoreError("invalid", tr("A new comment needs its place"));
    const files = attachments.length ? { attachments } : {};
    return this.write(fileKey, {
      server: (key) => {
        // The server doesn't keep files yet (Phase 6): the composer offers them in local files only.
        if (attachments.length) throw new StoreError("invalid", tr("Files can be added to comments in local files only for now"));
        return this.mp.call("POST", `/files/${key}/comments`, { id: this.newId(), threadId, message, mentions, anchor: input.anchor });
      },
      local: (rec, me) => {
        const now = this.host.now();
        const id = this.newId();
        if (threadId) {
          if (!rec.comments.some((c) => c.id === threadId && c.parentId === null)) throw new StoreError("not-found", tr("No such thread"));
          rec.comments.push({ id, threadId, parentId: threadId, user: me, message, mentions, createdAt: now, editedAt: null, reactions: [], ...files });
          rec.reads[threadId] = now;
        } else {
          const number = Math.max(0, ...rec.comments.map((c) => c.number ?? 0)) + 1;
          rec.comments.push({ id, threadId: id, parentId: null, user: me, message, mentions, createdAt: now, editedAt: null, reactions: [], ...files, anchor: input.anchor, number, resolvedAt: null });
          rec.reads[id] = now;
        }
      },
    });
  }

  /** The blobs a local file's comments hold (their files and videos' pictures): kept by the store's GC */
  async blobRefs(fileKey: FileKey): Promise<string[]> {
    const rec = await this.loadLocal(fileKey).catch(() => null);
    const out = new Set<string>();
    for (const c of rec?.comments ?? [])
      for (const a of c.attachments ?? []) {
        out.add(a.sha1);
        if (a.thumb) out.add(a.thumb);
      }
    return [...out];
  }

  async edit(fileKey: FileKey, commentId: string, message: string, mentions?: string[]): Promise<CommentsState> {
    return this.write(fileKey, {
      server: (key) => this.mp.call("PATCH", `/files/${key}/comments/${enc(commentId)}`, { message: cleanMessage(message), mentions: cleanMentions(mentions) }),
      local: (rec) => {
        const c = find(rec, commentId);
        const text = cleanMessage(message, !!c.attachments?.length);
        c.message = text;
        c.mentions = cleanMentions(mentions);
        c.editedAt = this.host.now();
      },
    });
  }

  async remove(fileKey: FileKey, commentId: string): Promise<CommentsState> {
    return this.write(fileKey, {
      server: (key) => this.mp.call("DELETE", `/files/${key}/comments/${enc(commentId)}`),
      local: (rec) => {
        const c = find(rec, commentId);
        if (c.parentId === null) {
          rec.comments = rec.comments.filter((x) => x.threadId !== c.id);
          delete rec.reads[c.id];
        } else rec.comments = rec.comments.filter((x) => x.id !== c.id);
      },
    });
  }

  async setResolved(fileKey: FileKey, threadId: string, resolved: boolean): Promise<CommentsState> {
    return this.write(fileKey, {
      server: (key) => this.mp.call("PATCH", `/files/${key}/comments/${enc(threadId)}`, { resolved: resolved === true }),
      local: (rec) => {
        find(rec, threadId).resolvedAt = resolved ? this.host.now() : null;
      },
    });
  }

  async setRead(fileKey: FileKey, threadIds: string[], read: boolean): Promise<CommentsState> {
    const ids = Array.isArray(threadIds) ? threadIds.filter((s) => typeof s === "string") : [];
    return this.write(fileKey, {
      server: (key) => this.mp.call("POST", `/files/${key}/comments/read`, { threadIds: ids, read: read !== false }),
      local: (rec) => {
        for (const id of ids) rec.reads[id] = read === false ? 0 : this.host.now();
      },
      quiet: true,
    });
  }

  async react(fileKey: FileKey, commentId: string, emoji: string, on: boolean): Promise<CommentsState> {
    if (typeof emoji !== "string" || !emoji || emoji.length > 32) throw new StoreError("invalid", "emoji");
    return this.write(fileKey, {
      server: (key) =>
        on ? this.mp.call("PUT", `/files/${key}/comments/${enc(commentId)}/reactions`, { emoji }) : this.mp.call("DELETE", `/files/${key}/comments/${enc(commentId)}/reactions?emoji=${enc(emoji)}`),
      local: (rec, me) => {
        const c = find(rec, commentId);
        const r = c.reactions.find((x) => x.emoji === emoji);
        if (on) {
          if (!r) c.reactions.push({ emoji, users: [me], createdAt: this.host.now() });
          else if (!r.users.some((u) => u.id === me.id)) r.users.push(me);
        } else if (r) {
          r.users = r.users.filter((u) => u.id !== me.id);
          if (!r.users.length) c.reactions = c.reactions.filter((x) => x !== r);
        }
      },
    });
  }

  async move(fileKey: FileKey, threadId: string, anchor: CommentAnchor): Promise<CommentsState> {
    if (!validAnchor(anchor)) throw new StoreError("invalid", "anchor");
    return this.write(fileKey, {
      server: (key) => this.mp.call("PATCH", `/files/${key}/comments/${enc(threadId)}`, { anchor }),
      local: (rec) => {
        find(rec, threadId).anchor = anchor;
      },
    });
  }

  async mentionable(fileKey: FileKey): Promise<MentionCandidate[]> {
    if (!(await this.sharedKey(fileKey))) return [];
    const members = await this.mp.members(fileKey).catch(() => []);
    return members.map((m) => ({ id: m.userId ?? m.email, name: m.name || m.email.split("@")[0], email: m.email }));
  }

  // --- internals ---

  private emit(fileKey: FileKey): void {
    for (const l of this.listeners) l(fileKey);
  }

  private async sharedKey(fileKey: FileKey): Promise<string | null> {
    return this.mp.signedIn ? this.mp.roomKey(fileKey) : null;
  }

  private newId(): string {
    const abc = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let s = "c_";
    for (let i = 0; i < 16; i++) s += abc[Math.floor(this.host.random() * abc.length)];
    return s;
  }

  /** One write at a time (a local record is read-modify-written); the other views hear of it. */
  private write(fileKey: FileKey, w: { server(key: string): Promise<unknown>; local(rec: LocalComments, me: CommentUser): void; quiet?: boolean }): Promise<CommentsState> {
    const run = async () => {
      const key = await this.sharedKey(fileKey);
      let state: CommentsState;
      if (key) {
        this.reads.delete(fileKey);
        state = this.fromServer(fileKey, await w.server(key));
      }
      else {
        const rec = await this.loadLocal(fileKey);
        w.local(rec, { id: LOCAL_ID, name: "You" });
        await this.host.save(fileKey, rec);
        state = await this.localState(fileKey, rec);
      }
      if (!w.quiet || !key) this.emit(fileKey);
      return state;
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  private fromServer(fileKey: FileKey, body: unknown): CommentsState {
    const b = body as Omit<CommentsState, "fileKey" | "shared">;
    const state: CommentsState = { fileKey, shared: true, me: b.me, canResolveAny: b.canResolveAny === true, canDeleteAny: b.canDeleteAny === true, threads: Array.isArray(b.threads) ? b.threads : [], error: null };
    this.cache.set(fileKey, state);
    return state;
  }

  private async localState(fileKey: FileKey, rec: LocalComments): Promise<CommentsState> {
    const who = await this.whoAmI();
    const me: CommentUser = { id: LOCAL_ID, name: who.id === LOCAL_ID ? "You" : who.name, email: who.email ?? null, picture: who.picture ?? null };
    const asMe = (u: CommentUser) => (u.id === LOCAL_ID ? me : u);
    const rows = rec.comments.map((c) => ({
      comment: { ...strip(c), user: asMe(c.user), reactions: c.reactions.map((r) => ({ ...r, users: r.users.map(asMe) })) },
      anchor: c.anchor ?? null,
      number: c.number,
      resolvedAt: c.resolvedAt ?? null,
      resolvedBy: c.resolvedAt ? me : null,
    }));
    return { fileKey, shared: false, me, canResolveAny: true, canDeleteAny: true, threads: buildThreads(rows, rec.reads, LOCAL_ID), error: null };
  }

  /** The signed-in user (asked once per session), else "You" */
  private async whoAmI(): Promise<CommentUser> {
    if (!this.mp.signedIn) return { id: LOCAL_ID, name: "You" };
    // Asked again after a minute (another account may have logged in since).
    if (this.me && this.host.now() - this.meAt < 60_000) return this.me;
    try {
      const u = await this.mp.call<{ id: string; email: string; name: string | null; picture: string | null }>("GET", "/me");
      this.me = { id: u.id, name: u.name || u.email, email: u.email, picture: u.picture };
      this.meAt = this.host.now();
      return this.me;
    } catch {
      return { id: LOCAL_ID, name: "You" };
    }
  }

  private async loadLocal(fileKey: FileKey): Promise<LocalComments> {
    const raw = (await this.host.load(fileKey).catch(() => null)) as Partial<LocalComments> | null;
    return { v: 1, comments: Array.isArray(raw?.comments) ? raw.comments : [], reads: raw?.reads && typeof raw.reads === "object" ? { ...raw.reads } : {} };
  }
}

/** The `comments` repository over a store's service (validated as it comes over the port) */
export function commentsApi(s: CommentsService): CommentsRepository {
  return {
    list: (fileKey) => s.list(fileKey),
    add: (fileKey, input) => s.add(fileKey, input),
    edit: (fileKey, id, message, mentions) => s.edit(fileKey, String(id), message, mentions),
    remove: (fileKey, id) => s.remove(fileKey, String(id)),
    setResolved: (fileKey, id, resolved) => s.setResolved(fileKey, String(id), resolved === true),
    setRead: (fileKey, ids, read) => s.setRead(fileKey, ids, read !== false),
    react: (fileKey, id, emoji, on) => s.react(fileKey, String(id), String(emoji), on === true),
    move: (fileKey, id, anchor) => s.move(fileKey, String(id), anchor),
    mentionable: (fileKey) => s.mentionable(fileKey),
    watch: (listener) => s.onChange((fileKey) => listener({ fileKey })),
  };
}

const enc = encodeURIComponent;

function strip(c: StoredComment): Comment {
  const { anchor: _a, number: _n, resolvedAt: _r, ...rest } = c;
  return rest;
}

function find(rec: LocalComments, id: string): StoredComment {
  const c = rec.comments.find((x) => x.id === id);
  if (!c) throw new StoreError("not-found", tr("No such comment"));
  return c;
}

function cleanMessage(v: unknown, mayBeEmpty = false): string {
  const t = typeof v === "string" ? v.trim() : "";
  if (!t && mayBeEmpty) return "";
  if (!t) throw new StoreError("invalid", tr("A comment needs some text"));
  if (commentLength(t) > MAX_COMMENT_LENGTH) throw new StoreError("invalid", tr("A comment can be up to {n} characters long", { n: MAX_COMMENT_LENGTH.toLocaleString("en-US") }));
  return t;
}

/** Attachments as they come over the port: at most 5, each a known type within its size, its bytes named by SHA-1 */
function cleanAttachments(v: unknown): CommentAttachment[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > MAX_ATTACHMENTS) throw new StoreError("invalid", tr("You can add up to {n} files", { n: MAX_ATTACHMENTS }));
  return v.map((x: Partial<CommentAttachment>) => {
    const mime = String(x?.mime ?? "");
    const video = isAttachmentVideo(mime);
    const size = Number(x?.size);
    if (!video && !(ATTACHMENT_IMAGE_TYPES as readonly string[]).includes(mime)) throw new StoreError("invalid", "attachment type");
    if (!Number.isFinite(size) || size < 0 || size > (video ? MAX_ATTACHMENT_VIDEO_BYTES : MAX_ATTACHMENT_IMAGE_BYTES)) throw new StoreError("invalid", "attachment size");
    if (!isSha1(x?.sha1) || (x.thumb != null && !isSha1(x.thumb))) throw new StoreError("invalid", "attachment bytes");
    const a: CommentAttachment = {
      id: typeof x.id === "string" && COMMENT_ID.test(x.id) ? x.id : x.sha1,
      name: String(x.name ?? "").slice(0, 255),
      mime,
      size,
      sha1: x.sha1,
      width: Math.max(0, Math.round(Number(x.width) || 0)),
      height: Math.max(0, Math.round(Number(x.height) || 0)),
    };
    if (x.thumb) a.thumb = x.thumb;
    if (Number.isFinite(x.lastModified)) a.lastModified = Number(x.lastModified);
    return a;
  });
}

function cleanMentions(v: unknown): string[] {
  return Array.isArray(v) ? [...new Set(v.filter((s): s is string => typeof s === "string" && s.length > 0))].slice(0, 50) : [];
}

function validAnchor(a: unknown): a is CommentAnchor {
  const x = a as CommentAnchor | null;
  return !!x && typeof x.pageId === "string" && !!x.pageId && Number.isFinite(x.x) && Number.isFinite(x.y);
}
