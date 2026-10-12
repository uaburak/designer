// @vitest-environment happy-dom
// The image's secondary toolbar on the real engine (docs/ai.md §4): it shows for a selected image with Figma's tools
// (Edit with prompt, Remove background, Select area, More ▾ Expand / Boost resolution / Vectorize); Vectorize's UI
// flow — More › Vectorize, the live preview, a mode and its setting changed (debounced), ✓ as one undo step;
// Select area's Erase / Isolate waiting for a lasso, Esc closing; Actions' image rows registered.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, createElement } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import { loadEngine } from "@/engine/loadEngine";
import { SAMPLE_DOCUMENT } from "@/engine/sampleDocument";
import { mount } from "@/ds/__tests__/dom";
import { EditorContext, EditorController } from "../../controller";
import { memoryDocumentSource } from "../../documentSource";
import { imageRowHandler } from "../../ai/actionRows";
import { imageToolsOf } from "../controller";
import { ImageToolbar } from "../ImageToolbar";

const wasm = resolve(process.cwd(), "src/renderer/src/engine/wasm/engine.wasm");

beforeAll(async () => {
  globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch;
  const bytes = readFileSync(wasm);
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
});

const HASH = "ab".repeat(20);

async function setup() {
  const source = memoryDocumentSource(SAMPLE_DOCUMENT, { fileName: "Toolbar" });
  const engine = await Engine.create(null, { sessionID: 1 });
  engine.load(await source.load());
  engine.setViewport(1280, 800, 1, 1280, 800);
  const ed = new EditorController(engine, new EngineStore(engine), source);
  engine.setProps(["1:5"], { fillPaints: [{ type: "IMAGE", image: { hash: HASH.match(/../g)!.map((h) => parseInt(h, 16)) }, imageScaleMode: "FILL", opacity: 1, visible: true, blendMode: "NORMAL", transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 }, originalImageWidth: 4, originalImageHeight: 2 }] as never });
  // Two colours, as the engine will draw the picture.
  const rgba = new Uint8Array(4 * 2 * 4);
  for (let i = 0; i < 8; i++) rgba.set(i % 4 < 2 ? [220, 20, 20, 255] : [20, 20, 220, 255], i * 4);
  engine.addImageRgba(HASH, 4, 2, rgba);
  const tools = imageToolsOf(ed);
  const recorded: string[] = [];
  tools.hooks = { api: null, checkCredits: async () => {}, record: (e) => recorded.push(e.action), confirmDownload: async () => false };
  const labels: string[] = [];
  engine.onAny((e) => {
    if (e.type === "DOCUMENT_CHANGED") labels.push(e.label);
  });
  const view = mount(() => createElement(EditorContext.Provider, { value: ed }, createElement(ImageToolbar)), {});
  return { ed, engine, tools, view, labels, recorded };
}

const toolbar = () => document.querySelector<HTMLElement>("[data-image-toolbar]");
const button = (label: string) => [...document.querySelectorAll<HTMLElement>("button, [role=menuitem], [role=menuitemradio]")].find((b) => b.getAttribute("aria-label") === label || b.textContent?.trim() === label) ?? null;
const click = (el: Element | null) => act(() => (el as HTMLElement).click());

describe("the image toolbar", () => {
  it("shows Figma's tools for a selected image only", async () => {
    const { engine, view } = await setup();
    expect(toolbar()).toBeNull();
    act(() => void engine.setSelection(["1:6"]));
    expect(toolbar()).toBeNull();
    act(() => void engine.setSelection(["1:5"]));
    expect(toolbar()).not.toBeNull();
    expect([...toolbar()!.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"))).toEqual(["Edit with prompt", "Remove background", "Select area", "More"]);
    click(button("More"));
    expect(["Expand", "Boost resolution", "Vectorize"].every((l) => button(l))).toBe(true);
    view.unmount();
    engine.destroy();
  });

  it("Vectorize: More › Vectorize previews, a mode and its setting update after 120 ms, ✓ is one undo step", async () => {
    const { engine, tools, view, labels, recorded } = await setup();
    act(() => void engine.setSelection(["1:5"]));
    const update = vi.spyOn(engine, "vectorizeUpdate");
    click(button("More"));
    await act(async () => {
      button("Vectorize")!.click();
      await vi.waitFor(() => expect(tools.state.get().vectorize).not.toBeNull());
    });
    expect(toolbar()!.dataset.imageToolbar).toBe("vectorize");
    expect(update).toHaveBeenCalledTimes(1);
    expect(labels).toEqual([]);
    click(button("Grayscale"));
    const range = toolbar()!.querySelector<HTMLInputElement>('input[type="range"]')!;
    expect(range.getAttribute("aria-label")).toBe("Number of grays");
    await vi.waitFor(() => expect(update).toHaveBeenLastCalledWith({ mode: "GRAYSCALE", grays: 4 }));
    click(button("Apply"));
    expect(labels).toEqual(["Vectorize"]);
    expect(engine.readNode("1:5")).toBeNull();
    expect(recorded).toEqual(["vectorize"]);
    expect(tools.state.get().mode).toBeNull();
    act(() => void engine.undo());
    expect(engine.readNode("1:5")).not.toBeNull();
    view.unmount();
    engine.destroy();
  });

  it("Vectorize's ✕ leaves nothing in the history", async () => {
    const { engine, tools, view, labels } = await setup();
    act(() => void engine.setSelection(["1:5"]));
    click(button("More"));
    await act(async () => {
      button("Vectorize")!.click();
      await vi.waitFor(() => expect(tools.state.get().vectorize).not.toBeNull());
    });
    click(button("Cancel"));
    expect(labels).toEqual([]);
    expect(engine.readNode("1:5")).not.toBeNull();
    view.unmount();
    engine.destroy();
  });

  it("Select area: Erase and Isolate wait for a lasso; Esc closes", async () => {
    const { engine, tools, view } = await setup();
    act(() => void engine.setSelection(["1:5"]));
    click(button("Select area"));
    expect(toolbar()!.dataset.imageToolbar).toBe("select-area");
    expect(button("Erase")!.getAttribute("aria-disabled")).toBe("true");
    act(() => tools.state.set({ lasso: [{ x: 1, y: 1 }, { x: 50, y: 1 }, { x: 50, y: 50 }] }));
    expect(button("Erase")!.getAttribute("aria-disabled")).toBeNull();
    act(() => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(tools.state.get().mode).toBeNull();
    view.unmount();
    engine.destroy();
  });

  it("registers Actions' Image editing rows", async () => {
    const { ed, engine, view } = await setup();
    act(() => void engine.setSelection(["1:5"]));
    for (const a of ["make-image", "remove-background", "boost-resolution", "edit-image"] as const) expect(imageRowHandler(a)).toBeTruthy();
    expect(imageRowHandler("remove-background")!.enabled!(ed)).toBe(true);
    act(() => imageRowHandler("edit-image")!.run(ed));
    expect(document.querySelector("[data-image-prompt=edit]")).not.toBeNull();
    act(() => void engine.setSelection(["1:6"]));
    expect(imageRowHandler("remove-background")!.enabled!(ed)).toBe(false);
    view.unmount();
    engine.destroy();
  });
});
