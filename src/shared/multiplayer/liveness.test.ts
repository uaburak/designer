/**
 * The room's liveness (docs/multiplayer.md §4.1): the heartbeat, silent members swept, a reconnect of the same app
 * replacing its older socket — the ghosts of killed apps and half-open sockets never stay in the facepile.
 */
import { describe, expect, it } from "vitest";
import { CLOSE_REPLACED, CLOSE_SILENT, HEARTBEAT_REPLY, HEARTBEAT_TEXT, LEGACY_SILENT_MS, SILENT_MS, type ServerControl } from "./protocol";
import { MemoryRoomStorage, Room, SEEN_PERSIST_MS, type Connection, type MemberState } from "./room";

class Client implements Connection {
  controls: ServerControl[] = [];
  raw: string[] = [];
  closed: number | undefined;
  send(d: string | Uint8Array) {
    if (typeof d !== "string") return;
    this.raw.push(d);
    this.controls.push(JSON.parse(d));
  }
  close(code?: number) {
    this.closed = code;
  }
  get welcome() {
    return this.controls.find((c) => c.t === "welcome") as Extract<ServerControl, { t: "welcome" }>;
  }
  of<T extends ServerControl["t"]>(t: T) {
    return this.controls.filter((c) => c.t === t) as Extract<ServerControl, { t: T }>[];
  }
}

function world() {
  const clock = { t: 1_000_000 };
  const states = new Map<Connection, MemberState>();
  const dropped: Connection[] = [];
  const room = new Room(new MemoryRoomStorage(), (c, s) => void states.set(c, { ...s }), { now: () => clock.t, onDropped: (c) => void dropped.push(c) });
  const join = (userId: string, hello: Record<string, unknown> = { client: `app-${userId}`, beat: 20_000 }) => {
    const c = new Client();
    room.connect(c, { userId, name: userId, role: "editor" });
    room.receive(c, JSON.stringify({ t: "hello", since: 0, ...hello }));
    return c;
  };
  return { clock, room, states, dropped, join };
}

describe("Room liveness", () => {
  it("answers the heartbeat (before hello too) and counts it as the member's last word", () => {
    const { clock, room, states, join } = world();
    const pre = new Client();
    room.connect(pre, { userId: "u", role: "viewer" });
    room.receive(pre, HEARTBEAT_TEXT);
    expect(pre.raw).toEqual([HEARTBEAT_REPLY]);
    expect(pre.closed).toBeUndefined();
    const a = join("a");
    clock.t += SEEN_PERSIST_MS + 1;
    const persisted = clock.t;
    room.receive(a, HEARTBEAT_TEXT);
    expect(a.raw.at(-1)).toBe(HEARTBEAT_REPLY);
    expect(room.member(a)?.seenAt).toBe(clock.t);
    // Persisted with the socket (hibernation), at most every SEEN_PERSIST_MS
    expect(states.get(a)?.seenAt).toBe(persisted);
    clock.t += 1000;
    room.receive(a, HEARTBEAT_TEXT);
    expect(room.member(a)?.seenAt).toBe(clock.t);
    expect(states.get(a)?.seenAt).toBe(persisted);
  });

  it("drops a member silent past SILENT_MS: peer-left to the others, its socket closed, the host told", () => {
    const { clock, room, dropped, join } = world();
    const a = join("a");
    const b = join("b");
    clock.t += SILENT_MS - 1000;
    room.receive(b, HEARTBEAT_TEXT);
    expect(room.sweep()).toBe(0);
    clock.t += 2000;
    expect(room.sweep()).toBe(1);
    expect(a.closed).toBe(CLOSE_SILENT);
    expect(dropped).toEqual([a]);
    expect(b.of("peer-left").map((m) => m.sessionID)).toEqual([a.welcome.sessionID]);
    expect(room.size).toBe(1);
    // A newcomer doesn't see the ghost
    const c = join("c");
    expect(c.welcome.peers.map((p) => p.userId)).toEqual(["b"]);
  });

  it("counts the runtime's heartbeat answers (no wake) as heard", () => {
    const { clock, room, join } = world();
    const a = join("a");
    clock.t += SILENT_MS * 3;
    expect(room.sweep((c) => (c === a ? clock.t - 5000 : null))).toBe(0);
    expect(room.sweep(() => null)).toBe(1);
  });

  it("gives an app without the heartbeat (1.5.0) LEGACY_SILENT_MS", () => {
    const { clock, room, join } = world();
    const old = join("old", {});
    clock.t += SILENT_MS * 2;
    expect(room.sweep()).toBe(0);
    clock.t += LEGACY_SILENT_MS;
    expect(room.sweep()).toBe(1);
    expect(old.closed).toBe(CLOSE_SILENT);
  });

  it("counts a restored socket kept before liveness from its restore, and persists that", () => {
    const { clock, room, states } = world();
    const ghost = new Client();
    room.restore(ghost, { userId: "g", role: "owner", sessionID: 4 });
    expect(states.get(ghost)?.seenAt).toBe(clock.t);
    clock.t += LEGACY_SILENT_MS + 1;
    expect(room.sweep()).toBe(1);
  });

  it("replaces the same app's older socket at hello (a reconnect after a drop, a sleep, a rehello)", () => {
    const { room, dropped, join } = world();
    const b = join("b");
    const a1 = join("a");
    const a2 = join("a");
    expect(a1.closed).toBe(CLOSE_REPLACED);
    expect(dropped).toEqual([a1]);
    expect(a2.welcome.peers.map((p) => p.sessionID)).toEqual([b.welcome.sessionID]);
    expect(b.of("peer-left").map((m) => m.sessionID)).toEqual([a1.welcome.sessionID]);
    expect(b.of("peer-joined").map((m) => [m.peer.sessionID, m.peer.client])).toEqual([
      [a1.welcome.sessionID, "app-a"],
      [a2.welcome.sessionID, "app-a"],
    ]);
    expect(room.size).toBe(2);
    // Another app of the same person (a second device), or another person whose app says the same id: both stay
    const other = join("a", { client: "laptop" });
    expect(other.closed).toBeUndefined();
    const c = new Client();
    room.connect(c, { userId: "c", role: "editor" });
    room.receive(c, JSON.stringify({ t: "hello", since: 0, client: "app-a" }));
    expect(c.closed).toBeUndefined();
    expect(a2.closed).toBeUndefined();
    expect(room.size).toBe(4);
  });

  it("ignores a client id that isn't a short string", () => {
    const { join } = world();
    const a1 = join("a", { client: "x".repeat(65) });
    const a2 = join("a", { client: "x".repeat(65) });
    expect(a1.closed).toBeUndefined();
    expect(a2.welcome.peers).toHaveLength(1);
    expect(a2.welcome.peers[0].client).toBeUndefined();
  });
});
