/**
 * Two installations editing one shared file through the real API (server/src/api.ts on node:sqlite) and the real room
 * (src/shared/multiplayer/room.ts), with an in-process WebSocket: share, join, edits both ways, Figma's conflict rule,
 * offline edits resent on reconnect, viewers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handle, type Deps, type Rooms } from "../../../server/src/api";
import { Db } from "../../../server/src/db";
import { sqliteD1 } from "../../../server/src/testing/sqliteD1";
import { memoryBuckets } from "../../../server/src/testing/memoryR2";
import { MemoryRoomStorage, Room, type Connection } from "../../shared/multiplayer/room";
import { decodeMessage, encodeMessage, type NodeChange } from "../../shared/schema/codec";
import type { FileChange } from "../../shared/store/repositories";
import type { FileKey, FileMeta } from "../../shared/store/types";
import { MultiplayerService, type MultiplayerDeps, type MultiplayerHost } from "./service";
import { multiplayerApi } from "./api";
import { isPackedSnapshot, packSnapshot, unpackSnapshot } from "../../shared/multiplayer/snapshotWire";
import type { UploadEvent, UploadProgress } from "../../shared/multiplayer/uploads";

const SERVER = "https://mp.test";

/* eslint-disable @typescript-eslint/no-explicit-any */

// --- the server: the Worker's handler, rooms in process ---

let server: Deps;
const rooms = new Map<string, { room: Room; storage: MemoryRoomStorage; snapshot: { seq: number; bytes: Uint8Array } | null; blobs: Map<string, Uint8Array> }>();
const roomOf = (key: string) => {
  let r = rooms.get(key);
  if (!r) {
    const storage = new MemoryRoomStorage();
    rooms.set(key, (r = { room: new Room(storage), storage, snapshot: null, blobs: new Map() }));
  }
  return r;
};
const fakeRooms: Rooms = {
  async fetch(key, path, init) {
    const r = roomOf(key);
    if (path.startsWith("/room/snapshot") && init.method === "PUT") {
      const seq = Number(new URL(path, "http://x").searchParams.get("seq"));
      r.snapshot = { seq, bytes: new Uint8Array(init.body as ArrayBuffer) };
      r.storage.compact(seq);
      return Response.json({ ok: true });
    }
    if (path === "/room/snapshot") return r.snapshot ? new Response(r.snapshot.bytes, { headers: { "x-seq": String(r.snapshot.seq) } }) : Response.json({ error: "no snapshot yet", code: "no_snapshot" }, { status: 404 });
    if (path === "/room/blobs/missing") return Response.json({ missing: (JSON.parse(String(init.body)).sha1s as string[]).filter((s) => !r.blobs.has(s)) });
    const blob = /^\/room\/blobs\/([0-9a-f]{40})$/.exec(path);
    if (blob && init.method === "PUT") {
      r.blobs.set(blob[1], new Uint8Array(init.body as ArrayBuffer));
      return Response.json({ ok: true });
    }
    if (blob) return r.blobs.has(blob[1]) ? new Response(r.blobs.get(blob[1])!.slice()) : new Response("none", { status: 404 });
    if (path === "/room/revoke") {
      r.room.closeUser(JSON.parse(String(init.body)).userId, 4003, "access changed");
      return Response.json({ ok: true });
    }
    return Response.json({ ok: true });
  },
};
const serverFetch: typeof fetch = async (input, init) => handle(new Request(String(input), init), server);

/** A WebSocket straight into the room, after the Worker's checks (token → user → role). */
const sockets = new Set<FakeSocket>();
class FakeSocket {
  binaryType = "arraybuffer";
  readyState = 0;
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  private conn: Connection | null = null;
  private room: Room | null = null;
  constructor(url: string) {
    sockets.add(this);
    void this.open(new URL(url));
  }
  private async open(u: URL) {
    const key = u.pathname.split("/")[2];
    const me = await serverFetch(`${SERVER}/me`, { headers: { authorization: `Bearer ${u.searchParams.get("token")}` } });
    if (!me.ok) return this.closed(1008, "unauthorized");
    const user = (await me.json()) as { id: string; name: string };
    const role = await server.db.roleOf(key, user.id);
    if (!role) return this.closed(1008, "no access");
    this.room = roomOf(key).room;
    this.conn = {
      send: (d) => queueMicrotask(() => this.onmessage?.({ data: typeof d === "string" ? d : d.slice().buffer })),
      close: (code = 1000, reason = "") => queueMicrotask(() => this.closed(code, reason)),
    };
    this.room.connect(this.conn, { userId: user.id, name: user.name, role });
    this.readyState = 1;
    this.onopen?.({});
  }
  send(d: string | Uint8Array) {
    if (this.readyState !== 1) return;
    const data = typeof d === "string" ? d : d.slice();
    queueMicrotask(() => this.conn && this.room?.receive(this.conn, data));
  }
  close(code = 1000, reason = "") {
    if (this.conn) this.room?.leave(this.conn);
    this.closed(code, reason);
  }
  /** The network drops: the room sees the socket go, the client sees it close */
  drop() {
    this.close(1006, "gone");
  }
  private closed(code: number, reason: string) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    sockets.delete(this);
    this.onclose?.({ code, reason });
  }
}

// --- an installation: a journal per file, as a store keeps it ---

class FakeStore implements MultiplayerHost {
  deviceOrdinal = 1;
  files = new Map<FileKey, { meta: FileMeta; snapshot: Uint8Array; frames: FileChange[] }>();
  saved: { installationId?: string; links: Record<string, unknown> } = { links: {} };
  private listeners = new Set<(c: FileChange) => void>();
  readonly fileChanges = { on: (l: (c: FileChange) => void) => (this.listeners.add(l), () => this.listeners.delete(l)) };
  private n = 0;

  addFile(name: string, nodes: NodeChange[]): FileKey {
    const fileKey = `local${++this.n}${Math.random().toString(36).slice(2, 8)}`;
    this.files.set(fileKey, { meta: { fileKey, name } as FileMeta, snapshot: msg(nodes), frames: [] });
    return fileKey;
  }
  /** An edit, journaled as the editor would */
  edit(fileKey: FileKey, nodes: NodeChange[]) {
    this.push(fileKey, { sessionID: this.deviceOrdinal * 2 ** 20 + 1, kind: "edit", message: msg(nodes) });
  }
  private push(fileKey: FileKey, c: Omit<FileChange, "fileKey" | "seq">) {
    const f = this.files.get(fileKey)!;
    const change = { ...c, fileKey, seq: f.frames.length + 1 };
    f.frames.push(change);
    for (const l of this.listeners) l(change);
    return change;
  }
  async backlog(fileKey: FileKey, fromSeq: number) {
    return this.files.get(fileKey)!.frames.filter((c) => c.seq > fromSeq);
  }
  async appendRemote(fileKey: FileKey, message: Uint8Array) {
    return { seq: this.push(fileKey, { sessionID: 0, kind: "remote", message }).seq };
  }
  newFileKey() {
    return `joined${++this.n}`;
  }
  async createSharedFile(input: { name: string; snapshot: Uint8Array; fileKey?: FileKey }) {
    const fileKey = input.fileKey ?? `joined${++this.n}`;
    const meta = { fileKey, name: input.name } as FileMeta;
    this.files.set(fileKey, { meta, snapshot: input.snapshot, frames: [] });
    return meta;
  }
  getMeta(fileKey: FileKey) {
    return this.files.get(fileKey)?.meta ?? null;
  }
  async setDeviceOrdinal(o: number) {
    this.deviceOrdinal = o;
  }
  async load() {
    return structuredClone(this.saved);
  }
  async saveInstallationId(id: string) {
    this.saved.installationId = id;
  }
  async saveLink(fileKey: FileKey, link: unknown) {
    if (link) this.saved.links[fileKey] = structuredClone(link);
    else delete this.saved.links[fileKey];
  }
  log() {}
  blobs = new Map<string, Uint8Array>();
  async hasBlobs(sha1s: string[]) {
    return sha1s.map((s) => this.blobs.has(s));
  }
  async getBlob(sha1: string) {
    return this.blobs.get(sha1)!;
  }
  async putBlob(bytes: Uint8Array) {
    const hex = [...new Uint8Array(await crypto.subtle.digest("SHA-1", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
    this.blobs.set(hex, bytes.slice());
  }
  async headSnapshot(fileKey: FileKey) {
    return msg(Object.entries(this.doc(fileKey)).map(([k, v]) => node(Number(k.split(":")[1]), v, Number(k.split(":")[0]))));
  }
  /** The document as the editor would hold it: snapshot, then every frame applied in journal order */
  doc(fileKey: FileKey): Record<string, Record<string, unknown>> {
    const f = this.files.get(fileKey)!;
    const out: Record<string, Record<string, unknown>> = {};
    for (const bytes of [f.snapshot, ...f.frames.map((c) => c.message)]) {
      for (const nc of decodeMessage(bytes).nodeChanges ?? []) {
        const k = `${nc.guid!.sessionID}:${nc.guid!.localID}`;
        if (nc.phase === "REMOVED") delete out[k];
        else {
          const { guid: _g, phase: _p, ...rest } = nc as any;
          out[k] = { ...(nc.phase === "CREATED" ? {} : out[k]), ...rest };
        }
      }
    }
    return out;
  }
}

const msg = (nodeChanges: NodeChange[]) => encodeMessage({ type: "NODE_CHANGES", sessionID: 0, ackID: 0, nodeChanges, blobs: [] });
const node = (localID: number, fields: Record<string, unknown>, sessionID = 0): NodeChange => ({ guid: { sessionID, localID }, ...fields }) as NodeChange;

/** Lets microtask hops and the services' async steps run */
const settle = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0));
};

async function signIn(email: string) {
  server.env.DEV_AUTH = "1";
  const r = await serverFetch(`${SERVER}/auth/dev`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, name: email.split("@")[0] }) });
  return ((await r.json()) as { token: string }).token;
}

async function installation(email: string, compactEvery?: number, deps: Partial<MultiplayerDeps> = {}) {
  const store = new FakeStore();
  const svc = new MultiplayerService(store, { fetch: serverFetch, WebSocket: FakeSocket as any, random: Math.random, backoff: () => 5, compactEvery, ...deps });
  await svc.setSession({ server: SERVER, token: await signIn(email) });
  return { store, svc };
}

const services: MultiplayerService[] = [];
beforeEach(() => {
  rooms.clear();
  server = { db: new Db(sqliteD1()), env: { SESSION_SECRET: "m".repeat(40) }, rooms: fakeRooms, fetch: fetch, now: () => Date.now() };
});
afterEach(() => {
  for (const s of services.splice(0)) s.close();
  for (const s of [...sockets]) s.close();
});

async function sharedPair(deps: { a?: Partial<MultiplayerDeps>; b?: Partial<MultiplayerDeps> } = {}) {
  const a = await installation("a@x.co", undefined, deps.a);
  const b = await installation("b@x.co", undefined, deps.b);
  services.push(a.svc, b.svc);
  const fa = a.store.addFile("Landing", [node(0, { name: "Document" }), node(1, { name: "Page 1" })]);
  a.store.edit(fa, [node(1, { name: "Home" })]); // before sharing: in the snapshot
  const snapshot = msg(Object.entries(a.store.doc(fa)).map(([k, v]) => node(Number(k.split(":")[1]), v)));
  const shared = await a.svc.share(fa, { snapshot, headSeq: 1 });
  await a.svc.invite(fa, "b@x.co", "editor");
  const list = await b.svc.listRemote();
  const { fileKey: fb } = await b.svc.openShared(list[0].key);
  await settle();
  return { a, b, fa, fb, key: shared.key! };
}

describe("MultiplayerService", () => {
  it("opens a shared file early: its key at once, the document coming down said, then the copy made (Figma's loader)", async () => {
    const a = await installation("a@x.co");
    const b = await installation("b@x.co");
    services.push(a.svc, b.svc);
    const fa = a.store.addFile("Landing", [node(0, { name: "Document" }), node(1, { name: "Page 1" })]);
    const shared = await a.svc.share(fa, { snapshot: msg([node(0, { name: "Document" }), node(1, { name: "Page 1" })]), headSeq: 0 });
    await a.svc.invite(fa, "b@x.co", "editor");
    const seen: { received?: number; reading?: true; done?: true }[] = [];
    const off = b.svc.onOpening((_k, p) => seen.push(p));
    const { fileKey } = await b.svc.openShared(shared.key!, undefined, undefined, { early: true });
    // The tab can open on it now; its record comes with the document
    expect(b.store.getMeta(fileKey)).toBeNull();
    // A second open of the same room while it comes down: the same copy
    expect((await b.svc.openShared(shared.key!)).fileKey).toBe(fileKey);
    await b.svc.whenCopied(fileKey);
    off();
    expect(b.store.getMeta(fileKey)).toMatchObject({ name: "Landing" });
    expect(b.store.doc(fileKey)["0:1"]).toEqual({ name: "Page 1" });
    expect(seen.some((p) => p.reading)).toBe(true);
    expect(seen.at(-1)).toEqual({ done: true });
    expect((await b.svc.fileState(fileKey)).shared).toBe(true);
  });

  it("packs a room's bare snapshot at its seq when someone who may edit opens it", async () => {
    const a = await installation("a@x.co");
    const b = await installation("b@x.co");
    services.push(a.svc, b.svc);
    const fa = a.store.addFile("Landing", [node(0, { name: "Document" })]);
    const bare = msg([node(0, { name: "Document" }), node(1, { name: "x".repeat(50_000) })]);
    const shared = await a.svc.share(fa, { snapshot: bare, headSeq: 0 });
    await a.svc.invite(fa, "b@x.co", "editor");
    const room = rooms.get(shared.key!)!;
    room.snapshot!.bytes = bare; // as an older client sent it
    const { fileKey } = await b.svc.openShared(shared.key!);
    await settle();
    expect(b.store.doc(fileKey)["0:1"]).toBeDefined();
    expect(isPackedSnapshot(rooms.get(shared.key!)!.snapshot!.bytes)).toBe(true);
    expect(await unpackSnapshot(rooms.get(shared.key!)!.snapshot!.bytes)).toEqual(bare);
  });

  it("reads a room snapshot sent before snapshots were packed (a bare Message)", async () => {
    const bare = msg([node(0, { name: "Document" })]);
    expect(await unpackSnapshot(bare)).toBe(bare);
    expect(await unpackSnapshot(await packSnapshot(bare))).toEqual(bare);
    expect(await packSnapshot(await packSnapshot(bare))).toEqual(await packSnapshot(bare));
  });

  it("gives each installation its own device ordinal from the server", async () => {
    const a = await installation("a@x.co");
    const b = await installation("b@x.co");
    services.push(a.svc, b.svc);
    expect(a.store.deviceOrdinal).toBe(2);
    expect(b.store.deviceOrdinal).toBe(3);
  });

  it("shares a file, the invitee opens it from the room's snapshot, and edits flow both ways", async () => {
    const { a, b, fa, fb } = await sharedPair();
    expect((await b.svc.listRemote())[0]).toMatchObject({ name: "Landing", role: "editor", fileKey: fb });
    expect(b.store.doc(fb)).toEqual({ "0:0": { name: "Document" }, "0:1": { name: "Home" } });
    expect((await a.svc.fileState(fa)).connection).toBe("live");
    expect((await b.svc.fileState(fb)).peers.length).toBe(1);

    a.store.edit(fa, [node(1, { name: "Landing page" })]);
    b.store.edit(fb, [node(7, { phase: "CREATED", name: "Hero" }, 3 * 2 ** 20 + 1)]);
    await settle();
    expect(b.store.doc(fb)["0:1"].name).toBe("Landing page");
    expect(a.store.doc(fa)).toEqual(b.store.doc(fb));
    // Remote frames are journaled as "remote" (the editor applies them without an undo step) and never sent back.
    expect(a.store.files.get(fa)!.frames.at(-1)!.kind).toBe("remote");
  });

  it("keeps a property this client changed and the room hasn't acknowledged (Figma's rule), and converges", async () => {
    const { a, b, fa, fb } = await sharedPair();
    // Both rename the page at once: B's frame reaches the room first, A's lands after it and wins.
    b.store.edit(fb, [node(1, { name: "From B", visible: false })]);
    a.store.edit(fa, [node(1, { name: "From A" })]);
    await settle();
    expect(a.store.doc(fa)["0:1"]).toMatchObject({ name: "From A", visible: false });
    expect(b.store.doc(fb)["0:1"]).toMatchObject({ name: "From A", visible: false });
  });

  it("sends offline edits when the connection comes back, and catches up on what it missed", async () => {
    const { a, b, fa, fb } = await sharedPair();
    for (const s of [...sockets]) s.drop();
    a.store.edit(fa, [node(1, { name: "Offline A" })]);
    b.store.edit(fb, [node(0, { name: "Doc B" })]);
    await new Promise((r) => setTimeout(r, 30));
    await settle();
    expect(a.store.doc(fa)).toEqual(b.store.doc(fb));
    expect(a.store.doc(fa)["0:1"].name).toBe("Offline A");
    expect(a.store.doc(fa)["0:0"].name).toBe("Doc B");
  });

  it("keeps the links across a restart and resumes from where it was", async () => {
    const { a, b, fa, fb } = await sharedPair();
    b.svc.close();
    for (const s of [...sockets]) if (s.readyState === 1) s.close();
    a.store.edit(fa, [node(1, { name: "While B was away" })]);
    await settle();
    const b2 = new MultiplayerService(b.store, { fetch: serverFetch, WebSocket: FakeSocket as any, random: Math.random, backoff: () => 5 });
    services.push(b2);
    await b2.setSession({ server: SERVER, token: await signIn("b@x.co") });
    await settle();
    expect(b.store.doc(fb)["0:1"].name).toBe("While B was away");
    expect(b.store.files.get(fb)!.frames.filter((c) => c.kind === "remote").length).toBe(1);
  });

  it("visits a room this client isn't in (a browser tab joins only its file) and leaves it after the linger", async () => {
    // Bug: a merge from a tab with only the branch open waited on main's copy, whose room that tab never joined.
    const { a, b, fa, fb } = await sharedPair();
    await b.svc.setSession({ server: SERVER, token: await signIn("b@x.co") }, { only: [] });
    await settle();
    expect((await b.svc.syncState(fb))!.connection).toBe("offline");
    a.store.edit(fa, [node(1, { name: "While B's tab was elsewhere" })]);
    await settle();
    expect(b.store.doc(fb)["0:1"].name).toBe("Home");

    const release = await b.svc.visit(fb, 20);
    const again = await b.svc.visit(fb, 20);
    await settle();
    expect(b.store.doc(fb)["0:1"].name).toBe("While B's tab was elsewhere");
    // The journal's tail is A's frame, never acknowledged to B: nothing of B's is unsent (a merge waited on `acked >= head`).
    const s = (await b.svc.syncState(fb))!;
    expect(s).toMatchObject({ connection: "live", pending: 0, unsent: 0 });
    expect(s.acked).toBeLessThan(b.store.files.get(fb)!.frames.at(-1)!.seq);
    b.store.edit(fb, [node(1, { name: "B again" })]);
    expect((await b.svc.syncState(fb))!.unsent).toBe(1);
    await settle();
    expect((await b.svc.syncState(fb))!.unsent).toBe(0);
    release();
    await new Promise((r) => setTimeout(r, 40));
    expect((await b.svc.syncState(fb))!.connection).toBe("live"); // still held by `again`
    again();
    again(); // a second call of one release does nothing
    await new Promise((r) => setTimeout(r, 40));
    await settle();
    expect((await b.svc.syncState(fb))!.connection).toBe("offline");
    // A file this client is in anyway: nothing to join, nothing to leave.
    const stay = await a.svc.visit(fa, 0);
    stay();
    await new Promise((r) => setTimeout(r, 10));
    expect((await a.svc.syncState(fa))!.connection).toBe("live");
  });

  it("shares reads of a file's members and access requests made at once; an invite reads them again", async () => {
    const { a, fa } = await sharedPair();
    const gets: string[] = [];
    const svc = a.svc as unknown as { deps: { fetch: typeof fetch } };
    const inner = svc.deps.fetch;
    svc.deps.fetch = async (input, init) => {
      const u = new URL(String(input));
      if ((init?.method ?? "GET") === "GET" && /\/(members|requests)$/.test(u.pathname)) gets.push(u.pathname.split("/").pop()!);
      return inner(input, init);
    };
    // Sharing and inviting read them a moment ago: still fresh.
    await a.svc.members(fa);
    expect(gets).toEqual([]);
    const realNow = Date.now;
    const t0 = realNow();
    Date.now = () => t0 + 3000; // past the freshness window
    try {
      await Promise.all([a.svc.members(fa), a.svc.members(fa), a.svc.requests(fa), a.svc.requests(fa)]);
      await a.svc.members(fa);
      expect(gets.sort()).toEqual(["members", "requests"]);
      // A change made here reads them again at once.
      expect((await a.svc.removeMember(fa, "b@x.co")).map((m) => m.email)).not.toContain("b@x.co");
      expect(gets.filter((g) => g === "members").length).toBe(2);
    } finally {
      Date.now = realNow;
    }
  });

  it("lets a viewer follow but sends nothing from it", async () => {
    const a = await installation("a@x.co");
    const v = await installation("v@x.co");
    services.push(a.svc, v.svc);
    const fa = a.store.addFile("Spec", [node(0, { name: "Document" })]);
    await a.svc.share(fa, { snapshot: a.store.files.get(fa)!.snapshot, headSeq: 0 });
    await a.svc.invite(fa, "v@x.co", "viewer");
    const { fileKey: fv } = await v.svc.openShared((await v.svc.listRemote())[0].key);
    await settle();
    v.store.edit(fv, [node(0, { name: "Viewer tried" })]);
    a.store.edit(fa, [node(0, { name: "Owner" })]);
    await settle();
    expect(v.store.doc(fv)["0:0"].name).toBe("Owner");
    expect(a.store.doc(fa)["0:0"].name).toBe("Owner");
    expect((await v.svc.fileState(fv)).role).toBe("viewer");
  });

  it("carries the images a frame uses: uploaded before it, downloaded before it lands", async () => {
    const { a, b, fa, fb } = await sharedPair();
    const png = new TextEncoder().encode("not really a png, but bytes all the same");
    await a.store.putBlob(png);
    const sha1 = [...a.store.blobs.keys()][0];
    const hash = Uint8Array.from(sha1.match(/../g)!.map((h) => parseInt(h, 16)));
    a.store.edit(fa, [node(9, { phase: "CREATED", name: "Photo", fillPaints: [{ type: "IMAGE", image: { hash } }] } as any, 2 * 2 ** 20 + 1)]);
    // The frame waits for its image (downloaded in a pool now: a few more hops)
    // The image comes through the pooled background download: wait for it, not for a fixed number of ticks
    await vi.waitFor(() => expect(b.store.blobs.get(sha1)).toEqual(png), { timeout: 5000 });
    expect(b.store.doc(fb)[`${2 * 2 ** 20 + 1}:9`].name).toBe("Photo");
  });

  it("compacts the room's history from a copy that is exactly the room's state", async () => {
    const a = await installation("a@x.co", 3);
    const b = await installation("b@x.co", 3);
    services.push(a.svc, b.svc);
    const fa = a.store.addFile("Busy", [node(0, { name: "Document" }), node(1, { name: "P" })]);
    await a.svc.share(fa, { snapshot: a.store.files.get(fa)!.snapshot, headSeq: 0 });
    await a.svc.invite(fa, "b@x.co", "editor");
    const { fileKey: fb } = await b.svc.openShared((await b.svc.listRemote())[0].key);
    await settle();
    for (let i = 0; i < 5; i++) {
      b.store.edit(fb, [node(1, { name: `P${i}` })]);
      await settle();
    }
    const room = [...rooms.values()][0];
    expect(room.snapshot!.seq).toBeGreaterThanOrEqual(3);
    // The snapshot is the document at that seq: a newcomer from it sees the latest name.
    const c = await installation("c@x.co");
    services.push(c.svc);
    await a.svc.invite(fa, "c@x.co", "viewer");
    const { fileKey: fc } = await c.svc.openShared((await c.svc.listRemote())[0].key);
    await settle();
    expect(c.store.doc(fc)["0:1"].name).toBe("P4");
  });

  it("replaces a copy left behind the room's history with a fresh one, keeping the old copy", async () => {
    const { a, b, fa, fb } = await sharedPair();
    b.svc.close();
    for (const s of [...sockets]) if (s.readyState === 1) s.close();
    for (let i = 0; i < 4; i++) a.store.edit(fa, [node(1, { name: `While away ${i}` })]);
    await settle();
    const room = [...rooms.values()][0];
    room.storage.compact(room.storage.lastSeq()); // the room compacted past B's copy (keep = 0 here)
    room.snapshot = { seq: room.storage.lastSeq(), bytes: await a.store.headSnapshot(fa) };
    const b2 = new MultiplayerService(b.store, { fetch: serverFetch, WebSocket: FakeSocket as any, random: Math.random, backoff: () => 5 });
    services.push(b2);
    const replaced: [string, string][] = [];
    b2.onReplaced((from, to) => replaced.push([from, to]));
    await b2.setSession({ server: SERVER, token: await signIn("b@x.co") });
    await settle();
    expect(replaced.length).toBe(1);
    expect(replaced[0][0]).toBe(fb);
    expect(b.store.doc(replaced[0][1])["0:1"].name).toBe("While away 3");
    expect((await b2.fileState(fb)).shared).toBe(false);
    expect((await b2.fileState(replaced[0][1])).shared).toBe(true);
  });

  it("opens a file by its link when the owner turned link access on", async () => {
    const a = await installation("a@x.co");
    const g = await installation("guest@x.co");
    services.push(a.svc, g.svc);
    const fa = a.store.addFile("Open house", [node(0, { name: "Document" })]);
    await a.svc.share(fa, { snapshot: a.store.files.get(fa)!.snapshot, headSeq: 0 });
    const info = await a.svc.setLinkAccess(fa, "editor");
    expect(info.link).toMatch(/\/f\//);
    const { keyFromLink } = await import("../../shared/multiplayer/types");
    const { fileKey: fg } = await g.svc.openShared(keyFromLink(info.link)!);
    await settle();
    g.store.edit(fg, [node(0, { name: "Guest was here" })]);
    await settle();
    expect(a.store.doc(fa)["0:0"].name).toBe("Guest was here");
    await a.svc.setLinkAccess(fa, "none");
    const late = await installation("late@x.co");
    services.push(late.svc);
    await expect(late.svc.openShared(info.key)).rejects.toMatchObject({ code: "not-found" });
  });

  it("renames a shared file on the server (what Home's listings and its library read), not only its copy", async () => {
    const { a, b, fa, fb } = await sharedPair();
    await a.svc.renameRemote(fa, "Landing v2");
    expect((await b.svc.listRemote())[0].name).toBe("Landing v2");
    await b.svc.renameRemote(fb, "Landing v3"); // an editor can
    expect((await a.svc.listRemote())[0].name).toBe("Landing v3");
    const local = a.store.addFile("Not shared", [node(0, {})]);
    await expect(a.svc.renameRemote(local, "x")).resolves.toBeUndefined(); // nothing to tell
  });

  it("lists members and invites, and refuses to share while signed out", async () => {
    const { a, fa } = await sharedPair();
    const members = await a.svc.members(fa);
    expect(members.map((m) => [m.email, m.role])).toEqual([
      ["a@x.co", "owner"],
      ["b@x.co", "editor"],
    ]);
    await a.svc.setSession(null);
    const other = a.store.addFile("Other", [node(0, {})]);
    await expect(a.svc.share(other, { snapshot: msg([]), headSeq: 0 })).rejects.toMatchObject({ code: "offline" });
  });
  it("asks for a link's password, opens with it, and sends signals to one session", async () => {
    const { a, b, fa, fb } = await sharedPair();
    await a.svc.setLinkAccess(fa, "viewer");
    const info = await a.svc.setLinkPassword(fa, "open sesame");
    expect(info.passwordProtected).toBe(true);
    const g = await installation("guest@x.co");
    services.push(g.svc);
    await expect(g.svc.openShared(info.key)).rejects.toMatchObject({ code: "forbidden", detail: { passwordRequired: true } });
    await expect(g.svc.openShared(info.key, "wrong")).rejects.toMatchObject({ detail: { passwordRequired: true, wrong: true } });
    const { fileKey: fg } = await g.svc.openShared(info.key, "open sesame");
    await settle();
    expect(g.store.doc(fg)["0:1"].name).toBe("Home");
    expect((await g.svc.fileState(fg)).connection).toBe("live");
    // Signals: to one session only, from the sender's.
    const got: { who: string; from: number; data: unknown }[] = [];
    a.svc.onSignal((_f, from, data) => got.push({ who: "a", from, data }));
    b.svc.onSignal((_f, from, data) => got.push({ who: "b", from, data }));
    const bState = await b.svc.fileState(fb);
    const gState = await g.svc.fileState(fg);
    await g.svc.signal(fg, bState.me!, { kind: "ask-spotlight" });
    await settle();
    expect(got).toEqual([{ who: "b", from: gState.me, data: { kind: "ask-spotlight" } }]);
  });

  it("transfers ownership to an invited member", async () => {
    const { a, b, fa, fb } = await sharedPair();
    const members = await a.svc.transferOwnership(fa, "b@x.co");
    expect(members.map((m) => [m.email, m.role])).toEqual([
      ["b@x.co", "owner"],
      ["a@x.co", "editor"],
    ]);
    expect((await a.svc.fileState(fa)).role).toBe("editor");
    await new Promise((r) => setTimeout(r, 30));
    await settle();
    expect((await b.svc.fileState(fb)).role).toBe("owner");
  });
});

// --- the 2026-10-12 incident: Cloudflare's pages, files gone from the server, shares that didn't finish uploading ---

/** Cloudflare's own page for a Worker over its limits (abridged) */
const CF_1102 = `<!DOCTYPE html><html><head><title>Worker exceeded resource limits | example.com | Cloudflare</title></head><body><h1><span class="cf-error-type">Error</span> <span class="cf-error-code">1102</span></h1></body></html>`;
const cfPage = (status = 503) => new Response(CF_1102, { status, headers: { "content-type": "text/html; charset=UTF-8", "cf-ray": "8d1f2a3b4c5d6e7f-AMS" } });

/** An installation whose server calls go through `wrap` first (null: the real handler answers) */
async function wrappedInstallation(email: string, wrap: (method: string, path: string) => Response | null | Promise<Response | null>, store = new FakeStore()) {
  const calls: string[] = [];
  const fetchVia: typeof fetch = async (input, init) => {
    const u = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push(`${method} ${u.pathname}${u.search}`);
    return (await wrap(method, u.pathname + u.search)) ?? serverFetch(input, init);
  };
  const svc = new MultiplayerService(store, { fetch: fetchVia, WebSocket: FakeSocket as any, random: Math.random, backoff: () => 5, retryDelays: [0, 0], uploadRetryDelays: [0, 0, 0] });
  services.push(svc);
  await svc.setSession({ server: SERVER, token: await signIn(email) });
  return { store, svc, calls };
}

/** The refusal a call ends with (a call that resolves fails the test) */
const refusal = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error("expected a refusal");
    },
    (e: unknown) => e as { code: string; message: string; detail: any },
  );

const wait = async (ms: number) => {
  await new Promise((r) => setTimeout(r, ms));
  await settle();
};

const deleteOnServer = async (key: string) => (await serverFetch(`${SERVER}/files/${key}`, { method: "DELETE", headers: { authorization: `Bearer ${await signIn("a@x.co")}` } })).status;

describe("MultiplayerService, when the server is gone or busy", () => {
  it("drops the link of a file deleted on the server, keeping the copy as a local file, and stops reconnecting", async () => {
    const { b, fb, key } = await sharedPair();
    b.svc.close();
    for (const s of [...sockets]) if (s.readyState === 1) s.close();
    expect(await deleteOnServer(key)).toBe(200);
    const states: boolean[] = [];
    const b2 = await wrappedInstallation("b@x.co", () => null, b.store);
    b2.svc.onFileState((f, s) => void (f === fb && states.push(s.shared)));
    for (let i = 0; i < 200 && b.store.saved.links[fb]; i++) await wait(5);
    await settle();
    expect(b.store.saved.links[fb]).toBeUndefined();
    expect((await b2.svc.fileState(fb)).shared).toBe(false);
    expect(states.at(-1)).toBe(false);
    expect(b.store.files.has(fb)).toBe(true);
    const asked = b2.calls.filter((c) => c === `GET /files/${key}`).length;
    expect(asked).toBe(1);
    await wait(60);
    expect(b2.calls.filter((c) => c === `GET /files/${key}`).length).toBe(asked);
  });

  it("keeps reconnecting (with its backoff) when the answer is a Cloudflare page or no network, not our 404", async () => {
    const { b, fb, key } = await sharedPair();
    b.svc.close();
    for (const s of [...sockets]) if (s.readyState === 1) s.close();
    await deleteOnServer(key);
    let n = 0;
    const b2 = await wrappedInstallation(
      "b@x.co",
      (m, path) => {
        if (m !== "GET" || path !== `/files/${key}`) return null;
        if (n++ % 2) throw new TypeError("fetch failed");
        return new Response(CF_1102, { status: 404, headers: { "content-type": "text/html" } });
      },
      b.store,
    );
    for (let i = 0; i < 200 && n <= 2; i++) await wait(5);
    expect(b.store.saved.links[fb]).toBeDefined();
    expect((await b2.svc.fileState(fb)).shared).toBe(true);
    expect(n).toBeGreaterThan(2);
  });

  it("finishes a share whose snapshot upload failed part-way: remembered in the link, uploaded on the next start", async () => {
    let failing = true;
    const a = await wrappedInstallation("a@x.co", (m, path) => (failing && m === "PUT" && /\/snapshot\?seq=/.test(path) ? cfPage(503) : null));
    const fa = a.store.addFile("B2C Project", [node(0, { name: "Document" }), node(1, { name: "Page 1" })]);
    const err = await refusal(a.svc.share(fa, { snapshot: msg([node(0, { name: "Document" }), node(1, { name: "Page 1" })]), headSeq: 0 }));
    expect(err.code).toBe("unavailable");
    expect(err.message).not.toMatch(/<|DOCTYPE/i);
    expect(err.detail).toMatchObject({ code: "upload_incomplete", pendingUpload: true });
    // Tried 1 + 3 times, then remembered
    expect(a.calls.filter((c) => c.startsWith("PUT ") && c.includes("/snapshot")).length).toBeGreaterThanOrEqual(4);
    const rec = a.store.saved.links[fa] as { key: string; pendingUpload?: boolean };
    expect(rec.pendingUpload).toBe(true);
    expect(rooms.get(rec.key)?.snapshot ?? null).toBeNull();

    // Someone it's shared with, meanwhile: "still uploading", not an error page, and nothing linked
    await a.svc.invite(fa, "b@x.co", "editor");
    a.svc.close();
    const b = await wrappedInstallation("b@x.co", () => null);
    const opening = await refusal(b.svc.openShared(rec.key));
    expect(opening.message).toBe("This file is still uploading. Try again in a moment.");
    expect(opening.detail.code).toBe("no_snapshot");
    expect(Object.keys(b.store.saved.links)).toEqual([]);

    // The next start (the server well again) uploads it, then joins the room
    failing = false;
    a.store.edit(fa, [node(1, { name: "Edited offline" })]);
    const a2 = await wrappedInstallation("a@x.co", () => null, a.store);
    for (let i = 0; i < 200 && (await a2.svc.fileState(fa)).connection !== "live"; i++) await wait(5);
    expect((a.store.saved.links[fa] as { pendingUpload?: boolean }).pendingUpload).toBeUndefined();
    expect(rooms.get(rec.key)!.snapshot).not.toBeNull();
    expect((await a2.svc.fileState(fa)).connection).toBe("live");
    const { fileKey } = await b.svc.openShared(rec.key);
    for (let i = 0; i < 200 && b.store.doc(fileKey)["0:1"].name !== "Edited offline"; i++) await wait(5);
    expect(b.store.doc(fileKey)["0:1"].name).toBe("Edited offline");
    // The edit is in the room's snapshot itself (uploaded from the copy's head), not only sent as a frame after it
    expect(decodeMessage(await unpackSnapshot(rooms.get(rec.key)!.snapshot!.bytes)).nodeChanges?.find((n) => n.guid?.localID === 1)?.name).toBe("Edited offline");
  });

  it("retries a share's upload through a busy moment and succeeds without a trace", async () => {
    let refusals = 2;
    const a = await wrappedInstallation("a@x.co", (m, path) => (m === "PUT" && /\/snapshot\?seq=/.test(path) && refusals-- > 0 ? new Response("error code: 1102", { status: 503, headers: { "cf-ray": "x-AMS" } }) : null));
    const fa = a.store.addFile("Landing", [node(0, { name: "Document" })]);
    const shared = await a.svc.share(fa, { snapshot: msg([node(0, { name: "Document" })]), headSeq: 0 });
    expect(shared.shared).toBe(true);
    expect((a.store.saved.links[fa] as { pendingUpload?: boolean }).pendingUpload).toBeUndefined();
    expect(rooms.get(shared.key!)!.snapshot).not.toBeNull();
  });

  it("tries a read again through Cloudflare's pages and says our words when they persist; writes go once", async () => {
    let pages = 2;
    const a = await wrappedInstallation("a@x.co", (m, path) => (m === "GET" && path === "/files" && pages-- > 0 ? cfPage(503) : null));
    expect(await a.svc.listRemote()).toEqual([]);
    pages = 10;
    const err = await refusal(a.svc.listRemote());
    expect(err).toMatchObject({ code: "unavailable", message: "The server is busy. Try again in a moment." });
    expect(err.detail).toMatchObject({ code: "server_busy", status: 503, cloudflare: 1102 });
    const b = await wrappedInstallation("b@x.co", (m) => (m === "POST" ? cfPage(502) : null));
    await expect(b.svc.call("POST", "/files", { key: "x_000000000000", name: "X" })).rejects.toMatchObject({ code: "unavailable" });
    expect(b.calls.filter((c) => c === "POST /files").length).toBe(1);
  });
});

// --- the upload panel (docs/multiplayer.md §5.1): progress, retries, Retry, Cancel, resumed uploads ---

/** An installation whose uploads the test follows from its first start (events before the session) */
async function watchedInstallation(email: string, wrap: (method: string, path: string, init: RequestInit) => Response | null | Promise<Response | null>, more: Partial<MultiplayerDeps> = {}, store = new FakeStore()) {
  const calls: string[] = [];
  const streamed: { path: string; declared: string | null; got: number }[] = [];
  const fetchVia: typeof fetch = async (input, init = {}) => {
    const u = new URL(String(input));
    const method = init.method ?? "GET";
    calls.push(`${method} ${u.pathname}${u.search}`);
    let i = init;
    // A streamed body read here as the network would (the in-process rooms keep bytes)
    if (init.body instanceof ReadableStream) {
      const bytes = new Uint8Array(await new Response(init.body).arrayBuffer());
      streamed.push({ path: u.pathname, declared: (init.headers as Record<string, string>)["content-length"] ?? null, got: bytes.length });
      // …and handed on whole (the in-process rooms read bytes, not a stream the Worker streams on)
      const { duplex: _d, ...rest } = init as RequestInit & { duplex?: string };
      const { "content-length": _l, ...headers } = init.headers as Record<string, string>;
      i = { ...rest, headers, body: bytes as unknown as RequestInit["body"] };
    }
    return (await wrap(method, u.pathname + u.search, init)) ?? serverFetch(input, i);
  };
  const svc = new MultiplayerService(store, { fetch: fetchVia, WebSocket: FakeSocket as any, random: Math.random, backoff: () => 5, retryDelays: [0, 0], uploadRetryDelays: [0, 0, 0], ...more });
  services.push(svc);
  const events: UploadEvent[] = [];
  svc.onUploads((e) => events.push(e));
  await svc.setSession({ server: SERVER, token: await signIn(email) });
  const uploads = () => events.filter((e): e is { upload: UploadProgress } => "upload" in e).map((e) => e.upload);
  return { store, svc, calls, streamed, events, uploads, api: multiplayerApi(svc) };
}

/** A snapshot of about `bytes` (one long layer name) */
const bigSnapshot = (bytes: number) => msg([node(0, { name: "Document" }), node(1, { name: "x".repeat(bytes) })]);

/** A request that hangs until its signal aborts it, as a slow upload would */
const hanging = (init: RequestInit) => new Promise<Response>((_, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError"))));

const snapshotPut = (m: string, path: string) => m === "PUT" && /\/snapshot\?seq=/.test(path);

describe("MultiplayerService, the upload panel", () => {
  it("streams a share's snapshot with its length declared and reports its bytes as they go, then done", async () => {
    const a = await watchedInstallation("a@x.co", () => null, { streamUploads: true });
    Object.assign(a.store, { describeUpload: async () => "Anex Tour › Design › KOC" });
    const snapshot = bigSnapshot(900_000);
    const fa = a.store.addFile("Big file", [node(0, { name: "Document" })]);
    const shared = await a.svc.share(fa, { snapshot, headSeq: 0 });
    await settle();
    // Gzipped for the wire (snapshotWire.ts): the room keeps what came, the Message comes back out of it
    const packed = await packSnapshot(snapshot);
    expect(packed.length).toBeLessThan(snapshot.length / 10);
    const put = a.streamed.find((s) => s.path.endsWith("/snapshot"))!;
    expect(put).toEqual({ path: `/files/${shared.key}/snapshot`, declared: String(packed.length), got: packed.length });
    expect(await unpackSnapshot(rooms.get(shared.key!)!.snapshot!.bytes)).toEqual(snapshot);
    const mine = a.uploads().filter((u) => u.fileKey === fa);
    expect(mine[0]).toMatchObject({ state: "queued", name: "Big file", bytesSent: 0, retryable: true });
    const sent = mine.filter((u) => u.state === "uploading").map((u) => u.bytesSent);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent).toEqual([...sent].sort((x, y) => x - y));
    expect(mine.at(-1)).toMatchObject({ state: "done", bytesSent: packed.length, bytesTotal: packed.length, destination: "Anex Tour › Design › KOC" });
    expect(await a.api.uploads()).toHaveLength(1);
  });

  it("says each retry of a busy moment, falling back to the bytes landed, then finishes", async () => {
    let refusals = 2;
    const a = await watchedInstallation("a@x.co", (m, path) => (snapshotPut(m, path) && refusals-- > 0 ? cfPage(503) : null));
    const fa = a.store.addFile("Landing", [node(0, { name: "Document" })]);
    await a.svc.share(fa, { snapshot: msg([node(0, { name: "Document" })]), headSeq: 0 });
    const states = a.uploads().map((u) => (u.state === "retrying" ? `retrying ${u.attempt} at ${u.bytesSent}` : u.state));
    expect(states).toContain("retrying 2 at 0");
    expect(states).toContain("retrying 3 at 0");
    expect(states.at(-1)).toBe("done");
  });

  it("fails with the server's words and Retry, which uploads it now", async () => {
    let failing = true;
    // The link's own retries wait a minute: only Retry sends it again
    const a = await watchedInstallation("a@x.co", (m, path) => (failing && snapshotPut(m, path) ? cfPage(503) : null), { backoff: () => 60_000 });
    const fa = a.store.addFile("B2C Project", [node(0, { name: "Document" })]);
    await expect(a.svc.share(fa, { snapshot: msg([node(0, { name: "Document" })]), headSeq: 0 })).rejects.toMatchObject({ detail: { code: "upload_incomplete" } });
    await wait(30);
    const failed = a.uploads().at(-1)!;
    expect(failed).toMatchObject({ state: "failed", error: "The server is busy. Try again in a moment.", retryable: true });
    failing = false;
    await a.api.retryUpload(failed.id);
    for (let i = 0; i < 200 && a.uploads().at(-1)!.state !== "done"; i++) await wait(5);
    expect(a.uploads().at(-1)).toMatchObject({ id: failed.id, state: "done" });
    expect((a.store.saved.links[fa] as { pendingUpload?: boolean }).pendingUpload).toBeUndefined();
  });

  it("cancels an upload under way: the request aborts, the file stays local and unlinked, the server's empty file goes", async () => {
    const a = await watchedInstallation("a@x.co", (m, path, init) => (snapshotPut(m, path) ? hanging(init) : null));
    const fa = a.store.addFile("Huge", [node(0, { name: "Document" })]);
    const sharing = a.svc.share(fa, { snapshot: msg([node(0, { name: "Document" })]), headSeq: 0 });
    for (let i = 0; i < 200 && !a.calls.some((c) => c.startsWith("PUT ") && c.includes("/snapshot")); i++) await wait(2);
    const id = a.uploads().at(-1)!.id;
    const key = (a.store.saved.links[fa] as { key: string }).key;
    await a.api.cancelUpload(id);
    await expect(sharing).rejects.toMatchObject({ code: "invalid", message: "Upload canceled", detail: { code: "upload_canceled" } });
    await wait(20);
    expect(a.store.saved.links[fa]).toBeUndefined();
    expect((await a.svc.fileState(fa)).shared).toBe(false);
    expect(a.store.files.has(fa)).toBe(true);
    expect(a.events.at(-1)).toEqual({ removed: id });
    expect(await a.api.uploads()).toEqual([]);
    expect(a.calls).toContain(`DELETE /files/${key}`);
    expect(await server.db.file(key)).toBeNull();
  });

  it("cancels one waiting to try again: unlinked at once, no upload left", async () => {
    const a = await watchedInstallation("a@x.co", (m, path) => (snapshotPut(m, path) ? cfPage(503) : null), { backoff: () => 60_000 });
    const fa = a.store.addFile("Waiting", [node(0, { name: "Document" })]);
    await expect(a.svc.share(fa, { snapshot: msg([node(0, { name: "Document" })]), headSeq: 0 })).rejects.toBeDefined();
    await wait(30);
    const id = a.uploads().at(-1)!.id;
    await a.api.cancelUpload(id);
    await wait(10);
    expect(a.store.saved.links[fa]).toBeUndefined();
    expect(await a.api.uploads()).toEqual([]);
    expect(a.calls.some((c) => c.startsWith("DELETE /files/"))).toBe(true);
  });

  it("reports an upload resumed at start-up from its first try", async () => {
    let failing = true;
    const a = await watchedInstallation("a@x.co", (m, path) => (failing && snapshotPut(m, path) ? cfPage(503) : null), { backoff: () => 60_000 });
    const fa = a.store.addFile("Resumed", [node(0, { name: "Document" })]);
    await expect(a.svc.share(fa, { snapshot: msg([node(0, { name: "Document" })]), headSeq: 0 })).rejects.toBeDefined();
    await wait(30);
    a.svc.close();
    failing = false;
    // The next start: the store's link finishes the upload, and the panel sees it from queued to done
    const a2 = await watchedInstallation("a@x.co", () => null, {}, a.store);
    for (let i = 0; i < 200 && a2.uploads().at(-1)?.state !== "done"; i++) await wait(5);
    const states = a2.uploads().map((u) => u.state);
    expect(states[0]).toBe("queued");
    expect(states.at(-1)).toBe("done");
    expect(a2.uploads().at(-1)).toMatchObject({ fileKey: fa, name: "Resumed" });
    expect(a2.uploads().at(-1)!.bytesSent).toBeGreaterThan(0);
  });
});

// --- Wecra 1.1 (docs/cloud.md §4): images to R2, 4 at a time, big ones in parts, the snapshot after them ---

describe("MultiplayerService, images to R2", () => {
  it("sends a file's images 4 at a time, one over 8 MB in parts (a failed part alone again), then the snapshot", async () => {
    const r2 = memoryBuckets();
    Object.assign(server.env, r2);
    let active = 0;
    let most = 0;
    let failPart2 = true;
    const blobCall = (m: string, path: string) => (m === "PUT" || m === "POST") && /\/blobs\/[0-9a-f]{40}(\/|$)/.test(path);
    const a = await watchedInstallation("a@x.co", async (m, path, init) => {
      if (m === "PUT" && path.endsWith("/parts/2") && failPart2) {
        failPart2 = false;
        return cfPage(503);
      }
      if (!blobCall(m, path) || path.endsWith("/complete") || path.endsWith("/uploads")) return null;
      active++;
      most = Math.max(most, active);
      await wait(5);
      try {
        return await serverFetch(`${SERVER}${path}`, init);
      } finally {
        active--;
      }
    });
    const images = [...Array.from({ length: 5 }, (_, i) => new Uint8Array(300_000).fill(i + 1)), new Uint8Array(9 * 1024 * 1024 + 123).fill(9)];
    const hashes: string[] = [];
    for (const img of images) {
      await a.store.putBlob(img);
      hashes.push([...a.store.blobs.keys()].at(-1)!);
    }
    const hashOf = (hex: string) => Uint8Array.from(hex.match(/../g)!.map((h) => parseInt(h, 16)));
    const snapshot = msg([node(0, { name: "Document" }), ...hashes.map((h, i) => node(10 + i, { name: `Photo ${i}`, fillPaints: [{ type: "IMAGE", image: { hash: hashOf(h) } }] } as any))]);
    const fa = a.store.addFile("Photos", [node(0, { name: "Document" })]);
    const shared = await a.svc.share(fa, { snapshot, headSeq: 0 });
    expect(most).toBeGreaterThan(1);
    expect(most).toBeLessThanOrEqual(4);
    const big = hashes[5];
    const parts = a.calls.filter((c) => c.includes(`/blobs/${big}/uploads/`));
    expect(parts.filter((c) => c.endsWith("/parts/1"))).toHaveLength(1);
    expect(parts.filter((c) => c.endsWith("/parts/2"))).toHaveLength(2);
    expect(parts.at(-1)).toMatch(/\/complete$/);
    // The snapshot only after every image landed
    const snapAt = a.calls.findIndex((c) => c.startsWith("PUT") && c.includes(`/files/${shared.key}/snapshot`));
    const lastBlob = Math.max(...a.calls.map((c, i) => (c.includes("/blobs/") && !c.includes("/missing") ? i : -1)));
    expect(snapAt).toBeGreaterThan(lastBlob);
    expect([...r2.FILES.objects.keys()].filter((k) => k.startsWith("b/")).sort()).toEqual(hashes.map((h) => `b/${h}`).sort());
    const done = a.uploads().at(-1)!;
    expect(done).toMatchObject({ state: "done", bytesTotal: (await packSnapshot(snapshot)).length + images.reduce((n, b) => n + b.length, 0) });
    expect(a.uploads().some((u) => u.state === "retrying")).toBe(true);
  });
});

describe("MultiplayerService, images after the file opens (Wecra 1.1.1, docs/cloud.md §4.1)", () => {
  const hashOf = (sha1: string) => Uint8Array.from(sha1.match(/../g)!.map((h) => parseInt(h, 16)));
  const isBlobGet = (m: string, path: string) => m === "GET" && /\/blobs\/[0-9a-f]{40}$/.test(path);

  /** Images' downloads that wait until the test opens the gate */
  function gate() {
    const g = { open: false, inFlight: 0, max: 0, order: [] as string[], waiters: [] as (() => void)[] };
    const wrap = async (m: string, path: string) => {
      if (!isBlobGet(m, path)) return null;
      g.order.push(path.slice(-40));
      g.inFlight++;
      g.max = Math.max(g.max, g.inFlight);
      if (!g.open) await new Promise<void>((r) => g.waiters.push(r));
      g.inFlight--;
      return null;
    };
    const release = async () => {
      g.open = true;
      for (const w of g.waiters.splice(0)) w();
      await settle();
    };
    return { g, wrap, release };
  }

  /** `a` shares a file of `n` images on two pages (the first page's are the last two made), `b` is invited */
  async function sharedWithImages(n: number) {
    const a = await installation("a@x.co");
    services.push(a.svc);
    const sha1s: string[] = [];
    for (let i = 0; i < n; i++) {
      const bytes = new TextEncoder().encode(`image ${i} `.repeat(40));
      await a.store.putBlob(bytes);
      sha1s.push([...a.store.blobs.keys()].at(-1)!);
    }
    const at = (localID: number, position: string) => ({ parentIndex: { guid: { sessionID: 0, localID }, position } });
    const nodes = [
      node(0, { type: "DOCUMENT", name: "Document" }),
      node(1, { type: "CANVAS", name: "Cover", ...at(0, "a") }),
      node(2, { type: "CANVAS", name: "Archive", ...at(0, "b") }),
      ...sha1s.map((s, i) => node(10 + i, { type: "RECTANGLE", name: `Photo ${i}`, ...at(i >= n - 2 ? 1 : 2, String.fromCharCode(65 + i)), fillPaints: [{ type: "IMAGE", image: { hash: hashOf(s) } }] })),
    ];
    const fa = a.store.addFile("Photos", nodes);
    const shared = await a.svc.share(fa, { snapshot: msg(nodes), headSeq: 0 });
    await a.svc.invite(fa, "b@x.co", "editor");
    return { a, fa, key: shared.key!, sha1s };
  }

  it("opens as soon as the snapshot is here; the images come after, the opened page's first, and are said", async () => {
    const { key, sha1s } = await sharedWithImages(12);
    const { g, wrap, release } = gate();
    const b = await watchedInstallation("b@x.co", wrap, { retryDelays: [] });
    const arrived: string[] = [];
    b.svc.onBlobsArrived((e) => arrived.push(...e.arrived));
    const { fileKey } = await b.svc.openShared(key);
    // Opened with no image here yet, the queue kept with the link for the next start
    expect(b.store.files.has(fileKey)).toBe(true);
    expect(b.store.blobs.size).toBe(0);
    expect((b.store.saved.links[fileKey] as { images?: string[] }).images).toHaveLength(12);
    await settle();
    // 8 at a time, the page it opens on first
    expect(g.max).toBe(8);
    expect(g.order.slice(0, 2).sort()).toEqual(sha1s.slice(-2).sort());
    const row = b.uploads().filter((u) => u.direction === "download").at(-1)!;
    expect(row).toMatchObject({ fileKey, name: "Photos", destination: "Downloading images" });
    await release();
    expect([...b.store.blobs.keys()].sort()).toEqual([...sha1s].sort());
    expect(arrived.sort()).toEqual([...sha1s].sort());
    expect((b.store.saved.links[fileKey] as { images?: string[] }).images).toBeUndefined();
    expect(b.uploads().filter((u) => u.direction === "download").at(-1)!.state).toBe("done");
  });

  it("an image wanted now (an editor, an export) goes to the front and is waited for", async () => {
    const { key, sha1s } = await sharedWithImages(12);
    const { g, wrap, release } = gate();
    const b = await watchedInstallation("b@x.co", wrap, { downloadConcurrency: 1 });
    await b.svc.openShared(key);
    await settle();
    const late = sha1s[5];
    const wanted = b.svc.wantBlob(late);
    // The one going finishes, then the wanted one
    g.waiters.shift()!();
    await settle();
    expect(g.order[1]).toBe(late);
    await release();
    expect(await wanted).toBe(true);
    expect(b.store.blobs.has(late)).toBe(true);
    // Nothing fetching it: false at once (the reader says not-found as before)
    expect(await b.svc.wantBlob("f".repeat(40))).toBe(false);
  });

  it("continues at the next start for a copy whose images didn't all come", async () => {
    const { key, sha1s } = await sharedWithImages(4);
    const { wrap } = gate();
    const store = new FakeStore();
    const b = await watchedInstallation("b@x.co", wrap, {}, store);
    const { fileKey } = await b.svc.openShared(key);
    await settle();
    b.svc.close();
    expect(store.blobs.size).toBe(0);
    expect((store.saved.links[fileKey] as { images?: string[] }).images).toHaveLength(4);
    // The store starts again: the link's images come down
    const again = await watchedInstallation("b@x.co", () => null, {}, store);
    await settle();
    expect([...store.blobs.keys()].sort()).toEqual([...sha1s].sort());
    expect((store.saved.links[fileKey] as { images?: string[] }).images).toBeUndefined();
    expect(again.uploads().filter((u) => u.direction === "download").at(-1)).toMatchObject({ fileKey, state: "done" });
  });
});

describe("MultiplayerService, Phase 6: concurrent editing (docs/multiplayer.md §18)", () => {
  const S = 2 * 2 ** 20 + 1;
  const big = (n: number, c = "x") => c.repeat(n);
  /** The room's frames of one of A's journal frames (its batch), in order */
  const framesOf = (key: string, batch: number) => rooms.get(key)!.storage.frames.filter((f) => f.batch === batch && f.sessionID !== 0);

  it("sends a change too large for one frame in parts, each a whole Message; the other side converges", async () => {
    const { a, b, fa, fb, key } = await sharedPair();
    a.store.edit(fa, [node(20, { phase: "CREATED", name: big(1_200_000) }, S), node(21, { phase: "CREATED", name: big(1_200_000, "y") }, S), node(1, { name: "After the paste" })]);
    const seq = a.store.files.get(fa)!.frames.at(-1)!.seq;
    await settle();
    const parts = framesOf(key, seq);
    expect(parts.length).toBe(3);
    for (const p of parts) expect(p.message.length).toBeLessThan(1_900_000);
    expect(parts.flatMap((p) => decodeMessage(p.message).nodeChanges!.map((n) => n.guid!.localID))).toEqual([20, 21, 1]);
    expect(b.store.doc(fb)).toEqual(a.store.doc(fa));
    expect(b.store.doc(fb)["0:1"].name).toBe("After the paste");
    expect(await a.svc.syncState(fa)).toMatchObject({ pending: 0, unsent: 0 });
    expect((a.store.saved.links[fa] as { partial?: unknown }).partial).toBeUndefined();
  });

  it("sends only the parts the room didn't take when the connection drops part-way", async () => {
    const { a, b, fa, fb, key } = await sharedPair();
    const room = rooms.get(key)!.room;
    const receive = room.receive.bind(room);
    let binary = 0;
    room.receive = (conn, data) => {
      receive(conn, data);
      // The network goes right after the room took the first part (its echo is lost with the socket)
      if (typeof data !== "string" && ++binary === 1) queueMicrotask(() => [...sockets].forEach((s) => s.drop()));
    };
    a.store.edit(fa, [node(20, { phase: "CREATED", name: big(1_200_000) }, S), node(21, { phase: "CREATED", name: big(1_200_000, "y") }, S), node(1, { name: "After the paste" })]);
    const seq = a.store.files.get(fa)!.frames.at(-1)!.seq;
    await wait(40);
    await wait(40);
    // Each part once: the first from before the drop, the rest after the reconnect
    expect(framesOf(key, seq).flatMap((p) => decodeMessage(p.message).nodeChanges!.map((n) => n.guid!.localID))).toEqual([20, 21, 1]);
    expect(b.store.doc(fb)).toEqual(a.store.doc(fa));
    expect(await a.svc.syncState(fa)).toMatchObject({ connection: "live", pending: 0, unsent: 0 });
  });

  it("reconnects when the room doesn't acknowledge a frame in time, and sends it again", async () => {
    const { a, b, fa, fb, key } = await sharedPair({ a: { ackTimeoutMs: 20 } });
    const room = rooms.get(key)!.room;
    const receive = room.receive.bind(room);
    let swallowed = false;
    room.receive = (conn, data) => {
      // Lost between the socket and the room: never sequenced, never echoed
      if (typeof data !== "string" && !swallowed) return void (swallowed = true);
      receive(conn, data);
    };
    a.store.edit(fa, [node(1, { name: "Lost on the way" })]);
    const seq = a.store.files.get(fa)!.frames.at(-1)!.seq;
    await wait(60);
    await wait(20);
    expect(swallowed).toBe(true);
    expect(framesOf(key, seq).length).toBe(1); // the second try's
    expect(b.store.doc(fb)["0:1"].name).toBe("Lost on the way");
    expect(await a.svc.syncState(fa)).toMatchObject({ connection: "live", pending: 0, unsent: 0 });
  });

  it("rolls back changes the room won't take: made a viewer while offline, the copy is replaced by the room's and keeps them as a draft", async () => {
    const { a, b, fa, fb } = await sharedPair({ b: { backoff: () => 200 } });
    const replaced: [string, string, string][] = [];
    b.svc.onReplaced((from, to, why) => replaced.push([from, to, why]));
    for (const s of [...sockets]) s.drop();
    b.store.edit(fb, [node(1, { name: "B offline" })]);
    await a.svc.invite(fa, "b@x.co", "viewer");
    await wait(260);
    await wait(20);
    expect(replaced).toEqual([[fb, expect.any(String), "read-only"]]);
    // Nothing lost: the change stays in the old copy, unlinked; the fresh copy and the room have the server's value.
    expect(b.store.doc(fb)["0:1"].name).toBe("B offline");
    expect((await b.svc.fileState(fb)).shared).toBe(false);
    expect(b.store.doc(replaced[0][1])["0:1"].name).toBe("Home");
    expect(a.store.doc(fa)["0:1"].name).toBe("Home");
    expect((await b.svc.fileState(replaced[0][1])).role).toBe("viewer");
  });

  it("a viewer's own local frames (never sent) are no reason to roll back", async () => {
    const { a, b, fa, fb } = await sharedPair();
    await a.svc.invite(fa, "b@x.co", "viewer");
    await wait(20);
    const replaced: string[] = [];
    b.svc.onReplaced((from) => replaced.push(from));
    b.store.edit(fb, [node(1, { name: "Viewer's local" })]);
    for (const s of [...sockets]) s.drop();
    await wait(30);
    expect(replaced).toEqual([]);
    expect(await b.svc.fileState(fb)).toMatchObject({ shared: true, role: "viewer" });
  });

  it("rolls back a change one field of which no frame can carry", async () => {
    const { a, b, fa, fb } = await sharedPair();
    const replaced: [string, string, string][] = [];
    a.svc.onReplaced((from, to, why) => replaced.push([from, to, why]));
    a.store.edit(fa, [node(1, { name: big(2_000_000) })]);
    await wait(20);
    expect(replaced).toEqual([[fa, expect.any(String), "too-large"]]);
    expect(String(a.store.doc(fa)["0:1"].name).length).toBe(2_000_000);
    expect(a.store.doc(replaced[0][1])["0:1"].name).toBe("Home");
    expect(b.store.doc(fb)["0:1"].name).toBe("Home");
    expect((await a.svc.fileState(replaced[0][1])).connection).toBe("live");
  });
});

describe("MultiplayerService, Phase 6: convergence (docs/multiplayer.md §18.4)", () => {
  /** The document the room's order makes: its snapshot, then every frame it holds after it */
  async function roomDoc(key: string) {
    const r = rooms.get(key)!;
    const out: Record<string, Record<string, unknown>> = {};
    const frames = [await unpackSnapshot(r.snapshot!.bytes), ...r.storage.frames.filter((f) => f.seq > r.snapshot!.seq).map((f) => f.message)];
    for (const bytes of frames)
      for (const nc of decodeMessage(bytes).nodeChanges ?? []) {
        const k = `${nc.guid!.sessionID}:${nc.guid!.localID}`;
        const { guid: _g, phase: _p, ...rest } = nc as any;
        out[k] = { ...(nc.phase === "CREATED" ? {} : out[k]), ...rest };
      }
    return out;
  }

  for (const start of [7, 2024, 31337])
    it(`three installations editing the same properties at once, with dropped connections, end on the room's order (seed ${start})`, async () => {
      const { a, b, fa, fb, key } = await sharedPair();
      const c = await installation("c@x.co");
      services.push(c.svc);
      await a.svc.invite(fa, "c@x.co", "editor");
      const { fileKey: fc } = await c.svc.openShared(key);
      await settle();
      const peers = [
        { store: a.store, svc: a.svc, f: fa },
        { store: b.store, svc: b.svc, f: fb },
        { store: c.store, svc: c.svc, f: fc },
      ];
      let seed = start;
      const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
      for (let step = 0; step < 80; step++) {
        const p = peers[Math.floor(rnd() * peers.length)];
        const id = Math.floor(rnd() * 2);
        const field = ["name", "visible", "opacity"][Math.floor(rnd() * 3)];
        const value = field === "name" ? `step ${step}` : field === "visible" ? rnd() < 0.5 : step / 100;
        p.store.edit(p.f, [node(id, { [field]: value })]);
        if (rnd() < 0.08) for (const s of [...sockets]) if (rnd() < 0.5) s.drop();
        if (rnd() < 0.3) await settle(); // some edits land together, some apart
      }
      await wait(40);
      await wait(40);
      for (const p of peers) expect(await p.svc.syncState(p.f)).toMatchObject({ connection: "live", pending: 0, unsent: 0 });
      const room = await roomDoc(key);
      expect(a.store.doc(fa)).toEqual(room);
      expect(b.store.doc(fb)).toEqual(room);
      expect(c.store.doc(fc)).toEqual(room);
    });
});

describe("MultiplayerService, Phase 6: Offline sync (atlas 22 §3.3)", () => {
  it("keeps the room's state as a version before changes made away from it are sent; not for a link with nothing waiting", async () => {
    const { a, b, fa, fb } = await sharedPair();
    b.svc.close();
    for (const s of [...sockets]) if (s.readyState === 1) s.close();
    b.store.edit(fb, [node(1, { name: "Made while closed" })]);
    const calls: string[] = [];
    const record: typeof fetch = async (input, init) => {
      const u = new URL(String(input));
      if ((init?.method ?? "GET") === "POST" && u.pathname.endsWith("/versions")) calls.push(String(init?.body));
      return serverFetch(input, init);
    };
    const b2 = new MultiplayerService(b.store, { fetch: record, WebSocket: FakeSocket as any, random: Math.random, backoff: () => 5 });
    services.push(b2);
    await b2.setSession({ server: SERVER, token: await signIn("b@x.co") });
    await settle();
    expect(calls.map((c) => JSON.parse(c))).toEqual([{ kind: "named", title: "Offline sync", description: "Before syncing changes" }]);
    expect(a.store.doc(fa)["0:1"].name).toBe("Made while closed");
    // A reconnect a moment later with nothing waiting: no savepoint
    for (const s of [...sockets]) s.drop();
    await wait(30);
    expect(calls).toHaveLength(1);
  });
});
