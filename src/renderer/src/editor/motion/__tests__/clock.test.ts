// The playback clock (docs/motion.md §6.2): wall time × 1, ONCE stops at the end, LOOP wraps, Ping-pong reverses,
// pausing keeps the playhead, a seek continues from there.
import { describe, expect, it } from "vitest";
import { Clock } from "../clock";

function fakeFrames() {
  const queue: ((now: number) => void)[] = [];
  let now = 0;
  const times: number[] = [];
  const clock = (playback: "ONCE" | "LOOP" | "PING_PONG", onEnd?: () => void) =>
    new Clock({
      durationUs: 1_000_000,
      playback,
      onTime: (t) => times.push(t),
      onEnd,
      raf: (cb) => {
        queue.push(cb);
        return queue.length;
      },
      caf: () => queue.splice(0),
      now: () => now,
    });
  const step = (ms: number) => {
    now += ms;
    const cbs = queue.splice(0);
    cbs.forEach((cb) => cb(now));
  };
  return { clock, step, times };
}

describe("Clock", () => {
  it("advances by wall time and ONCE stops at the duration", () => {
    const f = fakeFrames();
    let ended = 0;
    const c = f.clock("ONCE", () => ended++);
    c.play(0);
    f.step(400);
    f.step(400);
    expect(f.times).toEqual([400_000, 800_000]);
    f.step(400);
    expect(f.times.at(-1)).toBe(1_000_000);
    expect(c.playing).toBe(false);
    expect(ended).toBe(1);
    // Playing again from the end starts over.
    c.play(c.time);
    expect(c.time).toBe(0);
  });

  it("LOOP wraps", () => {
    const f = fakeFrames();
    const c = f.clock("LOOP");
    c.play(900_000);
    f.step(300);
    expect(c.time).toBe(200_000);
    expect(c.playing).toBe(true);
  });

  it("Ping-pong reverses at both ends", () => {
    const f = fakeFrames();
    const c = f.clock("PING_PONG");
    c.play(800_000);
    f.step(400);
    expect(c.time).toBe(800_000); // 1 200 000 reflected
    f.step(900);
    expect(c.time).toBe(100_000); // back through 0: −100 000 reflected
  });

  it("pause keeps the playhead; seek continues from the new time", () => {
    const f = fakeFrames();
    const c = f.clock("LOOP");
    c.play(0);
    f.step(250);
    c.pause();
    f.step(1000);
    expect(c.time).toBe(250_000);
    expect(f.times).toEqual([250_000]);
    c.seek(600_000);
    c.play(c.time);
    f.step(100);
    expect(c.time).toBe(700_000);
    c.configure(500_000, "ONCE");
    f.step(100);
    expect(c.time).toBe(500_000);
    expect(c.playing).toBe(false);
  });
});
