/**
 * The store's comments: a local file's in its record (as "You"), a shared file's through the real API
 * (server/src/api.ts + comments.ts on node:sqlite), and the change events views follow.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { handle, type Deps } from "../../../server/src/api";
import { Db } from "../../../server/src/db";
import { sqliteD1 } from "../../../server/src/testing/sqliteD1";
import type { FileKey } from "../../shared/store/types";
import type { MultiplayerService } from "../multiplayer/service";
import { CommentsService, LOCAL_ID, type LocalComments } from "./service";

const SERVER = "https://c.test";
let now = 1_000;
let server: Deps;

beforeEach(() => {
  now = Date.UTC(2026, 9, 11);
  server = { db: new Db(sqliteD1()), env: { SESSION_SECRET: "s".repeat(40), DEV_AUTH: "1" }, rooms: { fetch: async () => Response.json({ ok: true }) }, now: () => now, fetch: fetch };
});

/** The parts of MultiplayerService the comments use, over the real handler */
function fakeMp(token: string | null, links: Record<FileKey, string>) {
  const commentListeners = new Set<(k: FileKey) => void>();
  const mp = {
    signedIn: token !== null,
    roomKey: async (fileKey: FileKey) => links[fileKey] ?? null,
    status: async () => ({ signedIn: token !== null, server: SERVER, deviceOrdinal: 2 }),
    call: async (method: string, path: string, body?: unknown) => {
      const res = await handle(new Request(SERVER + path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }), server);
      if (!res.ok) throw new Error(((await res.json()) as { error: string }).error);
      return res.json();
    },
    members: async (fileKey: FileKey) => ((await mp.call("GET", `/files/${links[fileKey]}/members`)) as { members: unknown[] }).members,
    onComments: (l: (k: FileKey) => void) => (commentListeners.add(l), () => commentListeners.delete(l)),
    onFileState: () => () => {},
    fire: (k: FileKey) => commentListeners.forEach((l) => l(k)),
  };
  return mp;
}

function host() {
  const records = new Map<FileKey, LocalComments>();
  let r = 0;
  return { records, load: async (k: FileKey) => records.get(k) ?? null, save: async (k: FileKey, rec: LocalComments) => void records.set(k, structuredClone(rec)), now: () => now, random: () => ((r = (r * 9301 + 49297) % 233280), r / 233280) };
}

const anchor = { pageId: "0:1", x: 5, y: 6 };

describe("comments in the store", () => {
  it("keeps a local file's threads in its record, written by You", async () => {
    const h = host();
    const s = new CommentsService(h, fakeMp(null, {}) as unknown as MultiplayerService);
    const events: FileKey[] = [];
    s.onChange((k) => events.push(k));
    let st = await s.add("f1", { message: "  First  ", anchor });
    expect(st).toMatchObject({ shared: false, me: { id: LOCAL_ID, name: "You" }, canResolveAny: true });
    const t = st.threads[0];
    expect(t).toMatchObject({ number: 1, anchor, unread: false });
    expect(t.comments[0]).toMatchObject({ message: "First", parentId: null, user: { name: "You" } });
    now += 10;
    st = await s.add("f1", { threadId: t.id, message: "Reply" });
    expect(st.threads[0].comments.map((c) => c.message)).toEqual(["First", "Reply"]);
    st = await s.react("f1", t.id, "👍", true);
    expect(st.threads[0].comments[0].reactions).toMatchObject([{ emoji: "👍", users: [{ id: LOCAL_ID }] }]);
    st = await s.react("f1", t.id, "👍", false);
    expect(st.threads[0].comments[0].reactions).toEqual([]);
    st = await s.setResolved("f1", t.id, true);
    expect(st.threads[0].resolvedAt).toBe(now);
    st = await s.edit("f1", st.threads[0].comments[1].id, "Reply, edited");
    expect(st.threads[0].comments[1]).toMatchObject({ message: "Reply, edited", editedAt: now });
    st = await s.move("f1", t.id, { pageId: "0:2", x: 1, y: 2, nodeId: "1:1", offset: { x: 1, y: 2 } });
    expect(st.threads[0].anchor).toMatchObject({ pageId: "0:2", nodeId: "1:1" });
    st = await s.add("f1", { message: "Second", anchor });
    expect(st.threads.map((x) => x.number)).toEqual([1, 2]);
    st = await s.remove("f1", t.id);
    expect(st.threads.map((x) => x.number)).toEqual([2]);
    expect(h.records.get("f1")!.comments).toHaveLength(1);
    expect(events.every((k) => k === "f1") && events.length >= 8).toBe(true);
    await expect(s.add("f1", { message: "", anchor })).rejects.toThrow();
    await expect(s.add("f1", { message: "no place" })).rejects.toThrow();
    // Figma's 2,000 characters, as graphemes after the trailing whitespace.
    await expect(s.add("f1", { message: "x".repeat(2001), anchor })).rejects.toThrow(/2,000/);
    expect((await s.add("f1", { message: "👍🏽".repeat(2000) + "   ", anchor })).threads).toHaveLength(2);
  });

  it("keeps a local comment's files, which may come without text, and names their blobs for the GC", async () => {
    const h = host();
    const s = new CommentsService(h, fakeMp(null, {}) as unknown as MultiplayerService);
    const sha = (c: string) => c.repeat(40);
    const png = { id: "att_000001", name: "a.png", mime: "image/png", size: 10, sha1: sha("a"), width: 4, height: 3, lastModified: 7 };
    const mov = { id: "att_000002", name: "b.mov", mime: "video/quicktime", size: 99_000_000, sha1: sha("b"), width: 1600, height: 900, thumb: sha("c") };
    const st = await s.add("f1", { message: "", anchor, attachments: [png, mov] });
    expect(st.threads[0].comments[0]).toMatchObject({ message: "", attachments: [png, mov] });
    expect((await s.blobRefs("f1")).sort()).toEqual([sha("a"), sha("b"), sha("c")]);
    // Emptying the text of a comment with files is fine; one without them still needs some.
    expect((await s.edit("f1", st.threads[0].id, "  ")).threads[0].comments[0].message).toBe("");
    await expect(s.add("f1", { message: "", anchor, attachments: [{ ...png, mime: "image/tiff" }] })).rejects.toThrow();
    await expect(s.add("f1", { message: "", anchor, attachments: [{ ...png, size: 30_000_001 }] })).rejects.toThrow();
    await expect(s.add("f1", { message: "", anchor, attachments: Array.from({ length: 6 }, () => png) })).rejects.toThrow(/5/);
    // Comments written before files existed read as they were.
    h.records.get("f1")!.comments.push({ ...h.records.get("f1")!.comments[0], id: "c_old", threadId: "c_old", attachments: undefined, number: 9 });
    expect((await s.list("f1")).threads.find((t) => t.id === "c_old")?.comments[0].attachments).toBeUndefined();
  });

  it("uses the server for a shared file, as the signed-in user, and follows the room", async () => {
    const devSignIn = async (email: string) => (await (await handle(new Request(`${SERVER}/auth/dev`, { method: "POST", body: JSON.stringify({ email, name: email.split("@")[0] }) }), server)).json()) as { token: string; user: { id: string } };
    const alice = await devSignIn("alice@x.co");
    const bob = await devSignIn("bob@x.co");
    const asAlice = fakeMp(alice.token, { fa: "file_shared1" });
    await asAlice.call("POST", "/files", { key: "file_shared1", name: "F" });
    await asAlice.call("PUT", "/files/file_shared1/members", { email: "bob@x.co", role: "viewer" });
    const asBob = fakeMp(bob.token, { fb: "file_shared1" });
    const a = new CommentsService(host(), asAlice as unknown as MultiplayerService);
    const b = new CommentsService(host(), asBob as unknown as MultiplayerService);
    const heard: FileKey[] = [];
    b.onChange((k) => heard.push(k));

    const st = await a.add("fa", { message: "Hi @bob", anchor, mentions: [bob.user.id] });
    expect(st).toMatchObject({ shared: true, me: { id: alice.user.id, name: "alice" }, canResolveAny: true });
    asBob.fire("fb");
    expect(heard).toEqual(["fb"]);
    const seen = await b.list("fb");
    expect(seen.canResolveAny).toBe(false);
    expect(seen.threads[0]).toMatchObject({ unread: true, comments: [{ message: "Hi @bob", mentions: [bob.user.id], user: { id: alice.user.id } }] });
    expect((await b.setRead("fb", [seen.threads[0].id], true)).threads[0].unread).toBe(false);
    expect((await b.mentionable("fb")).map((p) => p.name).sort()).toEqual(["alice", "bob"]);
    // A viewer can't resolve someone else's thread; the server's refusal comes back.
    await expect(b.setResolved("fb", seen.threads[0].id, true)).rejects.toThrow(/resolve/);
    // Offline: the last list is kept, with the error.
    asBob.call = async () => {
      throw new Error("offline");
    };
    expect(await b.list("fb")).toMatchObject({ error: "offline", threads: [{ id: seen.threads[0].id }] });
  });

  it("reads a shared file's comments once when asked several times at open; the room's notice and writes read again", async () => {
    // The owner's run: opening a shared file fetched /comments 2–3 times in a burst (the first read, then the link up).
    const devSignIn = async (email: string) => (await (await handle(new Request(`${SERVER}/auth/dev`, { method: "POST", body: JSON.stringify({ email, name: email.split("@")[0] }) }), server)).json()) as { token: string; user: { id: string } };
    const alice = await devSignIn("alice@x.co");
    const mp = fakeMp(alice.token, { fa: "file_shared2" });
    await mp.call("POST", "/files", { key: "file_shared2", name: "F" });
    const gets: string[] = [];
    const call = mp.call;
    mp.call = async (method: string, path: string, body?: unknown) => {
      if (method === "GET" && path.endsWith("/comments")) gets.push(path);
      return call(method, path, body);
    };
    const s = new CommentsService(host(), mp as unknown as MultiplayerService);
    await Promise.all([s.list("fa"), s.list("fa")]);
    await s.list("fa");
    expect(gets.length).toBe(1);
    now += 2500; // past the freshness window
    await s.list("fa");
    expect(gets.length).toBe(2);
    mp.fire("fa"); // the room: they changed
    await s.list("fa");
    expect(gets.length).toBe(3);
    await s.add("fa", { message: "New", anchor });
    expect((await s.list("fa")).threads.length).toBe(1);
    expect(gets.length).toBe(4);
  });
});
