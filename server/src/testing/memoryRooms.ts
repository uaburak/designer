/**
 * Rooms for Node tests: each file's `RoomBox` (roomBox.ts) on its own node:sqlite database with the real `Room`
 * sequencer, and in-memory members — what `FileRoom` is, minus Cloudflare. `join` connects a member and says hello;
 * `send` sends a changes-up frame as that member, and each member keeps what it received.
 */
import { decodeChangesDown, encodeChangesUp, type ChangesDown, type Role } from "../../../src/shared/multiplayer/protocol";
import { Room, type Connection } from "../../../src/shared/multiplayer/room";
import type { Rooms } from "../api";
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
  join(key: string, userId: string, role?: Role): MemoryMember;
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
  const join = (key: string, userId: string, role: Role = "editor"): MemoryMember => {
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
    r.room.connect(m, { userId, role });
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
      const res = await get(key).box.fetch(new Request(url, { method: init.method, headers, body: init.body as BodyInit | undefined }));
      return res ?? new Response("not found", { status: 404 });
    },
  };
  return { rooms, get, join, send, calls };
}
