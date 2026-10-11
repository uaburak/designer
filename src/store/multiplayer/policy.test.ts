/**
 * Round 4c — what reaches the editor of the org's policies and of the idle timeout (docs/multiplayer.md §15.8–§15.10),
 * against the real handler of rounds 4a and 4b (src/store/org/fake/real.ts) and the real room
 * (src/shared/multiplayer/room.ts): the file's `policy` with its share info, `welcome.policy` and `{t: "policy"}`
 * (posted by the Worker's `PATCH admin/settings` to the room) as `FileShareState.policy` and a `policy` event, a close
 * with 4012 reconnecting after 2 s, and a 401 `idle_timeout` ending the session (`SessionEnded`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Rooms } from "../../../server/src/api";
import { acmeServer, REAL_ORIGIN as ORIGIN } from "../org/fake/real";
import { MemoryRoomStorage, Room, type Connection, type Identity } from "../../shared/multiplayer/room";
import type { MultiplayerEvent, SessionEnded } from "../../shared/multiplayer/types";
import type { RoomPolicy } from "../../shared/org/identity";
import { encodeMessage } from "../../shared/schema/codec";
import type { FileChange } from "../../shared/store/repositories";
import type { FileKey, FileMeta } from "../../shared/store/types";
import { multiplayerApi } from "./api";
import { MOVING_RETRY_MS, MultiplayerService, type MultiplayerHost } from "./service";

/* eslint-disable @typescript-eslint/no-explicit-any */

let w: Awaited<ReturnType<typeof world>>;
async function world() {
  const a = await acmeServer();
  return { ...a, deps: a.srv.deps, run: (sql: string, ...args: unknown[]) => a.srv.exec(sql, ...args), rows: (sql: string, ...args: unknown[]) => a.srv.rows<any>(sql, ...args) };
}
const rooms = new Map<string, Room>();
/** The identity (and policy) the Worker forwarded with each socket upgrade, by room key, for the socket to take */
const upgrades = new Map<string, Identity[]>();
const roomOf = (key: string) => {
  let r = rooms.get(key);
  if (!r) rooms.set(key, (r = new Room(new MemoryRoomStorage())));
  return r;
};

/** The Worker's room calls: the upgrade hands its identity and `policy` (x-policy) over; `/room/policy` broadcasts */
const fakeRooms: Rooms = {
  async fetch(key, path, init) {
    if (path === "/room/ws") {
      const id = init.identity!;
      upgrades.set(key, [...(upgrades.get(key) ?? []), { userId: id.userId, name: id.name ?? undefined, role: id.role, ...(init.policy ? { policy: init.policy } : {}) }]);
      return new Response(null, { status: 200, headers: { "x-upgrade": "ok" } });
    }
    if (path === "/room/policy") {
      roomOf(key).setPolicy(JSON.parse(String(init.body)) as RoomPolicy);
      return Response.json({ ok: true });
    }
    if (path === "/room/blobs/missing") return Response.json({ missing: [] });
    return Response.json({ ok: true });
  },
};

const serverFetch: typeof fetch = (input, init) => w.srv.fetch(input, init);

/** A WebSocket through the Worker's upgrade route (token, idle check, access, x-policy) into the real room */
const sockets = new Set<FakeSocket>();
class FakeSocket {
  binaryType = "arraybuffer";
  readyState = 0;
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  conn: Connection | null = null;
  room: Room | null = null;
  constructor(readonly url: string) {
    sockets.add(this);
    void this.open(new URL(url));
  }
  private async open(u: URL) {
    const key = u.pathname.split("/")[2];
    const res = await serverFetch(u.toString().replace(/^ws/, "http"), { headers: { upgrade: "websocket" } });
    // A refused upgrade: the browser's WebSocket sees only a failed connection
    if (res.status !== 200) return this.closed(1006, "");
    const identity = upgrades.get(key)!.shift()!;
    this.room = roomOf(key);
    this.conn = {
      send: (d) => queueMicrotask(() => this.onmessage?.({ data: typeof d === "string" ? d : d.slice().buffer })),
      close: (code = 1000, reason = "") => queueMicrotask(() => this.closed(code, reason)),
    };
    this.room.connect(this.conn, identity);
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
  closed(code: number, reason: string) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    sockets.delete(this);
    this.onclose?.({ code, reason });
  }
}

const doc = () => encodeMessage({ type: "NODE_CHANGES", sessionID: 0, ackID: 0, nodeChanges: [], blobs: [] });

/** An installation's journal, as a store keeps it */
class Host implements MultiplayerHost {
  deviceOrdinal = 1;
  files = new Map<FileKey, { meta: FileMeta; frames: FileChange[] }>();
  saved: { installationId?: string; links: Record<string, unknown> } = { links: {} };
  readonly fileChanges = { on: () => () => {} };
  logs: string[] = [];
  add(name: string): FileKey {
    const fileKey = `local${this.files.size + 1}`;
    this.files.set(fileKey, { meta: { fileKey, name } as FileMeta, frames: [] });
    return fileKey;
  }
  async backlog() {
    return [];
  }
  async appendRemote() {
    return { seq: 1 };
  }
  async createSharedFile(input: { name: string }) {
    const fileKey = this.add(input.name);
    return this.files.get(fileKey)!.meta;
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
  log(_level: string, message: string) {
    this.logs.push(message);
  }
  async hasBlobs(sha1s: string[]) {
    return sha1s.map(() => true);
  }
  async getBlob() {
    return new Uint8Array();
  }
  async putBlob() {}
  async headSnapshot() {
    return doc();
  }
}

/** Lets the sockets' microtasks and the services' async steps run */
const flush = async (n = 30) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

let host: Host;
let mp: MultiplayerService;
let events: MultiplayerEvent[];
let ended: SessionEnded[];

async function connect(token = w.admin.token) {
  host = new Host();
  mp = new MultiplayerService(host, { fetch: serverFetch, WebSocket: FakeSocket as never, random: Math.random, backoff: () => 0 });
  const api = multiplayerApi(mp);
  events = [];
  ended = [];
  api.watch((e) => events.push(e));
  api.watchSession((e) => ended.push(e));
  await mp.setSession({ server: ORIGIN, token });
}

/** A local file shared into the org (or outside any org), live in its room */
async function shared(orgId: string | null = w.orgId): Promise<{ fileKey: FileKey; key: string }> {
  const fileKey = host.add("Spec");
  const key = await mp.shareTo(fileKey, { snapshot: doc(), headSeq: 0 }, async (k, name) => (await mp.call("POST", "/files", { key: k, name, ...(orgId ? { orgId } : {}) }), k));
  for (let i = 0; i < 50 && (await mp.fileState(fileKey)).connection !== "live"; i++) await flush();
  expect((await mp.fileState(fileKey)).connection).toBe("live");
  return { fileKey, key };
}

beforeEach(async () => {
  w = await world();
  w.deps.rooms = fakeRooms;
  rooms.clear();
  upgrades.clear();
  sockets.clear();
  await connect();
});

afterEach(() => {
  mp.close();
  vi.useRealTimers();
});

describe("the org's policies in an open file (§15.9)", () => {
  it("the file's sharing policy comes with its share info; null outside orgs", async () => {
    const { fileKey } = await shared();
    expect((await mp.fileInfo(fileKey)).policy).toEqual({ publicLinks: true, passwordRequired: false, passwordMode: "any", linkExpiryMaxHours: null, cursorChat: true, audio: true, openSessions: true });
    await w.settings({ publicLinks: false, passwordMode: "autogenerated" });
    expect((await mp.fileInfo(fileKey)).policy).toMatchObject({ publicLinks: false, passwordMode: "autogenerated" });
    const outside = await shared(null);
    expect((await mp.fileInfo(outside.fileKey)).policy).toBeNull();
    expect((await mp.fileState(outside.fileKey)).policy).toBeNull();
  });

  it("welcome.policy is the file's state; an admin's change reaches the open file as a `policy` event", async () => {
    const { fileKey } = await shared();
    expect((await mp.fileState(fileKey)).policy).toEqual({ cursorChat: true, audio: true });
    events.length = 0;
    await w.settings({ cursorChat: false });
    await flush();
    const ev = events.filter((e) => e.policy);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ fileKey, policy: { cursorChat: false, audio: true }, state: { policy: { cursorChat: false, audio: true } } });
    await w.settings({ audio: false });
    await flush();
    expect(events.filter((e) => e.policy).at(-1)?.policy).toEqual({ cursorChat: false, audio: false });
    // A reconnect is welcomed with the policy as it is now (no event: nothing changed)
    const n = events.filter((e) => e.policy).length;
    [...sockets][0].close(1006, "gone");
    await flush();
    expect((await mp.fileState(fileKey)).policy).toEqual({ cursorChat: false, audio: false });
    expect(events.filter((e) => e.policy)).toHaveLength(n);
  });

  it("a room moving to another region (4012) reconnects after 2 s, without backoff", async () => {
    const { fileKey, key } = await shared();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // Before this, a slow backoff: 4012 must not use it
    (mp.deps_ as any).backoff = () => 60_000;
    const user = (await w.rows(`SELECT owner_id FROM files WHERE key = ?1`, key))[0].owner_id as string;
    roomOf(key).closeUser(user, 4012, "moving");
    await flush();
    expect((await mp.fileState(fileKey)).connection).toBe("offline");
    expect(sockets.size).toBe(0);
    vi.advanceTimersByTime(MOVING_RETRY_MS - 1);
    await flush();
    expect(sockets.size).toBe(0);
    vi.advanceTimersByTime(1);
    await flush();
    expect(sockets.size).toBe(1);
    expect((await mp.fileState(fileKey)).connection).toBe("live");
    expect((await mp.status()).signedIn).toBe(true);
  });
});

describe("the idle session timeout (§15.8)", () => {
  it("idle past the limit with only a socket open: the upgrade's refusal ends the session (seen as idle_timeout)", async () => {
    const { fileKey } = await shared();
    await w.run(`UPDATE sessions SET active_at = 1, idle_limit_ms = 1000`);
    // The socket drops; its upgrade is refused with 401 idle_timeout, which a WebSocket never shows — the server deleted
    // the session there but remembers why (idle_ended_sessions), so the store's next call hears idle_timeout too.
    [...sockets][0].close(1006, "gone");
    for (let i = 0; i < 100 && !ended.length; i++) await flush();
    expect(ended).toEqual([{ reason: "idle_timeout" }]);
    expect((await mp.status()).signedIn).toBe(false);
    expect((await mp.fileState(fileKey)).connection).toBe("offline");
    expect(sockets.size).toBe(0);
    expect(await w.rows(`SELECT id FROM sessions WHERE user_id = ?1`, w.admin.id)).toEqual([]);
    const log = await w.rows(`SELECT details FROM activity_log WHERE action = 'user_idle_session_timeout'`);
    expect(log.length).toBeGreaterThan(0);
  });

  it("a call refused with idle_timeout: the StoreError carries the code; later calls are signed out", async () => {
    const { fileKey } = await shared();
    await w.run(`UPDATE sessions SET active_at = 1, idle_limit_ms = 1000`);
    const e = await mp.fileInfo(fileKey).then(
      () => null,
      (err: any) => err,
    );
    expect(e).toMatchObject({ code: "forbidden", message: "You were logged out because you were inactive.", detail: { code: "idle_timeout" } });
    expect(ended).toEqual([{ reason: "idle_timeout" }]);
    await expect(mp.fileInfo(fileKey)).rejects.toMatchObject({ code: "offline" });
    expect(ended).toHaveLength(1);
    // Main signs in again: a new session, said again when it ends
    const fresh = await w.dev("alice@acme.test");
    await mp.setSession({ server: ORIGIN, token: fresh.token });
    expect((await mp.status()).signedIn).toBe(true);
  });

  it("any other 401 is `expired`: said once, the session dropped as well", async () => {
    await connect("x.eyJ1aWQiOiJ1MSJ9.y");
    expect(ended).toEqual([{ reason: "expired" }]);
    expect((await mp.status()).signedIn).toBe(false);
    await expect(mp.listRemote()).rejects.toMatchObject({ code: "offline" });
    expect(ended).toHaveLength(1);
  });
});

