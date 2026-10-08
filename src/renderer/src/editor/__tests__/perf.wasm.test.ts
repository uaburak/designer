// The editor's performance rules on the real engine (headless): one componentInfo read per document version, the
// Layers tree refreshed once per frame and after a canvas gesture (never inside the engine's event dispatch),
// Selection colors re-read only for colour-bearing changes, the tree patched from a delta.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import { loadEngine } from "@/engine/loadEngine";
import type { Message, NodeChange } from "@/engine/codec";
import { decodeLayerOutline, EditorController, patchTree } from "../controller";
import { memoryDocumentSource } from "../documentSource";
import { COMPONENTS_DOCUMENT } from "../fixtures";
import { canPushChanges, instanceChanges, instanceInfo, readC } from "../components";
import { changeTouchesColors } from "../hooks";
import { detailsWindow, treeFromNodes, visibleRows, type LayerTree } from "../model/layerTree";
import { readInside } from "../panels/design/SelectionColors";

const wasm = fileURLToPath(new URL("../../engine/wasm/engine.wasm", import.meta.url));

beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  g.window ??= globalThis;
  g.document ??= { querySelector: () => null };
  const bytes = readFileSync(wasm);
  await loadEngine({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), printErr: () => {} });
});

async function editor(doc: Message = COMPONENTS_DOCUMENT) {
  const source = memoryDocumentSource(doc, { fileName: "Components" });
  const engine = await Engine.create(null, { sessionID: 1 });
  engine.load(await source.load());
  engine.setViewport(1280, 800, 1, 1280, 800);
  const store = new EngineStore(engine);
  const ed = new EditorController(engine, store, source);
  engine.onDocumentChanged((_, e) => source.onChanges(e.message));
  return { ed, engine, source };
}

const position = (i: number) => String.fromCharCode(33 + Math.floor(i / 94)) + String.fromCharCode(33 + (i % 94));

/** The components document plus a page "0:9" of `frames` frames × `each` rectangles (a Layers panel's worth of rows). */
function withBigPage(frames: number, each: number): Message {
  const doc = structuredClone(COMPONENTS_DOCUMENT);
  doc.nodeChanges.push({ guid: "0:9", phase: "CREATED", type: "CANVAS", name: "Big", parentIndex: { guid: "0:0", position: "z" } });
  let id = 1;
  for (let f = 0; f < frames; f++) {
    const frame = `9:${id++}`;
    doc.nodeChanges.push({ guid: frame, phase: "CREATED", type: "FRAME", name: `Frame ${f}`, parentIndex: { guid: "0:9", position: position(f) }, size: { x: 400, y: 300 }, transform: { m00: 1, m01: 0, m02: f * 420, m10: 0, m11: 1, m12: 0 } });
    for (let r = 0; r < each; r++)
      doc.nodeChanges.push({ guid: `9:${id++}`, phase: "CREATED", type: "ROUNDED_RECTANGLE", name: `Rectangle ${r}`, parentIndex: { guid: frame, position: position(r) }, size: { x: 18, y: 18 }, transform: { m00: 1, m01: 0, m02: r * 20, m10: 0, m11: 1, m12: 5 }, visible: r % 7 !== 3, locked: r % 11 === 5 });
  }
  return doc;
}

/** What the Layers panel does for the rows it draws (Layers.tsx renderRow): the window's details, then the row's. */
function drawRows(tree: LayerTree, first: number, count: number) {
  const rows = visibleRows(tree, new Set());
  for (let i = first; i < first + count && i < rows.length; i++) {
    if (!tree.details.has(rows[i].id)) tree.details.prefetch(detailsWindow(rows, i));
    const node = tree.nodes.get(rows[i].id)!;
    void node.name;
    void node.visible;
    void node.locked;
    void node.stackMode;
  }
  return rows;
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

  it("a page switch reads the outline once and details only for the rows in view (two passes)", async () => {
    const frames = fakeFrames();
    try {
      const { ed, engine } = await editor(withBigPage(60, 40)); // 2460 rows on "0:9"
      ed.getTreeSnapshot();
      // Pass 1 reads the engine's outline (`layerOutline`, no names) when the build has it, else the layer tree.
      const hasOutline = typeof (engine as { layerOutline?: unknown }).layerOutline === "function";
      const treeReads = vi.spyOn(engine, "layerTreeVersioned");
      const outlineReads = hasOutline ? vi.spyOn(engine as unknown as { layerOutline: (p: string) => unknown }, "layerOutline") : treeReads;
      const detailReads = vi.spyOn(engine, "readNodes");
      engine.setCurrentPage("0:9");
      const tree = ed.getTreeSnapshot();
      expect(tree.page).toBe("0:9");
      expect(tree.nodes.size).toBe(2461);
      // Pass 1: one read of the page's rows; nothing else — no details built.
      expect(outlineReads).toHaveBeenCalledTimes(1);
      if (hasOutline) expect(treeReads).not.toHaveBeenCalled();
      expect(detailReads).not.toHaveBeenCalled();
      expect(tree.details.size).toBe(0);
      // Pass 2: the panel draws 40 rows → one engine read of their window (48 rows), 40 details built.
      const rows = drawRows(tree, 0, 40);
      expect(rows).toHaveLength(60);
      expect(detailReads).toHaveBeenCalledTimes(1);
      expect(detailReads.mock.calls[0][0]).toHaveLength(48);
      expect(detailReads.mock.calls[0][1]).toMatchObject({ fields: expect.arrayContaining(["name", "visible", "locked"]) });
      expect(tree.details.size).toBe(40);
      expect(tree.nodes.get(rows[0].id)!.name).toBe("Frame 59");
      // Expanding a frame shows its rectangles: the rows now in view read in one more window.
      const open = visibleRows(tree, new Set([rows[0].id]));
      expect(open).toHaveLength(100);
      for (let i = 1; i <= 40; i++) {
        if (!tree.details.has(open[i].id)) tree.details.prefetch(detailsWindow(open, i));
        void tree.nodes.get(open[i].id)!.name;
      }
      expect(detailReads).toHaveBeenCalledTimes(2);
      expect(tree.nodes.get(open[1].id)!.name).toBe("Rectangle 39");
      expect(tree.nodes.get(open[1].id)!.locked).toBe(false);
      expect(tree.nodes.get(open[40].id)!.visible).toBe(true);
      expect(outlineReads).toHaveBeenCalledTimes(1);
    } finally {
      frames.restore();
    }
  });

  it("a rename invalidates one row's details; the delta brings the new name without a read or a rebuilt hierarchy", async () => {
    const frames = fakeFrames();
    try {
      const { ed, engine } = await editor(withBigPage(30, 20));
      engine.setCurrentPage("0:9");
      const tree = ed.getTreeSnapshot();
      const rows = drawRows(tree, 0, 30);
      const detailReads = vi.spyOn(engine, "readNodes");
      const outlineReads = vi.spyOn(engine, "layerTreeVersioned");
      const target = rows[3].id;
      const other = rows[4].id;
      const otherDetails = tree.details.of(other);
      ed.setProps([target], { name: "Renamed" }, "Rename");
      // Inside the dispatch: that row's details dropped, the others kept; the tree waits for the frame.
      expect(tree.details.has(target)).toBe(false);
      expect(tree.details.has(other)).toBe(true);
      expect(ed.getTreeSnapshot()).toBe(tree);
      expect(frames.run()).toBe(1);
      const next = ed.getTreeSnapshot();
      expect(next).not.toBe(tree);
      expect(next.nodes).toBe(tree.nodes); // nothing structural: the hierarchy is reused as it is
      expect(next.nodes.get(target)!.name).toBe("Renamed");
      expect(next.details.of(other)).toBe(otherDetails);
      expect(detailReads).not.toHaveBeenCalled(); // the delta's row carried the name
      expect(outlineReads).not.toHaveBeenCalled();
      // The eye: the same — one row's details, no hierarchy copy.
      ed.setProps([other], { visible: false }, "Hide");
      frames.run();
      const hidden = ed.getTreeSnapshot();
      expect(hidden.nodes).toBe(tree.nodes);
      expect(hidden.nodes.get(other)!.visible).toBe(false);
      expect(hidden.nodes.get(target)!.name).toBe("Renamed");
      // A move changes a child list: the hierarchy is patched (a new map), details of untouched rows kept.
      expect(engine.moveNodes([target], ed.store.page, 0)).toBe(1);
      frames.run();
      const moved = ed.getTreeSnapshot();
      expect(moved.nodes).not.toBe(tree.nodes);
      expect(moved.nodes.get(ed.store.page)!.children[0]).toBe(target);
      expect(moved.details.of(other)).not.toBe(otherDetails); // its own row was in the delta (hidden above)
      expect(moved.details.of(rows[6].id)).toBe(tree.details.of(rows[6].id));
      expect(detailReads).not.toHaveBeenCalled();
      expect(outlineReads).not.toHaveBeenCalled();
    } finally {
      frames.restore();
    }
  });

  it("decodes an engine outline (ids, parent indexes, kinds) into rows with their children in order", () => {
    // Page P: A (frame: a1, a2), B; pre-order, each node followed by its children bottom first.
    const outline = decodeLayerOutline({
      ids: ["0:1", "1:1", "1:2", "I1:3;2:1", "1:4"],
      parents: [-1, 0, 1, 1, 0],
      kinds: [0, 1 | (2 << 8), 2, 2 | (1 << 8), 1 | (4 << 8)],
      types: ["CANVAS", "FRAME", "ROUNDED_RECTANGLE"],
    });
    expect(outline.map((o) => o.id)).toEqual(["0:1", "1:1", "1:2", "I1:3;2:1", "1:4"]);
    expect(outline[0]).toMatchObject({ parent: null, type: "CANVAS", children: ["1:1", "1:4"] });
    expect(outline[1]).toMatchObject({ parent: "0:1", type: "FRAME", children: ["1:2", "I1:3;2:1"], stateGroup: true, group: false });
    expect(outline[3]).toMatchObject({ parent: "1:1", derived: true });
    expect(outline[4]).toMatchObject({ type: "FRAME", group: true });
    expect(outline[4].stateGroup).toBeUndefined();
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
