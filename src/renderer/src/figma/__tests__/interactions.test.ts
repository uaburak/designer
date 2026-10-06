import { describe, expect, it } from "vitest";
import { durationOf, easingCss, springCurve, SPRINGS } from "@/components/project/interactions";

describe("prototype easings", () => {
  it("draws a spring as a linear() curve that ends at 1, and times it by its physics", () => {
    const bouncy = springCurve(SPRINGS.bouncy);
    expect(bouncy.css.startsWith("linear(")).toBe(true);
    expect(bouncy.css.endsWith("1 100%)")).toBe(true);
    // A bouncy spring overshoots: some sample past 1.
    expect(bouncy.css.match(/(\d+\.\d+) /g)?.some((v) => parseFloat(v) > 1)).toBe(true);
    expect(bouncy.duration).toBeGreaterThan(200);
    expect(bouncy.duration).toBeLessThan(5000);
    // A stiffer, as damped spring settles sooner.
    expect(springCurve(SPRINGS.quick).duration).toBeLessThan(springCurve(SPRINGS.slow).duration);
  });
  it("uses a spring's own time, a curve's set duration, a custom bezier's numbers", () => {
    expect(durationOf({ easing: "ease-out", duration: 450 })).toBe(450);
    expect(durationOf({ easing: "gentle", duration: 450 })).toBe(springCurve(SPRINGS.gentle).duration);
    expect(easingCss({ easing: "custom-bezier", duration: 300, bezier: [0.1, 0.2, 0.3, 0.4] })).toBe("cubic-bezier(0.1, 0.2, 0.3, 0.4)");
  });
});
