import { describe, expect, it } from "vitest";
import { heroFrame } from "./heroScroll";

const slot = { x: 56, y: 360, w: 1328, h: 500 };

describe("heroFrame", () => {
  it("starts as the viewport fitted into the slot, centred, with 12px corners", () => {
    const f = heroFrame(0, 810, 1440, 900, slot);
    expect(f.scale).toBeCloseTo(500 / 900);
    expect(f.y).toBe(360);
    expect(f.x).toBeCloseTo(56 + (1328 - 1440 * (500 / 900)) / 2);
    expect(f.radius * f.scale).toBeCloseTo(12);
    expect(f.copyOpacity).toBe(1);
  });

  it("fills the viewport once the grow distance is scrolled, and stays so", () => {
    for (const scrolled of [810, 2000]) {
      const f = heroFrame(scrolled, 810, 1440, 900, slot);
      expect(f).toMatchObject({ progress: 1, x: 0, y: 0, scale: 1, radius: 0, copyOpacity: 0 });
    }
  });

  it("grows steadily in between, the copy fading first", () => {
    const a = heroFrame(200, 810, 1440, 900, slot);
    const b = heroFrame(500, 810, 1440, 900, slot);
    expect(a.scale).toBeLessThan(b.scale);
    expect(b.copyOpacity).toBe(0);
  });

  it("snaps with reduced motion", () => {
    expect(heroFrame(300, 810, 1440, 900, slot, true).progress).toBe(0);
    expect(heroFrame(500, 810, 1440, 900, slot, true).scale).toBe(1);
  });

  it("never scales above the viewport for a slot bigger than it", () => {
    expect(heroFrame(0, 810, 400, 300, { x: 0, y: 0, w: 900, h: 900 }).scale).toBe(1);
  });
});
