import { describe, expect, it, vi } from "vitest";
import type { Guid, NodeChange } from "@/engine/codec";
import { patchTree } from "../controller";
import {
  ancestorsOf,
  DETAILS_WINDOW,
  detailsWindow,
  draggedLayers,
  dropTarget,
  dropZone,
  isContainer,
  normalizeSelection,
  rangeSelection,
  revealed,
  RowDetailsStore,
  selectionRuns,
  toggleSelection,
  treeFromNodes,
  treeFromOutline,
  visibleRows,
  withSubtree,
  type OutlineNode,
} from "../model/layerTree";

// Page 0:1 holds (bottom → top): A (frame: a1, a2 (frame: a2x)), B (rectangle), G (group: g1, g2).
const n = (guid: string, type: string, parent: string, childIds: string[] = [], extra: Partial<NodeChange> = {}): NodeChange =>
  ({ guid, type, name: guid, parentIndex: { guid: parent, position: "!" }, childIds, ...extra }) as NodeChange;

const tree = treeFromNodes("0:1", [
  n("0:1", "CANVAS", "0:0", ["A", "B", "G"]),
  n("A", "FRAME", "0:1", ["a1", "a2"]),
  n("a1", "ROUNDED_RECTANGLE", "A"),
  n("a2", "FRAME", "A", ["a2x"]),
  n("a2x", "ELLIPSE", "a2"),
  n("B", "ROUNDED_RECTANGLE", "0:1"),
  n("G", "FRAME", "0:1", ["g1", "g2"], { resizeToFit: true }),
  n("g1", "ELLIPSE", "G"),
  n("g2", "ELLIPSE", "G"),
]);

describe("visible rows", () => {
  it("lists the top layer first and indents the children of expanded layers", () => {
    expect(visibleRows(tree, new Set()).map((r) => r.id)).toEqual(["G", "B", "A"]);
    const rows = visibleRows(tree, new Set(["A", "a2"]));
    expect(rows.map((r) => `${r.id}@${r.depth}`)).toEqual(["G@0", "B@0", "A@0", "a2@1", "a2x@2", "a1@1"]);
    expect(rows.find((r) => r.id === "A")).toMatchObject({ expandable: true, expanded: true });
    expect(rows.find((r) => r.id === "B")).toMatchObject({ expandable: false, expanded: false });
  });

  it("knows groups and ancestors", () => {
    expect(tree.nodes.get("G")?.group).toBe(true);
    expect(tree.nodes.get("A")?.group).toBe(false);
    expect(ancestorsOf(tree, "a2x")).toEqual(["a2", "A"]);
    expect(ancestorsOf(tree, "B")).toEqual([]);
  });

  it("⌥-click opens or closes a whole subtree", () => {
    expect([...withSubtree(tree, "A", new Set(), true)].sort()).toEqual(["A", "a2"]);
    expect([...withSubtree(tree, "A", new Set(["A", "a2", "G"]), false)]).toEqual(["G"]);
  });

  it("reveals a canvas selection by opening its ancestors, keeping the set when nothing changes", () => {
    const open = revealed(tree, ["a2x"], new Set());
    expect([...open].sort()).toEqual(["A", "a2"]);
    expect(revealed(tree, ["a2x"], open)).toBe(open);
  });
});

// A page of `count` layers under `parent`, as an outline (pass 1) and as the engine rows pass 2 would read.
function bigPage(count: number) {
  const outline: OutlineNode[] = [{ id: "0:1", parent: null, type: "CANVAS", children: [], group: false }];
  const rows = new Map<Guid, NodeChange>();
  for (let i = 1; i <= count; i++) {
    const id = `1:${i}`;
    outline[0].children.push(id);
    outline.push({ id, parent: "0:1", type: i % 10 === 0 ? "FRAME" : "ROUNDED_RECTANGLE", children: [], group: false });
    rows.set(id, { guid: id, type: i % 10 === 0 ? "FRAME" : "ROUNDED_RECTANGLE", name: `Layer ${i}`, visible: i % 7 !== 0, locked: i % 5 === 0, ...(i % 10 === 0 ? { stackMode: "VERTICAL" } : {}) } as NodeChange);
  }
  const read = vi.fn((ids: readonly Guid[]) => ids.map((id) => rows.get(id)!).filter(Boolean));
  return { outline, rows, read };
}

describe("two passes (Figma's Layers panel)", () => {
  it("pass 1: the rows the panel shows come from the outline alone — no details read", () => {
    const { outline, read } = bigPage(500);
    const tree = treeFromOutline("0:1", outline, new RowDetailsStore(read));
    const rows = visibleRows(tree, new Set());
    expect(rows).toHaveLength(500);
    expect(rows[0].id).toBe("1:500"); // top layer first
    expect(ancestorsOf(tree, "1:3")).toEqual([]);
    expect(isContainer(tree.nodes.get("1:10"))).toBe(true);
    expect(isContainer(tree.nodes.get("1:11"))).toBe(false);
    expect(dropTarget(tree, rows, 0, 0.1, new Set(["1:3"]))).toMatchObject({ parent: "0:1", position: "before" });
    expect(read).not.toHaveBeenCalled();
    expect(tree.details.size).toBe(0);
  });

  it("pass 2: details are read for a window of rows in one call and computed only for the rows drawn", () => {
    const { outline, read } = bigPage(500);
    const tree = treeFromOutline("0:1", outline, new RowDetailsStore(read));
    const rows = visibleRows(tree, new Set());
    // The list draws rows 0..39 (what fits): the first row without details brings its window in one read.
    const draw = (i: number) => {
      if (!tree.details.has(rows[i].id)) tree.details.prefetch(detailsWindow(rows, i));
      const node = tree.nodes.get(rows[i].id)!;
      return { name: node.name, visible: node.visible, locked: node.locked, stackMode: node.stackMode };
    };
    expect(draw(0)).toEqual({ name: "Layer 500", visible: true, locked: true, stackMode: "VERTICAL" });
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0][0]).toHaveLength(DETAILS_WINDOW.below); // rows 0..47
    for (let i = 1; i < 40; i++) draw(i);
    expect(read).toHaveBeenCalledTimes(1);
    expect(tree.details.size).toBe(40); // built for the rows drawn, not the 48 read, not the 500
    expect(tree.details.computed("1:500")).toBe(true);
    expect(tree.details.computed("1:450")).toBe(false);
    // A scroll by one window: rows 48.. miss; one read brings the ones not in hand (24 above are).
    draw(48);
    expect(read).toHaveBeenCalledTimes(2);
    expect(read.mock.calls[1][0]).toHaveLength(48); // rows 48..95
    expect(draw(60).name).toBe("Layer 440");
    expect(read).toHaveBeenCalledTimes(2);
    // A row asked outside any window (a rename of a row not drawn) reads that row alone.
    expect(tree.nodes.get("1:7")!.name).toBe("Layer 7");
    expect(read).toHaveBeenCalledTimes(3);
    expect(read.mock.calls[2][0]).toEqual(["1:7"]);
  });

  it("the list's width: every open row's name, read alone (no details built), in reads of `limit` rows, cached until the row changes", () => {
    const { outline, read, rows: byId } = bigPage(500);
    const readNames = vi.fn((ids: readonly Guid[]) => ids.map((id) => ({ guid: id, name: byId.get(id)!.name }) as NodeChange));
    const tree = treeFromOutline("0:1", outline, new RowDetailsStore(read, readNames));
    const ids = visibleRows(tree, new Set()).map((r) => r.id);
    // A drawn window's details are in hand: their names cost no read.
    tree.details.prefetch(ids.slice(0, 48));
    const first = tree.details.names(ids, 400);
    expect(readNames).toHaveBeenCalledTimes(1);
    expect(readNames.mock.calls[0][0]).toHaveLength(400); // 452 missing, 400 per read
    expect(first.filter((n) => n === null)).toHaveLength(52);
    expect(first[0]).toBe("Layer 500");
    const second = tree.details.names(ids, 400);
    expect(readNames).toHaveBeenCalledTimes(2);
    expect(readNames.mock.calls[1][0]).toHaveLength(52);
    expect(second.every((n) => typeof n === "string")).toBe(true);
    expect(tree.details.size).toBe(0); // no details built for them
    expect(read).toHaveBeenCalledTimes(1); // the drawn window's read only
    tree.details.names(ids);
    expect(readNames).toHaveBeenCalledTimes(2); // cached
    // A renamed row is read again.
    byId.set("1:7", { ...byId.get("1:7")!, name: "Renamed" });
    tree.details.invalidate("1:7");
    expect(tree.details.names(["1:7", "1:8"])).toEqual(["Renamed", "Layer 8"]);
    expect(readNames.mock.calls[2][0]).toEqual(["1:7"]);
  });

  it("the window around a row: 24 above, 48 below, clipped to the list", () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({ id: `r${i}`, depth: 0, expandable: false, expanded: false }));
    expect(detailsWindow(rows, 0)).toHaveLength(48);
    expect(detailsWindow(rows, 50).map((id) => id)).toEqual(rows.slice(26, 98).map((r) => r.id));
    expect(detailsWindow(rows, 99)).toHaveLength(25);
  });

  it("patching from a delta keeps the details of untouched rows and replaces the touched rows'", () => {
    const { outline, read } = bigPage(200);
    const tree = treeFromOutline("0:1", outline, new RowDetailsStore(read));
    const rows = visibleRows(tree, new Set());
    tree.details.prefetch(detailsWindow(rows, 0));
    const before = tree.details.of("1:199");
    expect(tree.nodes.get("1:200")!.name).toBe("Layer 200");
    // 1:200 renamed, 1:3 moved under 1:10 (a frame): the delta carries their rows and the parents' child lists.
    const next = patchTree(tree, {
      removed: ["1:1"],
      nodes: [
        { guid: "1:200", type: "ROUNDED_RECTANGLE", name: "Renamed", visible: true, locked: false, parentIndex: { guid: "0:1", position: "!" }, childIds: [] },
        { guid: "1:3", type: "ROUNDED_RECTANGLE", name: "Layer 3", parentIndex: { guid: "1:10", position: "!" }, childIds: [] },
        { guid: "1:10", type: "FRAME", name: "Layer 10", stackMode: "VERTICAL", parentIndex: { guid: "0:1", position: "!" }, childIds: ["1:3"] } as NodeChange,
        { guid: "0:1", type: "CANVAS", name: "Page", childIds: outline[0].children.filter((id) => id !== "1:1" && id !== "1:3") },
      ],
    });
    expect(next).not.toBe(tree);
    expect(next.nodes.has("1:1")).toBe(false);
    expect(next.nodes.get("1:3")!.parent).toBe("1:10");
    expect(next.nodes.get("1:10")!.children).toEqual(["1:3"]);
    expect(next.nodes.get("1:200")!.name).toBe("Renamed"); // from the delta's row, no read
    expect(next.details.of("1:199")).toBe(before); // untouched: the same details object
    expect(read).toHaveBeenCalledTimes(1);
    expect(tree.nodes.has("1:1")).toBe(true); // the old tree's hierarchy is untouched
    // Nothing structural (a rename alone): the node map is reused, the details replaced.
    const renamed = patchTree(next, { removed: [], nodes: [{ guid: "1:199", type: "ROUNDED_RECTANGLE", name: "Again", parentIndex: { guid: "0:1", position: "!" }, childIds: [] }] }, undefined, { detailsOnly: true });
    expect(renamed.nodes).toBe(next.nodes);
    expect(renamed.nodes.get("1:199")!.name).toBe("Again");
    expect(renamed.details.of("1:200").name).toBe("Renamed");
    // `detailsOnly` asked but a child list did change: the full patch runs.
    const moved = patchTree(renamed, { removed: [], nodes: [{ guid: "1:10", type: "FRAME", name: "Layer 10", parentIndex: { guid: "0:1", position: "!" }, childIds: [] }] }, undefined, { detailsOnly: true });
    expect(moved.nodes).not.toBe(renamed.nodes);
    expect(moved.nodes.get("1:10")!.children).toEqual([]);
  });

  it("a row invalidated reads again when next shown; rows kept with the tree need no read", () => {
    const { outline, read, rows: engineRows } = bigPage(50);
    const tree = treeFromOutline("0:1", outline, new RowDetailsStore(read));
    expect(tree.nodes.get("1:50")!.name).toBe("Layer 50");
    engineRows.set("1:50", { ...engineRows.get("1:50")!, name: "Changed" });
    expect(tree.nodes.get("1:50")!.name).toBe("Layer 50"); // in hand: no read
    tree.details.invalidate("1:50");
    expect(tree.details.has("1:50")).toBe(false);
    expect(tree.nodes.get("1:50")!.name).toBe("Changed");
    expect(read).toHaveBeenCalledTimes(2);
    // treeFromNodes keeps the rows it is given (a delta's, a test's): details from them, never a read.
    const kept = treeFromNodes("0:1", [...engineRows.values()].map((r) => ({ ...r, parentIndex: { guid: "0:1", position: "!" } })), new RowDetailsStore(read));
    expect(kept.nodes.get("1:7")!.name).toBe("Layer 7");
    expect(read).toHaveBeenCalledTimes(2);
  });
});

describe("selection in the panel", () => {
  it("⇧-click selects the rows from the anchor, ancestors winning over their children", () => {
    const rows = visibleRows(tree, new Set(["A"]));
    // G, B, A, a2, a1
    expect(rangeSelection(tree, rows, "B", "a1")).toEqual(["B", "A"]);
    expect(rangeSelection(tree, rows, "a1", "a2")).toEqual(["a2", "a1"]);
    expect(rangeSelection(tree, rows, null, "B")).toEqual(["B"]);
    expect(rangeSelection(tree, rows, "B", "nope")).toEqual([]);
  });

  it("⌘-click toggles one layer, dropping its ancestors and descendants", () => {
    expect(toggleSelection(tree, ["B"], "G")).toEqual(["B", "G"]);
    expect(toggleSelection(tree, ["B", "G"], "B")).toEqual(["G"]);
    expect(toggleSelection(tree, ["A", "B"], "a2x")).toEqual(["B", "a2x"]);
    expect(toggleSelection(tree, ["a1", "a2x"], "A")).toEqual(["A"]);
  });

  it("normalizes a selection", () => {
    expect(normalizeSelection(tree, ["a1", "A", "B", "B", "a2x"])).toEqual(["A", "B"]);
  });

  it("merges contiguous highlighted rows into runs", () => {
    const rows = visibleRows(tree, new Set(["A", "a2"]));
    // G, B, A, a2, a2x, a1 — A selected: A and its rows highlighted; G alone.
    const lit = new Set(["G", "A", "a2", "a2x", "a1"]);
    const runs = selectionRuns(rows, (id) => lit.has(id));
    expect(runs.get("G")).toBe("single");
    expect(runs.has("B")).toBe(false);
    expect([runs.get("A"), runs.get("a2"), runs.get("a2x"), runs.get("a1")]).toEqual(["start", "middle", "middle", "end"]);
  });
});

describe("drag and drop", () => {
  const rows = visibleRows(tree, new Set(["A"])); // G, B, A, a2, a1

  it("splits a row into zones: containers take drops in their middle half", () => {
    expect(dropZone(0.2, false)).toBe("before");
    expect(dropZone(0.6, false)).toBe("after");
    expect(dropZone(0.2, true)).toBe("before");
    expect(dropZone(0.5, true)).toBe("inside");
    expect(dropZone(0.9, true)).toBe("after");
  });

  it("above a row goes just above it in paint order, below it just below", () => {
    // Drag B above G: G is index 1 among [A, G] (B excluded) → index 2.
    expect(dropTarget(tree, rows, 0, 0.1, new Set(["B"]))).toEqual({ row: "G", position: "before", parent: "0:1", index: 2 });
    // Drag G below A (A is expanded, its children follow): into A, on top.
    expect(dropTarget(tree, rows, 2, 0.9, new Set(["G"]))).toEqual({ row: "A", position: "after", parent: "A", index: 2 });
    // Drag B below a1 (bottom child of A): a1 is index 0 in A → index 0.
    expect(dropTarget(tree, rows, 4, 0.9, new Set(["B"]))).toEqual({ row: "a1", position: "after", parent: "A", index: 0 });
  });

  it("inside a container goes on top of its children", () => {
    expect(dropTarget(tree, rows, 0, 0.5, new Set(["B"]))).toEqual({ row: "G", position: "inside", parent: "G", index: 2 });
  });

  it("refuses drops on or into a dragged layer", () => {
    expect(dropTarget(tree, rows, 2, 0.5, new Set(["A"]))).toBeNull();
    expect(dropTarget(tree, rows, 3, 0.5, new Set(["A"]))).toBeNull();
  });

  it("drops under every row at the bottom of the page", () => {
    expect(dropTarget(tree, rows, 99, 0.5, new Set(["G"]))).toMatchObject({ parent: "0:1", index: 0 });
  });

  it("drags the selection when the pressed row is selected, else that row", () => {
    expect(draggedLayers(tree, rows, ["a1", "G", "A"], "G")).toEqual(["G", "A"]);
    expect(draggedLayers(tree, rows, ["a1", "G"], "B")).toEqual(["B"]);
  });
});
