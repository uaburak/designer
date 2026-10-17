// @vitest-environment happy-dom
// The Export section's Static | Animated tabs (docs/motion.md §7.1) on the real engine (headless Wasm): Static keeps
// today's rows and button; Animated shows the hint for a selection without a timeline root (the loaded wasm may predate
// Motion, in which case every root reads as none — the hint either way).
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
import { ExportSection } from "../panels/design/Export";

const wasm = resolve(process.cwd(), "src/renderer/src/engine/wasm/engine.wasm");

beforeAll(async () => {
  globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch;
  const bytes = readFileSync(wasm);
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
});

const click = (el: Element | null) => act(() => (el as HTMLElement).click());

describe("the Export section's tabs", () => {
  it("Static shows the export rows; Animated shows the hint without a timeline root", async () => {
    const source = memoryDocumentSource(PROTOTYPE_DOCUMENT, { fileName: "Prototype" });
    const engine = await Engine.create(null, { sessionID: 1 });
    engine.load(await source.load());
    const ed = new EditorController(engine, new EngineStore(engine), source);
    const node = engine.readNode("2:4") as { name?: string; exportSettings?: unknown };
    const targets = [{ guid: "2:4", name: node.name, exportSettings: node.exportSettings }];
    const Panel = () => createElement(EditorContext.Provider, { value: ed }, createElement(ExportSection, { targets, page: false }));
    const view = mount(Panel, {});
    // A tab's label is drawn twice (the bold ghost keeps its width): match the visible one.
    const tab = (name: string) => [...view.host.querySelectorAll<HTMLElement>('[role="tab"]')].find((e) => e.querySelector("span > span")?.textContent === name) ?? null;
    expect(tab("Static")?.getAttribute("aria-selected")).toBe("true");
    expect(view.host.querySelector("[data-animated-hint], [data-animated-export]")).toBeNull();
    // Static: today's section (no settings yet on this layer: its "+" is the only control).
    expect(view.host.querySelector('button[aria-label="Add export settings"]')).not.toBeNull();
    click(tab("Animated"));
    expect(tab("Animated")?.getAttribute("aria-selected")).toBe("true");
    expect(view.host.querySelector("[data-export-row]")).toBeNull();
    expect(view.host.querySelector("[data-animated-hint]")?.textContent).toContain("Select a top-level frame");
    expect(view.host.querySelector('button[aria-label="Add export settings"]')?.hasAttribute("disabled")).toBe(true);
    click(tab("Static"));
    expect(tab("Static")?.getAttribute("aria-selected")).toBe("true");
    expect(view.host.querySelector("[data-animated-hint]")).toBeNull();
    expect(view.host.querySelector('button[aria-label="Add export settings"]')?.hasAttribute("disabled")).toBe(false);
    view.unmount();
    engine.destroy();
  });
});
