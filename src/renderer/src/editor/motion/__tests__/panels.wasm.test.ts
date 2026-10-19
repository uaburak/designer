// @vitest-environment happy-dom
// Motion mode's right panel on the real engine (the committed Wasm build, the Figma logo fixture): the panels read the
// values at the playhead (the store reads the nodes again when the playhead moves), Design's X / Y and Rotation typed in
// Motion mode land on the keyframe at the playhead (or move the base of a layer without a track), the diamonds beside
// Design's fields, ⌘C / ⌘V of keyframes at the playhead (round 8 increment 2, docs/motion.md §6.10).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Message } from "@/engine/codec";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import { loadEngine } from "@/engine/loadEngine";
import { $, click, mount, type Mounted } from "../../../ds/__tests__/dom";
import { groupChain } from "../../actions";
import { EditorContext, EditorController } from "../../controller";
import { setMode } from "../../devmode/devMode";
import { memoryDocumentSource } from "../../documentSource";
import { IDENTITY, panelPosition, rotateTo, rotationOf, withPanelPosition } from "../../model/geometry";
import type { PanelNode } from "../../panels/design/shared";
import MOTION_LOGO_DOCUMENT from "../fixtures/figma-logo-motion.json";
import { copySelectedKeyframes, pasteKeyframes, clearKeyframeCopy } from "../keyframeClipboard";
import { motionUi, setPlayhead } from "../motionState";
import { MotionField, MotionFieldStates } from "../panels/MotionField";
import { motionPerLayer } from "../panels/motionWrites";

const wasm = join(process.cwd(), "src/renderer/src/engine/wasm/engine.wasm");
const RED = "1:2";
const GREEN = "1:6";
const typed = { final: true, source: "type" } as const;

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
  const store = new EngineStore(engine);
  const ed = new EditorController(engine, store, source);
  engine.setSelection([RED]);
  setMode(ed, "motion");
  return { ed, engine, store };
}

// PositionSection's reads and writes (panels/design/Sections.tsx).
const xOf = (ed: EditorController) => (n: PanelNode) => panelPosition(n.transform ?? IDENTITY, groupChain(ed, n)).x;
const moveX = (ed: EditorController) => (n: PanelNode, v: number) => ({ transform: withPanelPosition(n.transform ?? IDENTITY, groupChain(ed, n), v, null) });
const turnOf = (n: PanelNode) => rotationOf(n.transform ?? IDENTITY);
const turnTo = (n: PanelNode, deg: number) => (n.size ? { transform: rotateTo(n.transform ?? IDENTITY, n.size, deg) } : null);
const shown = (ed: EditorController, ref: string) => ed.store.readNode(ref) as PanelNode;
const keyframesOf = (ed: EditorController, node: string, label: string) =>
  ed.engine.motionTimeline(node)!.layers.find((l) => l.node === node)!.tracks.find((tr) => tr.label === label)!.keyframes;

let m: Mounted | null = null;
afterEach(() => {
  m?.unmount();
  m = null;
  clearKeyframeCopy();
});

describe("Motion mode's panels on the engine", () => {
  it("the store reads the values at the playhead, and the base values once Motion is left", async () => {
    const { ed, engine } = await editor();
    // The logo fades in: Red is hidden at 0 and shown at 3000 ms (its opacity keyframes 0 → 1 over 0–500 ms).
    expect(shown(ed, RED).opacity).toBe(0);
    setPlayhead(ed, 3_000_000);
    expect(shown(ed, RED).opacity).toBe(1);
    expect(shown(ed, RED).transform).toEqual(engine.readNode(RED)!.transform);
    // Scaled up at 3000 ms (1 → 1.15 → 1 over 2600–3400 ms): the transform read is the motion layer's.
    expect(shown(ed, RED).transform!.m00).toBeGreaterThan(1);
    setMode(ed, "design");
    expect(shown(ed, RED).transform!.m00).toBe(1);
    engine.destroy();
  });

  it("an edit that re-applies the layer is read again: a keyframe added at the playhead shows its value", async () => {
    const { ed, engine } = await editor();
    setPlayhead(ed, 3_000_000);
    expect(shown(ed, RED).opacity).toBe(1);
    // Opacity typed in Motion mode: the engine routes it into a keyframe at the playhead (motionRouteWrite).
    ed.setProps([RED], { opacity: 0.5 }, "Opacity");
    expect(shown(ed, RED).opacity).toBeCloseTo(0.5);
    expect(keyframesOf(ed, RED, "Opacity").map((k) => k.timeUs)).toContain(3_000_000);
    engine.destroy();
  });

  it("X typed over the value shown moves the Position keyframe at the playhead by the difference", async () => {
    const { ed, engine } = await editor();
    setPlayhead(ed, 4_300_000);
    const before = xOf(ed)(shown(ed, RED));
    motionPerLayer(ed, "Position", [RED], xOf(ed), moveX(ed), "x", () => {}).onChange?.(before + 50, typed);
    expect(xOf(ed)(shown(ed, RED))).toBeCloseTo(before + 50, 3);
    const k = keyframesOf(ed, RED, "Position").find((kf) => kf.timeUs === 4_300_000)!;
    expect(k.value).toEqual({ type: "VECTOR", value: { x: expect.closeTo(50, 3), y: 0 } });
    // One undo step puts the track back.
    expect(ed.store.undo.undoLabel).toBe("Position");
    engine.undo();
    expect(keyframesOf(ed, RED, "Position").some((kf) => kf.timeUs === 4_300_000)).toBe(false);
    engine.destroy();
  });

  it("Rotation typed lands on the Rotation keyframe; a turn across ±180 takes the short way", async () => {
    const { ed, engine } = await editor();
    setPlayhead(ed, 4_300_000);
    const handlers = () => motionPerLayer(ed, "Rotate", [RED], turnOf, turnTo, "rotation", () => {});
    handlers().onChange?.(10, typed);
    expect(turnOf(shown(ed, RED))).toBeCloseTo(10, 3);
    expect(keyframesOf(ed, RED, "Rotation").find((kf) => kf.timeUs === 4_300_000)?.value).toEqual({ type: "FLOAT", value: expect.closeTo(10, 3) });
    // At 4600 ms Red is half way round (180°, shown −180): 170 typed is a turn of −10, not 350.
    setPlayhead(ed, 4_600_000);
    handlers().onChange?.(170, typed);
    expect(keyframesOf(ed, RED, "Rotation").find((kf) => kf.timeUs === 4_600_000)?.value).toEqual({ type: "FLOAT", value: expect.closeTo(170, 3) });
    engine.destroy();
  });

  it("a layer without a Position track moves its base by the difference (auto-keyframe off)", async () => {
    const { ed, engine } = await editor();
    engine.runMotionCommand("MOTION_DELETE_TRACKS", { node: RED, fields: [{ type: "PROPERTY", name: "TRANSLATION_XY" }] });
    setPlayhead(ed, 3_000_000);
    const before = xOf(ed)(shown(ed, RED));
    motionPerLayer(ed, "Position", [RED], xOf(ed), moveX(ed), "x", () => {}).onChange?.(before - 20, typed);
    expect(xOf(ed)(shown(ed, RED))).toBeCloseTo(before - 20, 3);
    expect(ed.engine.motionFieldStates([RED])[RED]?.TRANSLATION_XY?.state ?? "none").toBe("none");
    engine.destroy();
  });

  it("a diamond beside a Design field shows the track and adds the keyframe at the playhead", async () => {
    const { ed, engine } = await editor();
    setPlayhead(ed, 3_000_000);
    const Harness = () =>
      createElement(MotionFieldStates, { nodes: [shown(ed, RED)], children: createElement(MotionField, { field: "ROTATION", children: createElement("input", { "aria-label": "Rotation" }) }) });
    m = mount(() => createElement(EditorContext.Provider, { value: ed }, createElement(Harness)), {});
    const field = $("[data-motion-field]", m.host);
    expect(field.dataset.motionField).toBe("ROTATION");
    expect(field.dataset.state).toBe("track");
    click($("button", field));
    expect(keyframesOf(ed, RED, "Rotation").map((k) => k.timeUs)).toContain(3_000_000);
    expect($("[data-motion-field]", m.host).dataset.state).toBe("keyframe");
    engine.destroy();
  });

  it("keyframes copied and pasted at the playhead onto the selected layer, as one undo step", async () => {
    const { ed, engine } = await editor();
    const green = engine.motionTimeline(GREEN)!.layers.find((l) => l.node === GREEN)!;
    const opacity = green.tracks.find((tr) => tr.label === "Opacity")!;
    expect(copySelectedKeyframes(engine.motionTimeline(), opacity.keyframes.slice(0, 2).map((k) => k.id))).toBe(true);
    setPlayhead(ed, 3_000_000);
    expect(motionUi(ed).timeUs).toBe(3_000_000);
    expect(pasteKeyframes(ed, engine.motionTimeline())).toBe(true);
    // Green's two keyframes (600 and 1100 ms, 0 → 1) on Red at 3000 and 3500 ms.
    const red = keyframesOf(ed, RED, "Opacity");
    expect(red.filter((k) => k.timeUs === 3_000_000 || k.timeUs === 3_500_000).map((k) => k.value)).toEqual([
      { type: "FLOAT", value: 0 },
      { type: "FLOAT", value: 1 },
    ]);
    expect(ed.store.undo.undoLabel).toBe("Paste keyframes");
    engine.undo();
    expect(keyframesOf(ed, RED, "Opacity").some((k) => k.timeUs === 3_500_000)).toBe(false);
    engine.destroy();
  });
});
