// Assets' performance rules on the real engine (headless), on `&doc=design-system` (340 assets, ~1,300 instances):
// the asset list is read again only for a change that can alter it — not for a drag, an insert or an edit elsewhere —
// and a cached component thumbnail goes stale only when something inside it changed (an instance in it re-derived
// from its main's change included), not when one of its instances is inserted or moved.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import { loadEngine } from "@/engine/loadEngine";
import { PointerType } from "@/engine/abi";
import { EditorController } from "../controller";
import { memoryDocumentSource } from "../documentSource";
import { designSystemDocument } from "../fixtures";
import { insertInstance } from "../components";

const wasm = fileURLToPath(new URL("../../engine/wasm/engine.wasm", import.meta.url));

beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  g.window ??= globalThis;
  g.document ??= { querySelector: () => null };
  // Node has no ImageData: the thumbnail cache only keeps it.
  g.ImageData ??= class {
    constructor(
      readonly data: Uint8ClampedArray,
      readonly width: number,
      readonly height: number
    ) {}
  };
  const bytes = readFileSync(wasm);
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
});

async function editor() {
  const source = memoryDocumentSource(designSystemDocument(), { fileName: "Design system" });
  const engine = await Engine.create(null, { sessionID: 1 });
  engine.load(await source.load());
  engine.setViewport(1280, 800, 1, 1280, 800);
  const store = new EngineStore(engine);
  const ed = new EditorController(engine, store, source);
  engine.onDocumentChanged((_, e) => source.onChanges(e.message));
  return { ed, engine };
}

/** Lets the deferred listeners run (they hear of changes in a microtask). */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("Assets performance rules (wasm, headless)", () => {
  it("lists every component and set once; a drag, an insert and edits elsewhere don't read the list again", async () => {
    const { ed, engine } = await editor();
    const assets = ed.components.assets();
    expect(assets.length).toBe(340); // 240 icons, 40 sets, 60 cards
    expect(assets.filter((a) => a.kind === "set").every((a) => a.variantCount === 8)).toBe(true);
    expect(ed.components.reads).toBe(1);
    let heard = 0;
    const off = ed.components.subscribeAssets(() => heard++);
    const version = ed.components.getAssetsVersion();

    // A drag of an instance in an auto-layout list, frame by frame, then its drop (one commit).
    engine.setCurrentPage("0:1");
    engine.setCamera({ x: 0, y: 0, zoom: 1 });
    engine.pointer(PointerType.DOWN, 28, 28, 0, 1, 0);
    for (let i = 1; i <= 30; i++) engine.pointer(PointerType.MOVE, 28 + i * 12, 28 + i * 6, 0, 1, 0);
    engine.pointer(PointerType.UP, 388, 208, 0, 0, 0);
    await settle();
    expect(engine.readNode("41:0", { fields: ["parentIndex"] })?.parentIndex?.guid).toBe("40:1"); // into Screen 2's list
    // An insert, an edit of a layer outside any component, a move into another frame.
    expect(insertInstance(ed, "21:0")).toBeTruthy();
    ed.setProps(["40:3"], { name: "Screen 4 (edited)" }, "Rename");
    expect(engine.moveNodes(["41:5"], "40:6", 0)).toBe(1);
    await settle();
    expect(ed.components.getAssetsVersion()).toBe(version);
    expect(heard).toBe(0);
    ed.components.assets();
    expect(ed.components.reads).toBe(1);
    off();
  });

  it("reads the list again after a change to a listed component, a set's variant, a frame they sit in, or a new component", async () => {
    const { ed, engine } = await editor();
    ed.components.assets();
    const read = () => {
      const before = ed.components.reads;
      const list = ed.components.assets();
      return { list, again: ed.components.reads > before };
    };
    ed.setProps(["11:0"], { name: "Icons/Set 1/Renamed" }, "Rename");
    await settle();
    let r = read();
    expect(r.again).toBe(true);
    expect(r.list.find((a) => a.id === "11:0")?.name).toBe("Icons/Set 1/Renamed");
    // A frame components sit in, renamed: their frame name in Assets.
    ed.setProps(["10:1"], { name: "Arrows" }, "Rename");
    await settle();
    r = read();
    expect(r.again).toBe(true);
    expect(r.list.find((a) => a.id === "11:40")?.frameName).toBe("Arrows");
    // The default variant moved below the others: the set's tile shows another one.
    ed.setProps(["21:0"], { transform: { m00: 1, m01: 0, m02: 10, m10: 0, m11: 1, m12: 400 } }, "Move");
    await settle();
    r = read();
    expect(r.again).toBe(true);
    expect(r.list.find((a) => a.id === "20:0")?.target).toBe("21:1");
    // Deleted: gone from the list; undone: back.
    ed.setProps(["31:5"], { name: "Cards/Card 6" }, "Rename"); // a no-op rename keeps the list
    await settle();
    expect(read().again).toBe(false);
    const { runEditorCommand } = await import("../commands");
    engine.setSelection(["31:5"]);
    runEditorCommand(ed, "edit.delete");
    await settle();
    r = read();
    expect(r.again).toBe(true);
    expect(r.list.some((a) => a.id === "31:5")).toBe(false);
    runEditorCommand(ed, "edit.undo");
    await settle();
    r = read();
    expect(r.again).toBe(true);
    expect(r.list.some((a) => a.id === "31:5")).toBe(true);
  });

  it("marks a cached thumbnail stale only when something inside it changed", async () => {
    const { ed, engine } = await editor();
    const pixels = { width: 2, height: 2, pixels: new Uint8Array(16) };
    (engine as unknown as { renderNodeThumbnailPixels: () => typeof pixels }).renderNodeThumbnailPixels = () => pixels;
    const thumbs = ed.thumbnails;
    const resolve = () => (thumbs as unknown as { resolve: () => void }).resolve();
    ed.components.assets(); // as Assets does first (its reads derive the components' pages)
    // Card 1 nests an instance of the Button 1 set's first variant (21:0); Icon 6 is on its own.
    for (const id of ["31:0", "31:1", "21:0", "11:5"]) expect(thumbs.renderNow(id, 64)).not.toBeNull();
    const stale = (id: string) => thumbs.peek(id, 64)?.stale;
    // An instance of the icon inserted and dragged elsewhere: nothing inside a component changed.
    expect(insertInstance(ed, "11:5")).toBeTruthy();
    resolve();
    expect(["31:0", "31:1", "21:0", "11:5"].map(stale)).toEqual([false, false, false, false]);
    // The variant's fill: the variant and the card that nests it, not the others.
    ed.setProps(["21:0"], { fillPaints: [{ type: "SOLID", color: { r: 1, g: 0, b: 0, a: 1 }, opacity: 1, visible: true }] }, "Fill");
    resolve();
    expect(["31:0", "31:1", "21:0", "11:5"].map(stale)).toEqual([true, false, true, false]);
    // Drawn again: fresh.
    thumbs.renderNow("21:0", 64);
    expect(stale("21:0")).toBe(false);
  });
});
