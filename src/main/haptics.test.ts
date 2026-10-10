// The trackpad's haptic tick (docs/desktop.md §10.2 "Haptics"): a view's `haptics:tick` is open to every role, and
// main plays at most one tick a frame (60 a second) however many steps a scrub sends; nothing off macOS.
import { describe, expect, it, vi } from "vitest";
import { SEND_ROLES } from "../shared/ipc";

vi.mock("electron", () => ({ app: { isPackaged: false, getAppPath: () => process.cwd() } }));
const { createHapticThrottle, hapticTick, HAPTIC_MIN_INTERVAL_MS } = await import("./haptics");

describe("haptics", () => {
  it("every view may send haptics:tick", () => {
    expect(SEND_ROLES["haptics:tick"]).toEqual(["tabbar", "home", "editor"]);
  });

  it("lets one tick through a frame (≤ 60 a second), whatever is sent", () => {
    const gate = createHapticThrottle();
    expect(HAPTIC_MIN_INTERVAL_MS).toBeCloseTo(16.667, 2);
    // A fast scrub: a step every 4 ms for one second → at most 60 ticks.
    let played = 0;
    for (let t = 1000; t < 2000; t += 4) if (gate(t)) played++;
    expect(played).toBeLessThanOrEqual(60);
    expect(played).toBe(50); // every 20 ms: the first step past each 16.7 ms
    // Slow steps (a step per 50 ms): every one plays.
    const slow = createHapticThrottle();
    expect([0, 50, 100, 150].map((t) => slow(t))).toEqual([true, true, true, true]);
    // Two in the same frame: the second waits.
    const same = createHapticThrottle();
    expect([same(10), same(12), same(26), same(27)]).toEqual([true, false, false, true]);
  });

  it("a clock that went back starts over", () => {
    const gate = createHapticThrottle();
    expect(gate(5000)).toBe(true);
    expect(gate(10)).toBe(true);
  });

  it("plays nothing off macOS", () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "linux" });
    try {
      expect(hapticTick(1e9)).toBe(false);
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });
});
