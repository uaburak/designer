// A shared file's version history read from its room (docs/data.md §15.7.1, as built §15.9) against the real server:
// server/src/api.ts `handle`, D1 on node:sqlite and real rooms (server/src/testing/memoryRooms.ts). Also: a shared
// merge / update uploads its batch's images to the target room first (RemoteBranches).
import { describe, expect, it } from "vitest";
import { handle, type Deps } from "../../../server/src/api";
import { Db } from "../../../server/src/db";
import { sqliteD1 } from "../../../server/src/testing/sqliteD1";
import type { Deps as ServerDeps } from "../../../server/src/api";
import { decodeMessage, encodeMessage, newDocumentMessage, type Message, type NodeChange } from "../../shared/schema/codec";
import { NodeTable } from "../../shared/schema/patch";
import type { FileMeta } from "../../shared/store/types";
import { RemoteBranches } from "../branches/remote";
import type { BranchRecord } from "../../shared/merge/branches";
import { httpError } from "../multiplayer/service";
import { RoomVersions, unpackFrames } from "./versionsRoom";

const ORIGIN = "https://designer.example.workers.dev";
const PAGE = { sessionID: 0, localID: 1 };

interface MemberLike {
  frames: { seq: number; sessionID: number; message: Uint8Array }[];
}
interface MemoryRoomsLike {
  rooms: ServerDeps["rooms"];
  get(key: string): { box: { head(): { lastSeq: number } } };
  join(key: string, userId: string): MemberLike;
  send(key: string, member: MemberLike, message: Uint8Array): void;
}

const edit = (nodeChanges: NodeChange[]): Uint8Array => encodeMessage({ type: "NODE_CHANGES", sessionID: 7, ackID: 0, nodeChanges, blobs: [] } as Message);
const rect = (localID: number, name: string): NodeChange => ({ guid: { sessionID: 7, localID }, phase: "CREATED", type: "ROUNDED_RECTANGLE", name, parentIndex: { guid: PAGE, position: "!" }, size: { x: 10, y: 10 } });

async function setup() {
  let now = Date.UTC(2026, 9, 11, 9);
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
    const res = await handle(
      new Request(ORIGIN + path, {
        method,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": bin ? "application/octet-stream" : "application/json" } : {}) },
        body: body === undefined ? undefined : bin ? (body as Uint8Array<ArrayBuffer>) : JSON.stringify(body),
      }),
      deps,
    );
    if (!res.ok) throw await httpError(res);
    return res;
  };
  const json = async <T>(method: string, path: string, token: string | null, body?: unknown): Promise<T> => {
    const text = await (await raw(method, path, token, body)).text();
    return (text ? JSON.parse(text) : undefined) as T;
  };
  const alice = await json<{ token: string; user: { id: string } }>("POST", "/auth/dev", null, { email: "alice@x.co", name: "alice" });
  await json("POST", "/files", alice.token, { key: "file_00001", name: "Design system" });
  await json("PUT", "/files/file_00001/snapshot?seq=0", alice.token, encodeMessage(newDocumentMessage()));
  const a = mem.join("file_00001", alice.user.id);
  return { mem, alice, a, raw, json };
}

describe("a shared file's version history is its room's (docs/data.md §15.7.1)", () => {
  it("lists, opens (snapshot + frames), names, restores and duplicates room versions", async () => {
    const { mem, alice, a, raw, json } = await setup();
    mem.send("file_00001", a, edit([rect(1, "First")]));
    const named = await json<{ version: { id: string } }>("POST", "/files/file_00001/versions", alice.token, { kind: "named", title: "V1" });
    mem.send("file_00001", a, edit([{ guid: { sessionID: 7, localID: 1 }, name: "Second" }]));

    // The local copy: its head is the room's head.
    const head = NodeTable.fromMessage(newDocumentMessage());
    head.apply(decodeMessage(edit([rect(1, "First")])));
    head.apply(decodeMessage(edit([{ guid: { sessionID: 7, localID: 1 }, name: "Second" }])));
    const added: { name: string; snapshot: Uint8Array }[] = [];
    let acked = 2;
    const rv = new RoomVersions({
      roomKey: async (k) => (k === "local" ? "file_00001" : null),
      call: (m, p, b) => json(m, p, alice.token, b),
      callBytes: async (m, p) => {
        const res = await raw(m, p, alice.token);
        return { bytes: new Uint8Array(await res.arrayBuffer()), headers: res.headers };
      },
      syncState: async () => ({ acked, pending: 0, connection: "live" }),
      flushedHead: async () => 3,
      headTable: async () => head,
      downloadBlobs: async () => {},
      getMeta: () => ({ fileKey: "local", name: "Design system", enabledLibraries: [] }) as unknown as FileMeta,
      addFile: async (input) => (added.push(input), { fileKey: "dup", name: input.name } as FileMeta),
      now: () => Date.now(),
      sleep: async () => {
        acked = 3; // the restore frame is acknowledged while we wait
      },
    });
    expect(await rv.shared("local")).toBe("file_00001");
    expect(await rv.shared("other")).toBeNull();

    const list = await rv.list("file_00001");
    expect(list.map((v) => [v.kind, v.title, v.seq])).toEqual([["named", "V1", 1]]);

    // The version is the room's snapshot plus its frames up to its seq.
    const opened = await rv.open("local", "file_00001", named.version.id);
    expect(opened.mode).toBe("view");
    const t = NodeTable.fromMessage(decodeMessage(opened.snapshot));
    expect(t.get("7:1")?.name).toBe("First");
    const frames = await raw("GET", `/files/file_00001/versions/${named.version.id}/frames`, alice.token);
    expect(unpackFrames(new Uint8Array(await frames.arrayBuffer()))).toHaveLength(1);

    // Restore: the head → the version, then a "restore" version once the room has the local frames.
    const diff = decodeMessage(await rv.restoreDiff("local", "file_00001", named.version.id));
    expect(diff.nodeChanges?.find((n) => n.guid?.localID === 1)?.name).toBe("First");
    const restored = await rv.create("local", "file_00001", { kind: "restore", restoredFrom: named.version.id });
    expect(restored).toMatchObject({ kind: "restore", restoredFrom: named.version.id, seq: 2 });

    // Name this version; Duplicate.
    expect((await rv.update("file_00001", restored.id, { title: "Back to V1" })).title).toBe("Back to V1");
    const dup = await rv.duplicate("local", "file_00001", named.version.id);
    expect(dup.name).toBe("Design system (V1)");
    expect(NodeTable.fromMessage(decodeMessage(added[0].snapshot)).get("7:1")?.name).toBe("First");
    expect((await rv.list("file_00001")).map((v) => v.kind)).toEqual(["restore", "named"]);
  });

  it("a room that never acknowledges the local frames refuses a version (offline)", async () => {
    const { alice, json } = await setup();
    let t = 0;
    const rv = new RoomVersions({
      roomKey: async () => "file_00001",
      call: (m, p, b) => json(m, p, alice.token, b),
      callBytes: async () => ({ bytes: new Uint8Array(), headers: new Headers() }),
      syncState: async () => ({ acked: 0, pending: 1, connection: "offline" }),
      flushedHead: async () => 1,
      headTable: async () => NodeTable.fromMessage(newDocumentMessage()),
      downloadBlobs: async () => {},
      getMeta: () => ({}) as FileMeta,
      addFile: async () => ({}) as FileMeta,
      now: () => (t += 5000),
      sleep: async () => {},
    });
    await expect(rv.create("local", "file_00001", { kind: "named", title: "X" })).rejects.toMatchObject({ code: "offline" });
  });
});

describe("a shared merge / update sends its images to the target room first", () => {
  it("uploads the batch's images to main's room (merge) and the branch's room (update) before the call", async () => {
    const hash = new Uint8Array(20).fill(0xab);
    const batch = encodeMessage({ type: "NODE_CHANGES", sessionID: 0, ackID: 0, nodeChanges: [{ guid: { sessionID: 7, localID: 2 }, phase: "CREATED", type: "RECTANGLE", parentIndex: { guid: PAGE, position: "#" }, fillPaints: [{ type: "IMAGE", image: { hash } }] }], blobs: [] } as Message);
    const order: string[] = [];
    const row = { branchKey: "brch", mainKey: "main", name: "B", status: "active", createdBy: { id: "u", name: null }, createdAt: 1, baseSeq: 1, mainSeenSeq: 1, sessionBase: 0, archivedAt: null, mergedAt: null, mergedBy: null, mergeVersionId: null, review: null };
    const remote = new RemoteBranches({
      call: async <T>(method: string, path: string) => {
        order.push(`${method} ${path}`);
        return { branch: row, seq: 2, versionId: "v", mainSeq: 3, preVersionId: "p", branchVersionId: "b" } as T;
      },
      syncState: async () => null,
      shareTo: async () => {
        throw new Error("unused");
      },
      newRoomKey: () => "x",
      linkedCopies: async () => new Map(),
      headSeq: async () => 0,
      signedIn: () => true,
      uploadBlobs: async (key, sha1s) => void order.push(`upload ${key} ${sha1s.join(",")}`),
    });
    const r = { branchFileKey: "bl", mainFileKey: "ml", mainKey: "main", branchKey: "brch" } as BranchRecord;
    await remote.merge(r, { mainSeq: 2, branchSeq: 1, batch });
    await remote.update(r, { mainSeq: 2, branchSeq: 1, base: new Uint8Array([1]), batch });
    const h = "ab".repeat(20);
    expect(order).toEqual([`upload main ${h}`, "POST /branches/brch/merge", `upload brch ${h}`, "PUT /branches/brch/base?seq=2", "POST /branches/brch/update"]);
  });
});
