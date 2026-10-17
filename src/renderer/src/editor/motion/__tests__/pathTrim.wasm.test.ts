// @vitest-environment happy-dom
// Round 8a increment 2 on the real engine (the committed Wasm build, the Figma logo fixture; docs/motion.md §5.3): the
// Path trim section writes the design's path trim, or — once the field has a track — the keyframe at the playhead (the
// engine routes the write); Edit anchor point turns the engine's anchor point tool on and off, in Motion only.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Message } from "@/engine/codec";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import { loadEngine } from "@/engine/loadEngine";
import { $, $$, click, focus, key, mount, type, type Mounted } from "../../../ds/__tests__/dom";
import { isEnabled, command, runEditorCommand } from "../../commands";
import { EditorContext, EditorController } from "../../controller";
import { setMode } from "../../devmode/devMode";
import { memoryDocumentSource } from "../../documentSource";
import type { PanelNode } from "../../panels/design/shared";
import MOTION_LOGO_DOCUMENT from "../fixtures/figma-logo-motion.json";
import { setPlayhead } from "../motionState";
import { MotionFieldStates } from "../panels/MotionField";
import { PathTrimSection } from "../panels/PathTrimSection";

const wasm = join(process.cwd(), "src/renderer/src/engine/wasm/engine.wasm");
const RED = "1:2";

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
  return { ed, engine, store };
}

const shown = (ed: EditorController, ref: string) => ed.store.readNode(ref) as PanelNode;
const trimEnd = (ed: EditorController) => shown(ed, RED).pathTrim?.value?.y ?? 1;

let m: Mounted | null = null;
afterEach(() => {
  m?.unmount();
  m = null;
});

function mountSection(ed: EditorController) {
  const Harness = () => {
    const nodes = [shown(ed, RED)];
    return createElement(MotionFieldStates, { nodes, children: createElement(PathTrimSection, { nodes }) });
  };
  m = mount(() => createElement(EditorContext.Provider, { value: ed }, createElement(Harness)), {});
  return m;
}

describe("Motion's round 8a increment 2 on the engine", () => {
  it("Path trim: the design's value without a track, the keyframe at the playhead with one; Design shows the design's", async () => {
    const { ed, engine } = await editor();
    // Red strokes, centred (in Design: the base).
    ed.setProps([RED], { strokePaints: [{ type: "SOLID", color: { r: 0, g: 0, b: 0, a: 1 }, opacity: 1, visible: true }], strokeWeight: 4, strokeAlign: "CENTER" }, "Stroke");
    setMode(ed, "motion");
    setPlayhead(ed, 3_000_000);
    let view = mountSection(ed);
    expect($("[data-path-trim]", view.host)).not.toBeNull();
    expect(view.host.textContent).not.toContain("only applies to center strokes");
    // No track: the typed end is the design's path trim.
    const endInput = () => $('input[aria-label="Path trim end"]', m!.host) as HTMLInputElement;
    focus(endInput());
    type(endInput(), "50");
    key(endInput(), "Enter");
    expect(trimEnd(ed)).toBeCloseTo(0.5);
    const endField = () => $('[data-motion-field="PATH_TRIM_END"]', m!.host);
    expect(endField().dataset.state).toBe("none");
    // The diamond keys the end at 3000 ms (its value there: 0.5); at 3500 ms a typed 25 % is a second keyframe.
    click($("button", endField()));
    expect(endField().dataset.state).toBe("keyframe");
    setPlayhead(ed, 3_500_000);
    view.unmount();
    view = mountSection(ed);
    focus(endInput());
    type(endInput(), "25");
    key(endInput(), "Enter");
    expect(trimEnd(ed)).toBeCloseTo(0.25);
    const keys = ed.engine.motionTimeline(RED)!.layers.find((l) => l.node === RED)!.tracks.find((tr) => tr.field.type === "PROPERTY" && tr.field.name === "PATH_TRIM_END")!.keyframes;
    expect(keys.map((k) => k.timeUs)).toEqual([3_000_000, 3_500_000]);
    expect(keys.map((k) => k.value)).toEqual([{ type: "FLOAT", value: 0.5 }, { type: "FLOAT", value: expect.closeTo(0.25, 6) }]);
    // Design shows the design: the end typed without a track.
    setMode(ed, "design");
    expect(trimEnd(ed)).toBeCloseTo(0.5);
    // An inside stroke: the section says the trim doesn't apply.
    setMode(ed, "motion");
    ed.setProps([RED], { strokeAlign: "INSIDE" }, "Stroke position");
    view.unmount();
    view = mountSection(ed);
    expect(view.host.textContent).toContain("Path trim only applies to center strokes.");
    expect($$("[data-motion-field]", view.host)).toHaveLength(2);
    engine.destroy();
  });

  it("Edit anchor point: the anchor point tool, on and off; not outside Motion", async () => {
    const { ed, engine } = await editor();
    expect(isEnabled(ed, command("motion.anchor-point"))).toBe(false);
    setMode(ed, "motion");
    expect(isEnabled(ed, command("motion.anchor-point"))).toBe(true);
    runEditorCommand(ed, "motion.anchor-point");
    expect(ed.store.tool).toBe("ANCHOR_POINT");
    // ⌥R in Motion is the same command.
    runEditorCommand(ed, "object.rotation-origin");
    expect(ed.store.tool).toBe("MOVE");
    runEditorCommand(ed, "motion.anchor-point");
    setMode(ed, "design");
    expect(ed.store.tool).toBe("MOVE");  // leaving Motion puts Move back
    engine.destroy();
  });
});
