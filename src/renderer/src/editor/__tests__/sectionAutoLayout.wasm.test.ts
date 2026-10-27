// @vitest-environment happy-dom
// Auto layout on sections ([ours], docs/schema.md "Auto layout on sections"): a section's Layout section offers
// "Use auto layout" as a frame's does; ⇧A gives a lone section auto layout itself (not a wrapping frame), and the panel
// then shows the section's Auto layout rows. The section stays a SECTION; a Figma export drops its stack fields
// (figmaExport.test.ts).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import { loadEngine } from "@/engine/loadEngine";
import { SAMPLE_DOCUMENT } from "@/engine/sampleDocument";
import { $, click, mount, type Mounted } from "../../ds/__tests__/dom";
import { EditorContext, EditorController } from "../controller";
import { memoryDocumentSource } from "../documentSource";
import { useNodes } from "../hooks";
import { LayoutSection } from "../panels/design/Layout";
import type { PanelNode } from "../panels/design/shared";

const wasm = join(process.cwd(), "src/renderer/src/engine/wasm/engine.wasm");
const FRAME = "1:1"; // a top-level frame (a section wraps only those)

beforeAll(async () => {
  globalThis.fetch = async () => new Response(null, { status: 404 });
  const bytes = readFileSync(wasm);
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
});

let m: Mounted | null = null;
afterEach(() => {
  m?.unmount();
  m = null;
});

describe("auto layout on a section ([ours])", () => {
  it("Use auto layout on a section's Layout gives the section itself auto layout; it stays a section", async () => {
    const source = memoryDocumentSource(SAMPLE_DOCUMENT, { fileName: "Test" });
    const engine = await Engine.create(null, { sessionID: 1 });
    engine.load(await source.load());
    engine.setViewport(1280, 800, 1, 1280, 800);
    const ed = new EditorController(engine, new EngineStore(engine), source);
    engine.setSelection([FRAME]);
    engine.command("WRAP_IN_SECTION");
    const section = (engine.readNode(FRAME, { fields: ["parentIndex"] }) as { parentIndex: { guid: string } }).parentIndex.guid;
    engine.setSelection([section]);
    expect((engine.readNode(section) as { type?: string }).type).toBe("SECTION");
    function Harness() {
      const nodes = useNodes([section]) as PanelNode[];
      return nodes.length ? createElement(LayoutSection, { nodes }) : null;
    }
    m = mount(() => createElement(EditorContext.Provider, { value: ed }, createElement(Harness)), {});
    const use = $('button[aria-label="Use auto layout"]', m.host);
    expect(use).toBeTruthy();
    click(use!);
    const after = engine.readNode(section) as { type?: string; stackMode?: string };
    expect(after.type).toBe("SECTION");
    expect(after.stackMode && after.stackMode !== "NONE").toBe(true);
    expect(ed.selection).toEqual([section]); // not wrapped in a new frame
    m.rerender(() => createElement(EditorContext.Provider, { value: ed }, createElement(Harness)), {});
    expect($('button[aria-label="Remove auto layout"]', m.host)).toBeTruthy();
  });
});
