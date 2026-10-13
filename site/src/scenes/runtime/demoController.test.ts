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

  it("never plays with reduced motion", async () => {
    const log: string[] = [];
    const demo = new DemoController(steps(log), { timers, startDelayMs: 0 });
    demo.setEnabled(false);
    demo.setVisible(true);
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
    demo.setVisible(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(log).toEqual(["start"]);
  });
});
