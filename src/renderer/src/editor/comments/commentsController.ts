/**
 * The editor's comments (docs/multiplayer.md §10; Figma's comments, live capture docs/research/figma/live/multiplayer/
 * comments.md, research R14-comments.md): the file's threads from the store's `comments` repository, kept fresh by its
 * events (the room's notices for a shared file), and this editor's comment UI state — the new-comment draft, the open
 * thread, the Comments panel's search / sort / filters. One per editor (`commentsOf`), read with `useComments`.
 */
import { useSyncExternalStore } from "react";
import { showToast } from "@/ds";
import { t } from "@/i18n";
import { getStoreClient } from "@/store";
import { mentionsIn, type CommentAnchor, type CommentAttachment, type CommentSegment, type CommentsState, type CommentThread, type MentionCandidate } from "@shared/comments";
import type { Guid, NodeChange } from "@/engine/codec";
import type { EditorController } from "../controller";
import type { ImageStore } from "../images";

/** Figma's sorts: "date" the threads' creation (`creationDate`), "recent" their last reply (`recent`), "unread" unread first */
export type CommentSort = "date" | "recent" | "unread";
export type CommentNotifications = "everything" | "mentions" | "nothing";

export interface CommentsView {
  data: CommentsState | null;
  /** The new comment being written: its place (page point, the top-level layer under it) */
  draft: CommentAnchor | null;
  /** The thread shown in its card */
  open: string | null;
  search: string;
  sort: CommentSort;
  showResolved: boolean;
  onlyMine: boolean;
  onlyPage: boolean;
  notifications: CommentNotifications;
  people: MentionCandidate[];
}

const PREFS_KEY = "designer.comments.prefs";
/** Figma attaches a comment to the top-level frame, component or group under it (R14 §attachment) */
const ATTACHABLE = new Set(["FRAME", "SYMBOL", "INSTANCE", "GROUP", "SECTION", "COMPONENT_SET"]);

function loadPrefs(): Partial<CommentsView> {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    const p = raw ? (JSON.parse(raw) as Partial<CommentsView>) : {};
    return { sort: p.sort === "unread" || p.sort === "recent" ? p.sort : "date", showResolved: p.showResolved === true, onlyMine: p.onlyMine === true, onlyPage: p.onlyPage === true, notifications: p.notifications === "mentions" || p.notifications === "nothing" ? p.notifications : "everything" };
  } catch {
    return {};
  }
}

let toldAboutReplies = false;

export class CommentsController {
  view: CommentsView;
  /** What the new-comment composer holds (a canvas click keeps a draft with text) */
  draftText = "";
  private listeners = new Set<() => void>();
  private off: (() => void) | null = null;
  private loading: Promise<void> | null = null;

  constructor(
    readonly ed: EditorController,
    readonly fileKey: string,
  ) {
    this.view = { data: null, draft: null, open: null, search: "", sort: "date", showResolved: false, onlyMine: false, onlyPage: false, notifications: "everything", people: [], ...loadPrefs() };
  }

  /** Follows the store while something shows comments */
  start(): void {
    if (this.off) return;
    this.off = getStoreClient().comments.watch((e) => {
      if (e.fileKey === this.fileKey) void this.reload();
    });
    void this.reload();
  }

  stop(): void {
    this.off?.();
    this.off = null;
  }

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  private set(patch: Partial<CommentsView>): void {
    this.view = { ...this.view, ...patch };
    if ("sort" in patch || "showResolved" in patch || "onlyMine" in patch || "onlyPage" in patch || "notifications" in patch) {
      try {
        const { sort, showResolved, onlyMine, onlyPage, notifications } = this.view;
        localStorage.setItem(PREFS_KEY, JSON.stringify({ sort, showResolved, onlyMine, onlyPage, notifications }));
      } catch {
        // per-viewer convenience only
      }
    }
    for (const l of this.listeners) l();
  }

  reload(): Promise<void> {
    const run = async () => {
      try {
        const data = await getStoreClient().comments.list(this.fileKey);
        const open = this.view.open && data.threads.some((t) => t.id === this.view.open) ? this.view.open : null;
        this.set({ data, open });
        this.refreshPeople();
      } catch (e) {
        console.warn("comments: couldn't read", e);
      }
    };
    // Reads one after another, the last one wins.
    this.loading = (this.loading ?? Promise.resolve()).then(run, run);
    return this.loading;
  }

  /** The people who can be @mentioned: everyone with access (the composer leaves you out) (asked again with each read and new comment: invites change it) */
  refreshPeople(): void {
    const data = this.view.data;
    if (!data?.shared) return;
    void getStoreClient().comments.mentionable(this.fileKey).then((people) => this.set({ people }), () => {});
  }

  private apply(p: Promise<CommentsState>, onError = "Couldn't save the comment"): Promise<CommentsState | null> {
    return p.then(
      (data) => {
        const open = this.view.open && data.threads.some((t) => t.id === this.view.open) ? this.view.open : null;
        this.set({ data, open });
        return data;
      },
      (e: unknown) => {
        showToast({ message: e instanceof Error && e.message ? e.message : t(onError), kind: "error" });
        return null;
      },
    );
  }

  // --- the UI's actions ---

  setSearch(search: string): void {
    this.set({ search });
  }
  setSort(sort: CommentSort): void {
    this.set({ sort });
  }
  toggle(key: "showResolved" | "onlyMine" | "onlyPage"): void {
    this.set({ [key]: !this.view[key] } as Partial<CommentsView>);
  }
  setNotifications(notifications: CommentNotifications): void {
    this.set({ notifications });
    // Figma's opt-in toast after a change (atlas 16 §2.8): 15 s, with Manage (the Comments panel, where the setting is).
    if (notifications === "nothing") return;
    showToast({
      message: notifications === "everything" ? t("You will be notified about all comments in this file") : t("You will be notified about replies and @mentions"),
      duration: 15_000,
      action: { label: t("Manage"), onAction: () => this.ed.setTool("COMMENT") },
    });
  }

  /** The Comment tool's click at a canvas point (CSS px): a new comment there. */
  startDraft(canvasX: number, canvasY: number): void {
    this.set({ draft: this.anchorAt(canvasX, canvasY), open: null });
    this.refreshPeople();
  }

  cancelDraft(): void {
    if (this.view.draft) this.set({ draft: null });
  }

  /** Where a comment's files go: the file's images (the store's blobs) — a local file's comments only for now */
  attachments(): ImageStore | undefined {
    return this.view.data && !this.view.data.shared ? this.ed.source.images : undefined;
  }

  /** The people a message mentions: those picked in the composer, and any "@Name" typed out */
  private mentions(message: string, picked: string[]): string[] {
    return [...new Set([...picked, ...mentionsIn(message, this.view.people)])];
  }

  async post(message: string, attachments: CommentAttachment[] = [], messageMeta: CommentSegment[] | null = null, picked: string[] = []): Promise<boolean> {
    const anchor = this.view.draft;
    if (!anchor || (!message.trim() && !attachments.length)) return false;
    const files = { ...(attachments.length ? { attachments } : {}), ...(messageMeta ? { messageMeta } : {}) };
    const data = await this.apply(getStoreClient().comments.add(this.fileKey, { message, mentions: this.mentions(message, picked), anchor, ...files }));
    if (!data) return false;
    this.set({ draft: null });
    if (!toldAboutReplies) {
      toldAboutReplies = true;
      showToast({ message: t("You will be notified about replies") });
    }
    return true;
  }

  async reply(threadId: string, message: string, attachments: CommentAttachment[] = [], messageMeta: CommentSegment[] | null = null, picked: string[] = []): Promise<boolean> {
    if (!message.trim() && !attachments.length) return false;
    const files = { ...(attachments.length ? { attachments } : {}), ...(messageMeta ? { messageMeta } : {}) };
    return !!(await this.apply(getStoreClient().comments.add(this.fileKey, { threadId, message, mentions: this.mentions(message, picked), ...files })));
  }

  async edit(commentId: string, message: string, messageMeta: CommentSegment[] | null = null, picked: string[] = []): Promise<boolean> {
    const had = this.view.data?.threads.some((th) => th.comments.some((c) => c.id === commentId && c.attachments?.length));
    if (!message.trim() && !had) return false;
    return !!(await this.apply(getStoreClient().comments.edit(this.fileKey, commentId, message, this.mentions(message, picked), messageMeta)));
  }

  /** Rich text in the composer: a local file's comments (a shared file's server keeps the plain text) */
  rich(): boolean {
    return !this.view.data?.shared;
  }

  async remove(commentId: string): Promise<void> {
    await this.apply(getStoreClient().comments.remove(this.fileKey, commentId), "Couldn't delete the comment");
  }

  async resolve(threadId: string, resolved: boolean): Promise<void> {
    const data = await this.apply(getStoreClient().comments.setResolved(this.fileKey, threadId, resolved));
    if (!data || !resolved) return;
    // Live: resolving closes the thread, "Comment resolved" · Undo.
    if (this.view.open === threadId) this.set({ open: null });
    showToast({ message: t("Comment resolved"), action: { label: t("Undo"), onAction: () => void this.resolve(threadId, false) } });
  }

  async markRead(threadIds: string[], read: boolean): Promise<void> {
    if (!threadIds.length) return;
    await this.apply(getStoreClient().comments.setRead(this.fileKey, threadIds, read));
  }

  markAllRead(): Promise<void> {
    return this.markRead((this.view.data?.threads ?? []).filter((t) => t.unread).map((t) => t.id), true);
  }

  async react(commentId: string, emoji: string, on: boolean): Promise<void> {
    await this.apply(getStoreClient().comments.react(this.fileKey, commentId, emoji, on));
  }

  /** A pin dropped at a canvas point (CSS px) */
  async move(threadId: string, canvasX: number, canvasY: number): Promise<void> {
    await this.apply(getStoreClient().comments.move(this.fileKey, threadId, this.anchorAt(canvasX, canvasY)));
  }

  /** Opens a thread's card (and reads it); `reveal`: from the list — its page, the view centred on it. */
  openThread(threadId: string | null, reveal = false): void {
    this.set({ open: threadId, draft: null });
    if (!threadId) return;
    const t = this.view.data?.threads.find((x) => x.id === threadId);
    if (!t) return;
    if (t.unread) void this.markRead([t.id], true);
    // A link to a resolved thread shows resolved threads (Figma turns the filter on).
    if (reveal && t.resolvedAt && !this.view.showResolved) this.set({ showResolved: true });
    if (reveal) {
      const ed = this.ed;
      if (t.anchor.pageId && t.anchor.pageId !== ed.store.page && ed.store.pages.some((p) => p.guid === t.anchor.pageId)) ed.engine.setCurrentPage(t.anchor.pageId as Guid);
      const at = this.pagePoint(t.anchor);
      ed.engine.centerOn(at.x, at.y, ed.engine.getCamera().zoom);
    }
  }

  copyLink(threadId: string): void {
    const thread = this.view.data?.threads.find((x) => x.id === threadId);
    const url = new URL(location.href);
    url.hash = `comment-${thread?.id ?? threadId}`;
    void navigator.clipboard?.writeText(url.toString()).then(
      () => showToast({ message: t("Copied link to clipboard") }),
      () => {},
    );
  }

  // --- geometry ---

  /** Where a thread is now, in page coordinates: its layer's top-left + offset (it moves with the layer), else its point */
  pagePoint(a: CommentAnchor): { x: number; y: number } {
    if (a.nodeId && a.offset) {
      const n = this.ed.store.readNode(a.nodeId as Guid) as (NodeChange & { removed?: boolean }) | null;
      if (n?.transform && n.parentIndex?.guid === a.pageId) return { x: n.transform.m02 + a.offset.x, y: n.transform.m12 + a.offset.y };
    }
    return { x: a.x, y: a.y };
  }

  /** The anchor for a canvas point (CSS px): the page point, and the top-level frame / component / group under it */
  anchorAt(canvasX: number, canvasY: number): CommentAnchor {
    const ed = this.ed;
    const cam = ed.engine.getCamera();
    const x = round((canvasX - cam.x) / cam.zoom);
    const y = round((canvasY - cam.y) / cam.zoom);
    const pageId = ed.store.page;
    for (const id of ed.engine.hitTest(canvasX, canvasY)) {
      let n: NodeChange | null = ed.store.readNode(id);
      for (let depth = 0; n && depth < 256; depth++) {
        const parent = n.parentIndex?.guid;
        if (parent === pageId) {
          if (ATTACHABLE.has(n.type ?? "") && n.transform) return { pageId, x, y, nodeId: n.guid, offset: { x: round(x - n.transform.m02), y: round(y - n.transform.m12) } };
          break;
        }
        n = parent ? ed.store.readNode(parent) : null;
      }
      break;
    }
    return { pageId, x, y, nodeId: null, offset: null };
  }
}

const round = (v: number) => Math.round(v * 100) / 100;

const registry = new WeakMap<EditorController, CommentsController>();

/** The editor's comments (null for a document that isn't a store file: the playground) */
export function commentsOf(ed: EditorController): CommentsController | null {
  const fileKey = (ed.source as unknown as { fileKey?: unknown }).fileKey;
  if (typeof fileKey !== "string") return null;
  let c = registry.get(ed);
  if (!c) registry.set(ed, (c = new CommentsController(ed, fileKey)));
  return c;
}

const EMPTY_VIEW: CommentsView = { data: null, draft: null, open: null, search: "", sort: "date", showResolved: false, onlyMine: false, onlyPage: false, notifications: "everything", people: [] };
const noop = () => () => {};

export function useComments(ed: EditorController): CommentsView {
  const c = commentsOf(ed);
  return useSyncExternalStore(c ? c.subscribe : noop, () => c?.view ?? EMPTY_VIEW);
}

/**
 * The threads the panel lists, as its search, sort and filters say (Figma's Sort/Filter menu, atlas 16 §2.8): resolved
 * threads hidden unless shown; "Only your threads" keeps those with a comment of yours or one mentioning you; a search
 * matching a reply finds its thread. "Sort by date" orders by the first comment's time, "Sort by last action" by the
 * last reply's, "Sort by unread" puts unread threads first, then by date — newest first in each.
 */
export function listedThreads(v: CommentsView, currentPage: string): CommentThread[] {
  const me = v.data?.me;
  const q = v.search.trim().toLowerCase();
  const mentionsMe = (mentions: string[]) => !!me && (mentions.includes(me.id) || (!!me.email && mentions.includes(me.email)));
  let list = (v.data?.threads ?? []).filter((t) => {
    if (t.resolvedAt && !v.showResolved) return false;
    if (v.onlyPage && t.anchor.pageId !== currentPage) return false;
    if (v.onlyMine && !t.comments.some((c) => c.user.id === me?.id || mentionsMe(c.mentions))) return false;
    if (q && !t.comments.some((c) => c.message.toLowerCase().includes(q) || c.user.name.toLowerCase().includes(q))) return false;
    return true;
  });
  const created = (t: CommentThread) => t.comments[0]?.createdAt ?? 0;
  const last = (t: CommentThread) => Math.max(0, ...t.comments.map((c) => c.createdAt));
  const key = v.sort === "recent" ? last : created;
  list = [...list].sort((a, b) => (v.sort === "unread" ? Number(b.unread) - Number(a.unread) : 0) || key(b) - key(a) || b.number - a.number);
  return list;
}
