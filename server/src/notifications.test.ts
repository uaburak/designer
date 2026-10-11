import { beforeEach, describe, expect, it } from "vitest";
import type { InboxMessage, NotificationPage, NotificationPrefs } from "../../src/shared/notifications";
import { handle, type Deps } from "./api";
import { Db } from "./db";
import { GROUP_MS } from "./notifications";
import { sqliteD1 } from "./testing/sqliteD1";

const ORIGIN = "https://designer.example.workers.dev";

let deps: Deps;
let inbox: { userId: string; msg: InboxMessage }[];
let now: number;

beforeEach(() => {
  now = Date.UTC(2026, 9, 11);
  inbox = [];
  deps = {
    db: new Db(sqliteD1()),
    env: { SESSION_SECRET: "s".repeat(40), DEV_AUTH: "1" },
    rooms: { fetch: async () => Response.json({ ok: true }) },
    inboxes: {
      async notify(userId, msg) {
        inbox.push({ userId, msg: msg as InboxMessage });
      },
      connect: async () => new Response(null, { status: 204 }),
    },
    now: () => now,
    fetch: async () => new Response("no", { status: 500 }),
  };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const call = async (method: string, path: string, token?: string, body?: unknown): Promise<{ status: number; body: any }> => {
  now += 1; // every call a little later: a stable newest-first order
  const res = await handle(
    new Request(ORIGIN + path, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    deps,
  );
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
};

async function signIn(email: string) {
  const r = await call("POST", "/auth/dev", undefined, { email, name: email.split("@")[0] });
  return r.body as { token: string; user: { id: string } };
}

const KEY = "file_n00001";
const anchor = { pageId: "0:1", x: 10, y: 20 };
const comments = `/files/${KEY}/comments`;
const list = async (token: string, q = ""): Promise<NotificationPage> => (await call("GET", `/notifications${q}`, token)).body as NotificationPage;

async function setup() {
  const owner = await signIn("owner@x.co");
  const editor = await signIn("ed@x.co");
  const viewer = await signIn("view@x.co");
  await call("POST", "/files", owner.token, { key: KEY, name: "Insider V3" });
  await call("PUT", `/files/${KEY}/members`, owner.token, { email: "ed@x.co", role: "editor" });
  await call("PUT", `/files/${KEY}/members`, owner.token, { email: "view@x.co", role: "viewer" });
  await deps.db.d1.prepare(`DELETE FROM notifications`).run(); // the invites: each test starts with none
  inbox.length = 0;
  return { owner, editor, viewer };
}

describe("notifications", () => {
  it("an invite tells the person invited, live; a role change doesn't", async () => {
    const owner = await signIn("owner@x.co");
    const ed = await signIn("ed@x.co");
    await call("POST", "/files", owner.token, { key: KEY, name: "Insider V3" });
    await call("PUT", `/files/${KEY}/members`, owner.token, { email: "ed@x.co", role: "editor" });
    const p = await list(ed.token);
    expect(p.items).toHaveLength(1);
    expect(p.items[0]).toMatchObject({ kind: "invite", fileKey: KEY, fileName: "Insider V3", role: "editor", read: false, actor: { id: owner.user.id, name: "owner" } });
    expect(p.unread).toBe(1);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ userId: ed.user.id, msg: { t: "notifications", unread: 1, desktop: true, item: { kind: "invite" } } });
    await call("PUT", `/files/${KEY}/members`, owner.token, { email: "ed@x.co", role: "viewer" });
    expect((await list(ed.token)).items).toHaveLength(1);
  });

  it("comments reach the owner, the thread's people and the mentioned; grouped like Figma", async () => {
    const { owner, editor, viewer } = await setup();
    // A viewer's new thread: the owner hears of it (Figma: the owner gets all comments); the editor doesn't (yet).
    const t = (await call("POST", comments, viewer.token, { message: "bence tekli row olsun", anchor })).body.threads[0];
    let o = await list(owner.token);
    expect(o.items.map((n) => [n.kind, n.text, n.count])).toEqual([["comment", "bence tekli row olsun", 1]]);
    expect(o.items[0]).toMatchObject({ threadId: t.id, commentId: t.id, actor: { id: viewer.user.id } });
    expect((await list(editor.token)).items).toEqual([]);
    expect((await list(viewer.token)).items).toEqual([]);
    // Three more from the viewer within 30 minutes fold into "4 comments" (the latest's text kept).
    for (const msg of ["two", "three", "four"]) {
      now += 60_000;
      await call("POST", comments, viewer.token, { threadId: t.id, message: msg });
    }
    o = await list(owner.token);
    expect(o.items).toHaveLength(1);
    expect(o.items[0]).toMatchObject({ count: 4, text: "four" });
    // After 30 minutes, or once read, a new row starts.
    now += GROUP_MS + 1;
    await call("POST", comments, viewer.token, { threadId: t.id, message: "later" });
    expect((await list(owner.token)).items.map((n) => n.count)).toEqual([1, 4]);
    // The editor replies: the viewer (in the thread) gets a reply; the owner too.
    await call("POST", comments, editor.token, { threadId: t.id, message: "ok" });
    expect((await list(viewer.token)).items[0]).toMatchObject({ kind: "reply", text: "ok" });
    // An @mention reaches the person mentioned, as "Mentioned you", in its own row.
    await call("POST", comments, owner.token, { message: "@ed look", mentions: [editor.user.id], anchor });
    const e = await list(editor.token);
    expect(e.items[0]).toMatchObject({ kind: "mention", text: "@ed look", count: 1 });
    // Someone who has left two comments hears of every new one (Figma's rule): the viewer, here.
    await call("POST", comments, editor.token, { message: "new thread", anchor });
    expect((await list(viewer.token)).items[0]).toMatchObject({ kind: "comment", text: "new thread" });
    // Nobody is told of their own comments.
    expect((await list(owner.token)).items.every((n) => n.actor.id !== owner.user.id)).toBe(true);
  });

  it("reactions reach the thread's people, with the comment's text and the emoji; deleting a thread forgets them", async () => {
    const { owner, editor } = await setup();
    const t = (await call("POST", comments, owner.token, { message: "yatay scroll", anchor })).body.threads[0];
    await call("PUT", `${comments}/${t.id}/reactions`, editor.token, { emoji: "👍" });
    await call("PUT", `${comments}/${t.id}/reactions`, editor.token, { emoji: "👍" }); // again: nothing new
    let o = await list(owner.token);
    expect(o.items).toHaveLength(1);
    expect(o.items[0]).toMatchObject({ kind: "reaction", emoji: "👍", text: "yatay scroll", count: 1 });
    await call("PUT", `${comments}/${t.id}/reactions`, editor.token, { emoji: "🎉" });
    o = await list(owner.token);
    expect(o.items[0]).toMatchObject({ kind: "reaction", count: 2 });
    await call("DELETE", `${comments}/${t.id}`, owner.token);
    expect((await list(owner.token)).items).toEqual([]);
  });

  it("filters, pages, the file menu and read marks", async () => {
    const { owner, viewer } = await setup();
    for (let i = 0; i < 5; i++) {
      now += GROUP_MS + 1;
      await call("POST", comments, viewer.token, { message: `m${i}`, anchor });
    }
    const first = await list(owner.token, "?limit=2");
    expect(first.items.map((n) => n.text)).toEqual(["m4", "m3"]);
    expect(first.files).toEqual([{ key: KEY, name: "Insider V3" }]);
    const second = await list(owner.token, `?limit=2&before=${first.next}`);
    expect(second.items.map((n) => n.text)).toEqual(["m2", "m1"]);
    expect((await list(owner.token, `?file=other_000001`)).items).toEqual([]);
    expect(first.unread).toBe(5);
    expect((await call("POST", "/notifications/read", owner.token, { ids: [first.items[0].id] })).body).toEqual({ unread: 4, pending: 0 });
    expect((await list(owner.token, "?filter=unread")).items).toHaveLength(4);
    expect(inbox.at(-1)).toMatchObject({ userId: owner.user.id, msg: { unread: 4 } });
    expect((await call("POST", "/notifications/read", owner.token, { all: true })).body.unread).toBe(0);
    expect((await call("POST", "/notifications/read", owner.token, { ids: [first.items[1].id], read: false })).body.unread).toBe(1);
    // Someone else's notification can't be touched.
    await call("POST", "/notifications/read", viewer.token, { all: true, read: false });
    expect((await list(owner.token)).unread).toBe(1);
  });

  it("Ask to edit: a request for the owner and editors, answered from the Requests tab; the asker is told", async () => {
    const { owner, editor, viewer } = await setup();
    await call("POST", `/files/${KEY}/requests`, viewer.token);
    await call("POST", `/files/${KEY}/requests`, viewer.token); // asked again: still one
    const o = await list(owner.token, "?filter=requests");
    expect(o.items.map((n) => [n.kind, n.state])).toEqual([["edit-request", "pending"]]);
    expect(o.pending).toBe(1);
    expect((await list(editor.token, "?filter=requests")).items).toHaveLength(1);
    expect((await list(viewer.token, "?filter=requests")).items).toEqual([]);
    // Only someone who can edit answers; the viewer can't answer their own.
    expect((await call("POST", `/notifications/${o.items[0].id}/answer`, viewer.token, { approve: true })).status).toBe(404);
    const answered = (await call("POST", `/notifications/${o.items[0].id}/answer`, owner.token, { approve: true })).body as NotificationPage;
    expect(answered.items.find((n) => n.kind === "edit-request")?.state).toBe("approved");
    expect(answered.pending).toBe(0);
    expect((await list(editor.token, "?filter=requests")).items[0].state).toBe("approved");
    expect((await call("GET", `/files/${KEY}`, viewer.token)).body.role).toBe("editor");
    expect((await list(viewer.token)).items[0]).toMatchObject({ kind: "request-approved", actor: { id: owner.user.id } });
    // Denied from the Share dialog: the same rows settle.
    const other = await signIn("other@x.co");
    await call("PUT", `/files/${KEY}/members`, owner.token, { email: "other@x.co", role: "viewer" });
    await call("POST", `/files/${KEY}/requests`, other.token);
    await call("POST", `/files/${KEY}/requests/${other.user.id}`, editor.token, { approve: false });
    expect((await list(owner.token, "?filter=requests")).items.map((n) => n.state)).toEqual(["denied", "approved"]);
    expect((await list(other.token)).items[0].kind).toBe("request-denied");
  });

  it("ownership transferred tells the new owner", async () => {
    const { owner, editor } = await setup();
    await call("POST", `/files/${KEY}/transfer`, owner.token, { email: "ed@x.co" });
    expect((await list(editor.token)).items[0]).toMatchObject({ kind: "ownership", actor: { id: owner.user.id } });
  });

  it("preferences: Figma's defaults, saved, and deciding what reaches the computer", async () => {
    const { owner, viewer } = await setup();
    const d = (await call("GET", "/notifications/prefs", owner.token)).body as NotificationPrefs;
    expect(d).toMatchObject({ desktop: { enabled: true, comments: "all" }, email: { enabled: true, invites: "all", digest: true }, productNews: true });
    const saved = (await call("PUT", "/notifications/prefs", owner.token, { ...d, desktop: { enabled: true, comments: "mentions" }, email: { ...d.email, invites: "bogus" } })).body as NotificationPrefs;
    expect(saved.desktop.comments).toBe("mentions");
    expect(saved.email.invites).toBe("all");
    inbox.length = 0;
    await call("POST", comments, viewer.token, { message: "plain", anchor });
    expect(inbox.find((x) => x.userId === owner.user.id)?.msg.desktop).toBe(false);
    inbox.length = 0;
    await call("POST", comments, viewer.token, { message: "@o", anchor, mentions: [owner.user.id] });
    expect(inbox.find((x) => x.userId === owner.user.id)?.msg.desktop).toBe(true);
    // Unsharing drops the file's notifications.
    await call("DELETE", `/files/${KEY}`, owner.token);
    expect((await list(owner.token)).items).toEqual([]);
  });

  it("needs a session; the inbox's socket takes the token in its URL", async () => {
    expect((await call("GET", "/notifications")).status).toBe(401);
    const a = await signIn("a@x.co");
    const res = await handle(new Request(`${ORIGIN}/notifications/ws?token=${a.token}`, { headers: { upgrade: "websocket" } }), deps);
    expect(res.status).toBe(204);
  });
});
