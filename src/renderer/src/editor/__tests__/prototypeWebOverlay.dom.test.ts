// @vitest-environment happy-dom
// Prototype › Overlay's Wecra-only rows for the presentation's Website behaviours (docs/engine.md §3.4): "Keep in
// window" for a Manual overlay (NodeChange.overlayEdgeBehavior, absent = on) and "Stack overlays" with its gap and max
// for one at a top or bottom position (NodeChange.overlayStack), on the real engine (headless Wasm).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, createElement } from "react";
import { beforeAll, describe, expect, it } from "vitest";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import { loadEngine } from "@/engine/loadEngine";
import { mount } from "@/ds/__tests__/dom";
import { EditorContext, EditorController } from "../controller";
import { memoryDocumentSource } from "../documentSource";
import { PROTOTYPE_DOCUMENT } from "../fixtures";
import { InteractionDetails } from "../panels/prototype/InteractionDetails";
import { protoFields } from "../panels/prototype/PrototypePanel";

const wasm = resolve(process.cwd(), "src/renderer/src/engine/wasm/engine.wasm");

beforeAll(async () => {
  globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch;
  const bytes = readFileSync(wasm);
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
});

// The fixture's "Menu button" (2:5) opens the overlay "Menu" (2:20, Bottom center).
const BUTTON = "2:5";
const MENU = "2:20";

async function setup() {
  const source = memoryDocumentSource(PROTOTYPE_DOCUMENT, { fileName: "Prototype" });
  const engine = await Engine.create(null, { sessionID: 1 });
  engine.load(await source.load());
  const ed = new EditorController(engine, new EngineStore(engine), source);
  const Details = () => createElement(EditorContext.Provider, { value: ed }, createElement(InteractionDetails, { node: BUTTON, index: 0, anchor: null, onClose: () => {} }));
  const view = mount(Details, {});
  return { ed, engine, view };
}

const checkbox = (label: string) =>
  [...document.querySelectorAll<HTMLLabelElement>("label[data-ds='Checkbox']")].find((l) => l.textContent === label)?.querySelector("input") ?? null;
const menu = (engine: Engine) => engine.readNode(MENU) as { overlayEdgeBehavior?: string; overlayStack?: { gap?: number; max?: number } };

describe("Prototype › Overlay: Website behaviours' rows", () => {
  it("Stack overlays at a bottom position: on with a gap and a max, off again", async () => {
    const { engine, view } = await setup();
    expect(checkbox("Keep in window")).toBeNull(); // Manual only
    const stack = checkbox("Stack overlays");
    expect(stack).not.toBeNull();
    expect(stack!.checked).toBe(false);
    expect(document.querySelector("[data-overlay-stack]")).toBeNull();
    act(() => stack!.click());
    expect(menu(engine).overlayStack).toEqual({ gap: 8, max: 3 });
    const row = document.querySelector("[data-overlay-stack]");
    expect(row).not.toBeNull();
    expect(row!.querySelectorAll("input")).toHaveLength(2);
    act(() => checkbox("Stack overlays")!.click());
    expect(menu(engine).overlayStack).toBeUndefined();
    view.unmount();
    engine.destroy();
  });

  it("Keep in window for a Manual overlay: on by default, off writes NONE, on again clears it", async () => {
    const { engine, view } = await setup();
    act(() => void engine.setProps([MENU], protoFields({ overlayPositionType: "MANUAL" })));
    expect(checkbox("Stack overlays")).toBeNull(); // preset positions only
    const keep = checkbox("Keep in window");
    expect(keep).not.toBeNull();
    expect(keep!.checked).toBe(true);
    act(() => keep!.click());
    expect(menu(engine).overlayEdgeBehavior).toBe("NONE");
    expect(checkbox("Keep in window")!.checked).toBe(false);
    act(() => checkbox("Keep in window")!.click());
    expect(menu(engine).overlayEdgeBehavior).toBeUndefined();
    view.unmount();
    engine.destroy();
  });
});
