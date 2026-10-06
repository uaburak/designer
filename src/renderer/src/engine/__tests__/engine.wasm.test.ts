// The real engine (the committed Wasm build) driven through the TS facade in Node, headless:
// marshalling, the result slot, the event pump, transactions and undo end to end.
// (docs/engine.md §11.2 plans a wasm-node build for this; the web build with two stubs does for now.)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { POINTER_CAPTURE, PointerType } from "../abi";
import type { EngineEvent, Message } from "../codec";
import { Engine } from "../Engine";
import { loadEngine } from "../loadEngine";
import { SAMPLE_DOCUMENT } from "../sampleDocument";

const wasm = fileURLToPath(new URL("../wasm/engine.wasm", import.meta.url));

beforeAll(async () => {
  // The web build's glue looks up `document` and `window` when it starts (its DOM helpers); headless needs nothing else.
  const g = globalThis as Record<string, unknown>;
  g.window ??= globalThis;
  g.document ??= { querySelector: () => null };
  const bytes = readFileSync(wasm);
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
});

async function engineWithSample() {
  const engine = await Engine.create(null, { sessionID: 9 });
  engine.load(SAMPLE_DOCUMENT);
  engine.setViewport(1280, 800, 2, 2560, 1600);
  engine.setCamera({ x: 0, y: 0, zoom: 1 });
  return engine;
}

describe("engine (wasm, headless)", () => {
  it("loads the sample and reads nodes back", async () => {
    const engine = await engineWithSample();
    expect(engine.pages()).toEqual([{ guid: "0:1", name: "Page 1" }]);
    const desktop = engine.readNode("1:1", { childIds: true })!;
    expect(desktop.name).toBe("Desktop");
    expect(desktop.type).toBe("FRAME");
    expect(desktop.childIds?.length).toBe(6);
    expect(engine.readNode("9:9")).toBeNull();
    const snapshot: Message = engine.encodeDocument();
    expect(snapshot.nodeChanges[0].guid).toBe("0:0");
    expect(snapshot.nodeChanges).toHaveLength(SAMPLE_DOCUMENT.nodeChanges.length);
    engine.destroy();
  });

  it("a drag is one DOCUMENT_CHANGED, delivered after the call; undo is another", async () => {
    const engine = await engineWithSample();
    const events: EngineEvent[] = [];
    engine.onAny((e) => events.push(e));
    const documents: number[] = [];
    engine.onDocumentChanged((changes) => documents.push(changes.length));
    const selections: string[][] = [];
    engine.onSelectionChanged((s) => selections.push(s.refs));

    // Card (1:5) sits at 24,88 in Desktop (0,0).
    const r = engine.pointer(PointerType.DOWN, 100, 150, 0, 1, 0);
    expect(r & POINTER_CAPTURE).toBeTruthy();
    for (let x = 105; x <= 160; x += 5) engine.pointer(PointerType.MOVE, x, 150, 0, 1, 0);
    engine.pointer(PointerType.UP, 160, 150, 0, 0, 0);
    expect(selections).toEqual([["1:5"]]);
    expect(documents).toEqual([1]);
    expect(engine.readNode("1:5")!.transform!.m02).toBe(84);
    const changed = events.find((e) => e.type === "DOCUMENT_CHANGED");
    expect(changed && changed.type === "DOCUMENT_CHANGED" && changed.message.nodeChanges[0]).toMatchObject({ guid: "1:5", transform: { m02: 84 } });

    expect(engine.undo()).toBe(true);
    expect(engine.readNode("1:5")!.transform!.m02).toBe(24);
    expect(documents).toEqual([1, 1]);
    engine.destroy();
  });

  it("keys: arrows are the engine's, letters go to the shortcut table", async () => {
    const engine = await engineWithSample();
    engine.setSelection(["1:5"]);
    expect(engine.key("down", "ArrowRight", "ArrowRight", 0)).toBe(1);
    expect(engine.readNode("1:5")!.transform!.m02).toBe(25);
    expect(engine.key("down", "KeyR", "r", 0)).toBe(0);
    engine.destroy();
  });

  it("panel writes: setProps inside a transaction is one undo step", async () => {
    const engine = await engineWithSample();
    let messages = 0;
    engine.onDocumentChanged(() => messages++);
    engine.txnBegin("Opacity");
    for (const opacity of [0.9, 0.7, 0.5]) engine.setProps(["1:5", "1:6"], { opacity });
    expect(messages).toBe(0);
    engine.txnCommit();
    expect(messages).toBe(1);
    expect(engine.readNode("1:6")!.opacity).toBeCloseTo(0.5);
    engine.undo();
    expect(engine.readNode("1:6")!.opacity ?? 1).toBe(1);
    engine.destroy();
  });

  it("tools, commands and the camera", async () => {
    const engine = await engineWithSample();
    const tools: string[] = [];
    engine.on("TOOL_CHANGED", (e) => tools.push(e.tool));
    engine.setTool("RECTANGLE");
    engine.pointer(PointerType.DOWN, 1100, 600, 0, 1, 0);
    engine.pointer(PointerType.MOVE, 1150, 650, 0, 1, 0);
    engine.pointer(PointerType.UP, 1150, 650, 0, 0, 0);
    const [id] = engine.getSelection().refs;
    expect(engine.readNode(id)).toMatchObject({ type: "ROUNDED_RECTANGLE", name: "Rectangle 1", size: { x: 50, y: 50 } });
    expect(id.startsWith("9:")).toBe(true);
    expect(tools).toEqual(["RECTANGLE", "MOVE"]);
    expect(engine.hitTest(100, 150)).toEqual(["1:5", "1:1"]);  // innermost first
    expect(engine.hitTest(1100, 100)).toEqual([]);
    engine.command("ZOOM_IN");
    expect(engine.getCamera().zoom).toBeCloseTo(2);
    expect(engine.stats().nodes).toBe(SAMPLE_DOCUMENT.nodeChanges.length + 1);
    engine.destroy();
  });

  it("refuses a bad payload without breaking", async () => {
    const engine = await engineWithSample();
    expect(engine.applyChanges({ type: "NODE_CHANGES", sessionID: 0, nodeChanges: [{ guid: "1:5", phase: "REMOVED" }] }, "remote")).toBe(0);
    expect(engine.readNode("1:5")).toBeNull();
    expect(engine.getSelection().refs).toEqual([]);
    engine.destroy();
  });
});
