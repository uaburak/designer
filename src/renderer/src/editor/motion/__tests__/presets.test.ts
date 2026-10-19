// Animation presets (docs/motion.md §4.6; round 8h): the `figma:motion` runtime (tween's two keyframes, a negative
// duration refused, duplicate positions collapsed), each first-party preset's tracks for its in / out / custom types at
// Figma's defaults, Text stagger's sub-animations and stagger, and the chrome's side (presets.ts): the props stored by
// defID and read back, which layers may take which preset, and a setting changed running the code again.
import { describe, expect, it } from "vitest";
import { animate, collapsePositions, tween } from "@shared/motion/runtime";
import { presetProps, runPreset } from "@shared/motion/presets";
import { ANIMATION_PRESETS, ANIMATION_STYLES, type PresetKey, type PresetTrackOutput, type TimelineClip } from "@shared/motion/types";
import type { EditorController } from "../../controller";
import { clipProps, editPreset, presetAllowed, presetDef, propId, storedProps } from "../presets";

const OUT = { type: "EASE_OUT" } as const;
const run = (key: PresetKey, props: Record<string, string | number | boolean> = {}) => runPreset(key, { props, duration: 0.5, easing: OUT, node: { type: "RECTANGLE", strokes: true } });
/** A track's field name, operation and [µs, value] pairs. */
const shape = (t: PresetTrackOutput) => ({
  field: t.field.type === "PROPERTY" ? t.field.name : "?",
  operation: t.operation,
  keys: t.keyframes.map((k) => [k.timeUs, k.value.value]),
});

describe("the figma:motion runtime", () => {
  it("tweens give two keyframes over [position, position + duration], both eased; a negative duration throws", () => {
    const tw = tween({ mode: "SCALE", timelinePosition: 0.25, duration: 0.5, from: 0, to: 1, easing: OUT });
    expect(tw.operation).toBe("SCALE");
    expect(tw.keyframes.map((k) => k.timeUs)).toEqual([250_000, 750_000]);
    expect(tw.keyframes.every((k) => k.easing === OUT)).toBe(true);
    expect(tween({ mode: "OFFSET", duration: 1, from: { x: 1, y: 2 }, to: { x: 0, y: 0 } }).keyframes[0].value).toEqual({ type: "VECTOR", value: { x: 1, y: 2 } });
    expect(() => tween({ mode: "SET", duration: -1, from: 0, to: 1 })).toThrow();
  });

  it("merges a track's tweens and collapses duplicate positions to the last one", () => {
    const t = animate("OPACITY", tween({ mode: "SET", duration: 0.5, from: 0, to: 1 }), tween({ mode: "SET", timelinePosition: 0.5, duration: 0.5, from: 0.5, to: 0 }));
    expect(shape(t).keys).toEqual([[0, 0], [500_000, 0.5], [1_000_000, 0]]);
    expect(collapsePositions([{ timeUs: 0, value: { type: "FLOAT", value: 1 } }, { timeUs: 0, value: { type: "FLOAT", value: 2 } }])).toEqual([{ timeUs: 0, value: { type: "FLOAT", value: 2 } }]);
  });
});

describe("the first-party presets", () => {
  it("Opacity: OPACITY × amount → 100 % in, 100 % → amount out, start → end custom", () => {
    expect(run("opacity").tracks.map(shape)).toEqual([{ field: "OPACITY", operation: "SCALE", keys: [[0, 0], [500_000, 1]] }]);
    expect(shape(run("opacity", { type: "fadeOut", amount: 20 }).tracks[0]).keys).toEqual([[0, 1], [500_000, 0.2]]);
    expect(shape(run("opacity", { type: "custom", start: 30, end: 60 }).tracks[0]).keys).toEqual([[0, 0.3], [500_000, 0.6]]);
  });

  it("Position: TRANSLATION_XY offset, travelling the way of its direction 200 px", () => {
    expect(run("position").tracks.map(shape)).toEqual([{ field: "TRANSLATION_XY", operation: "OFFSET", keys: [[0, { x: 200, y: -0 }], [500_000, { x: 0, y: 0 }]] }]);
    expect(shape(run("position", { type: "slide_out", direction: "bottom_right", distance: 10 }).tracks[0]).keys).toEqual([[0, { x: 0, y: 0 }], [500_000, { x: 10, y: 10 }]]);
    expect(shape(run("position", { type: "custom" }).tracks[0]).keys).toEqual([[0, { x: 200, y: 200 }], [500_000, { x: 0, y: 0 }]]);
  });

  it("Scale, Rotation, Size, Corner Radius at Figma's defaults", () => {
    expect(run("scale").tracks.map(shape)).toEqual([{ field: "SCALE_XY", operation: "SCALE", keys: [[0, 1.2], [500_000, 1]] }]);
    // A clockwise Rotate in turns to rest from +180° (public degrees are counter-clockwise).
    expect(run("rotation").tracks.map(shape)).toEqual([{ field: "ROTATION", operation: "OFFSET", keys: [[0, 180], [500_000, 0]] }]);
    expect(shape(run("rotation", { direction: "counterclockwise", type: "rotateOut", amount: 90 }).tracks[0]).keys).toEqual([[0, 0], [500_000, 90]]);
    expect(run("size").tracks.map(shape)).toEqual([
      { field: "WIDTH", operation: "OFFSET", keys: [[0, -50], [500_000, 0]] },
      { field: "HEIGHT", operation: "OFFSET", keys: [[0, -50], [500_000, 0]] },
    ]);
    expect(shape(run("cornerRadius").tracks[0]).keys).toEqual([[0, 0], [500_000, 10]]);
    expect(shape(run("cornerRadius", { type: "roundOut" }).tracks[0]).keys).toEqual([[0, 10], [500_000, 0]]);
  });

  it("Path: Draw the end, Erase the start, Travel a segment along it (SET)", () => {
    expect(run("path").tracks.map(shape)).toEqual([{ field: "PATH_TRIM_END", operation: "SET", keys: [[0, 0], [500_000, 1]] }]);
    expect(run("path", { type: "erase" }).tracks.map(shape)[0].field).toBe("PATH_TRIM_START");
    expect(run("path", { type: "travel" }).tracks.map(shape)).toEqual([
      { field: "PATH_TRIM_START", operation: "SET", keys: [[0, 0], [500_000, 0.9]] },
      { field: "PATH_TRIM_END", operation: "SET", keys: [[0, 0.1], [500_000, 1]] },
    ]);
  });

  it("Text and Text stagger stagger their tracks per element", () => {
    const typewriter = run("text", { revealBy: "word" });
    expect(typewriter.textStagger).toEqual({ grouping: "WORD", order: "LEFT_RIGHT", overlap: 0 });
    expect(typewriter.tracks[0].keyframes[1].easing).toEqual({ type: "HOLD" });
    // Figma's defaults: position on (from 40 px below, rising), the rest off; 50 % overlap by character.
    const enter = run("textStagger");
    expect(enter.tracks.map(shape)).toEqual([{ field: "TRANSLATION_XY", operation: "OFFSET", keys: [[0, { x: -0, y: 40 }], [500_000, { x: 0, y: 0 }]] }]);
    expect(enter.textStagger).toEqual({ grouping: "CHARACTER", order: "LEFT_RIGHT", overlap: 50, clipContent: false });
    const exit = run("textStagger", { animationDirection: "out", opacity: true, position: false, textDelayOrder: "CENTER_OUT" });
    expect(exit.tracks.map(shape)).toEqual([{ field: "OPACITY", operation: "SCALE", keys: [[0, 1], [500_000, 0]] }]);
    expect(exit.textStagger?.order).toBe("CENTER_OUT");
    expect(run("new").tracks).toEqual([]);
  });

  it("every catalogue entry has code, and every style names presets of the catalogue", () => {
    for (const p of ANIMATION_PRESETS) expect(() => run(p.key)).not.toThrow();
    for (const s of ANIMATION_STYLES) for (const p of s.presets) expect(presetDef(p.preset)).toBeDefined();
  });
});

describe("presets from the chrome", () => {
  it("stores the props by defID (Delay, Duration and Easing are the clip's) and reads them back with the defaults", () => {
    expect(propId("type")).toMatch(/^0:\d+$/);
    expect(propId("type")).not.toBe(propId("amount"));
    const stored = storedProps({ ...presetProps("opacity"), type: "fadeOut", delay: 1, duration: 2 });
    expect(Object.keys(stored).sort()).toEqual([propId("amount"), propId("end"), propId("start"), propId("type")].sort());
    const clip = { preset: "opacity" as const, props: { [propId("type")]: "fadeOut" } };
    expect(clipProps(clip)).toEqual({ type: "fadeOut", amount: 0, start: 0, end: 100 });
  });

  it("offers Path only to stroked layers and the text presets only to text layers", () => {
    const path = presetDef("path")!;
    const text = presetDef("textStagger")!;
    expect(presetAllowed(path, [{ type: "VECTOR", strokes: true }])).toBe(true);
    expect(presetAllowed(path, [{ type: "VECTOR", strokes: false }])).toBe(false);
    expect(presetAllowed(text, [{ type: "TEXT", strokes: false }])).toBe(true);
    expect(presetAllowed(text, [{ type: "RECTANGLE", strokes: false }, { type: "TEXT", strokes: false }])).toBe(false);
    expect(presetAllowed(presetDef("opacity")!, [])).toBe(false);
  });

  it("a prop changed runs the code again in the same command; a new length or easing alone doesn't", () => {
    const calls: [string, Record<string, unknown>][] = [];
    const ed = { engine: { runMotionCommand: (id: string, args: Record<string, unknown>) => (calls.push([id, args]), 0) } } as unknown as EditorController;
    const clip: TimelineClip = { id: "9:1", preset: "opacity", name: "Opacity", startUs: 0, durationUs: 500_000, disabled: false, easing: OUT, props: { [propId("type")]: "fadeIn" } };
    expect(editPreset(ed, clip, { props: { type: "fadeOut", amount: 25 } })).toBe(true);
    const [id, args] = calls[0];
    expect(id).toBe("MOTION_SET_ANIMATION");
    expect(args.props).toEqual(storedProps({ type: "fadeOut", amount: 25, start: 0, end: 100 }));
    expect((args.output as { tracks: PresetTrackOutput[] }).tracks[0].keyframes.map((k) => k.value.value)).toEqual([1, 0.25]);
    editPreset(ed, clip, { durationUs: 1_000_000 });
    expect(calls[1][1]).toEqual({ id: "9:1", durationUs: 1_000_000 });
    // A new type starts from its own defaults.
    editPreset(ed, clip, { preset: "scale" });
    expect(calls[2][1].preset).toBe("scale");
    expect((calls[2][1].output as { tracks: PresetTrackOutput[] }).tracks[0].field).toEqual({ type: "PROPERTY", name: "SCALE_XY" });
  });
});
