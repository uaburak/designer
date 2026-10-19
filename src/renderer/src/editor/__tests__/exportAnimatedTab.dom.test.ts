// @vitest-environment happy-dom
// The Export section's Static | Animated tabs (docs/motion.md §7.1) on the real engine (headless Wasm): only for a
// timeline root with something on it (Group 3, A-live O5) — a plain layer gets Figma's Export, its "+" alone.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { beforeAll, describe, expect, it } from "vitest";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import { loadEngine } from "@/engine/loadEngine";
import { mount } from "@/ds/__tests__/dom";
import { EditorContext, EditorController } from "../controller";
import { memoryDocumentSource } from "../documentSource";
import { PROTOTYPE_DOCUMENT } from "../fixtures";
import { ExportSection } from "../panels/design/Export";

const wasm = resolve(process.cwd(), "src/renderer/src/engine/wasm/engine.wasm");

beforeAll(async () => {
  globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch;
  const bytes = readFileSync(wasm);
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
});

describe("the Export section's tabs", () => {
  it("no Static / Animated strip without anything to export animated: Figma's Export with its +", async () => {
    const source = memoryDocumentSource(PROTOTYPE_DOCUMENT, { fileName: "Prototype" });
    const engine = await Engine.create(null, { sessionID: 1 });
    engine.load(await source.load());
    const ed = new EditorController(engine, new EngineStore(engine), source);
    const node = engine.readNode("2:4") as { name?: string; exportSettings?: unknown };
    const targets = [{ guid: "2:4", name: node.name, exportSettings: node.exportSettings }];
    const Panel = () => createElement(EditorContext.Provider, { value: ed }, createElement(ExportSection, { targets, page: false }));
    const view = mount(Panel, {});
    // Nothing to export animated on this layer (no timeline with keyframes, clips or audio): no Static / Animated
    // strip, Figma's Export alone — its "+" (A-live O5).
    expect(view.host.querySelector('[role="tablist"]')).toBeNull();
    expect(view.host.querySelector("[data-animated-hint], [data-animated-export]")).toBeNull();
    expect(view.host.querySelector('button[aria-label="Add export settings"]')?.hasAttribute("disabled")).toBe(false);
    view.unmount();
    engine.destroy();
  });
});
