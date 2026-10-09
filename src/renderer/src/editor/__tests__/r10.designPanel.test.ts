// Round 10 — Design panel states, popovers and sub-menus (docs/editor.md "Round 10 — Design panel states, popovers and
// sub-menus"): the nested instance's locks, Selection colors' rows, the font filter's groups, the grid track list, the
// Variable tab's axes, vector edit mode's points and mirroring, layout guide variables and the frame presets, each
// against the live dumps in docs/research/figma/live/.
import { describe, expect, it } from "vitest";
import { setTrackCount, setTrackSizing, type GridNode } from "../model/grid";
import { collectSelectionColors, SELECTION_COLORS_SHOWN } from "../model/selectionColors";
import { FONT_FILTER_MENU } from "../fontList";
import { NO_VECTOR_EDIT, pointsSummary, readVectorEdit } from "../vectorEdit";
import { isInstanceSublayer } from "../panels/design/shared";
import { trackMenu, trackSize } from "../panels/design/Grid";
import { axisOrder, axisStops } from "../panels/design/TypeSettings";
import { MIRRORING_OPTIONS } from "../panels/design/VectorPoints";
import { guideVariable } from "../panels/design/Effects";
import { FRAME_PRESETS } from "../panels/design/Header";
import type { NodeChange } from "@/engine/codec";
import type { LayoutGrid } from "../panels/design/shared";
import { placeBelow } from "@/ds/overlay/position";

const solid = (hex: number) => ({ type: "SOLID", visible: true, opacity: 1, color: { r: ((hex >> 16) & 255) / 255, g: ((hex >> 8) & 255) / 255, b: (hex & 255) / 255, a: 1 } });
const layer = (guid: string, fills: number[], strokes: number[] = []) => ({ guid, fillPaints: fills.map(solid), strokePaints: strokes.map(solid) }) as unknown as NodeChange;

describe("Nested instance (live design/nested-instance.txt: X / Y, Rotation, Flow, Wrap, Lock aspect ratio disabled)", () => {
  it("a layer inside an instance is told by its instance path", () => {
    expect(isInstanceSublayer({ guid: "I8:62;8:51" })).toBe(true);
    expect(isInstanceSublayer({ guid: "8:62" })).toBe(false);
  });
});

describe("Selection colors (live design/mixed-multi.txt: D9D9D9, 000000, 3380FF, FFFFFF, no link)", () => {
  it("one group per selected layer in selection order, each group's new colours by hex", () => {
    // Rect, Ellipse, Text, F_frame (its child C_child_in_frame 3380FF before it)
    const rows = collectSelectionColors([[layer("7:60", [0xd9d9d9])], [layer("7:61", [0xd9d9d9])], [layer("7:90", [0x000000])], [layer("7:2", [0x3380ff]), layer("7:1", [0xffffff])]]);
    expect(rows.map((c) => c.key.slice(0, 7).toUpperCase())).toEqual(["#D9D9D9", "#000000", "#3380FF", "#FFFFFF"]);
  });
  it("four rows show before a See all link", () => expect(SELECTION_COLORS_SHOWN).toBe(4));
});

describe("Font filter (live popovers/font-picker-filter-menu.txt: 240 × 229)", () => {
  it("All fonts | In this file | Popular, Google, Variable fonts | Uploaded by you, Installed by you", () => {
    expect(FONT_FILTER_MENU.map((e) => (e === "-" ? "-" : e.label))).toEqual(["All fonts", "-", "In this file", "-", "Popular fonts", "Google fonts", "Variable fonts", "-", "Uploaded by you", "Installed by you"]);
  });
});

describe("Grid track list (live grid/row-track-menu.txt: Fixed height (84), Hug contents, Fill container (1fr))", () => {
  // The capture's AL_grid: 320 × 200, padding 12, gaps 8, 3 × 2 tracks of 1fr.
  const base = { stackMode: "GRID" } as GridNode;
  const cols = setTrackCount(base, "columns", 3, 7).frame;
  const both = { ...base, ...cols, ...setTrackCount({ ...base, ...cols } as GridNode, "rows", 2, 7).frame } as GridNode;
  const fill = { type: "FLEX" as const, value: 1 };
  const filled = { ...both, ...setTrackSizing(both, "columns", [0, 1, 2], fill) } as GridNode;
  const grid = { ...filled, ...setTrackSizing(filled, "rows", [0, 1], fill), size: { x: 320, y: 200 }, gridColumnGap: 8, gridRowGap: 8, stackHorizontalPadding: 12, stackPaddingRight: 12, stackVerticalPadding: 12, stackPaddingBottom: 12 } as GridNode & { size: { x: number; y: number } };
  it("a fill row is its share of what padding and gaps leave", () => {
    expect(trackSize(grid, "rows", 1)).toBe(84);
    expect(trackSize(grid, "columns", 0)).toBe(Math.round((320 - 24 - 16) / 3));
  });
  it("the list reads live's labels, the current sizing checked", () => {
    const menu = trackMenu(grid, "rows", 1);
    expect(menu.map((e) => (typeof e === "object" && "label" in e ? e.label : e))).toEqual(["Fixed height (84)", "Hug contents", "Fill container (1fr)"]);
    expect(menu.map((e) => (typeof e === "object" && "checked" in e ? e.checked : null))).toEqual([false, false, true]);
  });
});

describe("Type settings › Variable (live popovers/type-settings-variable.txt: Slant at 194, Weight at 259)", () => {
  it("the axes by name", () => {
    expect(axisOrder([{ tag: "wght", name: "Weight" }, { tag: "slnt", name: "Slant" }]).map((a) => a.tag)).toEqual(["slnt", "wght"]);
  });
  it("Weight marks every 100 (nine for 100…900), another axis its default", () => {
    expect(axisStops({ tag: "wght", min: 100, max: 900, default: 400 })).toEqual([100, 200, 300, 400, 500, 600, 700, 800, 900]);
    expect(axisStops({ tag: "slnt", min: -10, max: 0, default: 0 })).toEqual([0]);
  });
});

describe("Vector edit mode (live design/vector-edit-mode.txt, vector-edit-point-selected.txt)", () => {
  it("Mirroring's three glyphs in live's order and wording", () => {
    expect(MIRRORING_OPTIONS.map((o) => o.label)).toEqual(["No mirroring", "Mirror angle", "Mirror angle and length"]);
    expect(MIRRORING_OPTIONS.every((o) => o.icon.startsWith("24.vector.mirror"))).toBe(true);
  });
  it("the selected points' X / Y are their box's top left; the radius when they share it", () => {
    const s = readVectorEdit({ active: true, ref: "7:66", selectedVertices: [0, 2], points: [{ index: 0, x: 940, y: 300, cornerRadius: 4 }, { index: 2, x: 900, y: 390, cornerRadius: 4 }] });
    expect(pointsSummary(s.points)).toEqual({ x: 900, y: 300, radius: 4 });
    expect(pointsSummary([{ index: 0, x: 1, y: 2, cornerRadius: 0 }, { index: 1, x: 3, y: 4, cornerRadius: 2 }])?.radius).toBeNull();
    expect(pointsSummary(NO_VECTOR_EDIT.points)).toBeNull();
  });
});

describe("Layout guide (live design/frame-with-layout-guide.txt: Size's Apply variable)", () => {
  it("reads the variable a guide's size is bound to", () => {
    const g = { pattern: "GRID", sectionSize: 8, sectionSizeVar: { dataType: "ALIAS", resolvedDataType: "FLOAT", value: { alias: { guid: { sessionID: 3, localID: 9 } } } } } as unknown as LayoutGrid;
    expect(guideVariable(g, "sectionSizeVar")).toBe("3:9");
    expect(guideVariable({ pattern: "GRID" } as LayoutGrid, "sectionSizeVar")).toBeNull();
  });
});

describe("Frame presets (live popovers/frame-presets-menu.txt: 222 × 1887, one list)", () => {
  it("the inch marks of live's names", () => {
    const names = FRAME_PRESETS.flatMap((g) => g.items.map(([n]) => n));
    for (const n of ['iPad Pro 11"', 'iPad Pro 12.9"', 'MacBook Pro 14"', 'MacBook Pro 16"']) expect(names).toContain(n);
  });
});

describe("Select lists under their field (live popovers/export-format-menu.txt, layout-guide-type-menu.txt)", () => {
  it("flush under the trigger, 8 left of it", () => {
    expect(placeBelow({ left: 976, top: 768, right: 1032, bottom: 792 }, { width: 110, height: 88 }, { width: 1440, height: 900 })).toEqual({ x: 968, y: 792 });
  });
  it("above it without the room", () => {
    expect(placeBelow({ left: 976, top: 860, right: 1032, bottom: 884 }, { width: 110, height: 88 }, { width: 1440, height: 900 })).toEqual({ x: 968, y: 772 });
  });
});
