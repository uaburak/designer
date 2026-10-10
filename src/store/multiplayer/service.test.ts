/**
 * Two installations editing one shared file through the real API (server/src/api.ts on node:sqlite) and the real room
 * (src/shared/multiplayer/room.ts), with an in-process WebSocket: share, join, edits both ways, Figma's conflict rule,
 * offline edits resent on reconnect, viewers.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handle, type Deps, type Rooms } from "../../../server/src/api";
import { Db } from "../../../server/src/db";
import { sqliteD1 } from "../../../server/src/testing/sqliteD1";
import { MemoryRoomStorage, Room, type Connection } from "../../shared/multiplayer/room";
import { decodeMessage, encodeMessage, type NodeChange } from "../../shared/schema/codec";
import type { FileChange } from "../../shared/store/repositories";
import type { FileKey, FileMeta } from "../../shared/store/types";
import { MultiplayerService, type MultiplayerHost } from "./service";

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
    if (path === "/room/snapshot") return r.snapshot ? new Response(r.snapshot.bytes, { headers: { "x-seq": String(r.snapshot.seq) } }) : new Response("none", { status: 404 });
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
  async createSharedFile(input: { name: string; snapshot: Uint8Array }) {
    const fileKey = `joined${++this.n}`;
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

async function installation(email: string, compactEvery?: number) {
  const store = new FakeStore();
  const svc = new MultiplayerService(store, { fetch: serverFetch, WebSocket: FakeSocket as any, random: Math.random, backoff: () => 5, compactEvery });
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

async function sharedPair() {
  const a = await installation("a@x.co");
  const b = await installation("b@x.co");
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
    await settle();
    expect(b.store.blobs.get(sha1)).toEqual(png);
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
