import { describe, expect, it } from "vitest";
import { clickSelection, idsInRect, inOrder, moveSelection, type SelectionState } from "../util/selection";
import { listTemplate, nextSort } from "../components/ListView";
import { collectionTarget } from "../components/CollectionView";
import { renameSelection } from "../components/InlineEdit";

const order = ["a", "b", "c", "d", "e"];
const none: SelectionState = { selected: [], anchor: null };

describe("selection model", () => {
  it("a click selects one and sets the anchor", () => {
    expect(clickSelection(order, { selected: ["a", "b"], anchor: "a" }, "d")).toEqual({ selected: ["d"], anchor: "d" });
  });
  it("⌘-click toggles and moves the anchor; the result stays in list order", () => {
    let s = clickSelection(order, none, "d");
    s = clickSelection(order, s, "b", { toggle: true });
    expect(s).toEqual({ selected: ["b", "d"], anchor: "b" });
    s = clickSelection(order, s, "d", { toggle: true });
    expect(s).toEqual({ selected: ["b"], anchor: "d" });
  });
  it("⇧-click selects the range from the anchor, either way, keeping the anchor", () => {
    const s = clickSelection(order, { selected: ["b"], anchor: "b" }, "d", { shift: true });
    expect(s).toEqual({ selected: ["b", "c", "d"], anchor: "b" });
    expect(clickSelection(order, s, "a", { shift: true })).toEqual({ selected: ["a", "b"], anchor: "b" });
  });
  it("⇧⌘-click adds the range to what was selected", () => {
    expect(clickSelection(order, { selected: ["e"], anchor: "a" }, "b", { shift: true, toggle: true })).toEqual({ selected: ["a", "b", "e"], anchor: "a" });
  });
  it("⇧-click without an anchor selects just that one", () => {
    expect(clickSelection(order, none, "c", { shift: true })).toEqual({ selected: ["c"], anchor: "c" });
  });
  it("arrows: plain moves select, ⇧ extends", () => {
    expect(moveSelection(order, { selected: ["b"], anchor: "b" }, "c", false)).toEqual({ selected: ["c"], anchor: "c" });
    expect(moveSelection(order, { selected: ["b"], anchor: "b" }, "d", true)).toEqual({ selected: ["b", "c", "d"], anchor: "b" });
  });
  it("drops ids that left the list", () => {
    expect(inOrder(order, ["z", "c", "a", "c"])).toEqual(["a", "c"]);
  });
  it("finds the boxes a marquee meets", () => {
    const items = [
      { id: "a", rect: { left: 0, top: 0, right: 10, bottom: 10 } },
      { id: "b", rect: { left: 20, top: 0, right: 30, bottom: 10 } },
      { id: "c", rect: { left: 0, top: 20, right: 10, bottom: 30 } },
    ];
    expect(idsInRect(items, { left: 5, top: 5, right: 25, bottom: 8 })).toEqual(["a", "b"]);
    expect(idsInRect(items, { left: 10, top: 10, right: 20, bottom: 20 })).toEqual([]);
  });
});

describe("collection keyboard targets", () => {
  // 3 columns of 268 + 36, two rows (the second has two items)
  const r = (col: number, row: number) => ({ left: col * 304, top: row * 249, right: col * 304 + 268, bottom: row * 249 + 213 });
  const grid = [r(0, 0), r(1, 0), r(2, 0), r(0, 1), r(1, 1)].map((rect, i) => ({ id: String(i), rect }));
  it("← → step through the order in a grid, stopping at the ends", () => {
    expect(collectionTarget("ArrowRight", grid, 2, "grid")).toBe(3);
    expect(collectionTarget("ArrowLeft", grid, 0, "grid")).toBe(0);
    expect(collectionTarget("ArrowRight", grid, 4, "grid")).toBe(4);
    expect(collectionTarget("ArrowRight", grid, 1, "list")).toBeNull();
  });
  it("↑ ↓ go to the nearest item in the next row by centre", () => {
    expect(collectionTarget("ArrowDown", grid, 1, "grid")).toBe(4);
    expect(collectionTarget("ArrowDown", grid, 2, "grid")).toBe(4); // no third column below: the nearest
    expect(collectionTarget("ArrowUp", grid, 3, "grid")).toBe(0);
    expect(collectionTarget("ArrowDown", grid, 3, "grid")).toBe(3); // last row: stays
  });
  it("Home / End, and the first press with nothing focused", () => {
    expect(collectionTarget("End", grid, 1, "grid")).toBe(4);
    expect(collectionTarget("Home", grid, 3, "grid")).toBe(0);
    expect(collectionTarget("ArrowDown", grid, -1, "grid")).toBe(0);
    expect(collectionTarget("ArrowUp", grid, -1, "grid")).toBe(4);
    expect(collectionTarget("a", grid, 0, "grid")).toBeNull();
  });
});

describe("list view helpers", () => {
  it("builds the column template", () => {
    expect(listTemplate([{ id: "name", label: "Name" }, { id: "edited", label: "Last modified", width: 160 }, { id: "x", label: "X", width: "minmax(80px, 1fr)" }])).toBe("minmax(0, 1fr) 160px minmax(80px, 1fr)");
  });
  it("flips the sort on the same column, starts others at their first direction", () => {
    expect(nextSort(null, "name")).toEqual({ column: "name", direction: "ascending" });
    expect(nextSort({ column: "name", direction: "ascending" }, "name")).toEqual({ column: "name", direction: "descending" });
    expect(nextSort({ column: "name", direction: "ascending" }, "edited", "descending")).toEqual({ column: "edited", direction: "descending" });
  });
  it("selects the name without its extension when asked", () => {
    expect(renameSelection("Logo.svg", "name")).toEqual([0, 4]);
    expect(renameSelection(".env", "name")).toEqual([0, 4]);
    expect(renameSelection("Portfolio", "name")).toEqual([0, 9]);
    expect(renameSelection("Portfolio", "end")).toEqual([9, 9]);
  });
});
