// @vitest-environment happy-dom
// The Prototype tab (panels/prototype) rendered on the real engine (headless Wasm): nothing selected shows Device,
// Background and Flows; a hotspot shows its interaction rows (remove, add); a top-level frame gets a flow starting
// point from "+"; Scroll behavior writes overflow.
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
import { PrototypePanel } from "../panels/prototype/PrototypePanel";

// happy-dom gives modules http URLs: the repo-relative path.
const wasm = resolve(process.cwd(), "src/renderer/src/engine/wasm/engine.wasm");

beforeAll(async () => {
  // No server behind happy-dom: the bundled fonts the engine asks for are simply not there.
  globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch;
  const bytes = readFileSync(wasm);
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
});

async function setup() {
  const source = memoryDocumentSource(PROTOTYPE_DOCUMENT, { fileName: "Prototype" });
  const engine = await Engine.create(null, { sessionID: 1 });
  engine.load(await source.load());
  const ed = new EditorController(engine, new EngineStore(engine), source);
  const Panel = () => createElement(EditorContext.Provider, { value: ed }, createElement(PrototypePanel));
  const view = mount(Panel, {});
  return { ed, engine, view };
}

const section = (host: HTMLElement, name: string) => host.querySelector<HTMLElement>(`section[aria-label="${name}"]`);
const click = (el: Element | null) => act(() => (el as HTMLElement).click());

describe("the Prototype tab", () => {
  it("nothing selected: Device, Background, Flows (the page's flow)", async () => {
    const { view, engine } = await setup();
    expect(section(view.host, "Device")).not.toBeNull();
    expect(section(view.host, "Background")?.querySelector("input")?.value.toUpperCase()).toContain("1E1E1E");
    expect(section(view.host, "Flows")?.querySelector("[data-flow]")?.textContent).toContain("Onboarding");
    view.unmount();
    engine.destroy();
  });

  it("a hotspot: its interaction row, removed and added back", async () => {
    const { view, engine } = await setup();
    act(() => void engine.setSelection(["2:4"]));
    const rows = () => [...view.host.querySelectorAll("[data-interaction]")];
    expect(rows()).toHaveLength(1);
    expect(rows()[0].textContent).toBe("ClickDetails"); // live: "Click → Details" (the arrow a glyph)
    expect(rows()[0].textContent).toContain("Details");
    expect(section(view.host, "Scroll behavior")?.textContent).toContain("Position");
    click(rows()[0].querySelector('button[aria-label="Remove interaction"]'));
    expect(rows()).toHaveLength(0);
    expect((engine.readNode("2:4") as { prototypeInteractions?: unknown }).prototypeInteractions).toBeUndefined();
    click(section(view.host, "Interactions")!.querySelector('button[aria-label="Add interaction"]'));
    expect(rows()).toHaveLength(1);
    expect(rows()[0].textContent).toContain("None");
    // One undo step each.
    act(() => void engine.undo());
    act(() => void engine.undo());
    expect(rows()[0].textContent).toContain("Details");
    view.unmount();
    engine.destroy();
  });

  it("a top-level frame: + adds a flow starting point", async () => {
    const { view, engine } = await setup();
    act(() => void engine.setSelection(["2:10"]));
    const flow = section(view.host, "Flow starting point")!;
    click(flow.querySelector('button[aria-label="Add starting point"]'));
    expect((engine.readNode("2:10") as { prototypeStartingPoint?: { name: string } }).prototypeStartingPoint?.name).toBe("Flow 2");
    expect(section(view.host, "Flow starting point")?.querySelector('input[aria-label="Flow name"]')).not.toBeNull();
    view.unmount();
    engine.destroy();
  });
});
