// Round 8 — the Design panel as live Figma's (docs/editor.md "Round 8 — Design panel"): Pattern paints through the
// picker, the font style menu's groups, the Grid panel's track removal, the constraints' and menus' live wording.
import { describe, expect, it } from "vitest";
import { convertPaint, PAINT_TABS, type PickerPaint } from "@/ds/util/paint";
import { fromPicker, paintLabel, toPicker, type FullPaint } from "../model/paints";
import { groupStyles, styleWeight } from "../fontList";
import { removeTrackAt, setTrackCount, setTrackSizing, tracksOf, type GridNode } from "../model/grid";
import { CONSTRAINT_OPTIONS } from "../model/constraints";
import { guidOf } from "../panels/design/Paints";
import { SHADER_FILL_PRESETS } from "../panels/design/Effects";

describe("Pattern paints (live popovers/fill-picker-pattern.txt)", () => {
  it("the picker's tabs are Solid, Gradient, Pattern, Image, Video (Shader opens its browser)", () => {
    expect(PAINT_TABS.map((t) => t.label)).toEqual(["Solid", "Gradient", "Pattern", "Image", "Video"]);
    expect(SHADER_FILL_PRESETS.slice(0, 4)).toEqual(["Moving gradient", "Mesh gradient", "Nebula", "Water caustic"]);
  });

  it("Solid → Pattern takes Figma's defaults; back to Solid drops the pattern's fields", () => {
    const solid: FullPaint = { type: "SOLID", color: { r: 1, g: 0, b: 0, a: 1 }, opacity: 1, visible: true };
    const picked = convertPaint(toPicker(solid), "PATTERN");
    const pattern = fromPicker(solid, picked);
    expect(pattern).toMatchObject({ type: "PATTERN", scale: 1, patternSpacing: { x: 0, y: 0 }, patternTileType: "RECTANGULAR", horizontalAlignment: "START", verticalAlignment: "START", visible: true });
    expect(pattern.color).toBeUndefined();
    expect(paintLabel(pattern)).toBe("Pattern");
    const withSource = { ...pattern, sourceNodeId: { sessionID: 7, localID: 60 } } as FullPaint;
    // A same-type edit keeps the source.
    const edited = fromPicker(withSource, { ...(toPicker(withSource) as PickerPaint), patternTileType: "HORIZONTAL_HEXAGONAL", patternSpacing: { x: 0.2, y: 0.1 } });
    expect(edited).toMatchObject({ sourceNodeId: { sessionID: 7, localID: 60 }, patternTileType: "HORIZONTAL_HEXAGONAL", patternSpacing: { x: 0.2, y: 0.1 } });
    const back = fromPicker(edited, convertPaint(toPicker(edited), "SOLID"));
    expect(back.type).toBe("SOLID");
    for (const k of ["sourceNodeId", "patternSpacing", "patternTileType", "horizontalAlignment", "verticalAlignment", "scale"]) expect(back[k]).toBeUndefined();
  });

  it("reads a source as the engine writes it or as a string", () => {
    expect(guidOf({ sessionID: 7, localID: 60 })).toBe("7:60");
    expect(guidOf("7:60")).toBe("7:60");
    expect(guidOf("nope")).toBeNull();
    expect(guidOf(undefined)).toBeNull();
  });
});

describe("Font style menu (live popovers/font-weight-menu.txt)", () => {
  it("upright styles by weight, then the italics", () => {
    const list = ["Bold Italic", "Thin", "Regular", "Italic", "Black", "Semi Bold", "Thin Italic", "Extra Light", "Medium"];
    expect(groupStyles(list)).toEqual({ upright: ["Thin", "Extra Light", "Regular", "Medium", "Semi Bold", "Black"], italic: ["Thin Italic", "Italic", "Bold Italic"] });
    expect(styleWeight("Extra Bold Italic")).toBe(800);
    expect(styleWeight("Semi Bold")).toBe(600);
    expect(styleWeight("Light")).toBe(300);
    expect(styleWeight("Regular")).toBe(400);
  });
});

describe("The Grid panel (live grid/row-track-selected-panel.txt)", () => {
  const grid = (): GridNode => {
    const base = { stackMode: "GRID" } as GridNode;
    const cols = setTrackCount(base, "columns", 3, 7).frame;
    const rows = setTrackCount({ ...base, ...cols } as GridNode, "rows", 2, 7).frame;
    return { ...base, ...cols, ...rows } as GridNode;
  };

  it("Remove column n of m: that track goes, its items move to the one before (the first: the next)", () => {
    const n = grid();
    const cols = tracksOf(n, "columns");
    const items = [
      { guid: "1:1", node: { gridColumnAnchor: cols[1].id } },
      { guid: "1:2", node: { gridColumnAnchor: cols[0].id } },
      { guid: "1:3", node: { gridColumnAnchor: cols[2].id } },
    ];
    const r = removeTrackAt(n, "columns", 1, items)!;
    const after = tracksOf({ ...n, ...r.frame } as GridNode, "columns");
    expect(after.map((t) => t.id)).toEqual([cols[0].id, cols[2].id]);
    expect(r.items).toEqual([{ guid: "1:1", fields: { gridColumnAnchor: cols[0].id } }]);
    const first = removeTrackAt(n, "columns", 0, items)!;
    expect(first.items).toEqual([{ guid: "1:2", fields: { gridColumnAnchor: cols[1].id } }]);
  });

  it("never removes the last track; sizes stay with their tracks", () => {
    const one = { ...grid(), ...setTrackCount(grid(), "rows", 1, 7).frame } as GridNode;
    expect(removeTrackAt(one, "rows", 0)).toBeNull();
    const n = { ...grid(), ...setTrackSizing(grid(), "columns", [2], { type: "FIXED", value: 84 }) } as GridNode;
    const r = removeTrackAt(n, "columns", 0)!;
    expect(tracksOf({ ...n, ...r.frame } as GridNode, "columns").map((t) => t.sizing)).toEqual([
      { type: "HUG", value: 1 },
      { type: "FIXED", value: 84 },
    ]);
  });
});

describe("Live wording", () => {
  it("constraints read Left + Right / Top + Bottom (popovers/constraint-*-menu.txt)", () => {
    expect(CONSTRAINT_OPTIONS.horizontal.map((o) => o.label)).toEqual(["Left", "Right", "Left + Right", "Center", "Scale"]);
    expect(CONSTRAINT_OPTIONS.vertical.map((o) => o.label)).toEqual(["Top", "Bottom", "Top + Bottom", "Center", "Scale"]);
  });
});
