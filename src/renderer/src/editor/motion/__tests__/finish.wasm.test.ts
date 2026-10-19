// @vitest-environment happy-dom
// Round 8i on the real engine (the committed Wasm build, the Figma logo fixture; docs/motion.md §4.7, §4.9, §6.7):
// Easing and Timing variables made by the chrome, a keyframe's easing and a clip's Delay / Duration / Easing bound to
// them (the timeline names the variable, the engine plays its value), the Easing presets' "New variable", keyframes
// pasted by the engine's command, X / Y tracks combined and split, custom animation styles made from a layer's clips,
// applied and deleted.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Message } from "@/engine/codec";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import { loadEngine } from "@/engine/loadEngine";
import { $, click, mount, type Mounted } from "../../../ds/__tests__/dom";
import { EditorContext, EditorController } from "../../controller";
import { setMode } from "../../devmode/devMode";
import { memoryDocumentSource } from "../../documentSource";
import { formatLiteral, resolveVariable } from "../../model/variables";
import { createCollection, createVariable } from "../../variables";
import { EasingControls } from "../easing/EasingPage";
import MOTION_LOGO from "../fixtures/figma-logo-motion.json";
import { clearKeyframeCopy, copySelectedKeyframes, pasteKeyframes } from "../keyframeClipboard";
import { setPlayhead } from "../motionState";
import { addPreset, applyStyle, createCustomStyle, customStyles, deleteCustomStyle, editPreset } from "../presets";

const wasm = join(process.cwd(), "src/renderer/src/engine/wasm/engine.wasm");
const RED = "1:2";

beforeAll(async () => {
  globalThis.fetch = async () => new Response(null, { status: 404 });
  const bytes = readFileSync(wasm);
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
});

async function editor() {
  const source = memoryDocumentSource(MOTION_LOGO as unknown as Message, { fileName: "Figma logo · Motion" });
  const engine = await Engine.create(null, { sessionID: 1 });
  engine.load(await source.load());
  engine.setViewport(1280, 800, 1, 1280, 800);
  const store = new EngineStore(engine);
  const ed = new EditorController(engine, store, source);
  engine.setSelection([RED]);
  setMode(ed, "motion");
  return { ed, engine, store };
}

const layerOf = (ed: EditorController, node = RED) => ed.engine.motionTimeline(node)!.layers.find((l) => l.node === node)!;

let m: Mounted | null = null;
afterEach(() => {
  m?.unmount();
  m = null;
  clearKeyframeCopy();
});

describe("round 8i on the engine", () => {
  it("Easing and Timing variables: made with Motion's defaults, bound to a keyframe and a clip, played and named", async () => {
    const { ed } = await editor();
    const collection = createCollection(ed)!;
    const easing = createVariable(ed, collection, "EASING", "", { kind: "literal", value: { type: "LINEAR" } })!;
    const timing = createVariable(ed, collection, "TIMING")!;
    const assets = ed.variables.get();
    expect(assets.lookup.variable(easing)?.type).toBe("EASING");
    expect(resolveVariable(easing, assets.lookup)).toEqual({ type: "LINEAR" });
    expect(resolveVariable(timing, assets.lookup)).toBe(500);
    expect(formatLiteral("TIMING", 500)).toBe("500ms");
    expect(formatLiteral("EASING", { type: "CUSTOM_CUBIC_BEZIER", easingFunctionCubicBezier: { x1: 0.1, y1: 0, x2: 0.3, y2: 1 } })).toBe("Custom bezier (0.1, 0, 0.3, 1)");
    // The first manual keyframe after the first eased by the variable: the timeline names it, its value is LINEAR.
    const track = layerOf(ed).tracks[0];
    const k = track.keyframes[1];
    expect(ed.engine.runMotionCommand("MOTION_SET_EASING", { ids: [k.id], easing: { variable: easing } })).toBe(0);
    const bound = layerOf(ed).tracks[0].keyframes[1];
    expect(bound.easingVariable).toBe(easing);
    expect(bound.easing).toEqual({ type: "LINEAR" });
    // A clip's Delay bound to the Timing variable (500 ms): it starts there.
    const [clip] = addPreset(ed, "opacity", [RED]);
    expect(editPreset(ed, layerOf(ed).clips.find((c) => c.id === clip)!, { variables: { delay: timing } })).toBe(true);
    const c = layerOf(ed).clips.find((x) => x.id === clip)!;
    expect(c.variables?.delay).toBe(timing);
    expect(c.startUs).toBe(500_000);
  });

  it("the Easing presets' New variable saves the current curve as an Easing variable and binds it", async () => {
    const { ed } = await editor();
    const changes: unknown[] = [];
    m = mount(() => createElement(EditorContext.Provider, { value: ed }, createElement(EasingControls, { values: [{ easing: { type: "EASE_IN_BACK" } }], onChange: (v: unknown, commit: boolean) => changes.push([v, commit]) })), {});
    expect($("[data-easing-graph]")).not.toBeNull();
    click($("[data-easing-select]"));
    click($("[data-new-easing-variable]"));
    const made = ed.variables.get().variables.find((v) => v.type === "EASING");
    expect(made).toBeDefined();
    expect(resolveVariable(made!.id, ed.variables.get().lookup)).toEqual({ type: "EASE_IN_BACK" });
    expect(changes.at(-1)).toEqual([{ variable: made!.id }, true]);
  });

  it("keyframes pasted by the engine; X / Y combined and split; a custom style made, applied and deleted", async () => {
    const { ed } = await editor();
    const before = layerOf(ed).tracks[0];
    copySelectedKeyframes(ed.engine.motionTimeline(RED), before.keyframes.map((k) => k.id));
    setPlayhead(ed, 1_000_000);
    expect(pasteKeyframes(ed, ed.engine.motionTimeline(RED))).toBe(true);
    expect(ed.store.undo.undoLabel).toBe("Paste keyframes");
    expect(layerOf(ed).tracks[0].keyframes.length).toBeGreaterThan(before.keyframes.length);
    // Position keyed on X and Y tracks, then combined into one and split again (the logo's XY track goes first: X / Y
    // tracks are refused beside it, round 8j).
    expect(ed.engine.runMotionCommand("MOTION_ADD_KEYFRAME", { nodes: [RED], field: { type: "PROPERTY", name: "TRANSLATION_X" }, timeUs: 0, value: { type: "FLOAT", value: 0 } })).not.toBe(0);
    ed.engine.runMotionCommand("MOTION_DELETE_TRACKS", { node: RED, fields: [{ type: "PROPERTY", name: "TRANSLATION_XY" }] });
    for (const [name, us, v] of [["TRANSLATION_X", 0, 0], ["TRANSLATION_X", 400_000, 30], ["TRANSLATION_Y", 400_000, 10]] as const)
      ed.engine.runMotionCommand("MOTION_ADD_KEYFRAME", { nodes: [RED], field: { type: "PROPERTY", name }, timeUs: us, value: { type: "FLOAT", value: v } });
    expect(ed.engine.runMotionCommand("MOTION_COMBINE_TRACKS", { node: RED, kind: "POSITION" })).toBe(0);
    const xy = layerOf(ed).tracks.find((t) => t.field.type === "PROPERTY" && t.field.name === "TRANSLATION_XY")!;
    expect(xy.keyframes.at(-1)!.value).toEqual({ type: "VECTOR", value: { x: 30, y: 10 } });
    expect(ed.engine.runMotionCommand("MOTION_SPLIT_TRACKS", { node: RED, kind: "POSITION" })).toBe(0);
    expect(layerOf(ed).tracks.some((t) => t.field.type === "PROPERTY" && t.field.name === "TRANSLATION_Y")).toBe(true);
    // A custom style from the layer's clips, applied to another layer, listed with its templates, deleted.
    addPreset(ed, "scale", [RED]);
    const style = createCustomStyle(ed, RED, "Pop")!;
    expect(style).toBeTruthy();
    const listed = customStyles(ed).find((s) => s.id === style)!;
    expect(listed.name).toBe("Pop");
    expect(listed.templates.map((t) => t.preset)).toContain("scale");
    const other = ed.engine.motionTimeline(RED)!.layers.find((l) => l.node !== RED)!.node;
    expect(applyStyle(ed, style, [other])).toBe(true);
    const applied = layerOf(ed, other).clips.filter((c) => c.style?.key === style);
    expect(applied.length).toBe(listed.templates.length);
    deleteCustomStyle(ed, style);
    expect(customStyles(ed).some((s) => s.id === style)).toBe(false);
    expect(layerOf(ed, other).clips.length).toBeGreaterThan(0); // the layer keeps its clips
  });
});
