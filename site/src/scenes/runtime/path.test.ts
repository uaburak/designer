import { describe, expect, it } from "vitest";
import { arcPoint, arcPoints, bendFor, cubicPoint, evenPoints, follow, typingDelays } from "./path";

describe("arcs", () => {
  it("start and end on the points, and bow off the straight line", () => {
    expect(arcPoint([0, 0], [100, 0], 0.1, 0)).toEqual([0, 0]);
    expect(arcPoint([0, 0], [100, 0], 0.1, 1)).toEqual([100, 0]);
    const mid = arcPoint([0, 0], [100, 0], 0.1, 0.5);
    expect(mid[0]).toBeCloseTo(50);
    expect(mid[1]).toBeCloseTo(-5); // half the control point's offset (−10)
    expect(arcPoint([0, 0], [100, 0], 0, 0.5)).toEqual([50, 0]);
  });

  it("are sampled evenly along their length", () => {
    const pts = arcPoints([0, 0], [300, 120], 0.15, 20);
    expect(pts).toHaveLength(21);
    expect(pts[0]).toEqual([0, 0]);
    expect(pts[20]).toEqual([300, 120]);
    const steps = pts.slice(1).map((p, i) => Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]));
    const mean = steps.reduce((a, b) => a + b, 0) / steps.length;
    for (const s of steps) expect(Math.abs(s - mean) / mean).toBeLessThan(0.03);
  });

  it("a move of no distance stays put", () => {
    expect(arcPoints([5, 5], [5, 5], 0.2, 4)).toEqual([
      [5, 5],
      [5, 5],
      [5, 5],
      [5, 5],
      [5, 5],
    ]);
  });

  it("bow by direction", () => {
    expect(bendFor([0, 0], [100, 10])).toBeGreaterThan(0);
    expect(bendFor([100, 0], [0, 10])).toBeLessThan(0);
    expect(Math.abs(bendFor([0, 0], [10, 100], 0.2))).toBe(0.2);
  });
});

describe("typingDelays", () => {
  it("one delay per character, within a person's range, pausing after punctuation", () => {
    const text = "Done, it fits on one line now.";
    const d = typingDelays(text);
    expect(d).toHaveLength(text.length);
    const comma = text.indexOf(",") + 1;
    for (const [i, ms] of d.entries()) {
      if (i === comma) expect(ms).toBeGreaterThan(90);
      else {
        expect(ms).toBeGreaterThanOrEqual(25);
        expect(ms).toBeLessThanOrEqual(70);
      }
    }
  });

  it("is uneven but the same every time", () => {
    const a = typingDelays("plant shop");
    expect(new Set(a).size).toBeGreaterThan(3);
    expect(typingDelays("plant shop")).toEqual(a);
  });
});

describe("follow", () => {
  it("moves a fraction of the way per 60 Hz frame", () => {
    const [x, y] = follow([0, 0], [100, 50], 0.3, 1000 / 60);
    expect(x).toBeCloseTo(30);
    expect(y).toBeCloseTo(15);
  });

  it("covers the same ground per second at any frame rate", () => {
    let a: [number, number] = [0, 0];
    let b: [number, number] = [0, 0];
    for (let i = 0; i < 6; i++) a = follow(a, [100, 0], 0.3, 1000 / 60);
    for (let i = 0; i < 12; i++) b = follow(b, [100, 0], 0.3, 1000 / 120);
    expect(b[0]).toBeCloseTo(a[0], 6);
  });

  it("snaps when within half a pixel, and alpha 1 jumps", () => {
    expect(follow([99.8, 0], [100, 0], 0.3, 16)).toEqual([100, 0]);
    expect(follow([0, 0], [40, 40], 1, 16)).toEqual([40, 40]);
  });
});

describe("cubic paths", () => {
  it("follow an SVG C curve, evenly spaced, end to end", () => {
    const pts = evenPoints((u) => cubicPoint([0, 0], [50, 0], [50, 100], [100, 100], u), 10);
    expect(pts[0]).toEqual([0, 0]);
    expect(pts[10]).toEqual([100, 100]);
    expect(pts[5][0]).toBeCloseTo(50, 0);
    expect(pts[5][1]).toBeCloseTo(50, 0);
  });
});
