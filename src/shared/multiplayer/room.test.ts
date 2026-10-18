import { describe, expect, it } from "vitest";
import { decodeChangesDown, encodeChangesUp, MAX_FRAME_BYTES, type Role, type ServerControl } from "./protocol";
import { MemoryRoomStorage, Room, type Connection, type MemberState } from "./room";

class Client implements Connection {
  controls: ServerControl[] = [];
  frames: ReturnType<typeof decodeChangesDown>[] = [];
  closed: number | undefined;
  send(d: string | Uint8Array) {
    if (typeof d === "string") this.controls.push(JSON.parse(d));
    else this.frames.push(decodeChangesDown(d));
  }
  close(code?: number) {
    this.closed = code;
  }
  get welcome() {
    return this.controls.find((c) => c.t === "welcome") as Extract<ServerControl, { t: "welcome" }>;
  }
  get last() {
    return this.controls.at(-1);
  }
}

function join(room: Room, since = 0, name?: string, role: Role = "editor"): Client {
  const c = new Client();
  room.connect(c, { userId: `u-${name ?? "x"}`, name, role });
  room.receive(c, JSON.stringify({ t: "hello", since }));
  return c;
}
const bytes = (...n: number[]) => new Uint8Array(n);

describe("Room", () => {
  it("gives each session its own id and orders frames by arrival, echoing them to the sender", () => {
    const room = new Room(new MemoryRoomStorage());
    const a = join(room);
    const b = join(room);
    expect(a.welcome.sessionID).toBe(1);
    expect(b.welcome.sessionID).toBe(2);
    room.receive(a, encodeChangesUp(7, bytes(1)));
    room.receive(b, encodeChangesUp(3, bytes(2)));
    room.receive(a, encodeChangesUp(8, bytes(3)));
    for (const c of [a, b]) {
      expect(c.frames.map((f) => [f!.seq, f!.sessionID, f!.batch, [...f!.message]])).toEqual([
        [1, 1, 7, [1]],
        [2, 2, 3, [2]],
        [3, 1, 8, [3]],
      ]);
    }
  });

  it("gives each session the multiplayer colour fewest of the others have (Figma's seven), told to it and to the others", () => {
    const room = new Room(new MemoryRoomStorage());
    const people = Array.from({ length: 9 }, (_, i) => join(room, 0, `P${i}`));
    // The first seven each get their own, in Figma's order; the eighth and ninth start again at the first
    expect(people.map((c) => c.welcome.color)).toEqual([0, 1, 2, 3, 4, 5, 6, 0, 1]);
    expect(people[8].welcome.peers.map((p) => p.color)).toEqual([0, 1, 2, 3, 4, 5, 6, 0]);
    const joined = people[0].controls.filter((c) => c.t === "peer-joined") as Extract<ServerControl, { t: "peer-joined" }>[];
    expect(joined.map((j) => j.peer.color)).toEqual([1, 2, 3, 4, 5, 6, 0, 1]);
    // Blue's person leaves: the next one gets blue, the least used again
    room.leave(people[1]);
    expect(join(room, 0, "Q").welcome.color).toBe(1);
  });

  it("catches a late or returning client up from `since`, then says ready", () => {
    const room = new Room(new MemoryRoomStorage());
    const a = join(room);
    for (let i = 1; i <= 4; i++) room.receive(a, encodeChangesUp(i, bytes(i)));
    const b = join(room, 2);
    expect(b.welcome.seq).toBe(4);
    expect(b.frames.map((f) => f!.seq)).toEqual([3, 4]);
    expect(b.last).toEqual({ t: "ready", seq: 4 });
    expect(join(room, 4).frames).toEqual([]);
  });

  it("sends a client older than the snapshot back to it, and one from the future away", () => {
    const storage = new MemoryRoomStorage();
    const room = new Room(storage);
    const a = join(room);
    for (let i = 1; i <= 5; i++) room.receive(a, encodeChangesUp(i, bytes(i)));
    storage.compact(3);
    expect(join(room, 2).last).toMatchObject({ t: "error", code: "too-old" });
    expect(join(room, 9).last).toMatchObject({ t: "error", code: "too-old" });
    const ok = join(room, 3);
    expect(ok.frames.map((f) => f!.seq)).toEqual([4, 5]);
    // A new file's room after a first snapshot upload: nothing to catch up on.
    const fresh = new MemoryRoomStorage();
    fresh.compact(0);
    expect(join(new Room(fresh), 0).last).toEqual({ t: "ready", seq: 0 });
  });

  it("lets viewers watch but not edit", () => {
    const room = new Room(new MemoryRoomStorage());
    const v = join(room, 0, "V", "viewer");
    expect(v.welcome.role).toBe("viewer");
    room.receive(v, encodeChangesUp(1, bytes(1)));
    expect(v.last).toMatchObject({ t: "error", code: "forbidden" });
    expect(v.closed).toBe(1008);
  });

  it("relays presence to the others only and shows it to newcomers, never storing it", () => {
    const storage = new MemoryRoomStorage();
    const room = new Room(storage);
    const a = join(room, 0, "Burak");
    const b = join(room);
    room.receive(a, JSON.stringify({ t: "presence", data: { x: 1, y: 2 } }));
    expect(b.controls.find((c) => c.t === "presence")).toEqual({ t: "presence", sessionID: 1, data: { x: 1, y: 2 } });
    expect(a.controls.some((c) => c.t === "presence")).toBe(false);
    const c = join(room);
    expect(c.welcome.peers.map((p) => [p.sessionID, p.name, p.presence])).toEqual([
      [1, "Burak", { x: 1, y: 2 }],
      [2, undefined, undefined],
    ]);
    expect(storage.lastSeq()).toBe(0);
  });

  it("relays a signal to the one session it names, from the sender's session", () => {
    const room = new Room(new MemoryRoomStorage());
    const a = join(room, 0, "a");
    const b = join(room, 0, "b");
    const c = join(room, 0, "c");
    const before = [b.controls.length, c.controls.length];
    room.receive(a, JSON.stringify({ t: "signal", to: b.welcome.sessionID, data: { kind: "ask-spotlight" } }));
    expect(b.last).toEqual({ t: "signal", from: a.welcome.sessionID, data: { kind: "ask-spotlight" } });
    expect(c.controls.length).toBe(before[1]);
    expect(b.controls.length).toBe(before[0] + 1);
    room.receive(a, JSON.stringify({ t: "signal", to: b.welcome.sessionID, data: "x".repeat(40_000) }));
    expect(a.closed).toBe(1008);
  });

  it("announces joins and leaves to members that said hello", () => {
    const room = new Room(new MemoryRoomStorage());
    const a = join(room);
    const quiet = new Client();
    room.connect(quiet, { userId: "q", role: "editor" });
    const b = join(room, 0, "B");
    expect(a.last).toEqual({ t: "peer-joined", peer: { sessionID: 2, userId: "u-B", name: "B", role: "editor", color: 1 } });
    expect(quiet.controls).toEqual([]);
    room.leave(b);
    expect(a.last).toEqual({ t: "peer-left", sessionID: 2 });
    expect(room.size).toBe(1);
  });

  it("rebuilds its members after hibernation from the state it reported", () => {
    const storage = new MemoryRoomStorage();
    const states = new Map<Connection, MemberState>();
    const room = new Room(storage, (c, s) => states.set(c, structuredClone(s)));
    const a = join(room, 0, "A");
    const b = join(room, 0, "B");
    room.receive(a, JSON.stringify({ t: "presence", data: { page: "1:0" } }));
    const woken = new Room(storage);
    for (const [c, s] of states) woken.restore(c, s);
    woken.receive(b, encodeChangesUp(5, bytes(9)));
    expect(a.frames.at(-1)).toMatchObject({ seq: 1, sessionID: 2, batch: 5 });
    const c = join(woken);
    expect(c.welcome.sessionID).toBe(3);
    expect(c.welcome.peers.find((p) => p.sessionID === 1)?.presence).toEqual({ page: "1:0" });
  });

  it("refuses frames before hello, unknown sockets, junk and oversized frames", () => {
    const room = new Room(new MemoryRoomStorage());
    const stranger = new Client();
    room.receive(stranger, JSON.stringify({ t: "hello", since: 0 }));
    expect(stranger.last).toMatchObject({ t: "error", code: "unauthorized" });
    const early = new Client();
    room.connect(early, { userId: "e", role: "editor" });
    room.receive(early, encodeChangesUp(1, bytes(1)));
    expect(early.last).toMatchObject({ t: "error", code: "unauthorized" });
    const a = join(room);
    room.receive(a, bytes(99, 0, 0, 0, 0, 0));
    expect(a.last).toMatchObject({ t: "error", code: "bad-frame" });
    const b = join(room);
    room.receive(b, encodeChangesUp(1, new Uint8Array(MAX_FRAME_BYTES)));
    expect(b.last).toMatchObject({ t: "error", code: "too-large" });
  });

  it("carries the org's room policy: welcome.policy from the socket's identity, a change broadcast to everyone (§15.9)", () => {
    const room = new Room(new MemoryRoomStorage());
    const states: MemberState[] = [];
    const r2 = new Room(new MemoryRoomStorage(), (_c, s) => states.push({ ...s }));
    const plain = join(room);
    expect(plain.welcome.policy).toBeUndefined();
    const a = new Client();
    r2.connect(a, { userId: "a", role: "editor", policy: { cursorChat: false, audio: true } });
    r2.receive(a, JSON.stringify({ t: "hello", since: 0 }));
    expect(a.welcome.policy).toEqual({ cursorChat: false, audio: true });
    const waiting = new Client();
    r2.connect(waiting, { userId: "w", role: "viewer", policy: { cursorChat: false, audio: true } });
    r2.setPolicy({ cursorChat: true, audio: false });
    expect(a.last).toEqual({ t: "policy", policy: { cursorChat: true, audio: false } });
    // a socket that hasn't said hello isn't told, but its welcome has the new policy (kept across hibernation)
    expect(waiting.controls).toEqual([]);
    r2.receive(waiting, JSON.stringify({ t: "hello", since: 0 }));
    expect(waiting.welcome.policy).toEqual({ cursorChat: true, audio: false });
    expect(states.at(-1)?.policy).toEqual({ cursorChat: true, audio: false });
  });
});
