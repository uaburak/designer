// @vitest-environment happy-dom
/**
 * Engine events are dispatched after any engine call, reads included: a component reading a node of a page not
 * derived yet while it renders delivers that page's LOAD changes (and whatever else was queued). The React hooks over
 * the engine's store must not update another component during that render — React's "Cannot update a component
 * (…) while rendering a different component (…)" (seen with Pins / ZoomMenu, DesignPanel / ExportSectionBody,
 * Selected / Layers, SelectionColorsSection / Assets).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, createElement, Fragment } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import { loadEngine } from "@/engine/loadEngine";
import { useCamera, useNode, useSelection } from "@/engine/hooks";
import { mount, type Mounted } from "@/ds/__tests__/dom";
import { COMPONENTS_DOCUMENT } from "../fixtures";
import { memoryDocumentSource } from "../documentSource";
import { EditorContext, EditorController } from "../controller";
import { useNodes, usePages, useTopics } from "../hooks";

const wasm = resolve(process.cwd(), "src/renderer/src/engine/wasm/engine.wasm");
beforeAll(async () => {
  const bytes = readFileSync(wasm);
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
});

let view: Mounted | null = null;
afterEach(() => {
  view?.unmount();
  view = null;
  vi.restoreAllMocks();
});

describe("store notifications out of render", () => {
  it("a render that reads a page not derived yet updates no other component while it renders", async () => {
    const source = memoryDocumentSource(COMPONENTS_DOCUMENT, { fileName: "Components" });
    const engine = await Engine.create(null, { sessionID: 1 });
    engine.load(await source.load());
    const store = new EngineStore(engine);
    const ed = new EditorController(engine, store, source);
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void errors.push(a.map(String).join(" ")));

    // Subscribers of every kind the panels use: topics, nodes on the page about to be derived, the camera.
    function Listeners() {
      useTopics(store, ["structure", "selection", "undo"]);
      useNode(store, "0:1");
      useNodes(["0:1"]);
      useSelection(store);
      useCamera(store);
      usePages();
      return null;
    }
    let reads = 0;
    function Reader({ read }: { read: boolean }) {
      // A panel reading the Components page's instance as it renders (DesignPanel's main component, Pins' anchors…).
      if (read) {
        reads++;
        engine.readNodes(["0:3"], { subtree: true, fields: ["type"] });
      }
      return null;
    }
    const App = ({ read }: { read: boolean }) => createElement(EditorContext.Provider, { value: ed }, createElement(Fragment, null, createElement(Reader, { read }), createElement(Listeners)));
    view = mount(App, { read: false });
    const changed = vi.fn();
    const off = engine.onAny((e) => changed(e.type));
    view.rerender(App, { read: true });
    await act(async () => {
      await Promise.resolve();
    });
    off();
    expect(reads).toBeGreaterThan(0);
    // The read did deliver the page's changes (the precondition)…
    expect(changed).toHaveBeenCalled();
    // …and no component was updated during another's render.
    expect(errors.filter((e) => e.includes("while rendering a different component"))).toEqual([]);
    engine.destroy();
  });

  it("a read delivers what it derived after the caller, in a microtask; the next write delivers it at once, in order", async () => {
    const engine = await Engine.create(null, { sessionID: 1 });
    engine.load(COMPONENTS_DOCUMENT);
    const seen: string[] = [];
    engine.onAny((e) => seen.push(e.type));
    engine.readNodes(["0:3"], { subtree: true, fields: ["type"] });
    expect(seen).toEqual([]);
    await Promise.resolve();
    expect(seen).toContain("STRUCTURE_CHANGED");
    seen.length = 0;
    // A page derived by a read, then a write before the microtask: the read's events come first, with the write's.
    engine.load(COMPONENTS_DOCUMENT);
    engine.readNodes(["0:3"], { subtree: true, fields: ["type"] });
    engine.setSelection(["1:1"]);
    expect(seen.indexOf("STRUCTURE_CHANGED")).toBeGreaterThanOrEqual(0);
    expect(seen.indexOf("STRUCTURE_CHANGED")).toBeLessThan(seen.lastIndexOf("SELECTION_CHANGED"));
    await Promise.resolve();
    engine.destroy();
  });
});
