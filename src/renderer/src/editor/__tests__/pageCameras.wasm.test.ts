// @vitest-environment happy-dom
// Each page opens where it was left (pageCameras.ts): a page's camera comes back when it is shown again, a page shown
// for the first time is zoomed to fit its content, an empty one shows its origin at 100 %; a caller that places the
// camera after switching wins. View › Rulers: on for a file without a kept choice, the user's choice is kept.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { Message, NodeChange } from "@/engine/codec";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import { loadEngine } from "@/engine/loadEngine";
import { SAMPLE_DOCUMENT } from "@/engine/sampleDocument";
import { EditorController } from "../controller";
import { memoryDocumentSource, type EditorUiState } from "../documentSource";
import { attachPageCameras } from "../pageCameras";
import { attachPersistence, restoreViewOptions } from "../persistence";

const wasm = join(process.cwd(), "src/renderer/src/engine/wasm/engine.wasm");

beforeAll(async () => {
  globalThis.fetch = async () => new Response(null, { status: 404 });
  const bytes = readFileSync(wasm);
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
});

const page = (guid: string, name: string, position: string): NodeChange => ({ guid, phase: "CREATED", type: "CANVAS", name, parentIndex: { guid: "0:0", position } });
// "Buttons": one rectangle far from the origin; "Empty": nothing on it.
const DOC: Message = {
  ...SAMPLE_DOCUMENT,
  nodeChanges: [
    ...SAMPLE_DOCUMENT.nodeChanges,
    page("5:1", "Buttons", "\""),
    page("5:2", "Empty", "#"),
    {
      guid: "5:3",
      phase: "CREATED",
      type: "ROUNDED_RECTANGLE",
      name: "Far",
      parentIndex: { guid: "5:1", position: "!" },
      size: { x: 200, y: 100 },
      transform: { m00: 1, m01: 0, m02: -7500, m10: 0, m11: 1, m12: -1500 },
      fillPaints: [],
    },
  ],
};

async function editor(uiState?: EditorUiState) {
  const source = memoryDocumentSource(DOC, { fileName: "Pages", uiState });
  const engine = await Engine.create(null, { sessionID: 1 });
  engine.load(await source.load());
  engine.setViewport(1280, 800, 1, 1280, 800);
  engine.setCurrentPage("0:1");
  const ed = new EditorController(engine, new EngineStore(engine), source);
  return { ed, engine, source };
}

describe("each page keeps its own camera", () => {
  it("a page shown for the first time is fitted; going back puts the previous page's camera back", async () => {
    const { ed, engine } = await editor();
    engine.setCamera({ x: 100, y: 50, zoom: 2 });
    const off = attachPageCameras(ed);

    engine.setCurrentPage("5:1");
    const fitted = engine.getCamera();
    // The far rectangle is in view (its middle at the viewport's middle), not the first page's spot.
    const mid = { x: (-7500 + 100) * fitted.zoom + fitted.x, y: (-1500 + 50) * fitted.zoom + fitted.y };
    expect(Math.abs(mid.x - 640)).toBeLessThan(2);
    expect(Math.abs(mid.y - 400)).toBeLessThan(2);

    // Moved on Buttons, then back to Page 1: Page 1's camera as it was left.
    engine.setCamera({ x: 3000, y: 900, zoom: 0.5 });
    engine.setCurrentPage("0:1");
    expect(engine.getCamera()).toEqual({ x: 100, y: 50, zoom: 2 });

    // And Buttons again: where it was left, not fitted again.
    engine.setCurrentPage("5:1");
    expect(engine.getCamera()).toEqual({ x: 3000, y: 900, zoom: 0.5 });
    off();
    engine.destroy();
  });

  it("an empty page shows its origin at 100 %", async () => {
    const { ed, engine } = await editor();
    engine.setCamera({ x: -4000, y: 700, zoom: 3 });
    const off = attachPageCameras(ed);
    engine.setCurrentPage("5:2");
    expect(engine.getCamera()).toEqual({ x: 0, y: 0, zoom: 1 });
    off();
    engine.destroy();
  });

  it("a caller that places the camera right after switching wins (Find, comments, links)", async () => {
    const { ed, engine } = await editor();
    const off = attachPageCameras(ed);
    engine.setCurrentPage("5:1");
    engine.setCamera({ x: 7, y: 8, zoom: 4 });
    expect(engine.getCamera()).toEqual({ x: 7, y: 8, zoom: 4 });
    engine.setCurrentPage("0:1");
    engine.setCurrentPage("5:1");
    expect(engine.getCamera()).toEqual({ x: 7, y: 8, zoom: 4 });
    off();
    engine.destroy();
  });
});

describe("View › Rulers", () => {
  const ui = (rulers?: boolean): EditorUiState => ({ currentPageId: null, pages: {}, leftPanelWidth: 240, rightPanelWidth: 240, ...(rulers === undefined ? {} : { rulers }) });

  it("are on for a file without a kept choice, and the default is not written as the file's choice", async () => {
    const { ed, engine, source } = await editor(ui());
    const writes: Partial<EditorUiState>[] = [];
    (source as { setUiState?: (p: Partial<EditorUiState>) => void }).setUiState = (p) => void writes.push(p);
    restoreViewOptions(ed);
    expect(ed.ui.get().rulers).toBe(true);
    const off = attachPersistence(ed);
    expect(writes.some((w) => "rulers" in w)).toBe(false);
    // The user turns them off: the file keeps it.
    ed.ui.set({ rulers: false });
    expect(writes.at(-1)).toEqual({ rulers: false });
    off();
    engine.destroy();
  });

  it("a file's kept choice stays", async () => {
    const { ed, engine } = await editor(ui(false));
    restoreViewOptions(ed);
    expect(ed.ui.get().rulers).toBe(false);
    engine.destroy();
  });
});
