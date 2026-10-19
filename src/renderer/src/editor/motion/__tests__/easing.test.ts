// Motion's easing curves in TypeScript (docs/motion.md §4.7; round 8i): the engine's maths (bezier solved for x,
// Figma's settle time, springs normalised over a segment, Hold), the public easing ↔ EasingData (an EASING variable's
// value), the spring editor's handle and its inverse, the hover preview's CSS timing functions; the timeline's layer bar
// and snapping grids.
import { describe, expect, it } from "vitest";
import { bounceAtHandle, cubicBezierAt, easingAt, easingCss, easingFromData, easingToData, springHandle, springNormalized, springSettle } from "@shared/motion/easing";
import { DEFAULT_KEYFRAME_EASING, SPRING_PRESETS, type MotionEasing } from "@shared/motion/types";
import { GRID_OFF_FPS, gridFromFps, gridFromMs, gridLabel, retimeLayer } from "../timeline/maths";
import { gridOptions } from "../timeline/TimelineSettings";

describe("easing curves", () => {
  it("solves a bezier for its x, as CSS does; Hold steps at the end; linear is linear", () => {
    expect(cubicBezierAt([0, 0, 1, 1], 0.3)).toBeCloseTo(0.3, 6);
    expect(cubicBezierAt([0.42, 0, 1, 1], 0.5)).toBeCloseTo(0.3153, 3);
    expect(cubicBezierAt([0.7, -0.4, 0.4, 1.4], 0.2)).toBeLessThan(0); // the back curve dips
    expect(easingAt({ type: "HOLD" }, 0.99)).toBe(0);
    expect(easingAt({ type: "HOLD" }, 1)).toBe(1);
    expect(easingAt({ type: "LINEAR" }, 0.25)).toBeCloseTo(0.25, 6);
    // A keyframe without an easing: Figma's CUSTOM_CUBIC (0.5, 0, 0.5, 1), symmetric.
    expect(easingAt(DEFAULT_KEYFRAME_EASING, 0.5)).toBeCloseTo(0.5, 6);
  });
  it("plays springs normalised: Gentle settles in Figma's 1.022 s, starts at 0, ends at 1, Bouncy overshoots", () => {
    expect(springSettle(SPRING_PRESETS.GENTLE!)).toBeCloseTo(1.022, 3);
    expect(springNormalized(SPRING_PRESETS.GENTLE!, 0)).toBe(0);
    expect(springNormalized(SPRING_PRESETS.GENTLE!, 1)).toBe(1);
    const peak = Math.max(...Array.from({ length: 50 }, (_, i) => easingAt({ type: "BOUNCY" }, i / 50)));
    expect(peak).toBeGreaterThan(1.2);
    expect(easingAt({ type: "CUSTOM_SPRING", easingFunctionSpring: { bounce: 0 } }, 0.5)).toBeLessThanOrEqual(1);
  });
  it("reads and writes an EasingData: named curves, a custom bezier's handles, a custom spring stored physical", () => {
    const cases: MotionEasing[] = [
      { type: "EASE_IN" },
      { type: "EASE_OUT" },
      { type: "HOLD" },
      { type: "GENTLE" },
      { type: "CUSTOM_CUBIC_BEZIER", easingFunctionCubicBezier: { x1: 0.2, y1: -0.3, x2: 0.8, y2: 1.4 } },
      { type: "CUSTOM_SPRING", easingFunctionSpring: { bounce: 0.4 } },
    ];
    for (const e of cases) expect(easingFromData(easingToData(e))).toEqual(e);
    expect(easingToData({ type: "EASE_IN" }).easingType).toBe("EASE_IN"); // 15, not IN_CUBIC
    expect(easingToData({ type: "CUSTOM_SPRING", easingFunctionSpring: { bounce: 0.4 } }).easingValue?.springEasing).toMatchObject({ mass: 1, stiffness: 100, springType: "NORMALIZED" });
    // IN_CUBIC (the kiwi default) or nothing: the keyframe default; the legacy SPRING: Gentle.
    expect(easingFromData({ easingType: "IN_CUBIC" })).toEqual(DEFAULT_KEYFRAME_EASING);
    expect(easingFromData(undefined)).toEqual(DEFAULT_KEYFRAME_EASING);
    expect(easingFromData({ easingType: "SPRING" })).toEqual({ type: "GENTLE" });
  });
  it("puts the spring handle at Figma's height for the bounce and reads a dragged one back", () => {
    expect(springHandle(0).y).toBeCloseTo(0, 9);
    expect(springHandle(1).y).toBeCloseTo(2, 9);
    for (const b of [0, 0.25, 0.5, 0.8, 1]) expect(bounceAtHandle(springHandle(b).y)).toBeCloseTo(b, 2);
    expect(springHandle(0.5).x).toBeGreaterThan(0);
    expect(springHandle(0.5).x).toBeLessThanOrEqual(1);
  });
  it("gives the hover preview CSS's timing functions: cubic-bezier, linear() for springs, steps for Hold", () => {
    expect(easingCss({ type: "EASE_OUT" })).toBe("cubic-bezier(0, 0, 0.58, 1)");
    expect(easingCss({ type: "HOLD" })).toBe("steps(1, jump-end)");
    const spring = easingCss({ type: "QUICK" }, 4);
    expect(spring.startsWith("linear(0, ")).toBe(true);
    expect(spring.endsWith(", 1)")).toBe(true);
  });
});

describe("timeline maths (round 8i)", () => {
  it("moves the layer bar, stretches it from either end, never shorter than a frame or before 0", () => {
    const ext = { startUs: 200_000, endUs: 600_000 };
    const id = (us: number) => Math.round(us);
    expect(retimeLayer(ext, "move", 100_000, id, 1000)).toEqual({ startUs: 300_000, endUs: 700_000 });
    expect(retimeLayer(ext, "move", -500_000, id, 1000)).toEqual({ startUs: 0, endUs: 400_000 });
    expect(retimeLayer(ext, "end", 200_000, id, 1000)).toEqual({ startUs: 200_000, endUs: 800_000 });
    expect(retimeLayer(ext, "end", -900_000, id, 1000)).toEqual({ startUs: 200_000, endUs: 201_000 });
    expect(retimeLayer(ext, "start", -100_000, id, 1000)).toEqual({ startUs: 100_000, endUs: 600_000 });
    expect(retimeLayer(ext, "start", 900_000, id, 1000)).toEqual({ startUs: 599_000, endUs: 600_000 });
  });
  it("snaps to Figma's grids: a step in ms as fps (1–1000), a frame rate rounded (1–120), Off at the millisecond", () => {
    expect(gridFromMs(100)).toBe(10);
    expect(gridFromMs(0.5)).toBe(1000);
    expect(gridFromMs(5000)).toBe(1);
    expect(gridFromMs(0)).toBeNull();
    expect(gridFromFps(29.6)).toBe(30);
    expect(gridFromFps(500)).toBe(120);
    expect(gridLabel(20, "ms")).toBe("50 ms");
    expect(gridLabel(GRID_OFF_FPS, "ms")).toBe("Off");
    expect(gridLabel(30000 / 1001, "frames")).toBe("29.97 fps");
    expect(gridOptions("frames", 60).map((o) => o.label)).toEqual(["60 fps", "30 fps", "29.97 fps", "24 fps", "23.976 fps", "12 fps"]);
    expect(gridOptions("ms", 10).map((o) => o.label)).toEqual(["100 ms", "50 ms", "10 ms", "Off"]);
    // A typed grid that is none of the presets comes first.
    expect(gridOptions("frames", 48)[0].label).toBe("48 fps");
  });
});
