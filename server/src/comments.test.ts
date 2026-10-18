import { beforeEach, describe, expect, it } from "vitest";
import type { CommentThread } from "../../src/shared/comments";
import { handle, type Deps } from "./api";
import { Db } from "./db";
import { sqliteD1 } from "./testing/sqliteD1";

const ORIGIN = "https://designer.example.workers.dev";

let deps: Deps;
let notices: { key: string; path: string; body: unknown }[];
let now: number;

beforeEach(() => {
  now = Date.UTC(2026, 9, 11);
  notices = [];
  deps = {
    db: new Db(sqliteD1()),
    env: { SESSION_SECRET: "s".repeat(40), DEV_AUTH: "1" },
    rooms: {
      async fetch(key, path, init) {
        notices.push({ key, path, body: init.body ? JSON.parse(String(init.body)) : null });
        return Response.json({ ok: true });
      },
    },
    now: () => now,
    fetch: async () => new Response("no", { status: 500 }),
  };
});

const call = async (method: string, path: string, token?: string, body?: unknown) => {
  const res = await handle(
    new Request(ORIGIN + path, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    deps,
  );
  return { status: res.status, body: (await res.json()) as { threads: CommentThread[]; canResolveAny: boolean; error?: string; me: { id: string } } };
};

async function signIn(email: string) {
  const r = await call("POST", "/auth/dev", undefined, { email, name: email.split("@")[0] });
  return r.body as unknown as { token: string; user: { id: string } };
}

const anchor = { pageId: "0:1", x: 10, y: 20 };

async function setup() {
  const owner = await signIn("owner@x.co");
  const editor = await signIn("ed@x.co");
  const viewer = await signIn("view@x.co");
  const stranger = await signIn("nobody@x.co");
  await call("POST", "/files", owner.token, { key: "file_c00001", name: "F" });
  await call("PUT", "/files/file_c00001/members", owner.token, { email: "ed@x.co", role: "editor" });
  await call("PUT", "/files/file_c00001/members", owner.token, { email: "view@x.co", role: "viewer" });
  notices.length = 0;
  return { owner, editor, viewer, stranger };
}

const base = "/files/file_c00001/comments";

describe("comments", () => {
  it("lets everyone with access comment — viewers too — numbers threads and tells the room", async () => {
    const { owner, viewer, stranger } = await setup();
    expect((await call("GET", base, stranger.token)).status).toBe(404);
    const a = await call("POST", base, viewer.token, { message: "  Looks good  ", anchor });
    expect(a.status).toBe(200);
    expect(a.body.threads).toHaveLength(1);
    expect(a.body.threads[0]).toMatchObject({ number: 1, anchor: { pageId: "0:1", x: 10, y: 20, nodeId: null }, unread: false, resolvedAt: null });
    expect(a.body.threads[0].comments[0]).toMatchObject({ message: "Looks good", parentId: null, user: { name: "view" } });
    expect(notices).toEqual([{ key: "file_c00001", path: "/room/comments", body: { threadId: a.body.threads[0].id, by: viewer.user.id } }]);
    const b = await call("POST", base, owner.token, { message: "Second", anchor: { ...anchor, nodeId: "1:2", offset: { x: 3, y: 4 } } });
    expect(b.body.threads.map((t) => t.number)).toEqual([1, 2]);
    expect(b.body.threads[1].anchor).toMatchObject({ nodeId: "1:2", offset: { x: 3, y: 4 } });
    // The owner sees the viewer's thread unread; the viewer sees the owner's.
    expect(b.body.threads.map((t) => t.unread)).toEqual([true, false]);
    expect((await call("GET", base, viewer.token)).body.threads.map((t) => t.unread)).toEqual([false, true]);
    expect((await call("POST", base, owner.token, { message: "", anchor })).status).toBe(400);
    expect((await call("POST", base, owner.token, { message: "No place" })).status).toBe(400);
  });

  it("keeps a Motion comment's playhead time (docs/motion.md §6.8), rounded, and clears it when moved outside Motion", async () => {
    const { owner } = await setup();
    const t = (await call("POST", base, owner.token, { message: "At 1.25 s", anchor: { ...anchor, timeMs: 1250.4 } })).body.threads[0];
    expect(t.anchor).toMatchObject({ pageId: "0:1", timeMs: 1250 });
    expect((await call("POST", base, owner.token, { message: "Bad time", anchor: { ...anchor, timeMs: -5 } })).body.threads[1].anchor.timeMs).toBeUndefined();
    const moved = await call("PATCH", `${base}/${t.id}`, owner.token, { anchor: { pageId: "0:1", x: 1, y: 1, timeMs: 500 } });
    expect(moved.body.threads[0].anchor.timeMs).toBe(500);
    const cleared = await call("PATCH", `${base}/${t.id}`, owner.token, { anchor: { pageId: "0:1", x: 1, y: 1 } });
    expect(cleared.body.threads[0].anchor.timeMs).toBeUndefined();
  });

  it("replies, read marks, edit and delete own only; a thread goes with its first comment", async () => {
    const { owner, editor } = await setup();
    const t = (await call("POST", base, owner.token, { message: "Root", anchor })).body.threads[0];
    now += 1000;
    const r = await call("POST", base, editor.token, { threadId: t.id, message: "Reply @owner", mentions: [owner.user.id] });
    const thread = r.body.threads[0];
    expect(thread.comments.map((c) => c.message)).toEqual(["Root", "Reply @owner"]);
    expect(thread.comments[1]).toMatchObject({ parentId: t.id, threadId: t.id, mentions: [owner.user.id] });
    const reply = thread.comments[1];
    expect((await call("GET", base, owner.token)).body.threads[0].unread).toBe(true);
    expect((await call("POST", `${base}/read`, owner.token, { threadIds: [t.id], read: true })).body.threads[0].unread).toBe(false);
    expect((await call("POST", `${base}/read`, owner.token, { threadIds: [t.id], read: false })).body.threads[0].unread).toBe(true);
    // Edit: author only.
    expect((await call("PATCH", `${base}/${reply.id}`, owner.token, { message: "hijack" })).status).toBe(403);
    const edited = await call("PATCH", `${base}/${reply.id}`, editor.token, { message: "Reply, edited" });
    expect(edited.body.threads[0].comments[1]).toMatchObject({ message: "Reply, edited", editedAt: now });
    // Delete: author only (Figma: only the author deletes their comments).
    expect((await call("DELETE", `${base}/${reply.id}`, owner.token)).status).toBe(403);
    expect((await call("DELETE", `${base}/${reply.id}`, editor.token)).body.threads[0].comments).toHaveLength(1);
    await call("POST", base, editor.token, { threadId: t.id, message: "Again" });
    expect((await call("DELETE", `${base}/${t.id}`, owner.token)).body.threads).toEqual([]);
  });

  it("resolves by the author or an editor, moves pins, and reacts", async () => {
    const { owner, editor, viewer } = await setup();
    const mine = (await call("POST", base, viewer.token, { message: "Viewer's", anchor })).body.threads[0];
    const theirs = (await call("POST", base, owner.token, { message: "Owner's", anchor })).body.threads[1];
    expect((await call("GET", base, viewer.token)).body.canResolveAny).toBe(false);
    expect((await call("PATCH", `${base}/${theirs.id}`, viewer.token, { resolved: true })).status).toBe(403);
    const res = await call("PATCH", `${base}/${mine.id}`, viewer.token, { resolved: true });
    expect(res.body.threads[0]).toMatchObject({ resolvedAt: now, resolvedBy: { id: viewer.user.id } });
    expect((await call("PATCH", `${base}/${theirs.id}`, editor.token, { resolved: true })).body.threads[1].resolvedAt).toBe(now);
    expect((await call("PATCH", `${base}/${mine.id}`, editor.token, { resolved: false })).body.threads[0].resolvedAt).toBeNull();
    // Moving a pin
    expect((await call("PATCH", `${base}/${theirs.id}`, viewer.token, { anchor: { pageId: "0:1", x: 1, y: 1 } })).status).toBe(403);
    expect((await call("PATCH", `${base}/${mine.id}`, viewer.token, { anchor: { pageId: "0:2", x: 5, y: 6 } })).body.threads[0].anchor).toMatchObject({ pageId: "0:2", x: 5, y: 6 });
    // Reactions: anyone, one per emoji per person, toggled.
    await call("PUT", `${base}/${theirs.id}/reactions`, viewer.token, { emoji: "👍" });
    await call("PUT", `${base}/${theirs.id}/reactions`, viewer.token, { emoji: "👍" });
    const r = await call("PUT", `${base}/${theirs.id}/reactions`, editor.token, { emoji: "👍" });
    expect(r.body.threads[1].comments[0].reactions).toMatchObject([{ emoji: "👍", users: [{ id: viewer.user.id }, { id: editor.user.id }] }]);
    const off = await call("DELETE", `${base}/${theirs.id}/reactions?emoji=${encodeURIComponent("👍")}`, viewer.token);
    expect(off.body.threads[1].comments[0].reactions[0].users.map((u) => u.id)).toEqual([editor.user.id]);
  });

  it("drops a file's comments when it stops being shared", async () => {
    const { owner } = await setup();
    const t = (await call("POST", base, owner.token, { message: "x", anchor })).body.threads[0];
    await call("PUT", `${base}/${t.id}/reactions`, owner.token, { emoji: "🎉" });
    expect((await call("DELETE", "/files/file_c00001", owner.token)).status).toBe(200);
    const left = await deps.db.d1.prepare(`SELECT COUNT(*) AS n FROM comments`).first<{ n: number }>();
    expect(left?.n).toBe(0);
  });
});
