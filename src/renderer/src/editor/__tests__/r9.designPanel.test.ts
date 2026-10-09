// Round 9 — Design panel sections and popovers (docs/editor.md "Round 9 — Design panel sections and popovers"): the
// first stroke's alignment, the export formats, the constraint glyphs, the effect type menu's flip and the grid
// dimensions picker's place, each against the live dumps in docs/research/figma/live/.
import { describe, expect, it } from "vitest";
import { place } from "@/ds/overlay/position";
import { EXPORT_FORMATS } from "../model/exports";
import { CONSTRAINT_ICONS, CONSTRAINT_OPTIONS } from "../model/constraints";
import { firstStrokeFields } from "../panels/design/Stroke";
import { GRID_PICKER, gridPickerOrigin } from "../panels/design/Grid";
import type { PanelNode } from "../panels/design/shared";

const node = (type: string, more: Record<string, unknown> = {}) => ({ guid: "7:60", type, ...more }) as unknown as PanelNode;

describe("Add stroke (live design/rectangle-with-stroke.txt: Stroke align reads Inside)", () => {
  it("closed shapes and frames get Inside with weight 1", () => {
    for (const type of ["ROUNDED_RECTANGLE", "ELLIPSE", "REGULAR_POLYGON", "STAR", "FRAME"]) expect(firstStrokeFields(node(type), 1)).toEqual({ strokeWeight: 1, strokeAlign: "INSIDE" });
  });
  it("lines, open vectors and text keep their alignment", () => {
    for (const type of ["LINE", "VECTOR", "TEXT"]) expect(firstStrokeFields(node(type), 1)).toEqual({ strokeWeight: 1 });
  });
  it("an alignment already chosen (Outside) is kept", () => {
    expect(firstStrokeFields(node("ROUNDED_RECTANGLE", { strokeAlign: "OUTSIDE" }), 1)).toEqual({ strokeWeight: 1 });
  });
});

describe("Export (live popovers/export-format-menu.txt)", () => {
  it("the file types read PNG, JPEG, SVG, PDF", () => {
    expect(EXPORT_FORMATS.map((f) => f.label)).toEqual(["PNG", "JPEG", "SVG", "PDF"]);
  });
});

describe("Constraints (live design/frame-child-constraints-expanded.txt)", () => {
  it("every option of both dropdowns has its glyph", () => {
    for (const axis of ["horizontal", "vertical"] as const) for (const o of CONSTRAINT_OPTIONS[axis]) expect(CONSTRAINT_ICONS[axis][o.value as keyof (typeof CONSTRAINT_ICONS)[typeof axis]]).toMatch(/^24\.constraint\./);
  });
});

describe("Effect type menu (live popovers/effect-type-menu.txt: 147 × 207 at 967,449)", () => {
  it("without room under the header's type button it flips above it, 12 away, at the button's left", () => {
    // The effect settings popover at 959,660: its type button at 967,668 (117 × 24).
    const trigger = { left: 967, top: 668, right: 967 + 117, bottom: 668 + 24 };
    expect(place(trigger, { width: 147, height: 207 }, { width: 1440, height: 900 }, "bottom", "start", 12)).toEqual({ x: 967, y: 449, side: "top" });
  });
  it("with room it opens under the button", () => {
    const trigger = { left: 967, top: 300, right: 1084, bottom: 324 };
    expect(place(trigger, { width: 147, height: 207 }, { width: 1440, height: 900 }, "bottom", "start", 12)).toEqual({ x: 967, y: 336, side: "bottom" });
  });
});

describe("Grid dimensions picker (live grid/grid-dimensions-picker.txt: 210 × 204 at 1204,427)", () => {
  it("a 12 × 8 board in a 210 wide picker", () => {
    expect(GRID_PICKER).toEqual({ columns: 12, rows: 8, width: 210 });
  });
  it("opens 12 left of the grid's button and 57 above it", () => {
    expect(gridPickerOrigin({ left: 1216, top: 484 })).toEqual({ x: 1204, y: 427 });
  });
});
