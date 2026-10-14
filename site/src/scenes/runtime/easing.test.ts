import { describe, expect, it } from "vitest";
import { BEZIER, cubicBezier, durationFor, linearEasing, motionTokens, springEasing, springSamples, SPRING } from "./easing";

describe("cubicBezier", () => {
  it("starts at 0, ends at 1 and clamps outside", () => {
    const f = cubicBezier(BEZIER.out);
    expect(f(0)).toBe(0);
    expect(f(1)).toBe(1);
    expect(f(-1)).toBe(0);
    expect(f(2)).toBe(1);
  });

  it("is the identity for the linear curve", () => {
    const f = cubicBezier([0, 0, 1, 1]);
    for (const t of [0.1, 0.33, 0.5, 0.9]) expect(f(t)).toBeCloseTo(t, 5);
  });

  it("matches known values of CSS's ease-in-out", () => {
    const f = cubicBezier([0.42, 0, 0.58, 1]);
    expect(f(0.5)).toBeCloseTo(0.5, 4);
    expect(f(0.25)).toBeCloseTo(0.1291, 3);
  });

  it("the expressive ease-out is far along early and monotonic", () => {
    const f = cubicBezier(BEZIER.out);
    expect(f(0.2)).toBeGreaterThan(0.6);
    let last = 0;
    for (let i = 1; i <= 100; i++) {
      const v = f(i / 100);
      expect(v).toBeGreaterThanOrEqual(last - 1e-9);
      last = v;
    }
  });
});

describe("springs", () => {
  it("start at 0, end exactly at 1, overshoot a little and settle", () => {
    const { values, duration } = springSamples(SPRING.gentle);
    expect(values[0]).toBe(0);
    expect(values[values.length - 1]).toBe(1);
    const peak = Math.max(...values);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThan(1.08);
    expect(duration).toBeGreaterThan(400);
    expect(duration).toBeLessThan(1400);
  });

  it("a firmer spring settles sooner", () => {
    expect(springSamples(SPRING.snap).duration).toBeLessThan(springSamples(SPRING.gentle).duration);
  });

  it("an overdamped spring never overshoots", () => {
    const { values } = springSamples({ stiffness: 100, damping: 40 });
    expect(Math.max(...values)).toBeLessThanOrEqual(1);
  });

  it("becomes a CSS linear() easing", () => {
    expect(linearEasing([0, 0.51234567, 1])).toBe("linear(0, 0.5123, 1)");
    const { easing } = springEasing(SPRING.gentle);
    expect(easing.startsWith("linear(0, ")).toBe(true);
    expect(easing.endsWith(", 1)")).toBe(true);
    expect(easing.split(",").length).toBeGreaterThan(10);
  });
});

describe("durationFor", () => {
  it("grows with the distance, within 240…900 ms", () => {
    expect(durationFor(0)).toBe(240);
    expect(durationFor(100)).toBeGreaterThan(durationFor(20));
    expect(durationFor(400)).toBeGreaterThan(durationFor(100));
    expect(durationFor(5000)).toBe(900);
  });
});

describe("motionTokens", () => {
  it("names every curve and duration", () => {
    const t = motionTokens();
    expect(t["--ease-out"]).toBe("cubic-bezier(0.16, 1, 0.3, 1)");
    expect(t["--ease-spring"]).toMatch(/^linear\(/);
    expect(t["--dur-1"]).toBe("240ms");
    expect(t["--dur-5"]).toBe("900ms");
  });
});
