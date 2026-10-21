/**
 * FileRoom's liveness schedule (docs/multiplayer.md §4.1): the one alarm rings for sweeps while sockets are open,
 * without moving autosave, FILE_UPDATE or Discovery later — run here as FileRoom's alarm() runs it, over a real RoomBox.
 */
import { describe, expect, it } from "vitest";
import { CLOSE_SILENT, HEARTBEAT_TEXT, SILENT_MS, type ServerControl } from "../../src/shared/multiplayer/protocol";
import type { Connection } from "../../src/shared/multiplayer/room";
import { FILE_UPDATE_QUIET_MS } from "./roomBox";
import { SWEEP_EVERY_MS, withSweep } from "./roomLiveness";
import { memoryRooms } from "./testing/memoryRooms";

type Conn = Connection & { closed?: number; texts: ServerControl[] };
const conn = (): Conn => {
  const c: Conn = {
    texts: [],
    send: (d) => void (typeof d === "string" && c.texts.push(JSON.parse(d))),
    close: (code) => void (c.closed = code),
  };
  return c;
};

describe("room liveness schedule", () => {
  it("rings by the next sweep only while sockets are open, never later than what autosave / Discovery want", () => {
    const now = 1_000_000;
    expect(withSweep(null, 0, now)).toBeNull();
    expect(withSweep(now + 5, 0, now)).toBe(now + 5);
    expect(withSweep(null, 2, now)).toBe(now + SWEEP_EVERY_MS);
    expect(withSweep(now + 3_600_000, 1, now)).toBe(now + SWEEP_EVERY_MS);
    expect(withSweep(now + 1000, 1, now)).toBe(now + 1000);
  });

  it("sweeps a silent member on the alarm, and FILE_UPDATE still fires on time after the early rings", () => {
    const start = 5_000_000;
    const clock = { t: start };
    const r = memoryRooms(() => clock.t).get("file_live1");
    const ghost = conn();
    const live = conn();
    let open = 2;
    for (const [c, u] of [
      [ghost, "ghost"],
      [live, "live"],
    ] as const) {
      r.room.connect(c, { userId: u, role: "editor" });
      r.room.receive(c, JSON.stringify({ t: "hello", since: 0, client: u, beat: 20_000 }));
    }
    // An edit with a FILE_UPDATE webhook: the box wants its alarm in 30 minutes; FileRoom's rings sooner
    r.box.edited(true);
    const due = start + FILE_UPDATE_QUIET_MS;
    expect(r.alarm).toBe(due);
    let alarm = withSweep(r.alarm, open, clock.t)!;
    expect(alarm).toBe(start + SWEEP_EVERY_MS);
    // FileRoom.alarm(): the sweep, then the box (rung early: nothing, its own time set again), the next ring armed
    const ring = () => {
      clock.t = alarm;
      r.room.receive(live, HEARTBEAT_TEXT); // the live app keeps talking
      open -= r.room.sweep();
      const { fileUpdate } = r.box.alarm();
      alarm = withSweep(r.alarm, open, clock.t)!;
      return fileUpdate;
    };
    expect(ring()).toBe(false);
    expect(ghost.closed).toBeUndefined();
    while (clock.t - start <= SILENT_MS) expect(ring()).toBe(false);
    expect(ghost.closed).toBe(CLOSE_SILENT);
    expect(live.texts.filter((m) => m.t === "peer-left")).toHaveLength(1);
    expect(open).toBe(1);
    // The rings go on every SWEEP_EVERY_MS and the webhook's time comes exactly when it was due
    let fired = false;
    for (let i = 0; i < 100 && !fired; i++) {
      expect(alarm).toBeLessThanOrEqual(due);
      fired = ring();
    }
    expect(fired).toBe(true);
    expect(clock.t).toBe(due);
    expect(live.closed).toBeUndefined();
  });
});
