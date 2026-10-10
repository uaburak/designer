// Round 7's left panel, as plain data: auto layout children in flow order and drops there, Collapse layers, the
// panel order, Find's matching / filters / replace, the bulk rename, page dividers, the keyboard's panel lists.
import { describe, expect, it } from "vitest";
import type { NodeChange } from "@/engine/codec";
import { collapsedLayers, dropTarget, flowOrdered, inPanelOrder, treeFromNodes, visibleRows } from "../model/layerTree";
import { countByType, filterOf, findLayers, findPattern, matchRanges, remapStyleIds, replaceText, stepIndex, type FindNode } from "../model/find";
import { expandRename, renameAll } from "../model/rename";
import { isDividerName } from "../panels/Pages";
import { inOverlay } from "../keyboard";
import { layerIcon } from "../panels/Layers";
import { showsRailLabels } from "../panels/Rail";
import { COMMANDS, command, comboText } from "../commands";

const n = (guid: string, type: string, parent: string, childIds: string[] = [], extra: Record<string, unknown> = {}): NodeChange =>
  ({ guid, type, name: guid, parentIndex: { guid: parent, position: "!" }, childIds, ...extra }) as NodeChange;

// Page 0:1 (bottom → top): H (horizontal auto layout: h1 h2 h3), V (vertical: v1 v2), Gr (grid: g1 g2), F (frame: f1 f2).
const tree = treeFromNodes("0:1", [
  n("0:1", "CANVAS", "0:0", ["H", "V", "Gr", "F"]),
  n("H", "FRAME", "0:1", ["h1", "h2", "h3"], { stackMode: "HORIZONTAL" }),
  n("h1", "ROUNDED_RECTANGLE", "H"),
  n("h2", "ROUNDED_RECTANGLE", "H"),
  n("h3", "ROUNDED_RECTANGLE", "H"),
  n("V", "FRAME", "0:1", ["v1", "v2"], { stackMode: "VERTICAL", stackWrap: "NO_WRAP" }),
  n("v1", "TEXT", "V"),
  n("v2", "TEXT", "V"),
  n("Gr", "FRAME", "0:1", ["g1", "g2"], { stackMode: "GRID" }),
  n("g1", "ROUNDED_RECTANGLE", "Gr"),
  n("g2", "ROUNDED_RECTANGLE", "Gr"),
  n("F", "FRAME", "0:1", ["f1", "f2"]),
  n("f1", "ROUNDED_RECTANGLE", "F", [], { fillPaints: [{ type: "IMAGE" }] }),
  n("f2", "ROUNDED_RECTANGLE", "F", [], { fillPaints: [{ type: "VIDEO" }], mask: true }),
]);

describe("Layers: auto layout in flow order (live: AL_horizontal / AL_wrap list item1 first, AL_grid item4 first)", () => {
  it("lists a horizontal or vertical auto layout's children first-first, a grid and a frame top-first", () => {
    const rows = visibleRows(tree, new Set(["H", "V", "Gr", "F"]));
    expect(rows.map((r) => r.id)).toEqual(["F", "f2", "f1", "Gr", "g2", "g1", "V", "v1", "v2", "H", "h1", "h2", "h3"]);
    expect(flowOrdered(tree, "H")).toBe(true);
    expect(flowOrdered(tree, "Gr")).toBe(false);
    expect(flowOrdered(tree, "0:1")).toBe(false);
  });

  it("drops above a row in an auto layout go before it in the flow; inside goes first", () => {
    const rows = visibleRows(tree, new Set(["H", "F"]));
    const at = (id: string) => rows.findIndex((r) => r.id === id);
    // Above h2 (listed second): flow index 1; below it: 2.
    expect(dropTarget(tree, rows, at("h2"), 0.1, new Set(["X"]))).toMatchObject({ parent: "H", index: 1 });
    expect(dropTarget(tree, rows, at("h2"), 0.9, new Set(["X"]))).toMatchObject({ parent: "H", index: 2 });
    // Inside the auto layout: its first place (the top of the list); inside a frame: the top of the paint order.
    expect(dropTarget(tree, rows, at("H"), 0.5, new Set(["X"]))).toMatchObject({ parent: "H", index: 0, position: "inside" });
    expect(dropTarget(tree, rows, at("F"), 0.5, new Set(["X"]))).toMatchObject({ parent: "F", index: 2, position: "inside" });
    // A plain frame keeps the paint-order rule: above f1 = just above it in paint order.
    expect(dropTarget(tree, rows, at("f1"), 0.1, new Set(["X"]))).toMatchObject({ parent: "F", index: 1 });
  });

  it("Collapse layers closes this page's layers but the selection's branch, and keeps other pages'", () => {
    const next = collapsedLayers(tree, ["h2"], new Set(["H", "V", "F", "other-page-layer"]));
    expect([...next].sort()).toEqual(["H", "other-page-layer"]);
    expect([...collapsedLayers(tree, [], new Set(["H", "F"]))]).toEqual([]);
  });

  it("orders a selection as the panel lists it, everything open", () => {
    expect(inPanelOrder(tree, ["h3", "F", "v2", "h1", "nope"])).toEqual(["F", "v2", "h1", "h3", "nope"]);
  });

  it("draws images, videos and masks with their glyphs", () => {
    expect(layerIcon(tree.nodes.get("f1")!)).toBe("16.image");
    expect(layerIcon(tree.nodes.get("f2")!)).toBe("16.mask");
    expect(layerIcon(tree.nodes.get("h1")!)).toBe("16.rectangle");
  });
});

describe("Find (help \"Find and replace\", live find-filter-menu)", () => {
  const nodes: FindNode[] = [
    { id: "1", page: "p", type: "FRAME", name: "Card" },
    { id: "2", page: "p", type: "TEXT", name: "Title", text: "Hello card world", parent: "Card" },
    { id: "3", page: "p", type: "ROUNDED_RECTANGLE", name: "card bg", parent: "Card" },
    { id: "4", page: "p", type: "ROUNDED_RECTANGLE", name: "Cardholder photo", media: true },
    { id: "5", page: "p", type: "SLICE", name: "card slice" },
    { id: "6", page: "p", type: "INSTANCE", name: "Button" },
  ];

  it("matches names and a text's characters, case-insensitive, Other left out unless asked", () => {
    expect(findLayers(nodes, "card").map((r) => r.id)).toEqual(["1", "2", "3", "4"]);
    const text = findLayers(nodes, "card")[1];
    expect(text).toMatchObject({ inText: true, label: "Hello card world", ranges: [[6, 10]], parent: "Card" });
    expect(findLayers(nodes, "card", { types: ["other"] }).map((r) => r.id)).toEqual(["5"]);
    expect(findLayers(nodes, "card", { types: ["image", "frame"] }).map((r) => r.id)).toEqual(["1", "4"]);
  });

  it("Match case and Whole words", () => {
    expect(findLayers(nodes, "Card", { matchCase: true }).map((r) => r.id)).toEqual(["1", "4"]);
    expect(findLayers(nodes, "card", { wholeWords: true }).map((r) => r.id)).toEqual(["1", "2", "3"]);
    expect(matchRanges("a.b a.b", findPattern("a.b"))).toEqual([[0, 3], [4, 7]]);
  });

  it("counts per type for the Settings menu (All = every type but Other)", () => {
    expect(countByType(nodes, "card")).toEqual({ all: 4, frame: 1, text: 1, shape: 1, image: 1, other: 1 });
    expect(filterOf({ type: "FRAME", stateGroup: true })).toBe("component");
    expect(filterOf({ type: "SECTION" })).toBe("frame");
    expect(filterOf({ type: "VECTOR" })).toBe("shape");
  });

  it("replaces in the characters and keeps each run's style", () => {
    const r = replaceText("card and Card", "card", "tile");
    expect(r.text).toBe("tile and tile");
    // Styles: "card" in 1, " and " in 0, "Card" in 2 → each replacement takes its first character's style.
    expect(remapStyleIds([1, 1, 1, 1, 0, 0, 0, 0, 0, 2, 2, 2, 2], r.edits)).toEqual([1, 1, 1, 1, 0, 0, 0, 0, 0, 2, 2, 2, 2]);
    const longer = replaceText("ab", "a", "xyz");
    expect(remapStyleIds([3, 4], longer.edits)).toEqual([3, 3, 3, 4]);
    expect(replaceText("abc", "x", "y").edits).toEqual([]);
  });

  it("↑ ↓ wrap around", () => {
    expect(stepIndex(-1, 3, 1)).toBe(0);
    expect(stepIndex(-1, 3, -1)).toBe(2);
    expect(stepIndex(2, 3, 1)).toBe(0);
    expect(stepIndex(0, 0, 1)).toBe(-1);
  });
});

describe("Rename layers (⌘R on several)", () => {
  it("fills $&, $n / $nn up from the bottom row and $N down", () => {
    expect(expandRename("Item $nn of $&", "Rect", 3, 1)).toBe("Item 03 of Rect");
    expect(renameAll(["c", "b", "a"], { match: "", renameTo: "Screen $n", start: 1 })).toEqual(["Screen 3", "Screen 2", "Screen 1"]);
    expect(renameAll(["c", "b", "a"], { match: "", renameTo: "S$N", start: 1 })).toEqual(["S1", "S2", "S3"]);
  });

  it("Match replaces only the matched part; names without it stay", () => {
    expect(renameAll(["btn/primary", "btn/secondary", "card"], { match: "btn", renameTo: "button", start: 1 })).toEqual(["button/primary", "button/secondary", "card"]);
    expect(renameAll(["a", "b"], { match: "", renameTo: "", start: 1 })).toEqual(["a", "b"]);
  });
});

describe("Pages and the keyboard", () => {
  it("a divider is a name starting with a dash (or only dashes / asterisks)", () => {
    expect(isDividerName("---")).toBe(true);
    expect(isDividerName("- Archive")).toBe(false);
    expect(isDividerName("– Divider test")).toBe(false);
    expect(isDividerName("***")).toBe(true);
    expect(isDividerName("Page 1")).toBe(false);
    expect(isDividerName("")).toBe(false);
  });

  it("the Pages list and Find's results are no overlay: shortcuts work with a row focused", () => {
    const list = { closest: () => ({ getAttribute: (a: string) => (a === "role" ? "listbox" : a === "data-keys" ? "panel" : null) }) };
    const menu = { closest: () => ({ getAttribute: (a: string) => (a === "role" ? "menu" : null) }) };
    const g = globalThis as unknown as { Element?: unknown };
    const saved = g.Element;
    class FakeElement {}
    g.Element = FakeElement;
    try {
      expect(inOverlay(Object.assign(new FakeElement(), list) as unknown as EventTarget)).toBe(false);
      expect(inOverlay(Object.assign(new FakeElement(), menu) as unknown as EventTarget)).toBe(true);
    } finally {
      g.Element = saved;
    }
  });

  it("Figma's keys: Minimize UI ⇧⌘\\, Collapse layers ⌥L, Find ⌘F, Find next ⇧⌘F, Find previous ⇧⌘D", () => {
    expect(command("view.minimize-ui").keys?.[0]).toMatchObject({ code: "Backslash", mod: true, shift: true });
    expect(command("view.collapse-layers").keys?.[0]).toMatchObject({ code: "KeyL", alt: true });
    expect(command("edit.find").keys?.[0]).toMatchObject({ code: "KeyF", mod: true });
    expect(command("edit.find-next").keys?.[0]).toMatchObject({ code: "KeyF", mod: true, shift: true });
    expect(command("edit.find-previous").keys?.[0]).toMatchObject({ code: "KeyD", mod: true, shift: true });
    // None of them is another command's key.
    const ids = ["view.minimize-ui", "view.collapse-layers", "edit.find", "edit.find-next", "edit.find-previous", "file.libraries", "view.design-panel", "view.prototype-panel"];
    for (const id of ids)
      for (const k of command(id).keys ?? []) {
        const same = COMMANDS.filter((c) => c.keys?.some((o) => comboText(o) === comboText(k) && o.code === k.code));
        expect(same.map((c) => c.id), id).toEqual([id]);
      }
  });
});

describe("Navigation bar: icons only by default (owner, round 14)", () => {
  it("shows the tabs' names only once View › Additional labels turned them on", () => {
    expect(showsRailLabels({})).toBe(false);
    expect(showsRailLabels({ railLabels: false })).toBe(false);
    expect(showsRailLabels({ railLabels: true })).toBe(true);
  });
});
