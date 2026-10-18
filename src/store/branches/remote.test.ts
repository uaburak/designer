// The store's client of shared files' branches (docs/data.md §15.7.1) against the real server: server/src/api.ts
// `handle` with D1 on node:sqlite and real rooms (server/src/testing/memoryRooms.ts), as server/src/branches.test.ts.
import { describe, expect, it } from "vitest";
import { handle, type Deps } from "../../../server/src/api";
import { Db } from "../../../server/src/db";
import { sqliteD1 } from "../../../server/src/testing/sqliteD1";
import type { Deps as ServerDeps } from "../../../server/src/api";
import type { FileKey } from "../../shared/store/types";
import { httpError } from "../multiplayer/service";
import { RemoteBranches, type SyncState } from "./remote";

const ORIGIN = "https://designer.example.workers.dev";
const bytes = (s: string) => new TextEncoder().encode(s);
const str = (b: Uint8Array) => new TextDecoder().decode(b);

interface MemberLike {
  frames: { seq: number; sessionID: number; message: Uint8Array }[];
}
interface MemoryRoomsLike {
  rooms: ServerDeps["rooms"];
  get(key: string): { box: { head(): { lastSeq: number } } };
  join(key: string, userId: string): MemberLike;
  send(key: string, member: MemberLike, message: Uint8Array): void;
}

async function setup() {
  let now = Date.UTC(2026, 9, 11, 9);
  // memoryRooms.ts uses DOM types the store's tsconfig doesn't have: imported by a path tsc doesn't follow.
  const memoryRoomsPath = "../../../server/src/testing/" + "memoryRooms";
  const { memoryRooms } = (await import(/* @vite-ignore */ memoryRoomsPath)) as { memoryRooms: (now: () => number) => MemoryRoomsLike };
  const mem = memoryRooms(() => now);
  const deps: Deps = {
    db: new Db(sqliteD1()),
    env: { SESSION_SECRET: "s".repeat(40), DEV_AUTH: "1" },
    rooms: mem.rooms,
    inboxes: { notify: async () => {}, connect: async () => new Response(null) },
    now: () => (now += 1000),
    fetch: async () => new Response("no", { status: 500 }),
  };
  const raw = async (method: string, path: string, token: string | null, body?: unknown): Promise<Response> => {
    const bin = body instanceof Uint8Array;
    return handle(
      new Request(ORIGIN + path, {
        method,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": bin ? "application/octet-stream" : "application/json" } : {}) },
        body: body === undefined ? undefined : bin ? (body as Uint8Array<ArrayBuffer>) : JSON.stringify(body),
      }),
      deps,
    );
  };
  const json = async <T>(method: string, path: string, token: string | null, body?: unknown): Promise<T> => {
    const res = await raw(method, path, token, body);
    if (!res.ok) throw await httpError(res);
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  };
  const alice = await json<{ token: string; user: { id: string } }>("POST", "/auth/dev", null, { email: "alice@x.co", name: "alice" });
  // Alice's shared file: a snapshot and two edits from her socket.
  await json("POST", "/files", alice.token, { key: "main_00001", name: "Design system" });
  await json("PUT", "/files/main_00001/snapshot?seq=0", alice.token, bytes("MAIN@0"));
  const bob = await json<{ token: string; user: { id: string } }>("POST", "/auth/dev", null, { email: "bob@x.co", name: "bob" });
  await json("PUT", "/files/main_00001/members", alice.token, { email: "bob@x.co", role: "viewer" });
  const a = mem.join("main_00001", alice.user.id);
  mem.send("main_00001", a, bytes("main-edit-1"));
  mem.send("main_00001", a, bytes("main-edit-2"));

  // This store's two local copies: main's linked to the room, the branch's linked by `shareTo`.
  const links = new Map<FileKey, string>([["mainLocal", "main_00001"]]);
  const sync = (fileKey: FileKey): SyncState | null => {
    const key = links.get(fileKey);
    if (!key) return null;
    return { key, since: mem.get(key).box.head().lastSeq, acked: 0, connection: "live", pending: 0 };
  };
  const remote = new RemoteBranches({
    call: (method, path, body) => json(method, path, alice.token, body),
    syncState: async (fileKey) => sync(fileKey),
    shareTo: async (fileKey, input, register, key) => {
      const answer = await register(key!, "Tokens v2");
      await json("PUT", `/files/${key}/snapshot?seq=0`, alice.token, input.snapshot);
      links.set(fileKey, key!);
      return answer;
    },
    newRoomKey: () => "brch_00001",
    linkedCopies: async () => new Map([...links].map(([f, k]) => [k, f])),
    headSeq: async () => 0,
    signedIn: () => true,
  });
  return { mem, alice, bob, a, remote, json, raw };
}

describe("RemoteBranches against the server (docs/data.md §15.7.1)", () => {
  it("creates, lists, renames, archives; updates from main and merges as one call each; reviews", async () => {
    const { mem, alice, bob, a, remote, raw } = await setup();
    expect(await remote.isShared("mainLocal")).toBe(true);
    expect(await remote.isShared("nope")).toBe(false);

    const { record, mainVersionId } = await remote.create({ mainFileKey: "mainLocal", branchFileKey: "branchLocal", name: "Tokens v2", snapshot: bytes("MAIN@2") });
    expect(record).toMatchObject({ branchFileKey: "branchLocal", mainFileKey: "mainLocal", mainKey: "main_00001", branchKey: "brch_00001", name: "Tokens v2", status: "active", base: { mainSeq: 2 }, mainSeenSeq: 2, createdBy: { id: alice.user.id } });
    expect(mainVersionId).toMatch(/^[0-9A-Za-z]{16}$/);
    expect(str(new Uint8Array(await (await raw("GET", "/branches/brch_00001/base", alice.token)).arrayBuffer()))).toBe("MAIN@2");
    expect((await remote.list("mainLocal", "active")).map((r) => r.branchFileKey)).toEqual(["branchLocal"]);
    expect(await remote.list("mainLocal", "archived")).toEqual([]);
    expect((await remote.patch(record, { status: "archived" })).status).toBe("archived");
    expect((await remote.patch(record, { status: "active", name: "Tokens v3" })).name).toBe("Tokens v3");

    // Both edit; Update from main: a stale branch seq is `stale`; then one call moves the base.
    const ab = mem.join("brch_00001", alice.user.id);
    mem.send("brch_00001", ab, bytes("branch-edit-1"));
    mem.send("main_00001", a, bytes("main-edit-3"));
    expect(await remote.roomSeq("mainLocal")).toBe(3);
    await expect(remote.update(record, { mainSeq: 3, branchSeq: 0, base: bytes("MAIN@3"), batch: bytes("update-batch") })).rejects.toMatchObject({ code: "stale" });
    const up = await remote.update(record, { mainSeq: 3, branchSeq: 1, base: bytes("MAIN@3"), batch: bytes("update-batch") });
    expect(up.record).toMatchObject({ base: { mainSeq: 3 }, mainSeenSeq: 3 });
    expect(up.seq).toBe(2);
    expect(str(ab.frames.at(-1)!.message)).toBe("update-batch");

    // Reviews.
    const review = await remote.requestReview(up.record, [bob.user.id], "New tokens");
    expect(review).toMatchObject({ state: "in-review", description: "New tokens" });
    // The request closed by its asker (docs/multiplayer.md §18.9); a new one opens again
    expect(await remote.closeReview({ ...up.record, review })).toMatchObject({ id: review.id, state: "closed" });
    expect((await remote.requestReview(up.record, [bob.user.id], "Again")).id).not.toBe(review.id);

    // Merge: a moved main is stale; then one frame on main, received by every client as remote.
    await expect(remote.merge(up.record, { mainSeq: 2, branchSeq: 2, batch: bytes("merge-batch") })).rejects.toMatchObject({ code: "stale" });
    const merged = await remote.merge(up.record, { mainSeq: 3, branchSeq: 2, title: "Tokens v2", description: "Ready", batch: bytes("merge-batch") });
    expect(merged.record).toMatchObject({ status: "merged", mergeVersionId: merged.versionId });
    expect(merged.mainSeq).toBe(4);
    expect(a.frames.at(-1)).toMatchObject({ seq: 4, sessionID: 0 });
    expect(str(a.frames.at(-1)!.message)).toBe("merge-batch");
    const v = await remote.version("mainLocal", merged.versionId);
    expect(v).toMatchObject({ id: merged.versionId, kind: "merge", title: "Tokens v2", description: "Ready", seq: 4 });
    await expect(remote.patch(merged.record, { status: "active" })).rejects.toMatchObject({ code: "invalid" });
  });
});

describe("RemoteBranches.catchUp (a merge never waits forever on a room)", () => {
  const deps = (state: () => SyncState | null, visits: string[]) => {
    let clock = 0;
    return new RemoteBranches({
      call: async () => ({}) as never,
      syncState: async () => state(),
      shareTo: async () => ({}) as never,
      newRoomKey: () => "k",
      linkedCopies: async () => new Map(),
      headSeq: async () => 0,
      signedIn: () => true,
      visit: async (fileKey) => (visits.push(`join ${fileKey}`), () => void visits.push(`leave ${fileKey}`)),
      sleep: async (ms) => void (clock += ms),
      now: () => clock,
    });
  };

  it("joins a room this tab isn't in, waits until the copy is live, and hands back the release", async () => {
    const visits: string[] = [];
    let polls = 0;
    const remote = deps(() => ({ key: "main_1", since: 3, acked: 0, connection: ++polls > 3 ? "live" : "connecting", pending: 0 }), visits);
    const release = await remote.catchUp("mainLocal");
    expect(visits).toEqual(["join mainLocal"]);
    release();
    expect(visits).toEqual(["join mainLocal", "leave mainLocal"]);
  });

  it("gives up with `offline` after the timeout and leaves the room", async () => {
    const visits: string[] = [];
    const remote = deps(() => ({ key: "main_1", since: 3, acked: 0, connection: "connecting", pending: 0 }), visits);
    await expect(remote.catchUp("mainLocal", 1000)).rejects.toMatchObject({ code: "offline", message: "Couldn’t reach this file’s room. Check your connection and try again." });
    expect(visits).toEqual(["join mainLocal", "leave mainLocal"]);
    const saving = deps(() => ({ key: "main_1", since: 3, acked: 0, connection: "live", pending: 2 }), []);
    await expect(saving.catchUp("mainLocal", 1000)).rejects.toMatchObject({ code: "offline", message: "Changes to this file are still being saved. Try again in a moment." });
  });
});
