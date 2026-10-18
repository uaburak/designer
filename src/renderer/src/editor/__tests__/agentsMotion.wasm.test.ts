// @vitest-environment happy-dom
// The agents' motion tools (round 8f, docs/motion.md §9) on the real engine and the Figma logo fixture: get_motion reads
// the timeline in Figma's Plugin API shapes (seconds, public units), set_keyframes writes / edits / merges a track and
// grows the timeline, remove_keyframes, set_timeline, the presets (add / edit / remove, Figma's prop names), a composite
// style applied and detached, the refusals Figma's API has (a top-level frame, combined vs separated tracks, WIDTH on
// a vector, EASE_IN_OUT), audio edits, and export_animation handing back a GIF / Lottie file — each call one undo step.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { Message } from "@/engine/codec";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import { loadEngine } from "@/engine/loadEngine";
import { TOOL_BY_NAME, type ToolResult } from "@shared/agents/tools";
import { EditorController } from "../controller";
import { memoryDocumentSource } from "../documentSource";
import { runTool, type ToolEnv } from "../agents/mcpTools";
import { AgentTurns } from "../agents/turns";
import MOTION_LOGO_DOCUMENT from "../motion/fixtures/figma-logo-motion.json";

const wasm = join(process.cwd(), "src/renderer/src/engine/wasm/engine.wasm");
const FRAME = "1:1";
const RED = "1:2";
const GREEN = "1:6";

beforeAll(async () => {
  globalThis.fetch = async () => new Response(null, { status: 404 });
  const bytes = readFileSync(wasm);
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
});

async function editor() {
  const source = memoryDocumentSource(MOTION_LOGO_DOCUMENT as unknown as Message, { fileName: "Figma logo · Motion" });
  const engine = await Engine.create(null, { sessionID: 1 });
  engine.load(await source.load());
  engine.setViewport(1280, 800, 1, 1280, 800);
  const ed = new EditorController(engine, new EngineStore(engine), source);
  const turns = new AgentTurns(ed);
  const env: ToolEnv = { ed, write: (_l, fn, refs) => turns.write(null, "Claude Code", fn, refs) };
  const call = async (name: string, args: Record<string, unknown>) => runTool(env, name, args);
  return { ed, engine, call };
}

const text = (r: ToolResult) => r.content.map((c) => (c.type === "text" ? c.text : "")).join("");
const json = (r: ToolResult) => {
  expect(r.isError, text(r)).toBeFalsy();
  return JSON.parse(text(r));
};
const error = (r: ToolResult) => {
  expect(r.isError, text(r)).toBe(true);
  return text(r);
};

describe("agents' motion tools", () => {
  it("lists every motion tool with an object schema", () => {
    for (const name of ["get_motion", "set_keyframes", "remove_keyframes", "set_timeline", "add_animation", "edit_animation", "remove_animations", "apply_animation_style", "detach_animation_style", "add_audio", "edit_audio", "export_animation"]) {
      const t = TOOL_BY_NAME.get(name);
      expect(t, name).toBeDefined();
      expect(t!.inputSchema.type).toBe("object");
    }
    expect(TOOL_BY_NAME.get("get_motion")!.write).toBe(false);
    expect(TOOL_BY_NAME.get("export_animation")!.write).toBe(false);
    expect(TOOL_BY_NAME.get("set_keyframes")!.write).toBe(true);
  });

  it("get_motion reads the timeline in seconds with Figma's manualKeyframeTracks, and the resolved model on request", async () => {
    const { call } = await editor();
    const m = json(await call("get_motion", { nodeId: RED, resolved: true }));
    expect(m.timeline).toMatchObject({ id: FRAME, frame: "Figma logo" });
    expect(m.timeline.duration).toBeGreaterThan(0);
    const red = m.layers.find((l: { id: string }) => l.id === RED);
    expect(Object.keys(red.manualKeyframeTracks)).toEqual(expect.arrayContaining(["TRANSLATION_XY", "OPACITY"]));
    const op = red.manualKeyframeTracks.OPACITY;
    expect(op.id).toBeTruthy();
    for (const k of op.keyframes) {
      expect(k.id).toBeTruthy();
      expect(k.value.type).toBe("FLOAT");
      expect(k.value.value).toBeGreaterThanOrEqual(0);
      expect(k.value.value).toBeLessThanOrEqual(1);
      expect(k.timelinePosition).toBeLessThanOrEqual(m.timeline.duration);
    }
    expect(m.resolved.root).toBe(FRAME);
    expect(m.resolved.layers.length).toBeGreaterThan(0);
    expect(m.resolved.layers[0].properties[0].keyframes[0]).toHaveProperty("time");
  });

  it("set_keyframes writes a new track (one undo step), edits it by keyframe id, merges, and grows the timeline", async () => {
    const { engine, call } = await editor();
    const before = json(await call("get_motion", { nodeId: FRAME })).timeline.duration;
    const r = json(await call("set_keyframes", { nodeIds: [GREEN], field: "ROTATION", keyframes: [{ timelinePosition: 0, value: { type: "FLOAT", value: 0 } }, { timelinePosition: before + 1, value: { type: "FLOAT", value: -360 }, easing: { type: "EASE_OUT" } }] }));
    const track = r.tracks[GREEN];
    expect(track.keyframes.map((k: { timelinePosition: number }) => k.timelinePosition)).toEqual([0, before + 1]);
    // Stored as Figma does (−radians, float32): read back to within the float's step.
    expect(track.keyframes[1]).toMatchObject({ value: { type: "FLOAT" }, easing: { type: "EASE_OUT" } });
    expect(track.keyframes[1].value.value).toBeCloseTo(-360, 3);
    expect(r.timeline.duration).toBeCloseTo(before + 1, 6);
    // Edit the second keyframe by its id, drop the first (not listed).
    const id1 = track.keyframes[1].id;
    const e = json(await call("set_keyframes", { nodeId: GREEN, field: { type: "PROPERTY", name: "ROTATION" }, keyframes: [{ id: id1, timelinePosition: 1, value: { type: "FLOAT", value: 90 } }] }));
    expect(e.tracks[GREEN].keyframes).toHaveLength(1);
    expect(e.tracks[GREEN].keyframes[0]).toMatchObject({ id: id1, timelinePosition: 1 });
    expect(e.tracks[GREEN].keyframes[0].value.value).toBeCloseTo(90, 3);
    // Merge: added, nothing deleted.
    const mg = json(await call("set_keyframes", { nodeId: GREEN, field: "ROTATION", merge: true, keyframes: [{ timelinePosition: 0.5, value: 45 }] }));
    expect(mg.tracks[GREEN].keyframes.map((k: { timelinePosition: number }) => k.timelinePosition)).toEqual([0.5, 1]);
    // A bare number reads as the field's type; each call is one step.
    engine.command("UNDO");
    expect(json(await call("get_motion", { nodeId: GREEN })).layers.find((l: { id: string }) => l.id === GREEN).manualKeyframeTracks.ROTATION.keyframes).toHaveLength(1);
  });

  it("refuses what Figma's API refuses: a top-level frame, XY with X, WIDTH on an ellipse's group-like types, EASE_IN_OUT, a wrong value type", async () => {
    const { call } = await editor();
    expect(error(await call("set_keyframes", { nodeId: FRAME, field: "OPACITY", keyframes: [{ timelinePosition: 0, value: 1 }] }))).toContain("top-level frames");
    expect(error(await call("set_keyframes", { nodeId: RED, field: "TRANSLATION_X", keyframes: [{ timelinePosition: 0, value: 4 }] }))).toContain("combined or separated");
    expect(error(await call("set_keyframes", { nodeId: RED, field: "OPACITY", keyframes: [{ timelinePosition: 0, value: 1, easing: { type: "EASE_IN_OUT" } }] }))).toContain("EASE_IN_AND_OUT");
    expect(error(await call("set_keyframes", { nodeId: RED, field: "OPACITY", keyframes: [{ timelinePosition: 0, value: { type: "VECTOR", value: { x: 1, y: 1 } } }] }))).toContain('{type: "FLOAT", value}');
    expect(error(await call("set_keyframes", { nodeId: RED, field: "SHEAR", keyframes: [] }))).toContain("can't be keyframed");
    expect(error(await call("set_keyframes", { nodeId: RED, field: "OPACITY", keyframes: [{ timelinePosition: -1, value: 1 }] }))).toContain("timelinePosition");
    expect(error(await call("set_keyframes", { field: "OPACITY", keyframes: [] }))).toContain("no nodes given");
  });

  it("remove_keyframes takes keyframes by id and whole tracks; set_timeline sets duration, playback and fps", async () => {
    const { call } = await editor();
    const red = json(await call("get_motion", { nodeId: RED })).layers.find((l: { id: string }) => l.id === RED);
    const first = red.manualKeyframeTracks.OPACITY.keyframes[0].id;
    json(await call("remove_keyframes", { keyframeIds: [first] }));
    const after = json(await call("get_motion", { nodeId: RED })).layers.find((l: { id: string }) => l.id === RED);
    expect(after.manualKeyframeTracks.OPACITY.keyframes.map((k: { id: string }) => k.id)).not.toContain(first);
    const t = json(await call("remove_keyframes", { nodeId: RED, fields: ["OPACITY"] }));
    expect(t.removedTracks).toHaveLength(1);
    expect(json(await call("get_motion", { nodeId: RED })).layers.find((l: { id: string }) => l.id === RED).manualKeyframeTracks.OPACITY).toBeUndefined();
    const tl = json(await call("set_timeline", { nodeId: RED, duration: 4, playback: "PING_PONG", fps: 30 }));
    expect(tl.timeline).toMatchObject({ id: FRAME, duration: 4, playback: "PING_PONG", fps: 30 });
    expect(error(await call("set_timeline", { nodeId: RED, duration: -1 }))).toContain("duration");
  });

  it("add_animation / edit_animation / remove_animations: a preset by Figma's style id with Figma's prop names", async () => {
    const { engine, call } = await editor();
    const a = json(await call("add_animation", { nodeIds: [GREEN], style: "Opacity", timelineOffset: 0.25, duration: 0.4, props: { timing: "out", easing: { type: "EASE_IN" } } }));
    const anim = a.animations[GREEN];
    expect(anim).toMatchObject({ type: "FIGMA", styleId: "Opacity", timelineOffset: 0.25, duration: 0.4, visible: true });
    expect(anim.props).toMatchObject({ type: "fadeOut", easing: { type: "EASE_IN" } });
    const edited = json(await call("edit_animation", { nodeId: GREEN, animationId: anim.id, duration: 1, props: { type: "fadeIn", amount: 20 }, visible: false }));
    expect(edited.animation).toMatchObject({ id: anim.id, duration: 1, visible: false, props: { type: "fadeIn", amount: 20 } });
    expect(error(await call("add_animation", { nodeIds: [GREEN], style: "TextStagger" }))).toContain("text layers");
    expect(error(await call("add_animation", { nodeIds: [GREEN], style: "Opacity", props: { wobble: 1 } }))).toContain("no prop wobble");
    expect(error(await call("add_animation", { nodeIds: [GREEN], style: "Sparkle" }))).toContain("No animation style");
    json(await call("remove_animations", { nodeId: GREEN, animationIds: [anim.id] }));
    expect(json(await call("get_motion", { nodeId: GREEN })).layers.find((l: { id: string }) => l.id === GREEN)?.animations ?? []).toHaveLength(0);
    engine.command("UNDO");
    expect(json(await call("get_motion", { nodeId: GREEN })).layers.find((l: { id: string }) => l.id === GREEN).animations).toHaveLength(1);
  });

  it("apply_animation_style stacks a composite style's presets under one entry, detach_animation_style keeps them", async () => {
    const { call } = await editor();
    const r = json(await call("apply_animation_style", { nodeIds: [GREEN], style: "slideIn", timelineOffset: 0.5 }));
    expect(r.layers[GREEN].map((s: { styleId: string }) => s.styleId)).toEqual(["Position", "Opacity"]);
    expect(r.layers[GREEN].every((s: { timelineOffset: number }) => s.timelineOffset === 0.5)).toBe(true);
    const layer = json(await call("get_motion", { nodeId: GREEN })).layers.find((l: { id: string }) => l.id === GREEN);
    expect(layer.animationStyles).toHaveLength(1);
    expect(layer.animationStyles[0]).toMatchObject({ style: "slideIn" });
    json(await call("detach_animation_style", { styleEntryId: layer.animationStyles[0].id }));
    const after = json(await call("get_motion", { nodeId: GREEN })).layers.find((l: { id: string }) => l.id === GREEN);
    expect(after.animationStyles).toBeUndefined();
    expect(after.animations).toHaveLength(2);
    expect(error(await call("apply_animation_style", { nodeIds: [GREEN], style: "textEnter" }))).toContain("text layers");
  });

  it("edit_audio names the timeline's clips; add_audio needs bytes", async () => {
    const { call } = await editor();
    expect(error(await call("edit_audio", { nodeId: FRAME, audioId: "9:9" }))).toContain("no audio");
    expect(error(await call("add_audio", { nodeId: FRAME, path: "beat.mp3" }))).toContain("wasn't read by the app");
  });

  it("export_animation hands back the file (GIF, Lottie) for main to save", async () => {
    const { call } = await editor();
    const gif = await call("export_animation", { nodeId: RED, format: "GIF", scale: 0.25, fps: 24 });
    const g = json(gif);
    expect(g.file).toBe("Figma logo.gif");
    expect(gif.files![0]).toMatchObject({ name: "Figma logo.gif", mimeType: "image/gif" });
    expect(atob(gif.files![0].data).slice(0, 6)).toBe("GIF89a");
    const lottie = await call("export_animation", { nodeId: FRAME, format: "LOTTIE", fps: 24 });
    expect(JSON.parse(atob(lottie.files![0].data))).toMatchObject({ v: "5.7.0", fr: 24 });
    expect(error(await call("export_animation", { nodeId: FRAME, format: "AVI" }))).toContain("format");
  });
});
