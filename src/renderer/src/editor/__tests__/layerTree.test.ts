import { describe, expect, it } from "vitest";
import type { NodeChange } from "@/engine/codec";
import {
  ancestorsOf,
  draggedLayers,
  dropTarget,
  dropZone,
  normalizeSelection,
  rangeSelection,
  revealed,
  selectionRuns,
  toggleSelection,
  treeFromNodes,
  visibleRows,
  withSubtree,
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
