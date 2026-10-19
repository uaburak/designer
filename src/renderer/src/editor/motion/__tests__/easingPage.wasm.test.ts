// @vitest-environment happy-dom
// The right panel's Easing page (docs/motion.md §6.14; Figma's, docs/research/figma/live/2026-10-18/motion-easing.txt):
// the graph's layout and the presets' glyphs (pure), segment selection on the timeline's view, and the page on the real
// engine (the committed Wasm build, the Figma logo fixture) — the preset select and its popover, Flip curve, the Bezier
// field, a handle dragged as one undo step, Curve | Spring and Bounce, several segments edited together (Mixed).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { act } from "react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Message } from "@/engine/codec";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import { loadEngine } from "@/engine/loadEngine";
import { MIXED } from "@/ds";
import type { TimelineModel } from "@shared/motion/types";
import { $, $$, box, click, focus, key, mount, pointer, spy, type, type Mounted } from "../../../ds/__tests__/dom";
import { EditorContext, EditorController } from "../../controller";
import { setMode } from "../../devmode/devMode";
import { memoryDocumentSource } from "../../documentSource";
import { EasingPage, useEasingSegments } from "../easing/EasingPage";
import { bezierText, bounceForPeak, curveLayout, flipEasing, parseBezierText, presetGlyphPath, segmentTargets, sharedEasing, springPeak } from "../easing/easingMaths";
import MOTION_LOGO from "../fixtures/figma-logo-motion.json";
import { motionUi, setMotionUi } from "../motionState";
import { Timeline, type TimelineProps } from "../timeline/Timeline";

const wasm = join(process.cwd(), "src/renderer/src/engine/wasm/engine.wasm");
const RED = "1:2";

describe("the Easing page's maths", () => {
  it("fits the curve graph as Figma's: 0 and 1 at 164 and 44, an overshooting handle at 12 (0.45, 1.45, 0.8, 1)", () => {
    const plain = curveLayout([0.42, 0, 0.58, 1]);
    expect([plain.x(0), plain.x(1), plain.y(0), plain.y(1)]).toEqual([44, 164, 164, 44]);
    const back = curveLayout([0.45, 1.45, 0.8, 1]);
    expect(back.y(0)).toBe(164);
    expect(back.y(1.45)).toBeCloseTo(12, 6);
    expect(back.y(1)).toBeCloseTo(59.2, 1);
    const under = curveLayout([0.7, -0.4, 0.4, 1.4]);
    expect(under.y(-0.4)).toBeCloseTo(196, 6);
    expect(under.y(1.4)).toBeCloseTo(12, 6);
    expect(under.v(under.y(0.3))).toBeCloseTo(0.3, 6);
  });

  it("flips a curve end for end (Ease in ↔ Ease out), parses the Bezier field, draws Figma's Hold glyph", () => {
    expect(flipEasing({ type: "EASE_IN" })).toEqual({ type: "EASE_OUT" });
    expect(flipEasing({ type: "CUSTOM_CUBIC_BEZIER", easingFunctionCubicBezier: { x1: 0.45, y1: 1.45, x2: 0.8, y2: 1 } })).toEqual({ type: "CUSTOM_CUBIC_BEZIER", easingFunctionCubicBezier: { x1: 0.2, y1: 0, x2: 0.55, y2: -0.45 } });
    expect(flipEasing({ type: "HOLD" })).toBeNull();
    expect(parseBezierText("0.62, -0.01, 0.39, 1")).toEqual([0.62, -0.01, 0.39, 1]);
    expect(parseBezierText("1.5 2 -1 0")).toEqual([1, 2, 0, 0]);
    expect(parseBezierText("0.1, 0.2")).toBeNull();
    expect(bezierText([0.454, 1.45, 0.8, 1])).toBe("0.45, 1.45, 0.8, 1");
    expect(presetGlyphPath("HOLD")).toBe("M6.5 17.5H17.5V6.5");
    expect(presetGlyphPath("LINEAR").startsWith("M6.50 17.50")).toBe(true);
  });

  it("finds the spring's first peak and the bounce that reaches a peak", () => {
    const pk = springPeak({ type: "CUSTOM_SPRING", easingFunctionSpring: { bounce: 0.5 } });
    expect(pk.v).toBeGreaterThan(1);
    expect(bounceForPeak(pk.v)).toBeCloseTo(0.5, 1);
    expect(bounceForPeak(1)).toBe(0);
  });

  it("reads the selected segments from the model; their easing shared, or Mixed", () => {
    const model = { layers: [{ node: "1:2", tracks: [{ keyframes: [
      { id: "a", timeUs: 0, easing: { type: "LINEAR" } },
      { id: "b", timeUs: 500_000, easing: { type: "EASE_OUT" } },
      { id: "c", timeUs: 900_000, easing: { type: "EASE_IN" } },
    ] }] }] } as unknown as TimelineModel;
    // The first keyframe has no segment before it.
    expect(segmentTargets(model, ["a", "b"], new Set(["1:2"])).map((s) => [s.id, s.startUs, s.endUs])).toEqual([["b", 0, 500_000]]);
    expect(segmentTargets(model, ["b"], new Set(["9:9"]))).toEqual([]);
    expect(sharedEasing(segmentTargets(model, ["b"], new Set(["1:2"])))).toEqual({ type: "EASE_OUT" });
    expect(sharedEasing(segmentTargets(model, ["b", "c"], new Set(["1:2"])))).toBe(MIXED);
  });
});

describe("segments on the timeline", () => {
  const MODEL: TimelineModel = {
    root: "1:1", rootName: "Card", timelineId: "1:1", durationUs: 2_000_000, playback: "LOOP", snappingFps: 60, audioTracks: [], audio: [],
    layers: [{ node: "1:2", name: "Rect", icon: "16.rectangle", depth: 0, clips: [], startUs: 0, endUs: 1_000_000, tracks: [
      { id: "t1", field: { type: "PROPERTY", name: "OPACITY" }, label: "Opacity", keyframes: [
        { id: "k1", timeUs: 0, value: { type: "FLOAT", value: 1 }, easing: { type: "LINEAR" } },
        { id: "k2", timeUs: 1_000_000, value: { type: "FLOAT", value: 0 }, easing: { type: "EASE_OUT" } },
      ] },
    ] }],
  };
  const props = (over: Partial<TimelineProps>) => ({
    model: MODEL, timeUs: 0, playing: false, autoKeyframe: false, collapsed: false, unit: "ms", selectedKeyframes: new Set(), selectedNodes: new Set(),
    onSeek() {}, onTogglePlay() {}, onToggleAutoKeyframe() {}, onToggleCollapse() {}, onSetTimeline() {}, onSelectKeyframes() {}, onMoveKeyframes() {}, onDeleteKeyframes() {}, onDeleteTrack() {}, onSetEasing() {}, onSelectLayer() {}, onCopyKeyframes() {}, onPasteKeyframes: () => false, onResize() {},
    ...over,
  }) as TimelineProps;

  it("a segment wears Figma's easing glyph; a click selects it and its layer (⇧ adds), no popover; selected, it is blue", () => {
    const select = spy();
    const view = mount(Timeline, props({ onSelectSegments: select as unknown as TimelineProps["onSelectSegments"], selectedSegments: new Set(["k0"]) }));
    box($('[aria-label="Tracks"]', view.host), { left: 0, top: 0, width: 600, height: 200 });
    const seg = $('[data-segment="k2"]', view.host);
    expect($("[data-easing-glyph]", seg)).not.toBeNull();
    click(seg);
    expect(select.calls.at(-1)).toEqual([["k2"], "1:2", false]);
    expect($("[data-easing-editor]")).toBeNull();
    seg.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
    expect(select.calls.at(-1)).toEqual([["k0", "k2"], "1:2", true]);
    view.rerender(Timeline, props({ onSelectSegments: select as unknown as TimelineProps["onSelectSegments"], selectedSegments: new Set(["k2"]) }));
    expect($('[data-segment="k2"]', view.host).hasAttribute("data-segment-selected")).toBe(true);
    view.unmount();
  });
});

describe("the Easing page on the engine", () => {
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
    return { ed, engine };
  }
  const trackOf = (ed: EditorController) => ed.engine.motionTimeline(RED)!.layers.find((l) => l.node === RED)!.tracks.find((tr) => tr.keyframes.length > 2)!;
  function Page() {
    const segments = useEasingSegments([{ guid: RED }]);
    return segments.length ? createElement(EasingPage, { targets: segments }) : null;
  }
  let m: Mounted | null = null;
  afterEach(() => {
    m?.unmount();
    m = null;
  });
  const show = (ed: EditorController) => (m = mount(() => createElement(EditorContext.Provider, { value: ed }, createElement(Page)), {}));
  const easingOf = (ed: EditorController, id: string) => trackOf(ed).keyframes.find((k) => k.id === id)!.easing;
  // The engine stores the handles as float32.
  const rounded = (e: unknown) => JSON.parse(JSON.stringify(e, (_, v) => (typeof v === "number" ? Math.round(v * 1e4) / 1e4 : v)));

  it("presets: the select opens Figma's rows, a pick writes the segment's easing as one undo step; Flip, the Bezier field", async () => {
    const { ed, engine } = await editor();
    const k = trackOf(ed).keyframes[1];
    act(() => ed.engine.runMotionCommand("MOTION_SET_EASING", { ids: [k.id], easing: { type: "EASE_OUT_BACK" } }));
    act(() => setMotionUi(ed, { selectedSegments: [k.id] }));
    show(ed);
    expect($("[data-easing-page]")).not.toBeNull();
    click($("[data-easing-select]"));
    const rows = $$("[data-easing-presets] [data-easing]").map((e) => e.dataset.easing);
    expect(rows).toEqual(["HOLD", "LINEAR", "EASE_IN", "EASE_OUT", "EASE_IN_AND_OUT", "EASE_IN_BACK", "EASE_OUT_BACK", "EASE_IN_AND_OUT_BACK", "CUSTOM_CUBIC_BEZIER"]);
    const before = easingOf(ed, k.id);
    act(() => click($('[data-easing-presets] [data-easing="EASE_IN"]')));
    expect(easingOf(ed, k.id)).toEqual({ type: "EASE_IN" });
    expect($('[data-easing-presets] [data-easing="EASE_IN"]').getAttribute("aria-selected")).toBe("true");
    act(() => click($("[data-easing-flip]")));
    expect(easingOf(ed, k.id)).toEqual({ type: "EASE_OUT" });
    act(() => engine.undo());
    expect(easingOf(ed, k.id)).toEqual({ type: "EASE_IN" });
    act(() => engine.undo());
    expect(easingOf(ed, k.id)).toEqual(before);
    const field = $("[data-easing-bezier] input") as HTMLInputElement;
    focus(field);
    type(field, "0.45, 1.4, 0.8, 1");
    key(field, "Enter");
    expect(rounded(easingOf(ed, k.id))).toEqual({ type: "CUSTOM_CUBIC_BEZIER", easingFunctionCubicBezier: { x1: 0.45, y1: 1.4, x2: 0.8, y2: 1 } });
    expect($("[data-easing-select]").textContent).toBe("Custom bezier");
    // Back: the layer's sections again.
    act(() => click($("[data-easing-back]")));
    expect(motionUi(ed).selectedSegments).toEqual([]);
  });

  it("a handle dragged is one undo step and makes a custom bezier; Spring and Bounce; two segments edit together (Mixed)", async () => {
    const { ed, engine } = await editor();
    const [, k1, k2] = trackOf(ed).keyframes;
    act(() => ed.engine.runMotionCommand("MOTION_SET_EASING", { ids: [k1.id], easing: { type: "EASE_IN_AND_OUT" } }));
    act(() => setMotionUi(ed, { selectedSegments: [k1.id] }));
    show(ed);
    const graph = $("[data-easing-graph]");
    box(graph, { left: 0, top: 0, width: 208, height: 208 });
    const h1 = $('[data-handle="1"]', graph);
    act(() => pointer(h1, "pointerdown", { clientX: 94, clientY: 164 }));
    act(() => window.dispatchEvent(new MouseEvent("pointermove", { clientX: 74, clientY: 104 })));
    act(() => window.dispatchEvent(new MouseEvent("pointermove", { clientX: 68, clientY: 44 })));
    act(() => window.dispatchEvent(new MouseEvent("pointerup", {})));
    expect(rounded(easingOf(ed, k1.id))).toEqual({ type: "CUSTOM_CUBIC_BEZIER", easingFunctionCubicBezier: { x1: 0.2, y1: 1, x2: 0.58, y2: 1 } });
    act(() => engine.undo());
    expect(easingOf(ed, k1.id)).toEqual({ type: "EASE_IN_AND_OUT" });
    // Curve | Spring: a custom spring; Bounce writes it.
    act(() => click($$('[role="radio"]').find((r) => r.textContent === "Spring")!));
    expect(easingOf(ed, k1.id)).toMatchObject({ type: "CUSTOM_SPRING" });
    expect($("[data-easing-graph]").dataset.graphKind).toBe("spring");
    expect($("[data-easing-bounce]")).not.toBeNull();
    // Two segments with different easings: Mixed; a preset writes both.
    if (!k2) return;
    act(() => setMotionUi(ed, { selectedSegments: [k1.id, k2.id] }));
    expect($("[data-easing-select]").textContent).toBe("Mixed");
    act(() => click($("[data-easing-select]")));
    act(() => click($('[data-easing-presets] [data-easing="LINEAR"]')));
    expect([easingOf(ed, k1.id), easingOf(ed, k2.id)]).toEqual([{ type: "LINEAR" }, { type: "LINEAR" }]);
  });
});
