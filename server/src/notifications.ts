/**
 * Notifications (docs/multiplayer.md §12; migration 0008; research R16-notifications.md). Made here as things happen —
 * the comments routes, invites, "Ask to edit" and its answer, "Transfer ownership" call the `notify…` functions — and
 * pushed at once to the person's inbox (a per-user Durable Object, inbox.ts) so the bell updates without polling.
 *
 *   GET  /notifications?filter=all|requests|unread&file=<key>&before=<cursor>&limit=50
 *   POST /notifications/read                {ids?, all?, read?}        → {unread, pending}
 *   POST /notifications/:id/answer          {approve}                  a request's Approve / Deny → the first page
 *   GET  /notifications/prefs · PUT {…}                                 Settings › Notifications
 *   GET  /notifications/ws?token=                                       the inbox's WebSocket
 *
 * Who gets what (Figma, help.figma.com 360041547813 / 360039813234 / 4408435431319): a new comment goes to the file's
 * owner and to everyone who has left two or more comments on it; a reply to the thread's participants as well; an
 * @mention to the person mentioned; a reaction to the thread's participants; an invite to the person invited; a request
 * to edit to the owner and everyone who can edit; its answer to the person who asked. In-app notifications can't be
 * turned off (Figma); the person's preferences decide which also reach their computer. Email is stored, never sent.
 */
import { cleanPrefs, DEFAULT_NOTIFICATION_PREFS, DEV_STATUS_FOLD_MS, isDevStatusKind, wantsDesktop, type InboxMessage, type NotificationItem, type NotificationKind, type NotificationPage, type NotificationPrefs } from "../../src/shared/notifications";
import type { Deps } from "./api";
import type { User } from "./db";
import { canOpen } from "./org/db";
import { randomToken } from "./tokens";

/**
 * Organizations' kinds (docs/multiplayer.md §14.11; wording to be read from Figma's bell when the UI is built): stored
 * with no file (`file_key` null, `file_name` the team's or folder's name), `org_id` / `team_id` set. Kept here, outside
 * `src/shared/notifications.ts`'s `NotificationKind`, until the client renders them (round 1b/1c).
 */
export type OrgNotificationKind = "team_invite" | "project_invite" | "team_join_request" | "seat_request" | "seat_request_approved" | "seat_request_denied" | "guest_request" | "library_default_override";

/**
 * Branches' kinds (docs/data.md §15.5, docs/multiplayer.md §14.11; wording to be read from Figma's bell when the UI is
 * built), on the branch's file: `branch_review_request` (to each reviewer; `text` the description),
 * `branch_review` (to the person who asked; `state` the verdict — "approved" | "changes-suggested" —, `text` the
 * comment), `branch_merged` (to the branch's creator and reviewers). Server-side only, as `OrgNotificationKind`.
 */
export type BranchNotificationKind = "branch_review_request" | "branch_review" | "branch_merged";

/** Kinds answered with Approve / Deny: the Requests tab and the pending count (the org's are answered on their own routes) */
const REQUEST_KINDS = `('edit-request', 'team_join_request', 'seat_request', 'guest_request', 'plugin_request')`;

/**
 * What the store's org cache hears through the inbox (§14.6, §14.11; src/store/notifications/service.ts OrgNotice):
 * `{t: "org", what, orgId?, teamId?, parentId?, projectId?}`, `what` naming an OrgEvent of
 * src/shared/org/repositories.ts without its ".changed" / ".updated".
 */
export interface OrgNotice {
  /** "libraries": an org library's settings or scope changed (docs/data.md §16.7) */
  what: "orgs" | "org" | "teams" | "team" | "projects" | "files" | "libraries";
  orgId?: string;
  teamId?: string;
  parentId?: string | null;
  projectId?: string | null;
}

/** Like events fold into one unread row for this long (Figma batches comment notifications every 30 minutes). */
export const GROUP_MS = 30 * 60_000;
/** Figma's modal lists the 50 most recent */
export const PAGE = 50;

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
const fail = (status: number, error: string) => json({ error }, status);

interface Row {
  id: string;
  kind: NotificationKind;
  file_key: string | null;
  file_name: string;
  f_name: string | null;
  actor_id: string;
  a_name: string | null;
  a_email: string;
  a_picture: string | null;
  thread_id: string | null;
  comment_id: string | null;
  text: string | null;
  emoji: string | null;
  role: string | null;
  count: number;
  state: string | null;
  created_at: number;
  updated_at: number;
  read_at: number | null;
}

const toItem = (r: Row): NotificationItem => ({
  id: r.id,
  kind: r.kind,
  fileKey: r.file_key,
  fileName: r.f_name ?? r.file_name,
  actor: { id: r.actor_id, name: r.a_name || r.a_email, email: r.a_email, picture: r.a_picture },
  threadId: r.thread_id,
  commentId: r.comment_id,
  text: r.text,
  emoji: r.emoji,
  role: r.role === "viewer" || r.role === "editor" ? r.role : null,
  count: r.count,
  // A branch review's verdict ("changes-suggested" is outside NotificationItem's union until the client learns it).
  state: r.state === "pending" || r.state === "approved" || r.state === "denied" ? r.state : r.kind === ("branch_review" as NotificationKind) && r.state ? (r.state as NotificationItem["state"]) : null,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  read: r.read_at !== null,
});

const SELECT = `SELECT n.*, u.name AS a_name, u.email AS a_email, u.picture AS a_picture, f.name AS f_name
  FROM notifications n JOIN users u ON u.id = n.actor_id LEFT JOIN files f ON f.key = n.file_key`;

/** The routes under /notifications (dispatched by one line in api.ts). `answer` is api.ts's Approve / Deny. */
export async function notificationsRoute(
  req: Request,
  deps: Deps,
  user: User,
  parts: string[],
  answer: (key: string, requesterId: string, approve: boolean) => Promise<boolean>,
): Promise<Response> {
  const m = req.method;
  const url = new URL(req.url);
  if (parts.length === 1 && m === "GET") {
    const filter = url.searchParams.get("filter");
    const limit = Math.max(1, Math.min(PAGE, Number(url.searchParams.get("limit")) || PAGE));
    return json(await page(deps, user.id, { filter: filter === "requests" || filter === "unread" ? filter : "all", fileKey: url.searchParams.get("file"), orgId: url.searchParams.get("org"), teamId: url.searchParams.get("team"), before: url.searchParams.get("before"), limit }));
  }
  if (parts.length === 2 && parts[1] === "ws" && m === "GET") {
    if (!deps.inboxes) return fail(503, "live notifications aren't available here");
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return fail(426, "expected a WebSocket");
    return deps.inboxes.connect(user.id, req);
  }
  if (parts.length === 2 && parts[1] === "read" && m === "POST") {
    const body = await readJson(req);
    if (!body) return fail(400, "expected a JSON object");
    const at = body.read === false ? null : deps.now();
    if (body.all === true) await deps.db.d1.prepare(`UPDATE notifications SET read_at = ?2 WHERE user_id = ?1 AND (read_at IS NULL) = (?2 IS NOT NULL)`).bind(user.id, at).run();
    else {
      const ids = Array.isArray(body.ids) ? body.ids.filter((s): s is string => typeof s === "string").slice(0, 500) : null;
      if (!ids) return fail(400, "ids or all");
      for (const id of ids) await deps.db.d1.prepare(`UPDATE notifications SET read_at = ?3 WHERE id = ?1 AND user_id = ?2`).bind(id, user.id, at).run();
    }
    const counts = await countsOf(deps, user.id);
    await push(deps, user.id);
    return json(counts);
  }
  if (parts.length === 2 && parts[1] === "prefs") {
    if (m === "GET") return json(await prefsOf(deps, user.id));
    if (m === "PUT") {
      const prefs = cleanPrefs(await readJson(req));
      await deps.db.d1
        .prepare(`INSERT INTO notification_prefs (user_id, prefs, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT (user_id) DO UPDATE SET prefs = ?2, updated_at = ?3`)
        .bind(user.id, JSON.stringify(prefs), deps.now())
        .run();
      return json(prefs);
    }
    return fail(405, "method not allowed");
  }
  if (parts.length === 3 && parts[2] === "answer" && m === "POST") {
    const body = await readJson(req);
    const n = await deps.db.d1.prepare(`SELECT kind, file_key, actor_id, state FROM notifications WHERE id = ?1 AND user_id = ?2`).bind(parts[1], user.id).first<{ kind: string; file_key: string | null; actor_id: string; state: string | null }>();
    if (!n || n.kind !== "edit-request" || !n.file_key) return fail(404, "no such request");
    const access = await canOpen(deps, n.file_key, user.id);
    if (access?.role !== "owner" && access?.role !== "editor") return fail(403, "only people who can edit the file can answer");
    // Already answered (by someone else): nothing to do, the row shows how.
    if (n.state === "pending" && !(await answer(n.file_key, n.actor_id, body?.approve === true))) await settle(deps, n.file_key, n.actor_id, "denied");
    return json(await page(deps, user.id, { filter: url.searchParams.get("filter") === "requests" ? "requests" : "all", fileKey: null, orgId: null, teamId: null, before: null, limit: PAGE }));
  }
  return fail(404, "not found");
}

async function page(deps: Deps, userId: string, q: { filter: "all" | "requests" | "unread"; fileKey: string | null; orgId: string | null; teamId: string | null; before: string | null; limit: number }): Promise<NotificationPage> {
  const where = [`n.user_id = ?1`];
  const args: unknown[] = [userId];
  if (q.filter === "requests") where.push(`n.kind IN ${REQUEST_KINDS}`);
  if (q.filter === "unread") where.push(`n.read_at IS NULL`);
  if (q.fileKey) {
    args.push(q.fileKey);
    where.push(`n.file_key = ?${args.length}`);
  }
  // The bell's "All notifications ⌄": one organization (or "none": outside any), one team (§14.11).
  if (q.orgId) {
    if (q.orgId === "none") where.push(`n.org_id IS NULL`);
    else {
      args.push(q.orgId);
      where.push(`n.org_id = ?${args.length}`);
    }
  }
  if (q.teamId) {
    args.push(q.teamId);
    where.push(`n.team_id = ?${args.length}`);
  }
  const cursor = /^(\d+)_(.+)$/.exec(q.before ?? "");
  if (cursor) {
    args.push(Number(cursor[1]), cursor[2]);
    where.push(`(n.updated_at < ?${args.length - 1} OR (n.updated_at = ?${args.length - 1} AND n.id < ?${args.length}))`);
  }
  args.push(q.limit + 1);
  const { results } = await deps.db.d1
    .prepare(`${SELECT} WHERE ${where.join(" AND ")} ORDER BY n.updated_at DESC, n.id DESC LIMIT ?${args.length}`)
    .bind(...args)
    .all<Row>();
  const more = results.length > q.limit;
  const items = results.slice(0, q.limit).map(toItem);
  const { results: files } = await deps.db.d1
    .prepare(
      `SELECT n.file_key AS key, COALESCE(f.name, MAX(n.file_name)) AS name, MAX(n.updated_at) AS at FROM notifications n LEFT JOIN files f ON f.key = n.file_key
       WHERE n.user_id = ?1 AND n.file_key IS NOT NULL GROUP BY n.file_key ORDER BY at DESC LIMIT 50`,
    )
    .bind(userId)
    .all<{ key: string; name: string }>();
  const last = items[items.length - 1];
  return { items, ...(await countsOf(deps, userId)), files: files.map((f) => ({ key: f.key, name: f.name })), next: more && last ? `${last.updatedAt}_${last.id}` : null };
}

async function countsOf(deps: Deps, userId: string): Promise<{ unread: number; pending: number }> {
  const r = await deps.db.d1
    .prepare(`SELECT SUM(read_at IS NULL) AS unread, SUM(kind IN ${REQUEST_KINDS} AND state = 'pending') AS pending FROM notifications WHERE user_id = ?1`)
    .bind(userId)
    .first<{ unread: number | null; pending: number | null }>();
  return { unread: r?.unread ?? 0, pending: r?.pending ?? 0 };
}

export async function prefsOf(deps: Deps, userId: string): Promise<NotificationPrefs> {
  const r = await deps.db.d1.prepare(`SELECT prefs FROM notification_prefs WHERE user_id = ?1`).bind(userId).first<{ prefs: string }>();
  if (!r) return DEFAULT_NOTIFICATION_PREFS;
  try {
    return cleanPrefs(JSON.parse(r.prefs));
  } catch {
    return DEFAULT_NOTIFICATION_PREFS;
  }
}

/** Tells the person's inbox: the counts, and the new notification (with whether it goes to their computer). */
async function push(deps: Deps, userId: string, item?: NotificationItem): Promise<void> {
  if (!deps.inboxes) return;
  try {
    const counts = await countsOf(deps, userId);
    const msg: InboxMessage = { t: "notifications", ...counts };
    if (item) {
      msg.item = item;
      msg.desktop = wantsDesktop(await prefsOf(deps, userId), item.kind);
    }
    await deps.inboxes.notify(userId, msg);
  } catch (e) {
    // Stored; the bell shows it on its next read.
    console.error("notifications: inbox push failed", e);
  }
}

interface NewNotification {
  userId: string;
  kind: NotificationKind;
  fileKey: string | null;
  actorId: string;
  threadId?: string | null;
  commentId?: string | null;
  text?: string | null;
  emoji?: string | null;
  role?: string | null;
  state?: string | null;
  /** Org kinds: the org, team and the name shown (no file) */
  place?: { orgId: string; teamId: string | null; name: string };
}

/** Stores one (folding it into a recent unread one of the same kind of event from the same person on the same file). */
async function deliver(deps: Deps, n: NewNotification): Promise<void> {
  const d1 = deps.db.d1;
  const now = deps.now();
  const place = n.fileKey ? await d1.prepare(`SELECT name, org_id, team_id FROM files WHERE key = ?1`).bind(n.fileKey).first<{ name: string; org_id: string | null; team_id: string | null }>() : null;
  const fileName = place?.name ?? n.place?.name ?? "";
  const orgId = place?.org_id ?? n.place?.orgId ?? null;
  const teamId = place?.team_id ?? n.place?.teamId ?? null;
  // Comments and replies fold into "N comments", reactions into "N reactions"; a mention keeps its own row. Dev Mode
  // statuses fold by kind within an hour (round 5, docs/editor.md D-4: "3 designs marked ready for dev").
  const dev = isDevStatusKind(n.kind);
  const family = n.kind === "comment" || n.kind === "reply" ? `'comment', 'reply'` : n.kind === "reaction" ? `'reaction'` : dev ? `'${n.kind}'` : null;
  const foldMs = dev ? DEV_STATUS_FOLD_MS : GROUP_MS;
  let id: string | null = null;
  if (family) {
    const g = await d1
      .prepare(
        `SELECT id FROM notifications WHERE user_id = ?1 AND file_key = ?2 AND actor_id = ?3 AND read_at IS NULL AND kind IN (${family}) AND updated_at >= ?4
         ORDER BY updated_at DESC LIMIT 1`,
      )
      .bind(n.userId, n.fileKey, n.actorId, now - foldMs)
      .first<{ id: string }>();
    if (g) {
      id = g.id;
      await d1
        .prepare(`UPDATE notifications SET count = count + 1, kind = ?2, thread_id = ?3, comment_id = ?4, text = ?5, emoji = ?6, file_name = ?7, updated_at = ?8 WHERE id = ?1`)
        .bind(id, n.kind, n.threadId ?? null, n.commentId ?? null, n.text ?? null, n.emoji ?? null, fileName, now)
        .run();
    }
  }
  if (!id) {
    id = `n_${randomToken(12)}`;
    await d1
      .prepare(
        `INSERT INTO notifications (id, user_id, kind, file_key, file_name, actor_id, thread_id, comment_id, text, emoji, role, state, created_at, updated_at, org_id, team_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13, ?14, ?15)`,
      )
      .bind(id, n.userId, n.kind, n.fileKey, fileName, n.actorId, n.threadId ?? null, n.commentId ?? null, n.text ?? null, n.emoji ?? null, n.role ?? null, n.state ?? null, now, orgId, teamId)
      .run();
  }
  const row = await d1.prepare(`${SELECT} WHERE n.id = ?1`).bind(id).first<Row>();
  await push(deps, n.userId, row ? toItem(row) : undefined);
}

/** Each step is its own: a failure leaves the action that caused it done (the notification is lost, not the comment). */
async function safely(what: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    console.error(`notifications: ${what} failed`, e);
  }
}

/** People who can open the file now (resolveAccess, §14.9: owner, members, teams, folders, groups, audience, the link) */
async function withAccess(deps: Deps, key: string, ids: Iterable<string>): Promise<string[]> {
  const out: string[] = [];
  for (const id of new Set(ids)) if (await canOpen(deps, key, id)) out.push(id);
  return out;
}

/** A new comment (a thread, or a reply in `threadId`) by `by`. */
export async function notifyComment(deps: Deps, c: { key: string; by: User; commentId: string; threadId: string; reply: boolean; message: string; mentions: string[] }): Promise<void> {
  await safely("a comment", async () => {
    const d1 = deps.db.d1;
    const file = await deps.db.file(c.key);
    if (!file) return;
    const mentioned = await resolveMentions(deps, c.mentions);
    const { results: participants } = await d1.prepare(`SELECT DISTINCT user_id FROM comments WHERE thread_id = ?1`).bind(c.threadId).all<{ user_id: string }>();
    // Figma: "If you're not the file owner and leave two or more comments on a file, you'll be notified about all new comments".
    const { results: regulars } = await d1.prepare(`SELECT user_id FROM comments WHERE file_key = ?1 GROUP BY user_id HAVING COUNT(*) >= 2`).bind(c.key).all<{ user_id: string }>();
    const inThread = new Set(participants.map((p) => p.user_id));
    const candidates = [file.ownerId, ...regulars.map((r) => r.user_id), ...mentioned, ...(c.reply ? inThread : [])];
    for (const userId of await withAccess(deps, c.key, candidates)) {
      if (userId === c.by.id) continue;
      const kind: NotificationKind = mentioned.includes(userId) ? "mention" : c.reply && inThread.has(userId) ? "reply" : "comment";
      await deliver(deps, { userId, kind, fileKey: c.key, actorId: c.by.id, threadId: c.threadId, commentId: c.commentId, text: c.message });
    }
  });
}

/** A reaction on a comment: the thread's participants hear of it (Figma: "replies or reacts to threads you've created or participated in"). */
export async function notifyReaction(deps: Deps, r: { key: string; by: User; commentId: string; threadId: string; emoji: string }): Promise<void> {
  await safely("a reaction", async () => {
    const d1 = deps.db.d1;
    const comment = await d1.prepare(`SELECT message FROM comments WHERE id = ?1`).bind(r.commentId).first<{ message: string }>();
    const { results } = await d1.prepare(`SELECT DISTINCT user_id FROM comments WHERE thread_id = ?1`).bind(r.threadId).all<{ user_id: string }>();
    for (const userId of await withAccess(deps, r.key, results.map((x) => x.user_id))) {
      if (userId === r.by.id) continue;
      await deliver(deps, { userId, kind: "reaction", fileKey: r.key, actorId: r.by.id, threadId: r.threadId, commentId: r.commentId, text: comment?.message ?? null, emoji: r.emoji });
    }
  });
}

/** Comments deleted: their notifications go too (the counts of the others are left). */
export async function forgetComments(deps: Deps, key: string, commentIds: string[]): Promise<void> {
  await safely("forgetting comments", async () => {
    const users = new Set<string>();
    for (const id of commentIds) {
      const { results } = await deps.db.d1.prepare(`DELETE FROM notifications WHERE file_key = ?1 AND (comment_id = ?2 OR thread_id = ?2) RETURNING user_id`).bind(key, id).all<{ user_id: string }>();
      for (const r of results) users.add(r.user_id);
    }
    for (const u of users) await push(deps, u);
  });
}

/** Invited to a file (a new member who already has an account). */
export async function notifyInvite(deps: Deps, i: { key: string; by: User; userId: string; role: "editor" | "viewer" }): Promise<void> {
  await safely("an invite", () => deliver(deps, { userId: i.userId, kind: "invite", fileKey: i.key, actorId: i.by.id, role: i.role }));
}

/** "Ask to edit": the owner and everyone who can edit (Figma: they can approve or deny). One pending row per asker. */
export async function notifyEditRequest(deps: Deps, r: { key: string; by: User }): Promise<void> {
  await safely("a request", async () => {
    const d1 = deps.db.d1;
    const file = await deps.db.file(r.key);
    if (!file) return;
    const { results } = await d1.prepare(`SELECT user_id FROM members WHERE file_key = ?1 AND role = 'editor' AND user_id IS NOT NULL`).bind(r.key).all<{ user_id: string }>();
    for (const userId of new Set([file.ownerId, ...results.map((x) => x.user_id)])) {
      if (userId === r.by.id) continue;
      const open = await d1.prepare(`SELECT id FROM notifications WHERE user_id = ?1 AND file_key = ?2 AND actor_id = ?3 AND kind = 'edit-request' AND state = 'pending'`).bind(userId, r.key, r.by.id).first();
      if (open) continue;
      await deliver(deps, { userId, kind: "edit-request", fileKey: r.key, actorId: r.by.id, state: "pending" });
    }
  });
}

/** Marks the request's rows answered, for everyone who got them. */
async function settle(deps: Deps, key: string, requesterId: string, state: "approved" | "denied"): Promise<string[]> {
  const { results } = await deps.db.d1
    .prepare(`UPDATE notifications SET state = ?3 WHERE file_key = ?1 AND actor_id = ?2 AND kind = 'edit-request' AND state = 'pending' RETURNING user_id`)
    .bind(key, requesterId, state)
    .all<{ user_id: string }>();
  return results.map((r) => r.user_id);
}

/** A request to edit answered by `by`: the rows show it, and the person who asked is told. */
export async function notifyRequestAnswered(deps: Deps, a: { key: string; by: User; requesterId: string; approve: boolean }): Promise<void> {
  await safely("an answer", async () => {
    for (const u of await settle(deps, a.key, a.requesterId, a.approve ? "approved" : "denied")) await push(deps, u);
    await deliver(deps, { userId: a.requesterId, kind: a.approve ? "request-approved" : "request-denied", fileKey: a.key, actorId: a.by.id });
  });
}

/** "Transfer ownership": the new owner is told. */
export async function notifyOwnership(deps: Deps, o: { key: string; by: User; toId: string }): Promise<void> {
  await safely("ownership", () => deliver(deps, { userId: o.toId, kind: "ownership", fileKey: o.key, actorId: o.by.id }));
}

/** "Request review" on a branch: each reviewer who can open it (not the asker). */
export async function notifyBranchReview(deps: Deps, r: { key: string; by: User; reviewerIds: string[]; description: string }): Promise<void> {
  await safely("a branch review request", async () => {
    for (const userId of await withAccess(deps, r.key, r.reviewerIds)) {
      if (userId === r.by.id) continue;
      await deliver(deps, { userId, kind: "branch_review_request" as NotificationKind, fileKey: r.key, actorId: r.by.id, text: r.description || null, state: "pending" });
    }
  });
}

/** A reviewer's verdict: the person who asked is told; their request rows show it answered. */
export async function notifyBranchVerdict(deps: Deps, v: { key: string; by: User; toId: string; verdict: "approved" | "changes-suggested"; comment: string }): Promise<void> {
  await safely("a branch review", async () => {
    await deps.db.d1.prepare(`UPDATE notifications SET state = ?3 WHERE file_key = ?1 AND user_id = ?2 AND kind = 'branch_review_request' AND state = 'pending'`).bind(v.key, v.by.id, v.verdict).run();
    if (v.toId !== v.by.id) await deliver(deps, { userId: v.toId, kind: "branch_review" as NotificationKind, fileKey: v.key, actorId: v.by.id, text: v.comment || null, state: v.verdict });
  });
}

/** A branch merged into its main file: its creator and reviewers (not the merger). */
export async function notifyBranchMerged(deps: Deps, m: { key: string; by: User; userIds: string[] }): Promise<void> {
  await safely("a branch merge", async () => {
    for (const userId of await withAccess(deps, m.key, m.userIds)) {
      if (userId !== m.by.id) await deliver(deps, { userId, kind: "branch_merged" as NotificationKind, fileKey: m.key, actorId: m.by.id });
    }
  });
}

/**
 * A Dev Mode status change (round 5, docs/editor.md D-4; devmode/status.ts picks who): each person told once, folded
 * with their unread rows of the same kind from the same person on the same file within the hour. `text` is the
 * design's name (and, for "changed", a line break and the reason — `devStatusText`).
 */
export async function notifyDevStatus(deps: Deps, d: { key: string; by: User; kind: "dev_ready" | "dev_completed" | "dev_changed"; design: string; reason?: string; userIds: string[] }): Promise<void> {
  await safely("a Dev Mode status", async () => {
    const design = d.design.replace(/\s+/g, " ").trim().slice(0, 200);
    const text = d.kind === "dev_changed" && d.reason ? `${design}\n${d.reason.trim().slice(0, 500)}` : design;
    for (const userId of new Set(d.userIds)) if (userId !== d.by.id) await deliver(deps, { userId, kind: d.kind, fileKey: d.key, actorId: d.by.id, text });
  });
}

/** "Request approval" for a plugin or widget (round 5, docs/plugins.md §10.3): every admin given, a pending row each. */
export async function notifyPluginRequest(deps: Deps, r: { orgId: string; orgName: string; by: User; adminIds: string[]; pluginName: string }): Promise<void> {
  await safely("a plugin request", async () => {
    for (const userId of new Set(r.adminIds)) {
      if (userId !== r.by.id) await deliver(deps, { userId, kind: "plugin_request", fileKey: null, actorId: r.by.id, text: r.pluginName, state: "pending", place: { orgId: r.orgId, teamId: null, name: r.orgName } });
    }
  });
}

/** A plugin request answered: the admins' rows show how (by org, requester and plugin name), the requester is told. */
export async function notifyPluginAnswer(deps: Deps, a: { orgId: string; orgName: string; by: User; requesterId: string; pluginName: string; approve: boolean }): Promise<void> {
  await safely("a plugin answer", async () => {
    const state = a.approve ? "approved" : "denied";
    const { results } = await deps.db.d1
      .prepare(`UPDATE notifications SET state = ?4 WHERE kind = 'plugin_request' AND org_id = ?1 AND actor_id = ?2 AND text = ?3 AND state = 'pending' RETURNING user_id`)
      .bind(a.orgId, a.requesterId, a.pluginName, state)
      .all<{ user_id: string }>();
    for (const u of new Set(results.map((x) => x.user_id))) await push(deps, u);
    if (a.requesterId !== a.by.id) await deliver(deps, { userId: a.requesterId, kind: "plugin_request_answer", fileKey: null, actorId: a.by.id, text: a.pluginName, state, place: { orgId: a.orgId, teamId: null, name: a.orgName } });
  });
}

/** @mentions are user ids, emails of people invited without an account yet (who have no inbox), or `g:<groupId>` — a
 *  user group, each member told per their own preferences (§14.11; withAccess keeps those who can open the file). */
async function resolveMentions(deps: Deps, mentions: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const m of mentions) {
    if (m.startsWith("g:")) {
      const { results } = await deps.db.d1.prepare(`SELECT user_id FROM user_group_members WHERE group_id = ?1`).bind(m.slice(2)).all<{ user_id: string }>();
      out.push(...results.map((r) => r.user_id));
    } else if (m.includes("@")) {
      const u = await deps.db.d1.prepare(`SELECT id FROM users WHERE email = ?1 ORDER BY created_at LIMIT 1`).bind(m.trim().toLowerCase()).first<{ id: string }>();
      if (u) out.push(u.id);
    } else out.push(m);
  }
  return out;
}

/** An organization's notification (§14.11): no file, the team's or folder's name, `org_id` / `team_id` set. */
export async function notifyOrg(deps: Deps, n: { userId: string; kind: OrgNotificationKind; actorId: string; orgId: string; teamId?: string | null; name: string; text?: string | null; role?: string | null; state?: string | null }): Promise<void> {
  if (n.userId === n.actorId) return;
  await safely(n.kind, () => deliver(deps, { userId: n.userId, kind: n.kind as NotificationKind, fileKey: null, actorId: n.actorId, text: n.text, role: n.role, state: n.state, place: { orgId: n.orgId, teamId: n.teamId ?? null, name: n.name } }));
}

/** A pending org request answered: the rows of everyone who got it show how (by kind, org, team and the asker). */
export async function settleOrg(deps: Deps, kind: OrgNotificationKind, orgId: string, actorId: string, state: "approved" | "denied", teamId?: string | null): Promise<void> {
  await safely("an org answer", async () => {
    const { results } = await deps.db.d1
      .prepare(`UPDATE notifications SET state = ?4 WHERE kind = ?1 AND org_id = ?2 AND actor_id = ?3 AND state = 'pending' AND (?5 IS NULL OR team_id = ?5) RETURNING user_id`)
      .bind(kind, orgId, actorId, state, teamId ?? null)
      .all<{ user_id: string }>();
    for (const u of new Set(results.map((r) => r.user_id))) await push(deps, u);
  });
}

/** `{t: "org", …}` to these people's open apps: their org cache refreshes (§14.6). Never fails the action. */
export async function orgNotice(deps: Deps, userIds: Iterable<string>, notice: OrgNotice): Promise<void> {
  if (!deps.inboxes) return;
  for (const id of new Set(userIds)) {
    try {
      await deps.inboxes.notify(id, { t: "org", ...notice });
    } catch (e) {
      console.error("notifications: org notice failed", e);
    }
  }
}

/**
 * Any inbox message to these people's open apps — the libraries' `{t: "library", libraryKey, version | status}` and
 * the shared fonts' `{t: "fonts", orgId, version}` (docs/data.md §16.7, docs/desktop.md §14.3). Never fails the action.
 */
export async function inboxMessage(deps: Deps, userIds: Iterable<string>, message: unknown): Promise<void> {
  if (!deps.inboxes) return;
  for (const id of new Set(userIds)) {
    try {
      await deps.inboxes.notify(id, message);
    } catch (e) {
      console.error("notifications: inbox message failed", e);
    }
  }
}

/**
 * "‹person› turned off ‹library› for ‹team›" (docs/data.md §16.5; wording unverified): a workspace or team turned off a
 * default of a library approved above it. Stored with no file: the library's name in `file_name` (§16.11 notes), the
 * workspace's or team's name in `text`.
 */
export async function notifyLibraryOverride(deps: Deps, n: { userIds: string[]; actorId: string; orgId: string; teamId: string | null; libraryName: string; scopeName: string }): Promise<void> {
  for (const userId of new Set(n.userIds)) await notifyOrg(deps, { userId, kind: "library_default_override", actorId: n.actorId, orgId: n.orgId, teamId: n.teamId, name: n.libraryName, text: n.scopeName });
}

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const v = (await req.json()) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
