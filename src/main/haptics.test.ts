// The trackpad's haptic tick (docs/desktop.md §10.2 "Haptics"): a view's `haptics:tick` is open to every role, and
// main plays at most one tick in 80 ms (12.5 a second) however many steps a scrub or the canvas sends, dropping the rest; nothing off macOS.
import { describe, expect, it, vi } from "vitest";
import { SEND_ROLES } from "../shared/ipc";

vi.mock("electron", () => ({ app: { isPackaged: false, getAppPath: () => process.cwd() } }));
const { createHapticThrottle, hapticTick, HAPTIC_MIN_INTERVAL_MS } = await import("./haptics");

describe("haptics", () => {
  it("every view may send haptics:tick", () => {
    expect(SEND_ROLES["haptics:tick"]).toEqual(["tabbar", "home", "editor"]);
  });

  it("lets one tick through in 80 ms (≤ 12.5 a second), dropping the rest, whatever is sent", () => {
    const gate = createHapticThrottle();
    expect(HAPTIC_MIN_INTERVAL_MS).toBe(80);
    // A fast scrub: a step every 4 ms for one second → 13 ticks (t = 1000, 1080, … 1960), the rest dropped.
    let played = 0;
    for (let t = 1000; t < 2000; t += 4) if (gate(t)) played++;
    expect(played).toBe(13);
    // Dropped, not queued: after the fast burst stops, nothing plays late — the next tick waits for the next step.
    expect(gate(2100)).toBe(true);
    // Slow steps (a step per 100 ms, or exactly 80): every one plays.
    const slow = createHapticThrottle();
    expect([0, 100, 200, 300].map((t) => slow(t))).toEqual([true, true, true, true]);
    const edge = createHapticThrottle();
    expect([0, 80, 160].map((t) => edge(t))).toEqual([true, true, true]);
    // Two inside 80 ms: the second is dropped; the clock counts from the one that played.
    const same = createHapticThrottle();
    expect([same(10), same(50), same(89), same(90)]).toEqual([true, false, false, true]);
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
