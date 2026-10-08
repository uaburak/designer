// @vitest-environment happy-dom
// Export on the real engine (the committed Wasm build, headless): export settings written from the panel and read back,
// the engine's export list and exports (SVG, PDF, PNG pixels, sizes), the Design panel's Export section and the Export
// dialog (⇧⌘E) mounted on the controller, the commands' wiring.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement, useState } from "react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import { loadEngine } from "@/engine/loadEngine";
import { SAMPLE_DOCUMENT } from "@/engine/sampleDocument";
import { $, $$, click, mount, type Mounted } from "../../ds/__tests__/dom";
import { COMMAND_BY_ID, isEnabled } from "../commands";
import { EditorContext, EditorController } from "../controller";
import { memoryDocumentSource } from "../documentSource";
import { ExportDialog } from "../ExportDialog";
import { pageFrames, selectionText } from "../exporting";
import { useNodes } from "../hooks";
import { exportSettingsOf, nextExportSetting } from "../model/exports";
import { ExportSection, type ExportTarget } from "../panels/design/Export";

const wasm = join(process.cwd(), "src/renderer/src/engine/wasm/engine.wasm");

beforeAll(async () => {
  // happy-dom's page is http://localhost:3000: the bundled fonts' fetch has nowhere to go (no fonts are needed here).
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
  const ed = new EditorController(engine, store, source);
  return { ed, engine };
}

let m: Mounted | null = null;
afterEach(() => {
  m?.unmount();
  m = null;
});

describe("export on the engine", () => {
  it("export settings are kept by the engine, read back, and listed for the Export dialog", async () => {
    const { ed, engine } = await editor();
    const settings = [nextExportSetting([]), { ...nextExportSetting([nextExportSetting([])]), imageType: "SVG" as const }];
    ed.setProps(["1:5"], { exportSettings: settings } as never, "Add export settings");
    const read = exportSettingsOf(engine.readNode("1:5") as { exportSettings?: unknown });
    expect(read.length).toBe(2);
    expect(read[0].constraint).toEqual({ type: "CONTENT_SCALE", value: 1 });
    expect(read[1].imageType).toBe("SVG");
    expect(read[1].suffix).toBe("@2x");
    const list = engine.exportList();
    expect(list.map((e) => e.guid)).toEqual(["1:5"]);
    expect(list[0].name).toBe("Card");
    expect(list[0].exportSettings.length).toBe(2);
    engine.undo();
    expect(engine.exportList()).toEqual([]);
  });

  it("exports SVG, PDF and PNG pixels at the asked size", async () => {
    const { engine } = await editor();
    const svg = engine.exportNodes(["1:5"], { imageType: "SVG" });
    expect(svg.status).toBe("ok");
    const text = new TextDecoder().decode((svg as { bytes: Uint8Array }).bytes);
    expect(text).toMatch(/^<svg width="280" height="160" viewBox="0 0 280 160" fill="none" xmlns="http:\/\/www.w3.org\/2000\/svg">/);
    expect(text).toContain('rx="12"');
    const pdf = engine.exportNodes(["1:1", "1:10"], { imageType: "PDF" });
    expect(pdf.status).toBe("ok");
    const pdfText = new TextDecoder("latin1").decode((pdf as { bytes: Uint8Array }).bytes);
    expect(pdfText.startsWith("%PDF-1.7")).toBe(true);
    expect(pdfText).toContain("/Count 2");
    const png = engine.exportNodes(["1:1"], { imageType: "PNG", constraint: { type: "CONTENT_WIDTH", value: 320 } });
    expect(png.status).toBe("ok");
    const px = (png as { pixels: { width: number; height: number } }).pixels;
    expect([px.width, px.height]).toEqual([320, 210]);
    const info = engine.exportInfo(["1:1"], { imageType: "PNG", constraint: { type: "CONTENT_SCALE", value: 2 } });
    expect(info?.targets[0]).toMatchObject({ ref: "1:1", width: 1280, height: 840 });
    const missing = engine.exportNodes(["9:9"], { imageType: "PNG" });
    expect(missing.status).toBe("error");
  });

  it("the Export section: '+' adds Figma's rows, the scale and format change, minus removes; the button names the layer", async () => {
    const { ed } = await editor();
    function Harness() {
      const [node] = useNodes(["1:5"]);
      return node ? createElement(ExportSection, { targets: [node as ExportTarget], page: false }) : null;
    }
    m = mount(() => createElement(EditorContext.Provider, { value: ed }, createElement(Harness)), {});
    const add = $('[aria-label="Add export settings"]', m.host);
    click(add);
    click(add);
    click(add);
    const rows = $$("[data-export-row]", m.host);
    expect(rows.length).toBe(3);
    const scales = $$('[data-export-row] input', m.host).map((i) => (i as HTMLInputElement).value);
    expect(scales).toEqual(["1x", "2x", "3x"]);
    expect(exportSettingsOf(ed.engine.readNode("1:5") as { exportSettings?: unknown }).map((s) => s.suffix)).toEqual(["", "@2x", "@3x"]);
    expect($("[data-export-button]", m.host).textContent).toBe("Export Card");
    click($$('[aria-label="Remove export settings"]', m.host)[1]);
    expect($$("[data-export-row]", m.host).length).toBe(2);
    expect(exportSettingsOf(ed.engine.readNode("1:5") as { exportSettings?: unknown }).map((s) => s.suffix)).toEqual(["", "@3x"]);
    // One undo step per edit.
    act(() => void ed.engine.undo());
    expect($$("[data-export-row]", m.host).length).toBe(3);
  });

  it("the Export dialog lists the page's layers with settings, all checked", async () => {
    const { ed } = await editor();
    ed.setProps(["1:5"], { exportSettings: [nextExportSetting([])] } as never, "Add export settings");
    ed.setProps(["1:10"], { exportSettings: [{ ...nextExportSetting([]), imageType: "PDF" }] } as never, "Add export settings");
    ed.ui.set({ exportDialog: true });
    function Host() {
      const [, force] = useState(0);
      void force;
      return createElement(EditorContext.Provider, { value: ed }, createElement(ExportDialog));
    }
    m = mount(Host, {});
    const rows = $$("[data-export-dialog-row]");
    expect(rows.map((r) => r.dataset.exportDialogRow)).toEqual(["1:5", "1:10"]);
    expect(rows[0].textContent).toContain("Card");
    expect(rows[0].textContent).toContain("1x PNG");
    expect(rows[0].textContent).toContain("280 × 160");
    expect(rows[1].textContent).toContain("PDF");
    expect($$('[data-export-dialog-row] input[type="checkbox"]').every((c) => (c as HTMLInputElement).checked)).toBe(true);
    act(() => ed.ui.set({ exportDialog: false }));
    expect($$("[data-export-dialog-row]").length).toBe(0);
  });

  it("commands: Export… and Export frames to PDF are on; Copy as text knows text layers; frames in reading order", async () => {
    const { ed } = await editor();
    expect(isEnabled(ed, COMMAND_BY_ID.get("file.export")!)).toBe(true);
    expect(isEnabled(ed, COMMAND_BY_ID.get("file.export-frames-to-pdf")!)).toBe(true);
    ed.engine.setSelection(["1:5"]);
    expect(isEnabled(ed, COMMAND_BY_ID.get("edit.copy-as-png")!)).toBe(true);
    expect(isEnabled(ed, COMMAND_BY_ID.get("edit.copy-as-text")!)).toBe(false);
    expect(selectionText(ed)).toBe("");
    COMMAND_BY_ID.get("file.export")!.run(ed);
    expect(ed.ui.get().exportDialog).toBe(true);
    expect(pageFrames(ed).map((f) => f.name)).toEqual(["Desktop", "Mobile"]);
  });
});
