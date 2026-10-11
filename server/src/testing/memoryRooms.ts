/**
 * Rooms for Node tests: each file's `RoomBox` (roomBox.ts) on its own node:sqlite database with the real `Room`
 * sequencer, and in-memory members — what `FileRoom` is, minus Cloudflare. `join` connects a member and says hello;
 * `send` sends a changes-up frame as that member, and each member keeps what it received.
 */
import { CLOSE_MOVING, decodeChangesDown, encodeChangesUp, type ChangesDown, type Role } from "../../../src/shared/multiplayer/protocol";
import { Room, type Connection } from "../../../src/shared/multiplayer/room";
import type { RoomPolicy } from "../../../src/shared/org/identity";
import type { Rooms } from "../api";
import type { ObjectNamespace } from "../libraries/db";
import { parseRoomPolicy } from "../policy/roomPolicy";
import { RoomBox } from "../roomBox";
import { sqliteStorage } from "./memoryPreviews";

export interface MemoryMember extends Connection {
  userId: string;
  sessionID: number;
  frames: ChangesDown[];
  texts: unknown[];
  closed: number | null;
}

export interface MemoryRoom {
  box: RoomBox;
  room: Room;
  members: MemoryMember[];
  alarm: number | null;
}

export interface MemoryRooms {
  rooms: Rooms;
  get(key: string): MemoryRoom;
  join(key: string, userId: string, role?: Role, policy?: RoomPolicy): MemoryMember;
  send(key: string, member: MemoryMember, message: Uint8Array, batch?: number): void;
  /** Every call made, as the org tests record them */
  calls: { key: string; path: string; method: string }[];
}

export function memoryRooms(now: () => number): MemoryRooms {
  const all = new Map<string, MemoryRoom>();
  const calls: MemoryRooms["calls"] = [];
  const make = (): MemoryRoom => {
    const storage = sqliteStorage();
    const made: MemoryRoom = { members: [], alarm: null } as unknown as MemoryRoom;
    made.box = new RoomBox({
      sql: storage.sql,
      transaction: storage.transaction,
      now,
      setAlarm: (at) => void (made.alarm = at),
      broadcast: (frame) => {
        for (const m of made.members) if (m.sessionID && m.closed === null) m.send(frame);
      },
      hasSession: (userId, sessionID) => made.members.some((m) => m.userId === userId && m.sessionID === sessionID && m.closed === null),
    });
    made.room = new Room(made.box.storage);
    return made;
  };
  const get = (key: string): MemoryRoom => {
    let r = all.get(key);
    if (!r) all.set(key, (r = make()));
    return r;
  };
  const join = (key: string, userId: string, role: Role = "editor", policy?: RoomPolicy): MemoryMember => {
    const r = get(key);
    const m: MemoryMember = {
      userId,
      sessionID: 0,
      frames: [],
      texts: [],
      closed: null,
      send(data) {
        if (typeof data === "string") {
          const msg = JSON.parse(data) as { t: string; sessionID?: number };
          if (msg.t === "welcome") m.sessionID = msg.sessionID!;
          m.texts.push(msg);
        } else {
          const f = decodeChangesDown(data);
          if (f) m.frames.push(f);
        }
      },
      close(code) {
        m.closed = code ?? 1000;
      },
    };
    r.members.push(m);
    r.room.connect(m, { userId, role, ...(policy ? { policy } : {}) });
    r.room.receive(m, JSON.stringify({ t: "hello", since: r.box.storage.lastSeq() }));
    return m;
  };
  const send = (key: string, member: MemoryMember, message: Uint8Array, batch = 1) => {
    const r = get(key);
    const before = r.box.storage.lastSeq();
    r.room.receive(member, encodeChangesUp(batch, message));
    if (r.box.storage.lastSeq() > before) r.box.edited();
  };
  const rooms: Rooms = {
    async fetch(key, path, init) {
      calls.push({ key, path, method: init.method ?? "GET" });
      const headers = new Headers();
      if (init.identity) {
        headers.set("x-user-id", init.identity.userId);
        headers.set("x-user-name", init.identity.name ?? "");
        headers.set("x-role", init.identity.role);
      }
      const url = new URL(`https://room${path}`);
      if (url.pathname === "/room" && init.method === "DELETE") {
        all.delete(key);
        return Response.json({ ok: true });
      }
      if (["/room/notice", "/room/comments", "/room/revoke", "/room/revoke-link"].includes(url.pathname)) return Response.json({ ok: true });
      if (url.pathname === "/room/reauth") {
        for (const m of get(key).members) m.closed ??= 4003;
        return Response.json({ ok: true });
      }
      if (url.pathname === "/room/policy") {
        const p = parseRoomPolicy(init.body);
        if (!p) return new Response("bad policy", { status: 400 });
        get(key).room.setPolicy(p);
        return Response.json({ ok: true });
      }
      const res = await get(key).box.fetch(new Request(url, { method: init.method, headers, body: init.body as RequestInit["body"] }));
      return res ?? new Response("not found", { status: 404 });
    },
  };
  return { rooms, get, join, send, calls };
}

// ---- a FileRoom namespace with jurisdictions (docs/multiplayer.md §15.10) -------------------------------------------

/** One object of `memoryRoomNamespace`: what `FileRoom` does over its `RoomBox`, minus Cloudflare */
export interface MemoryRoomObject extends MemoryRoom {
  fetch(req: Request): Promise<Response>;
}

export interface MemoryRoomNamespace {
  /** Cloudflare's `ROOMS` binding: `idFromName`, `get`, `jurisdiction("eu")` */
  binding: ObjectNamespace;
  /** The objects made, by jurisdiction ("default" | "eu") and name */
  objects: Record<"default" | "eu", Map<string, MemoryRoomObject>>;
  /** A member joins the room of `key` in `j` (as `join` above) */
  join(j: "default" | "eu", key: string, userId: string, role?: Role, policy?: RoomPolicy): MemoryMember;
  /** Fail the next request whose path matches (one shot) */
  failNext(path: string): void;
}

/**
 * The `ROOMS` binding for tests of jurisdiction routing and moves: each object is a `RoomBox` + `Room` on its own
 * node:sqlite database, answering the routes `FileRoom` answers itself (policy, freeze closing sockets with 4012,
 * DELETE /room, reauth, revoke) and the box's for the rest. `jurisdiction("eu")` is a second, separate set of objects.
 */
export function memoryRoomNamespace(now: () => number): MemoryRoomNamespace {
  const objects: MemoryRoomNamespace["objects"] = { default: new Map(), eu: new Map() };
  const failing: string[] = [];
  const make = (): MemoryRoomObject => {
    let storage = sqliteStorage();
    const o = { members: [], alarm: null } as unknown as MemoryRoomObject;
    const build = () => {
      o.box = new RoomBox({
        sql: storage.sql,
        transaction: storage.transaction,
        now,
        setAlarm: (at) => void (o.alarm = at),
        broadcast: (frame) => {
          for (const m of o.members) if (m.sessionID && m.closed === null) m.send(frame);
        },
        hasSession: (userId, sessionID) => o.members.some((m) => m.userId === userId && m.sessionID === sessionID && m.closed === null),
      });
      o.room = new Room(o.box.storage);
    };
    build();
    o.fetch = async (req) => {
      const url = new URL(req.url);
      const at = failing.indexOf(url.pathname);
      if (at >= 0) {
        failing.splice(at, 1);
        return new Response("injected failure", { status: 500 });
      }
      switch (`${req.method} ${url.pathname}`) {
        case "POST /room/policy": {
          const p = parseRoomPolicy(await req.text());
          if (!p) return new Response("bad policy", { status: 400 });
          o.room.setPolicy(p);
          return Response.json({ ok: true });
        }
        case "POST /room/freeze": {
          const res = (await o.box.fetch(req))!;
          if (res.ok && o.box.moving()) o.room.closeAll(CLOSE_MOVING, "moving to another region");
          return res;
        }
        case "DELETE /room":
          o.room.closeAll(4001, "file no longer shared");
          storage = sqliteStorage();
          o.members = [];
          build();
          return Response.json({ ok: true });
        case "POST /room/reauth":
        case "POST /room/revoke-link":
        case "POST /room/revoke":
        case "POST /room/notice":
        case "POST /room/comments":
          return Response.json({ ok: true });
        case "GET /room/ws":
          return o.box.moving() ? Response.json({ error: "moving", code: "moving" }, { status: 503 }) : new Response(null, { status: 200 });
      }
      return (await o.box.fetch(req)) ?? new Response("not found", { status: 404 });
    };
    return o;
  };
  const ns = (j: "default" | "eu"): ObjectNamespace => ({
    idFromName: (name) => name,
    get: (id) => {
      const name = id as unknown as string;
      let o = objects[j].get(name);
      if (!o) objects[j].set(name, (o = make()));
      return o;
    },
    ...(j === "default" ? { jurisdiction: (name: "eu") => ns(name) } : {}),
  });
  const binding = ns("default");
  const join: MemoryRoomNamespace["join"] = (j, key, userId, role = "editor", policy) => {
    const r = (j === "eu" ? binding.jurisdiction!("eu") : binding).get(key as never) as unknown as MemoryRoomObject;
    const m: MemoryMember = {
      userId,
      sessionID: 0,
      frames: [],
      texts: [],
      closed: null,
      send(data) {
        if (typeof data === "string") {
          const msg = JSON.parse(data) as { t: string; sessionID?: number };
          if (msg.t === "welcome") m.sessionID = msg.sessionID!;
          m.texts.push(msg);
        } else {
          const f = decodeChangesDown(data);
          if (f) m.frames.push(f);
        }
      },
      close(code) {
        m.closed = code ?? 1000;
      },
    };
    r.members.push(m);
    r.room.connect(m, { userId, role, ...(policy ? { policy } : {}) });
    r.room.receive(m, JSON.stringify({ t: "hello", since: r.box.storage.lastSeq() }));
    return m;
  };
  return { binding, objects, join, failNext: (path) => void failing.push(path) };
}
