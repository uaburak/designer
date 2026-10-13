import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DemoController, type DemoRun, type DemoTimers } from "./demoController";

const timers: DemoTimers = { set: (fn, ms) => setTimeout(fn, ms) as unknown as number, clear: (id) => clearTimeout(id) };

/** A script of three 1 s steps, recording the steps it reached. */
function steps(log: string[]) {
  return async (run: DemoRun) => {
    log.push("start");
    for (const step of ["a", "b", "c"]) {
      await run.wait(1000);
      log.push(step);
    }
  };
}

describe("DemoController", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("plays once the scene is on screen, and loops", async () => {
    const log: string[] = [];
    const demo = new DemoController(steps(log), { timers, startDelayMs: 100, loopGapMs: 500 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(log).toEqual([]);
    demo.setVisible(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(demo.state).toBe("playing");
    await vi.advanceTimersByTimeAsync(3000);
    expect(log).toEqual(["start", "a", "b", "c"]);
    expect(demo.state).toBe("between");
    await vi.advanceTimersByTimeAsync(500);
    expect(log.at(-1)).toBe("start");
  });

  it("yields at once when the visitor touches the scene and starts over after the idle time", async () => {
    const log: string[] = [];
    const demo = new DemoController(steps(log), { timers, startDelayMs: 0, idleMs: 4000 });
    demo.setVisible(true);
    await vi.advanceTimersByTimeAsync(1500);
    expect(log).toEqual(["start", "a"]);
    demo.interact();
    expect(demo.state).toBe("yielded");
    await vi.advanceTimersByTimeAsync(3999);
    expect(log).toEqual(["start", "a"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(demo.state).toBe("playing");
    expect(log).toEqual(["start", "a", "start"]);
  });

  it("waits longer while the visitor keeps touching or pointing", async () => {
    const log: string[] = [];
    const demo = new DemoController(steps(log), { timers, startDelayMs: 0, idleMs: 4000 });
    demo.setVisible(true);
    await vi.advanceTimersByTimeAsync(10);
    demo.interact();
    await vi.advanceTimersByTimeAsync(3000);
    demo.interact();
    await vi.advanceTimersByTimeAsync(3000);
    demo.poke();
    await vi.advanceTimersByTimeAsync(3000);
    expect(demo.state).toBe("yielded");
    await vi.advanceTimersByTimeAsync(1000);
    expect(demo.state).toBe("playing");
  });

  it("stops off screen and starts from the beginning when back", async () => {
    const log: string[] = [];
    const demo = new DemoController(steps(log), { timers, startDelayMs: 0 });
    demo.setVisible(true);
    await vi.advanceTimersByTimeAsync(1500);
    demo.setVisible(false);
    expect(demo.state).toBe("off");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(log).toEqual(["start", "a"]);
    demo.setVisible(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(log).toEqual(["start", "a", "start"]);
  });

  it("never plays with reduced motion, and a touch doesn't start it", async () => {
    const log: string[] = [];
    const demo = new DemoController(steps(log), { timers, startDelayMs: 0, idleMs: 100 });
    demo.setEnabled(false);
    demo.setVisible(true);
    demo.interact();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(log).toEqual([]);
    expect(demo.state).toBe("off");
  });

  it("does nothing after dispose", async () => {
    const log: string[] = [];
    const demo = new DemoController(steps(log), { timers, startDelayMs: 0 });
    demo.setVisible(true);
    await vi.advanceTimersByTimeAsync(500);
    demo.dispose();
    demo.interact();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(log).toEqual(["start"]);
  });
});
