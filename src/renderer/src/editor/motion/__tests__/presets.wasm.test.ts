// @vitest-environment happy-dom
// The Animations section on the real engine (the committed Wasm build, the Figma logo fixture; round 8h, docs/motion.md
// §4.6, §6.5): + adds a preset at the playhead as one "Add animation" step, its row opens its settings, a setting
// changed runs the preset's code again, the eye turns the clip off, remove takes it; the composite styles stack their
// presets under one style, which Detach forgets.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement } from "react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Message } from "@/engine/codec";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import { loadEngine } from "@/engine/loadEngine";
import { $, $$, click, mount, type Mounted } from "../../../ds/__tests__/dom";
import { EditorContext, EditorController } from "../../controller";
import { setMode } from "../../devmode/devMode";
import { memoryDocumentSource } from "../../documentSource";
import type { PanelNode } from "../../panels/design/shared";
import MOTION_LOGO_DOCUMENT from "../fixtures/figma-logo-motion.json";
import { motionUi, setPlayhead } from "../motionState";
import { AnimationsSection } from "../panels/AnimationsSection";
import { clipProps, editPreset } from "../presets";

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
  setMode(ed, "motion");
  return { ed, engine, store };
}

const clipsOf = (ed: EditorController) => ed.engine.motionTimeline(RED)!.layers.find((l) => l.node === RED)!.clips;
const menuItem = (label: string) => $$('[role="menuitem"]').find((r) => r.textContent?.includes(label))!;

let m: Mounted | null = null;
afterEach(() => {
  m?.unmount();
  m = null;
});

function section(ed: EditorController) {
  const node = ed.store.readNode(RED) as PanelNode;
  m = mount(() => createElement(EditorContext.Provider, { value: ed }, createElement(AnimationsSection, { nodes: [node] })), {});
  return m;
}

describe("the Animations section on the engine", () => {
  it("+ adds a preset at the playhead in one step; its row opens its settings; a setting runs the code again", async () => {
    const { ed, engine } = await editor();
    setPlayhead(ed, 1_000_000);
    const view = section(ed);
    expect($$("[data-clip-row]", view.host)).toHaveLength(0);
    act(() => click($('[aria-label="Add animation"]', view.host)));
    // Path needs strokes and the text presets a text layer: not offered to Red.
    expect(menuItem("Text stagger").getAttribute("aria-disabled")).toBe("true");
    act(() => click(menuItem("Opacity")));
    const [clip] = clipsOf(ed);
    expect(clip).toMatchObject({ preset: "opacity", startUs: 1_000_000, durationUs: 500_000, easing: { type: "EASE_OUT" }, disabled: false });
    expect(clipProps(clip)).toEqual({ type: "fadeIn", amount: 0, start: 0, end: 100 });
    expect(ed.store.undo.undoLabel).toBe("Add animation");
    // The new clip is selected: its row and its settings show.
    expect(motionUi(ed).selectedClip).toBe(clip.id);
    expect($(`[data-clip-row="${clip.id}"]`, view.host).textContent).toContain("Opacity");
    expect($(`[data-clip-settings="${clip.id}"]`, view.host)).not.toBeNull();
    // Fade out instead: the code runs again (one step), the clip's track follows.
    act(() => void editPreset(ed, clip, { props: { type: "fadeOut" } }));
    const after = clipsOf(ed)[0];
    expect(clipProps(after).type).toBe("fadeOut");
    expect(ed.store.undo.undoLabel).toBe("Edit animation");
    // The eye turns it off; remove takes it.
    act(() => click($(`[data-clip-row="${clip.id}"] [aria-label="Toggle visibility"]`, view.host)));
    expect(clipsOf(ed)[0].disabled).toBe(true);
    act(() => click($(`[data-clip-row="${clip.id}"] [aria-label="Remove animation"]`, view.host)));
    expect(clipsOf(ed)).toHaveLength(0);
    engine.undo();
    expect(clipsOf(ed)).toHaveLength(1);
    engine.destroy();
  });

  it("a composite style stacks its presets under one style; Detach forgets the style, keeps the presets", async () => {
    const { ed, engine } = await editor();
    const view = section(ed);
    act(() => click($('[aria-label="Animation styles"]', view.host)));
    expect(menuItem("Text enter")).toBeUndefined(); // text styles only for text layers
    act(() => click(menuItem("Slide in")));
    const clips = clipsOf(ed);
    expect(clips.map((c) => c.preset)).toEqual(["position", "opacity"]);
    expect(clips.every((c) => c.style?.key === "slideIn")).toBe(true);
    expect(ed.store.undo.undoLabel).toBe("Apply animation style");
    act(() => click($(`[data-clip-row="${clips[0].id}"] [aria-label="Detach animation style"]`, view.host)));
    expect(clipsOf(ed).map((c) => c.style)).toEqual([undefined, undefined]);
    expect(clipsOf(ed)).toHaveLength(2);
    engine.destroy();
  });
});
