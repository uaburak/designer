// The animate tool's compiler (docs/research/motion-for-agents.md §3a): GSAP's position parameter, stagger, from / to
// semantics against a stand-in host, the easing names mapped to Wecra's curves (exact power1 / power2, bounce and steps
// unrolled into keys, springs from physics), repeat / yoyo unrolled, overwrite, labels, text split.
import { describe, expect, it } from "vitest";
import { bezierAt, compileScript, JUMP, parseDraw, parseEase, parseOrigin, resolvePosition, staggerDelays, valueAt, type Channel, type Host, type Key, type Value } from "../agents/animateScript";

/** Layers A, B, C (rest: opacity 1, x 0, scale 1, fill red) and a text T ("Hello world"). */
function host(over: Partial<Host> = {}): Host {
  const names: Record<string, string> = { "1:2": "A", "1:3": "B", "1:4": "C", "1:5": "T" };
  return {
    resolve: (targets) => {
      const list = (Array.isArray(targets) ? targets : [targets]) as string[];
      const ids = list.flatMap((t) => (t === "Cards/*" ? ["1:2", "1:3", "1:4"] : Object.keys(names).filter((id) => id === t || names[id] === t)));
      const warnings = list.filter((t) => t !== "Cards/*" && !Object.keys(names).some((id) => id === t || names[id] === t)).map((t) => `no ${t}`);
      return { ids, warnings };
    },
    rest: (_id, c: Channel): Value | null => (c === "opacity" || c === "scale" ? 1 : c === "fill" ? { r: 1, g: 0, b: 0, a: 1 } : c === "arcEnd" ? null : 0),
    elements: (id, split) => (id === "1:5" ? (split === "chars" ? 10 : split === "words" ? 2 : 1) : null),
    ...over,
  };
}

const keys = (c: ReturnType<typeof compileScript>, id: string, ch: Channel) => c.layers.get(id)!.channels.get(ch)!;
const times = (k: Key[]) => k.map((x) => Math.round(x.t * 1000) / 1000);
const vals = (k: Key[]) => k.map((x) => (typeof x.v === "number" ? Math.round(x.v * 1000) / 1000 : x.v));

describe("animate script: positions and stagger", () => {
  it("reads GSAP's position parameter", () => {
    const ctx = { prevStart: 1, prevEnd: 2, end: 3, labels: { intro: 0.5 } as Record<string, number> };
    expect(resolvePosition(undefined, ctx, "p")).toBe(3);
    expect(resolvePosition(1.25, ctx, "p")).toBe(1.25);
    expect(resolvePosition("<", ctx, "p")).toBe(1);
    expect(resolvePosition(">", ctx, "p")).toBe(2);
    expect(resolvePosition("<0.2", ctx, "p")).toBeCloseTo(1.2);
    expect(resolvePosition(">-0.5", ctx, "p")).toBeCloseTo(1.5);
    expect(resolvePosition("<+=0.3", ctx, "p")).toBeCloseTo(1.3);
    expect(resolvePosition("+=0.4", ctx, "p")).toBeCloseTo(3.4);
    expect(resolvePosition("-=1", ctx, "p")).toBeCloseTo(2);
    expect(resolvePosition("intro", ctx, "p")).toBe(0.5);
    expect(resolvePosition("intro+=0.25", ctx, "p")).toBe(0.75);
    // An unknown label is added at the end (GSAP).
    expect(resolvePosition("outro", ctx, "p")).toBe(3);
    expect(ctx.labels.outro).toBe(3);
    expect(() => resolvePosition("<<", ctx, "p")).toThrow();
  });

  it("spreads a stagger as GSAP does: each, amount, from start / end / center / edges / index / random", () => {
    expect(staggerDelays(4, 0.1, "s").map((d) => +d.toFixed(3))).toEqual([0, 0.1, 0.2, 0.3]);
    expect(staggerDelays(4, { amount: 0.6 }, "s").map((d) => +d.toFixed(3))).toEqual([0, 0.2, 0.4, 0.6]);
    expect(staggerDelays(3, { each: 0.1, from: "end" }, "s").map((d) => +d.toFixed(3))).toEqual([0.2, 0.1, 0]);
    expect(staggerDelays(5, { each: 0.1, from: "center" }, "s").map((d) => +d.toFixed(3))).toEqual([0.2, 0.1, 0, 0.1, 0.2]);
    expect(staggerDelays(5, { each: 0.1, from: "edges" }, "s").map((d) => +d.toFixed(3))).toEqual([0, 0.1, 0.2, 0.1, 0]);
    expect(staggerDelays(4, { each: 0.1, from: 1 }, "s").map((d) => +d.toFixed(3))).toEqual([0.1, 0, 0.1, 0.2]);
    const r = staggerDelays(6, { each: 0.1, from: "random" }, "s");
    expect([...r].sort().map((d) => +d.toFixed(3))).toEqual([0, 0.1, 0.2, 0.3, 0.4, 0.5]);
    expect(staggerDelays(6, { each: 0.1, from: "random" }, "s")).toEqual(r); // the same script, the same timeline
  });

  it("sequences tweens: default after the end, '<' with the previous, '+=' gaps, labels; stagger over targets", () => {
    const c = compileScript(
      {
        defaults: { duration: 0.5, ease: "power2.out" },
        tweens: [
          { targets: "Cards/*", from: { opacity: 0, y: 40 }, stagger: 0.1 },
          { label: "title" },
          { targets: "T", from: { opacity: 0 }, position: "<0.2" },
          { targets: "A", to: { x: 100 }, position: "title+=0.5", duration: 1 },
        ],
      },
      host(),
    );
    expect(c.tweens.map((t) => [t.start, +t.end.toFixed(3)])).toEqual([[0, 0.7], [0.2, 0.7], [1.2, 2.2]]);
    expect(c.labels.title).toBeCloseTo(0.7);
    // B starts 0.1 s after A: from 0 (held back to 0) to its rest 1, eased power2.out (exact t³ mirror).
    const b = keys(c, "1:3", "opacity");
    expect(times(b)).toEqual([0.1, 0.6]);
    expect(vals(b)).toEqual([0, 1]);
    expect(b[0].ease).toEqual({ type: "HOLD" });
    expect(b[1].ease).toEqual({ type: "CUSTOM_CUBIC_BEZIER", easingFunctionCubicBezier: { x1: 1 / 3, y1: 1, x2: 2 / 3, y2: 1 } });
    expect(vals(keys(c, "1:4", "y"))).toEqual([40, 0]);
    expect(c.end).toBeCloseTo(2.2);
  });
});

describe("animate script: values over time", () => {
  it("a later tween starts where an earlier one left the property; fromTo sets both ends", () => {
    const c = compileScript(
      { tweens: [{ targets: "A", to: { x: 100 }, duration: 1, ease: "none" }, { targets: "A", to: { x: 50 }, duration: 0.5, position: "+=0.5" }, { targets: "B", fromTo: [{ rotate: -90 }, { rotate: 90 }], duration: 2 }] },
      host(),
    );
    const a = keys(c, "1:2", "x");
    expect(times(a)).toEqual([0, 1, 1.5, 2]);
    expect(vals(a)).toEqual([0, 100, 100, 50]);
    expect(vals(keys(c, "1:3", "rotate"))).toEqual([-90, 90]);
  });

  it("a from-value that differs from the key already there jumps just after it (Hold), as GSAP renders it", () => {
    const c = compileScript({ tweens: [{ targets: "A", to: { x: 100 }, duration: 1 }, { targets: "A", from: { x: -50 }, duration: 1, position: 1 }] }, host());
    const a = keys(c, "1:2", "x");
    expect(times(a)).toEqual([0, 1, 1 + JUMP, 2]);
    expect(vals(a)).toEqual([0, 100, -50, 100]);
    expect(a[2].ease.type).toBe("HOLD");
  });

  it("overwrites the part of an earlier tween a later one runs over", () => {
    const c = compileScript({ tweens: [{ targets: "A", to: { x: 200 }, duration: 2, ease: "none" }, { targets: "A", to: { x: 0 }, duration: 0.5, position: 1 }] }, host());
    const a = keys(c, "1:2", "x");
    // The earlier tween's end (2 s) goes: x stays 0 after 1.5 s.
    expect(times(a)).toEqual([0, 1, 1.5]);
    expect(vals(a)).toEqual([0, 100, 0]);
  });

  it("keyframes play in sequence from the current values; colours interpolate per channel", () => {
    const c = compileScript({ tweens: [{ targets: "A", keyframes: [{ x: 100, duration: 0.4 }, { x: 0, fill: "#0000ff", duration: 0.6 }], ease: "none" }] }, host());
    expect(times(keys(c, "1:2", "x"))).toEqual([0, 0.4, 1]);
    const f = keys(c, "1:2", "fill");
    expect(times(f)).toEqual([0.4, 1]);
    expect(f[1].v).toEqual({ r: 0, g: 0, b: 1, a: 1 });
    const mid = valueAt(f, 0.7, { r: 1, g: 0, b: 0, a: 1 }) as { r: number; g: number; b: number; a: number };
    expect([mid.r, mid.g, mid.b, mid.a].map((x) => +x.toFixed(6))).toEqual([0.5, 0, 0.5, 1]);
  });

  it("repeat and yoyo are unrolled (the way back eased in reverse); repeat -1 runs to the timeline's length", () => {
    const c = compileScript({ tweens: [{ targets: "A", to: { y: -20 }, duration: 0.5, ease: "power2.out", repeat: 3, yoyo: true }] }, host());
    const a = keys(c, "1:2", "y");
    expect(times(a)).toEqual([0, 0.5, 1, 1.5, 2]);
    expect(vals(a)).toEqual([0, -20, 0, -20, 0]);
    // The return leg is power2.out played backwards: power2.in.
    const back = a[2].ease.easingFunctionCubicBezier!;
    expect([back.x1, back.y1, back.x2, back.y2].map((x) => +x.toFixed(6))).toEqual([0.333333, 0, 0.666667, 0]);
    expect(c.end).toBeCloseTo(2);
    const spin = compileScript({ tweens: [{ targets: "B", to: { rotate: 360 }, duration: 1, ease: "none", repeat: -1 }] }, host(), { timelineDuration: 3 });
    const r = keys(spin, "1:3", "rotate");
    // Each turn starts again from 0 just after the last one ends.
    expect(vals(r)).toEqual([0, 360, 0, 360, 0, 360]);
    expect(times(r)).toEqual([0, 1, 1 + JUMP, 2, 2 + JUMP, 3]);
    expect(() => compileScript({ tweens: [{ targets: "B", to: { rotate: 360 }, repeat: -1 }] }, host())).toThrow(/timeline.duration/);
  });

  it("split text: one set of tracks, the text's own stagger, the span holding every element", () => {
    const c = compileScript({ tweens: [{ targets: "T", split: "chars", from: { opacity: 0, y: 20 }, duration: 0.4, stagger: { each: 0.05, from: "center" } }] }, host());
    expect(c.layers.get("1:5")!.textStagger).toEqual({ grouping: "CHARACTER_NO_WHITESPACE", delayMs: 50, order: "CENTER_OUT" });
    expect(times(keys(c, "1:5", "opacity"))).toEqual([0, 0.4]);
    expect(c.end).toBeCloseTo(0.4 + 9 * 0.05);
  });

  it("warns for layers that can't take a property and targets that match nothing; refuses unknown properties", () => {
    const c = compileScript({ tweens: [{ targets: ["A", "Nope"], to: { arcEnd: 90, opacity: 0.5 } }] }, host());
    expect(c.warnings.join("\n")).toMatch(/no Nope/);
    expect(c.warnings.join("\n")).toMatch(/can't animate arcEnd/);
    expect(c.layers.get("1:2")!.channels.has("arcEnd")).toBe(false);
    expect(() => compileScript({ tweens: [{ targets: "A", to: { wobble: 3 } }] }, host())).toThrow(/wobble/);
    expect(() => compileScript({ tweens: [] }, host())).toThrow(/tweens/);
  });

  it("merge mode starts from the layer's existing keys", () => {
    const existing: Key[] = [{ t: 0, v: 0, ease: { type: "HOLD" } }, { t: 1, v: 1, ease: { type: "LINEAR" } }];
    const c = compileScript({ tweens: [{ targets: "A", to: { opacity: 0 }, position: 2, duration: 0.5 }] }, host({ existing: () => existing }), { merge: true });
    expect(times(keys(c, "1:2", "opacity"))).toEqual([0, 1, 2, 2.5]);
    expect(vals(keys(c, "1:2", "opacity"))).toEqual([0, 1, 1, 0]);
  });
});

describe("animate script: easing names", () => {
  const curve = (s: unknown) => {
    const e = parseEase(s);
    if (e.kind !== "easing" || e.easing.type !== "CUSTOM_CUBIC_BEZIER") throw new Error(`not a bezier: ${JSON.stringify(e)}`);
    const b = e.easing.easingFunctionCubicBezier!;
    return [b.x1, b.y1, b.x2, b.y2];
  };
  it("power1 / power2 are exact; the CSS and GSAP aliases map", () => {
    for (const p of [0.1, 0.3, 0.5, 0.8]) {
      expect(bezierAt(curve("power1.in") as never, p)).toBeCloseTo(p * p, 4);
      expect(bezierAt(curve("power2.in") as never, p)).toBeCloseTo(p * p * p, 4);
      expect(bezierAt(curve("cubic.out") as never, p)).toBeCloseTo(1 - (1 - p) ** 3, 4);
    }
    expect(curve("power2")).toEqual(curve("power2.out"));
    expect(curve("Power3.easeInOut")).toEqual(curve("power3.inOut"));
    expect(curve("ease-out")).toEqual([0, 0, 0.58, 1]);
    expect(curve("cubic-bezier(0.2, 0.8, 0.2, 1)")).toEqual([0.2, 0.8, 0.2, 1]);
    expect(curve([0.1, 0.2, 0.3, 1])).toEqual([0.1, 0.2, 0.3, 1]);
    expect(curve("back.out(3)")[1]).toBeGreaterThan(curve("back.out")[1]);
    expect(parseEase("none")).toEqual({ kind: "easing", easing: { type: "LINEAR" } });
    expect(parseEase("EASE_OUT")).toEqual({ kind: "easing", easing: { type: "EASE_OUT" } });
    expect(parseEase("GENTLE")).toEqual({ kind: "easing", easing: { type: "GENTLE" } });
    expect(() => parseEase("wobbly.out")).toThrow(/GSAP/);
  });

  it("springs come from physics (damping ratio) or a bounce", () => {
    expect(parseEase({ type: "spring", stiffness: 100, damping: 10, mass: 1 })).toEqual({ kind: "easing", easing: { type: "CUSTOM_SPRING", easingFunctionSpring: { bounce: 0.5 } } });
    expect(parseEase({ type: "spring", bounce: 0.25 })).toEqual({ kind: "easing", easing: { type: "CUSTOM_SPRING", easingFunctionSpring: { bounce: 0.25 } } });
    expect(parseEase("spring(0.4)")).toEqual({ kind: "easing", easing: { type: "CUSTOM_SPRING", easingFunctionSpring: { bounce: 0.4 } } });
  });

  it("bounce, steps and elastic are unrolled into keys that land on GSAP's curve", () => {
    const penner = (t: number) => {
      const n = 7.5625, d = 2.75;
      if (t < 1 / d) return n * t * t;
      if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
      if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
      return n * (t -= 2.625 / d) * t + 0.984375;
    };
    const c = compileScript({ tweens: [{ targets: "A", to: { y: 100 }, duration: 1, ease: "bounce.out" }] }, host());
    const k = keys(c, "1:2", "y");
    expect(k).toHaveLength(8);
    for (const p of [0.1, 0.25, 0.45, 0.6, 0.77, 0.86, 0.93, 0.98]) expect(valueAt(k, p, 0) as number).toBeCloseTo(100 * penner(p), 3);
    const st = compileScript({ tweens: [{ targets: "A", to: { x: 40 }, duration: 1, ease: "steps(4)" }] }, host());
    const s = keys(st, "1:2", "x");
    expect(vals(s)).toEqual([0, 10, 20, 30, 40]);
    expect(valueAt(s, 0.3, 0)).toBe(10);
    expect(valueAt(s, 0.74, 0)).toBe(20);
    const el = compileScript({ tweens: [{ targets: "A", to: { scale: 2 }, duration: 1, ease: "elastic.out(1, 0.3)" }] }, host());
    const e = keys(el, "1:2", "scale");
    expect(e.length).toBeGreaterThan(4);
    expect(Math.max(...e.map((x) => x.v as number))).toBeGreaterThan(2.2); // the overshoot is there
    expect(e[e.length - 1].v).toBe(2);
    // bounce.in mirrors bounce.out.
    const bi = keys(compileScript({ tweens: [{ targets: "A", to: { y: 100 }, duration: 1, ease: "bounce.in" }] }, host()), "1:2", "y");
    for (const p of [0.1, 0.4, 0.8]) expect(valueAt(bi, p, 0) as number).toBeCloseTo(100 * (1 - penner(1 - p)), 3);
  });
});

describe("animate script: properties", () => {
  it("drawSVG, transform origin and colour forms", () => {
    expect(parseDraw("0% 100%", "d")).toEqual({ start: 0, end: 1 });
    expect(parseDraw("40%", "d")).toEqual({ start: 0, end: 0.4 });
    expect(parseDraw([0.2, 0.8], "d")).toEqual({ start: 0.2, end: 0.8 });
    expect(parseOrigin("left top", "o")).toEqual({ x: 0, y: 0 });
    expect(parseOrigin("center bottom", "o")).toEqual({ x: 50, y: 100 });
    expect(parseOrigin("25% 75%", "o")).toEqual({ x: 25, y: 75 });
    const c = compileScript({ tweens: [{ targets: "A", fromTo: [{ drawSVG: "0%" }, { drawSVG: "0% 100%" }], transformOrigin: "left top" }, { targets: "B", to: { backgroundColor: "rgb(0, 128, 255)", autoAlpha: 0.5 } }] }, host());
    expect(vals(keys(c, "1:2", "trimEnd"))).toEqual([0, 1]);
    expect(c.layers.get("1:2")!.origin).toEqual({ x: 0, y: 0 });
    const f = keys(c, "1:3", "fill");
    expect((f[1].v as { b: number }).b).toBe(1);
    expect(vals(keys(c, "1:3", "opacity"))).toEqual([1, 0.5]);
  });
});
