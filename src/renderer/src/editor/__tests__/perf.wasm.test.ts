// The editor's performance rules on the real engine (headless): one componentInfo read per document version, the
// Layers tree refreshed once per frame and after a canvas gesture (never inside the engine's event dispatch),
// Selection colors re-read only for colour-bearing changes, the tree patched from a delta.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import { loadEngine } from "@/engine/loadEngine";
import type { NodeChange } from "@/engine/codec";
import { EditorController, patchTree } from "../controller";
import { memoryDocumentSource } from "../documentSource";
import { COMPONENTS_DOCUMENT } from "../fixtures";
import { canPushChanges, instanceChanges, instanceInfo, readC } from "../components";
import { changeTouchesColors } from "../hooks";
import { treeFromNodes, visibleRows } from "../model/layerTree";
import { readInside } from "../panels/design/SelectionColors";

const wasm = fileURLToPath(new URL("../../engine/wasm/engine.wasm", import.meta.url));

beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  g.window ??= globalThis;
  g.document ??= { querySelector: () => null };
  const bytes = readFileSync(wasm);
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
});

async function editor() {
  const source = memoryDocumentSource(COMPONENTS_DOCUMENT, { fileName: "Components" });
  const engine = await Engine.create(null, { sessionID: 1 });
  engine.load(await source.load());
  engine.setViewport(1280, 800, 1, 1280, 800);
  const store = new EngineStore(engine);
  const ed = new EditorController(engine, store, source);
  engine.onDocumentChanged((_, e) => source.onChanges(e.message));
  return { ed, engine, source };
}

/** A requestAnimationFrame the test runs by hand. */
function fakeFrames() {
  const queue: FrameRequestCallback[] = [];
  const g = globalThis as Record<string, unknown>;
  const before = { raf: g.requestAnimationFrame, caf: g.cancelAnimationFrame };
  g.requestAnimationFrame = (cb: FrameRequestCallback) => {
    queue.push(cb);
    return queue.length;
  };
  g.cancelAnimationFrame = () => {};
  return {
    run: () => {
      const cbs = queue.splice(0);
      for (const cb of cbs) cb(performance.now());
      return cbs.length;
    },
    pending: () => queue.length,
    restore: () => {
      g.requestAnimationFrame = before.raf;
      g.cancelAnimationFrame = before.caf;
    },
  };
}

describe("editor performance rules (wasm, headless)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reads engine.componentInfo once per document version however many panels ask", async () => {
    const { ed, engine } = await editor();
    if (typeof (engine as { componentInfo?: unknown }).componentInfo !== "function") return; // an engine without E6
    engine.setSelection(["2:2"]); // the Button instance
    const inst = readC(ed, "2:2")!;
    // A first read derives the main's page on an engine with lazy per-page derivation (its COMPONENTS_CHANGED is a
    // document change); the counting starts after it.
    instanceInfo(ed, inst);
    const spy = vi.spyOn(engine, "componentInfo");
    // The header's menu, the properties, Push changes and Reset ▸ all ask about the same instance.
    instanceInfo(ed, inst);
    instanceChanges(ed, inst);
    canPushChanges(ed);
    instanceInfo(ed, inst);
    expect(spy.mock.calls.filter((c) => c[0] === "2:2").length).toBe(1);
    // A committed change makes the next read ask the engine again (once).
    ed.setProps(["2:2"], { name: "Button renamed" }, "Rename");
    instanceInfo(ed, inst);
    instanceChanges(ed, inst);
    expect(spy.mock.calls.filter((c) => c[0] === "2:2").length).toBe(2);
    // A plain move (GEOMETRY) inside an open scrub changes nothing an instance's panel shows: no new read.
    ed.edit("Move", { final: false, source: "drag" } as never, () => engine.setProps(["2:2"], { transform: { m00: 1, m01: 0, m02: 50, m10: 0, m11: 1, m12: 50 } }));
    instanceInfo(ed, inst);
    expect(spy.mock.calls.filter((c) => c[0] === "2:2").length).toBe(2);
    ed.cancelEdit();
  });

  it("refreshes the Layers tree once per animation frame, and after a canvas gesture ends — never inside the event dispatch", async () => {
    const frames = fakeFrames();
    try {
      const { ed, engine } = await editor();
      const first = ed.getTreeSnapshot();
      let notified = 0;
      const off = ed.subscribeTree(() => notified++);
      // Two structural changes in one tick: one frame, one notification, one re-read.
      expect(engine.moveNodes(["2:3"], ed.store.page, 0)).toBe(1);
      expect(engine.moveNodes(["2:3"], ed.store.page, 1)).toBe(1);
      expect(notified).toBe(0);
      expect(ed.getTreeSnapshot()).toBe(first); // stale until the frame: nothing read in the dispatch
      expect(frames.run()).toBe(1);
      expect(notified).toBe(1);
      const second = ed.getTreeSnapshot();
      expect(second).not.toBe(first);
      // A canvas gesture: Layers waits for the release (Figma reflects a reparent on drop).
      ed.beginGesture();
      expect(engine.moveNodes(["2:3"], ed.store.page, 0)).toBe(1);
      expect(frames.pending()).toBe(0);
      expect(ed.getTreeSnapshot()).toBe(second);
      ed.endGesture();
      expect(frames.pending()).toBe(1);
      frames.run();
      expect(notified).toBe(2);
      expect(ed.getTreeSnapshot()).not.toBe(second);
      // getTree() stays synchronous and current for callers that need it now (tests, drops).
      expect(visibleRows(ed.getTree(), new Set()).map((r) => r.id)).toContain("2:3");
      off();
    } finally {
      frames.restore();
    }
  });

  it("switches pages at once (the new page's tree in the same tick)", async () => {
    const frames = fakeFrames();
    try {
      const { ed, engine } = await editor();
      ed.getTreeSnapshot();
      let notified = 0;
      ed.subscribeTree(() => notified++);
      engine.setCurrentPage("0:3");
      expect(notified).toBe(1);
      expect(ed.getTreeSnapshot().page).toBe("0:3");
    } finally {
      frames.restore();
    }
  });

  it("Selection colors re-read only for colour-bearing changes", () => {
    const move: NodeChange = { guid: "1:1", transform: { m00: 1, m01: 0, m02: 3, m10: 0, m11: 1, m12: 4 } };
    const resize: NodeChange = { guid: "1:1", size: { x: 10, y: 10 } };
    expect(changeTouchesColors({ nodeChanges: [move, resize] })).toBe(false);
    expect(changeTouchesColors({ nodeChanges: [{ guid: "1:1", fillPaints: [] }] })).toBe(true);
    expect(changeTouchesColors({ nodeChanges: [{ guid: "1:1", visible: false }] })).toBe(true);
    expect(changeTouchesColors({ nodeChanges: [{ guid: "1:9", phase: "CREATED", type: "RECTANGLE" }] })).toBe(true);
    expect(changeTouchesColors({ nodeChanges: [{ guid: "1:1", parentIndex: { guid: "1:2", position: "!" } }] })).toBe(true);
  });

  it("reads the visible layers inside the selection, each subtree top first, selected layers left out", async () => {
    const { engine } = await editor();
    const inside = readInside(engine, ["2:2"]);
    expect(inside).not.toBeNull();
    expect(inside!.every((n) => n.guid !== "2:2")).toBe(true);
    expect(inside!.length).toBeGreaterThan(0);
    // Each row carries what the colours need.
    for (const n of inside!) expect(n.visible !== false).toBe(true);
    expect(readInside(engine, ["2:2"], 1)).toBeNull(); // past the cap: not listed
  });

  it("patches a Layers tree from a delta: removed rows dropped, rows upserted with their new children", () => {
    const tree = treeFromNodes("0:1", [
      { guid: "0:1", type: "CANVAS", name: "Page", childIds: ["1:1", "1:2"] },
      { guid: "1:1", type: "FRAME", name: "A", parentIndex: { guid: "0:1", position: "!" }, childIds: ["1:3"] },
      { guid: "1:2", type: "RECTANGLE", name: "B", parentIndex: { guid: "0:1", position: '"' } },
      { guid: "1:3", type: "TEXT", name: "T", parentIndex: { guid: "1:1", position: "!" } },
    ]);
    // B reparented into A (on top), T removed.
    const next = patchTree(tree, {
      removed: ["1:3"],
      nodes: [
        { guid: "0:1", type: "CANVAS", name: "Page", childIds: ["1:1"] },
        { guid: "1:1", type: "FRAME", name: "A", parentIndex: { guid: "0:1", position: "!" }, childIds: ["1:2"] },
        { guid: "1:2", type: "RECTANGLE", name: "B", parentIndex: { guid: "1:1", position: "!" } },
      ],
    });
    expect(next.nodes.has("1:3")).toBe(false);
    expect(next.nodes.get("1:1")?.children).toEqual(["1:2"]);
    expect(next.nodes.get("1:2")?.parent).toBe("1:1");
    expect(visibleRows(next, new Set(["1:1"])).map((r) => r.id)).toEqual(["1:1", "1:2"]);
    expect(tree.nodes.has("1:3")).toBe(true); // the old tree is untouched
  });
});
