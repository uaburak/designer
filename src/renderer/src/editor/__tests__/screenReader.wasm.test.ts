// @vitest-environment happy-dom
// The canvas's screen reader mirror (atlas 21 §6) on the real engine: off by default; on, a hidden tree of the page's
// layers named and kinded, the selection marked and said in a live region, a row's Enter selecting its layer.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement } from "react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import { loadEngine } from "@/engine/loadEngine";
import { SAMPLE_DOCUMENT } from "@/engine/sampleDocument";
import { $, $$, mount, type Mounted } from "../../ds/__tests__/dom";
import { EditorContext, EditorController } from "../controller";
import { memoryDocumentSource } from "../documentSource";
import { ScreenReaderMirror } from "../canvas/ScreenReaderMirror";

const wasm = join(process.cwd(), "src/renderer/src/engine/wasm/engine.wasm");

beforeAll(async () => {
  globalThis.fetch = async () => new Response(null, { status: 404 });
  const bytes = readFileSync(wasm);
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
});

async function editor() {
  const source = memoryDocumentSource(SAMPLE_DOCUMENT, { fileName: "Test" });
  const engine = await Engine.create(null, { sessionID: 1 });
  engine.load(await source.load());
  engine.setViewport(1280, 800, 1, 1280, 800);
  const store = new EngineStore(engine);
  return { ed: new EditorController(engine, store, source), engine };
}

let m: Mounted | null = null;
afterEach(() => {
  m?.unmount();
  m = null;
});

describe("the screen reader's mirror of the canvas", () => {
  it("is there only with Screen reader on: the layers, the selection marked and said", async () => {
    const { ed, engine } = await editor();
    m = mount(() => createElement(EditorContext.Provider, { value: ed }, createElement(ScreenReaderMirror)), {});
    expect($("[data-screen-reader-mirror]", m.host)).toBeNull();
    await act(async () => ed.ui.set({ screenReader: true } as never));
    const rows = $$('[role="treeitem"]', m.host);
    expect(rows.length).toBeGreaterThan(0);
    const first = rows[0];
    expect(first.getAttribute("aria-label")).toMatch(/, (Frame|Auto layout|Rectangle|Text|Group|Section|Component)/);
    expect($('[role="status"]', m.host)!.textContent).toBe("Nothing selected");
    const id = first.getAttribute("data-layer")!;
    await act(async () => first.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(engine.getSelection().refs).toEqual([id]);
    expect($(`[data-layer="${id}"]`, m.host)!.getAttribute("aria-selected")).toBe("true");
    expect($('[role="status"]', m.host)!.textContent).toMatch(/, selected$/);
  });
});
