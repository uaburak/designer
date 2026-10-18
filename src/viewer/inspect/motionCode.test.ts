// Dev Mode's Motion code (docs/motion.md §8.2; round 8f) from a fixed resolved model: CSS @keyframes with the
// timeline's percentages and per-keyframe timing functions, X / Y merged into one translate, rotation clockwise,
// springs as linear(), the same motion written once; motion.dev's React; the timing rows.
import { describe, expect, it } from "vitest";
import type { ResolvedMotion } from "@shared/motion/types";
import { cssEasing, motionCode, motionCss, motionReact, slug, springSamples, timingRows } from "./motionCode";

const F = (value: number) => ({ type: "FLOAT" as const, value });
const RESOLVED: ResolvedMotion = {
  root: "1:1",
  durationUs: 2_000_000,
  playback: "LOOP",
  layers: [
    {
      node: "1:2",
      path: "1:2",
      name: "Red dot",
      anchor: { x: 50, y: 50 },
      size: { width: 100, height: 100 },
      properties: [
        { field: { type: "PROPERTY", name: "OPACITY" }, kind: "absolute", keyframes: [{ timeUs: 500_000, value: F(0), easing: { type: "LINEAR" } }, { timeUs: 1_000_000, value: F(1), easing: { type: "EASE_OUT" } }] },
        { field: { type: "PROPERTY", name: "TRANSLATION_X" }, kind: "additive", keyframes: [{ timeUs: 0, value: F(0), easing: { type: "LINEAR" } }, { timeUs: 2_000_000, value: F(100), easing: { type: "LINEAR" } }] },
        { field: { type: "PROPERTY", name: "TRANSLATION_Y" }, kind: "additive", keyframes: [{ timeUs: 1_000_000, value: F(40), easing: { type: "LINEAR" } }] },
        { field: { type: "PROPERTY", name: "ROTATION" }, kind: "additive", keyframes: [{ timeUs: 0, value: F(0), easing: { type: "LINEAR" } }, { timeUs: 1_000_000, value: F(90), easing: { type: "GENTLE" } }] },
        { field: { type: "PROPERTY", name: "PATH_TRIM_END" }, kind: "absolute", keyframes: [{ timeUs: 0, value: F(0), easing: { type: "LINEAR" } }] },
      ],
    },
    {
      node: "1:3",
      path: "1:3",
      name: "Red dot copy",
      anchor: { x: 50, y: 50 },
      size: { width: 100, height: 100 },
      properties: [],
    },
  ],
};
// The copy moves as the original does.
RESOLVED.layers[1].properties = RESOLVED.layers[0].properties;

describe("Dev Mode's Motion code", () => {
  it("CSS: a class per layer, @keyframes per property group over the timeline, held ends, easings into the next keyframe", () => {
    const css = motionCss({ resolved: RESOLVED });
    expect(css).toContain(".red-dot {");
    expect(css).toContain("red-dot-opacity 2000ms linear infinite both");
    expect(css).toContain("transform-origin: 50% 50%;");
    // Opacity: held at 0 until 25 %, eased out to 50 %, held to the end.
    expect(css).toContain("@keyframes red-dot-opacity {\n  0% { opacity: 0; animation-timing-function: steps(1, jump-end); }\n  25% { opacity: 0; animation-timing-function: cubic-bezier(0, 0, 0.58, 1); }\n  50% { opacity: 1; }\n  100% { opacity: 1; }\n}");
    // X and Y in one translate: Y held at 40 from the start, X linear (50 at 50 %).
    expect(css).toContain("0% { translate: 0px 40px;");
    expect(css).toContain("50% { translate: 50px 40px;");
    expect(css).toContain("100% { translate: 100px 40px;");
    // Figma's +90° (counter-clockwise) is CSS's −90deg; a spring into it is linear().
    expect(css).toMatch(/0% \{ rotate: 0deg; animation-timing-function: linear\(0, [^)]*1\); \}/);
    expect(css).toContain("50% { rotate: -90deg; }");
    expect(css).toContain("/* Not in CSS: PATH_TRIM_END */");
    // The copy's opacity is the same motion: one comment.
    expect(css).toContain("/* .red-dot-copy: the same motion as .red-dot */");
  });

  it("the playback style sets the iteration; easings map as Figma's curves", () => {
    expect(motionCss({ resolved: { ...RESOLVED, playback: "PING_PONG" } })).toContain("infinite alternate both");
    expect(motionCss({ resolved: { ...RESOLVED, playback: "ONCE" } })).toContain("2000ms linear 1 both");
    expect(cssEasing({ type: "HOLD" })).toBe("steps(1, jump-end)");
    expect(cssEasing({ type: "CUSTOM_CUBIC_BEZIER" })).toBe("cubic-bezier(0.5, 0, 0.5, 1)");
    expect(cssEasing({ type: "EASE_IN_AND_OUT_BACK" })).toBe("cubic-bezier(0.7, -0.4, 0.4, 1.4)");
    const s = springSamples({ type: "BOUNCY" });
    expect(s).toHaveLength(31);
    expect(s[0]).toBe(0);
    expect(Math.max(...s)).toBeGreaterThan(1); // it overshoots
    expect(Math.abs(s[30] - 1)).toBeLessThan(0.002);
  });

  it("React: motion.dev's animate / transition per layer, times over the timeline, rotate clockwise", () => {
    const code = motionReact({ resolved: RESOLVED });
    expect(code).toContain('import { motion } from "motion/react";');
    expect(code).toContain("opacity: [0, 0, 1, 1]");
    expect(code).toContain('opacity: { duration: 2, times: [0, 0.25, 0.5, 1], ease: ["linear", [0, 0, 0.58, 1], "linear"], repeat: Infinity, repeatType: "loop" }');
    expect(code).toContain("rotate: [0, -90, -90]");
    expect(code).toContain('style={{ transformOrigin: "50% 50%" }}');
    expect(code).toContain("not animated here: PATH_TRIM_END");
  });

  it("JSON is the resolved model; the timing rows list each property's span", () => {
    expect(JSON.parse(motionCode("json", { resolved: RESOLVED }))).toEqual(RESOLVED);
    const rows = timingRows(RESOLVED);
    expect(rows[0]).toMatchObject({ layer: "Red dot", property: "OPACITY", startMs: 500, endMs: 1000, easing: { type: "EASE_OUT" }, from: F(0), to: F(1), keyframes: 2 });
    expect(slug("Ürün kartı 2")).toBe("urun-kart-2");
    expect(slug("1 up")).toBe("layer-1-up");
  });
});
