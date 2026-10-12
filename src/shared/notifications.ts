/**
 * Notifications (docs/multiplayer.md §12; research docs/research/figma/R16-notifications.md): Figma's bell in Home —
 * comments, replies, @mentions and reactions on files you're in, invites, requests to edit and their answers, ownership
 * transferred to you. The server (D1, migration 0008, server/src/notifications.ts) makes them as things happen and
 * tells the person's inbox (a per-user Durable Object) at once; the store's `notifications` repository reads them, and
 * main shows the desktop ones. Types and pure helpers shared by the server, the store, main and the views.
 */

export type NotificationKind =
  /** A new thread on a file you're in (owner, or someone who commented twice on it — Figma's rule) */
  | "comment"
  /** A reply in a thread you started or replied in */
  | "reply"
  /** You were @mentioned in a comment */
  | "mention"
  /** Someone reacted in a thread you started or replied in */
  | "reaction"
  /** You were invited to a file */
  | "invite"
  /** Someone asked to edit your file (owner and editors; Requests tab, Approve / Deny) */
  | "edit-request"
  /** Your request to edit was approved */
  | "request-approved"
  /** Your request to edit was denied */
  | "request-denied"
  /** A file's owner made you its owner */
  | "ownership"
  /**
   * Round 5 (docs/editor.md D-4): a design in a file you viewed in Dev Mode was marked ready for dev / completed / updated
   * after a change ("Done with changes"). `text` is the design's name — for `dev_changed` the name, a line break and the
   * reason (`devStatusText` splits them). One person's rows of one kind on one file fold within an hour (`count`).
   */
  | "dev_ready"
  | "dev_completed"
  | "dev_changed"
  /**
   * Round 5 (docs/plugins.md §10.3): someone asked to approve a plugin or widget (org admins; `state` pending → approved
   * | denied when answered), and its answer (the requester; `state` approved | denied). `text` is the plugin's name,
   * `fileName` the org's; no file.
   */
  | "plugin_request"
  | "plugin_request_answer"
  /** The server's spend guard (docs/multiplayer.md §17.1), to its operators: `text` says which metric and how far */
  | "capacity_warning";

export interface NotificationActor {
  id: string;
  name: string;
  email: string | null;
  picture: string | null;
}

export interface NotificationItem {
  id: string;
  kind: NotificationKind;
  /** The shared file's room key (null when the file is gone) */
  fileKey: string | null;
  fileName: string;
  actor: NotificationActor;
  /** Comments: the thread and the latest comment it is about */
  threadId: string | null;
  commentId: string | null;
  /** The comment's text (a reaction: the comment reacted to) */
  text: string | null;
  /** A single reaction's emoji */
  emoji: string | null;
  /** An invite's role */
  role: "editor" | "viewer" | null;
  /** Grouped like Figma: "4 comments · <file>", "2 reactions · <file>" */
  count: number;
  /** A request: waiting for an answer, or how it was answered */
  state: "pending" | "approved" | "denied" | null;
  createdAt: number;
  /** The latest event folded into it (the list is newest first by this) */
  updatedAt: number;
  read: boolean;
  /** An organization's notification (an invite to a team, a request): its team's icon, else its org's — a server
   *  route as OrgSummary.iconUrl (docs/multiplayer.md §14.16); absent: none */
  placeIconUrl?: string;
}

export type NotificationFilter = "all" | "requests" | "unread";

export interface NotificationQuery {
  filter?: NotificationFilter;
  /** Only this file's ("All notifications ⌄" menu) */
  fileKey?: string | null;
  /** Paging: the `next` of the previous page */
  before?: string | null;
  limit?: number;
}

export interface NotificationPage {
  items: NotificationItem[];
  /** Unread notifications in total (the bell's dot and "Unread (n)") */
  unread: number;
  /** Requests still waiting (the Requests tab) */
  pending: number;
  /** Files the person has notifications from, newest first (the filter menu) */
  files: { key: string; name: string }[];
  /** The cursor of the next page, null at the end */
  next: string | null;
}

export type CommentsLevel = "all" | "mentions" | "none";

/** Settings › Notifications (the owner's 3.png / 4.png), as Figma words and orders them. */
export interface NotificationPrefs {
  desktop: { enabled: boolean; comments: CommentsLevel };
  /** Stored; no email is sent yet (docs/multiplayer.md §12) */
  email: {
    enabled: boolean;
    comments: CommentsLevel;
    invites: "all" | "response" | "none";
    community: CommentsLevel;
    workspace: "all" | "none";
    userGroups: "all" | "shared" | "none";
    digest: boolean;
  };
  productNews: boolean;
  /** Round 5 (docs/editor.md D-4): Settings › Notifications › Dev Mode — "Status changes" | "Nothing" on this computer */
  devMode: "status" | "none";
}

/** Figma's defaults: everything on (help.figma.com 360039813234: desktop and email notifications are on by default). */
export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  desktop: { enabled: true, comments: "all" },
  email: { enabled: true, comments: "all", invites: "all", community: "all", workspace: "all", userGroups: "all", digest: true },
  productNews: true,
  devMode: "status",
};

const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(v as T) ? (v as T) : fallback);
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === "boolean" ? v : fallback);

/** Any input made into valid preferences (missing or bad fields take the defaults). */
export function cleanPrefs(v: unknown): NotificationPrefs {
  const d = DEFAULT_NOTIFICATION_PREFS;
  const o = (v && typeof v === "object" ? v : {}) as Record<string, Record<string, unknown> | undefined>;
  const dk = o.desktop ?? {};
  const em = o.email ?? {};
  const levels = ["all", "mentions", "none"] as const;
  return {
    desktop: { enabled: bool(dk.enabled, d.desktop.enabled), comments: pick(dk.comments, levels, d.desktop.comments) },
    email: {
      enabled: bool(em.enabled, d.email.enabled),
      comments: pick(em.comments, levels, d.email.comments),
      invites: pick(em.invites, ["all", "response", "none"] as const, d.email.invites),
      community: pick(em.community, levels, d.email.community),
      workspace: pick(em.workspace, ["all", "none"] as const, d.email.workspace),
      userGroups: pick(em.userGroups, ["all", "shared", "none"] as const, d.email.userGroups),
      digest: bool(em.digest, d.email.digest),
    },
    productNews: bool((o as Record<string, unknown>).productNews, d.productNews),
    devMode: pick((o as Record<string, unknown>).devMode, ["status", "none"] as const, d.devMode),
  };
}

export const isCommentKind = (k: NotificationKind): boolean => k === "comment" || k === "reply" || k === "mention" || k === "reaction";
export const isDevStatusKind = (k: NotificationKind): boolean => k === "dev_ready" || k === "dev_completed" || k === "dev_changed";

/** Kinds whose rows fold within `DEV_STATUS_FOLD_MS` (one person, one kind, one file) — docs/editor.md D-4 */
export const DEV_STATUS_FOLD_MS = 60 * 60_000;

/** A Dev Mode status row's design name and (for `dev_changed`) its reason, from `text` */
export function devStatusText(text: string | null): { design: string; reason: string } {
  const t = text ?? "";
  const i = t.indexOf("\n");
  return i < 0 ? { design: t, reason: "" } : { design: t.slice(0, i), reason: t.slice(i + 1) };
}

/**
 * Is this notification one for the computer ("Send notifications to my computer")? File comments follow their choice —
 * "Only mentions and replies" takes mentions and what happens in your threads (replies, reactions: Figma's "replies or
 * reacts to threads you've created or participated in"); invites and requests always come.
 */
export function wantsDesktop(prefs: NotificationPrefs, kind: NotificationKind): boolean {
  if (!prefs.desktop.enabled) return false;
  // Settings › Notifications › Dev Mode: "Status changes" / "Nothing" (round 5)
  if (isDevStatusKind(kind)) return prefs.devMode !== "none";
  if (!isCommentKind(kind)) return true;
  const level = prefs.desktop.comments;
  if (level === "none") return false;
  if (level === "mentions") return kind !== "comment";
  return true;
}

/** The row's second line before " · <file>", in Figma's words ("Commented", "4 comments", "Reacted", "2 reactions"). */
export function notificationAction(n: Pick<NotificationItem, "kind" | "count" | "state" | "role"> & { text?: string | null }): string {
  const many = n.count > 1;
  switch (n.kind) {
    case "comment":
      return many ? `${n.count} comments` : "Commented";
    case "reply":
      return many ? `${n.count} comments` : "Replied";
    case "mention":
      return many ? `${n.count} comments` : "Mentioned you";
    case "reaction":
      return many ? `${n.count} reactions` : "Reacted";
    case "invite":
      return n.role === "viewer" ? "Invited you to view" : "Invited you to edit";
    case "edit-request":
      return "Requested to edit";
    case "request-approved":
      return "Approved your request to edit";
    case "request-denied":
      return "Denied your request to edit";
    case "ownership":
      return "Made you the owner";
    // Round 5's kinds (docs/editor.md D-4, docs/plugins.md §10.3). Figma's own bell text isn't published: these say
    // Figma's actions in the past tense — its buttons "Mark as ready for dev", "Mark as completed", "Done with changes"
    // (help.figma.com 26781702258583) and "Request approval" / Approve / Decline (4404228724759, 17882120337815).
    case "dev_ready":
    case "dev_completed":
    case "dev_changed": {
      const { design, reason } = devStatusText(n.text ?? null);
      const what = design || "a design";
      if (n.kind === "dev_ready") return many ? `Marked ${n.count} designs as ready for dev` : `Marked ${what} as ready for dev`;
      if (n.kind === "dev_completed") return many ? `Marked ${n.count} designs as completed` : `Marked ${what} as completed`;
      return many ? `Marked ${n.count} designs as ready for dev after changes` : `Marked ${what} as ready for dev after changes${reason ? `: ${reason}` : ""}`;
    }
    case "plugin_request":
      return `Requested approval for ${n.text || "a plugin"}`;
    case "plugin_request_answer":
      return n.state === "denied" ? `Declined your request for ${n.text || "a plugin"}` : `Approved your request for ${n.text || "a plugin"}`;
    case "capacity_warning":
      return "Usage warning";
  }
}

/** A desktop notification's title and body (macOS shows the app's name above them). */
export function desktopText(n: NotificationItem): { title: string; body: string } {
  const action = `${notificationAction(n)} · ${n.fileName}`;
  // Dev Mode and plugin rows carry their text in the action already
  const own = isDevStatusKind(n.kind) || n.kind === "plugin_request" || n.kind === "plugin_request_answer";
  return { title: n.actor.name, body: n.text && n.count === 1 && !own ? `${action}\n${n.text}` : action };
}

/** The link a desktop notification's click opens (designer://open, as the server's /f/<key> page hands it over; Home
 *  lands it — at the thread for a comment). */
export function notificationLink(n: Pick<NotificationItem, "fileKey" | "kind" | "threadId">): string | null {
  if (!n.fileKey) return null;
  const u = new URL("designer://open");
  u.searchParams.set("key", n.fileKey);
  if (isCommentKind(n.kind) && n.threadId) u.hash = `comment-${n.threadId}`;
  // Dev Mode status rows open the file in Dev Mode on its ready-for-dev view (OpenIntent.devMode "ready", D-4)
  if (isDevStatusKind(n.kind)) {
    u.searchParams.set("m", "dev");
    u.searchParams.set("dev", "ready");
  }
  return u.toString();
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The row's date as the owner's capture shows it ("Sep 21", "Aug 4"); another year adds it ("Aug 4, 2025"); today the
 *  time ("3:45 PM" — not seen live). */
export function notificationDate(at: number, now: number): string {
  const d = new Date(at);
  const n = new Date(now);
  if (d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()) {
    const h = d.getHours();
    return `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
  }
  const day = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return d.getFullYear() === n.getFullYear() ? day : `${day}, ${d.getFullYear()}`;
}

/** The live message on a person's inbox socket. */
export type InboxMessage = { t: "notifications"; unread: number; pending: number; item?: NotificationItem; desktop?: boolean };

/** The store's event on topic `notifications`. */
export interface NotificationsEvent {
  unread: number;
  pending: number;
  /** A new (or newly grouped) notification, and whether the person wants it on their computer */
  item?: NotificationItem;
  desktop?: boolean;
}

export interface NotificationsRepository {
  list(query?: NotificationQuery): Promise<NotificationPage>;
  /** `ids` (or every one with `all`) marked read, or unread with `read: false` */
  markRead(input: { ids?: string[]; all?: boolean; read?: boolean }): Promise<{ unread: number }>;
  prefs(): Promise<NotificationPrefs>;
  setPrefs(prefs: NotificationPrefs): Promise<NotificationPrefs>;
  /** A request's Approve / Deny from the Requests tab */
  answer(id: string, approve: boolean): Promise<NotificationPage>;
  watch(listener: (e: NotificationsEvent) => void): () => void;
}
