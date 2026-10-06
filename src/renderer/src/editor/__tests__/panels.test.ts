// The Design panel's Phase 2 rules as plain data: sizing (Hug / Fill / Fixed, min / max), constraints,
// Selection colors, text views, and the types the panel names and draws.
import { describe, expect, it } from "vitest";
import type { NodeChange } from "@/engine/codec";
import { canFill, canHug, canLimit, limitOf, sizingChanges, sizingOf, withLimit, withoutLimits, type SizingNode } from "../model/sizing";
import { clickConstraint, hasConstraints, selectedSides } from "../model/constraints";
import { collectColors, recolor, showSelectionColors } from "../model/selectionColors";
import { hexToColor } from "../model/color";
import { lineHeightView } from "../panels/design/Typography";
import { nodeTypeLabel, typeLabel } from "../panels/design/shared";
import { layerIcon } from "../panels/Layers";

const vertical: SizingNode = { type: "FRAME", stackMode: "VERTICAL", stackPrimarySizing: "RESIZE_TO_FIT_WITH_IMPLICIT_SIZE", stackCounterSizing: "FIXED" };
const horizontal: SizingNode = { type: "FRAME", stackMode: "HORIZONTAL", stackPrimarySizing: "FIXED", stackCounterSizing: "FIXED" };
const rect: SizingNode = { type: "ROUNDED_RECTANGLE", size: { x: 100, y: 40 }, stackChildPrimaryGrow: 0, stackChildAlignSelf: "AUTO", minSize: { value: { x: 0, y: 0 } }, maxSize: { value: { x: 0, y: 0 } } };

describe("sizing", () => {
  it("reads Hug from an auto-layout frame's own sizing (absent primary = Hug)", () => {
    expect(sizingOf(vertical, null, "y")).toBe("HUG");
    expect(sizingOf(vertical, null, "x")).toBe("FIXED");
    expect(sizingOf({ type: "FRAME", stackMode: "HORIZONTAL" }, null, "x")).toBe("HUG");
    expect(sizingOf(rect, null, "x")).toBe("FIXED");
  });

  it("reads Fill along the parent's flow (grow) and across it (stretch)", () => {
    expect(sizingOf({ ...rect, stackChildPrimaryGrow: 1 }, horizontal, "x")).toBe("FILL");
    expect(sizingOf({ ...rect, stackChildAlignSelf: "STRETCH" }, horizontal, "y")).toBe("FILL");
    expect(sizingOf({ ...rect, stackChildPrimaryGrow: 1, stackPositioning: "ABSOLUTE" }, horizontal, "x")).toBe("FIXED");
  });

  it("offers Hug to auto layout and text, Fill and min/max inside auto layout", () => {
    expect(canHug(vertical)).toBe(true);
    expect(canHug({ type: "TEXT" })).toBe(true);
    expect(canHug(rect)).toBe(false);
    expect(canFill(rect, horizontal)).toBe(true);
    expect(canFill(rect, { type: "FRAME", stackMode: "NONE" })).toBe(false);
    expect(canLimit(rect, null)).toBe(false);
    expect(canLimit(vertical, null)).toBe(true);
  });

  it("writes Fill on the child and turns a hugging parent's axis Fixed", () => {
    const parent = { ...horizontal, stackPrimarySizing: "RESIZE_TO_FIT_WITH_IMPLICIT_SIZE" as const };
    expect(sizingChanges(rect, parent, "x", "FILL")).toEqual({ node: { stackChildPrimaryGrow: 1 }, parent: { stackPrimarySizing: "FIXED" } });
    expect(sizingChanges(rect, horizontal, "y", "FILL")).toEqual({ node: { stackChildAlignSelf: "STRETCH" }, parent: null });
    // A hugging auto-layout child set to Fill stops hugging that axis
    expect(sizingChanges(vertical, horizontal, "y", "FILL").node).toEqual({ stackPrimarySizing: "FIXED", stackChildAlignSelf: "STRETCH" });
    expect(sizingChanges(vertical, null, "x", "HUG").node).toEqual({ stackCounterSizing: "RESIZE_TO_FIT_WITH_IMPLICIT_SIZE" });
    expect(sizingChanges({ ...rect, stackChildPrimaryGrow: 1 }, horizontal, "x", "FIXED").node).toEqual({ stackChildPrimaryGrow: 0 });
  });

  it("maps text resizing onto textAutoResize", () => {
    const text = { type: "TEXT", textAutoResize: "NONE" };
    expect(sizingChanges(text, null, "x", "HUG").node).toEqual({ textAutoResize: "WIDTH_AND_HEIGHT" });
    expect(sizingChanges(text, null, "y", "HUG").node).toEqual({ textAutoResize: "HEIGHT" });
    expect(sizingChanges({ type: "TEXT", textAutoResize: "WIDTH_AND_HEIGHT" }, null, "x", "FIXED").node).toEqual({ textAutoResize: "HEIGHT" });
    expect(sizingOf({ type: "TEXT", textAutoResize: "HEIGHT" }, null, "y")).toBe("HUG");
    expect(sizingOf({ type: "TEXT", textAutoResize: "HEIGHT" }, null, "x")).toBe("FIXED");
  });

  it("keeps min / max per axis, 0 = none", () => {
    const limited = { ...rect, ...withLimit(rect, "min", "x", 50) } as SizingNode;
    expect(limitOf(limited, "min", "x")).toBe(50);
    expect(limitOf(limited, "min", "y")).toBeNull();
    expect(withLimit(limited, "min", "y", 20)).toEqual({ minSize: { value: { x: 50, y: 20 } } });
    // A limit the size breaks clamps the size with it.
    expect(withLimit(rect, "max", "x", 80)).toEqual({ maxSize: { value: { x: 80, y: 0 } }, size: { x: 80, y: 40 } });
    expect(withLimit(rect, "min", "y", 60)).toEqual({ minSize: { value: { x: 0, y: 60 } }, size: { x: 100, y: 60 } });
    expect(withoutLimits(limited, "x")).toEqual({ minSize: { value: { x: 0, y: 0 } }, maxSize: { value: { x: 0, y: 0 } } });
  });
});

describe("constraints", () => {
  it("clicks a line: one side, ⇧ for both, ⇧ again to drop one; the cross centres", () => {
    expect(clickConstraint("MIN", "max", false)).toBe("MAX");
    expect(clickConstraint("MIN", "max", true)).toBe("STRETCH");
    expect(clickConstraint("STRETCH", "min", true)).toBe("MAX");
    expect(clickConstraint("SCALE", "center", false)).toBe("CENTER");
    expect(clickConstraint("FIXED_MAX" as never, "min", true)).toBe("STRETCH");
  });

  it("lights the lines of a constraint", () => {
    expect(selectedSides("STRETCH")).toEqual(["min", "max"]);
    expect(selectedSides("SCALE")).toEqual([]);
  });

  it("shows for children of frames (through groups), not on the page or in auto layout", () => {
    const page = { type: "CANVAS", group: false };
    const frame = { type: "FRAME", group: false, stackMode: "NONE" };
    const al = { type: "FRAME", group: false, stackMode: "VERTICAL" };
    const group = { type: "FRAME", group: true };
    expect(hasConstraints([frame, page], false)).toBe(true);
    expect(hasConstraints([page], false)).toBe(false);
    expect(hasConstraints([group, page], false)).toBe(false);
    expect(hasConstraints([group, frame, page], false)).toBe(true);
    expect(hasConstraints([al, page], false)).toBe(false);
    expect(hasConstraints([al, page], true)).toBe(true);
  });
});

const solid = (hex: string, opacity = 1, visible = true) => ({ type: "SOLID" as const, color: hexToColor(hex), opacity, visible });
const n = (guid: string, fills: ReturnType<typeof solid>[], strokes: ReturnType<typeof solid>[] = []): NodeChange => ({ guid, fillPaints: fills, strokePaints: strokes });

describe("selection colors", () => {
  it("lists each solid colour once, fills and strokes, without hidden paints", () => {
    const colors = collectColors([n("1", [solid("#ffffff")], [solid("#000000")]), n("2", [solid("#FFFFFF"), solid("#ff0000", 1, false)]), n("3", [solid("#ffffff", 0.5)])]);
    expect(colors.map((c) => c.key)).toEqual(["#ffffff/100", "#000000/100", "#ffffff/50"]);
    expect(colors[0].uses).toEqual([
      { guid: "1", field: "fillPaints", index: 0 },
      { guid: "2", field: "fillPaints", index: 0 },
    ]);
  });

  it("shows for layers with coloured children, or several layers whose colours differ", () => {
    const a = n("1", [solid("#ffffff")]);
    const b = n("2", [solid("#ffffff")]);
    const c = n("3", [solid("#ff0000")]);
    expect(showSelectionColors([a], [])).toBe(false);
    expect(showSelectionColors([a], [c])).toBe(true);
    expect(showSelectionColors([a, b], [])).toBe(false);
    expect(showSelectionColors([a, c], [])).toBe(true);
  });

  it("recolours every use in one write per node, keeping the other paints", () => {
    const nodes = new Map([
      ["1", n("1", [solid("#ffffff"), solid("#00ff00")], [solid("#ffffff")])],
      ["2", n("2", [solid("#ffffff")])],
    ]);
    const uses = collectColors([...nodes.values()])[0].uses;
    const out = recolor(nodes, uses, { color: hexToColor("#123456") });
    expect(out.size).toBe(2);
    expect(out.get("1")?.fillPaints?.[0].color).toEqual(hexToColor("#123456"));
    expect(out.get("1")?.fillPaints?.[1].color).toEqual(hexToColor("#00ff00"));
    expect(out.get("1")?.strokePaints?.[0].color).toEqual(hexToColor("#123456"));
    expect(recolor(nodes, uses, { opacity: 0.5 }).get("2")?.fillPaints?.[0].opacity).toBe(0.5);
  });
});

describe("text and types", () => {
  it("shows line height as Auto, px or percent", () => {
    expect(lineHeightView({ value: 100, units: "PERCENT" })).toEqual({ value: null, label: "Auto" });
    expect(lineHeightView({ value: 24, units: "PIXELS" })).toEqual({ value: 24 });
    expect(lineHeightView({ value: 1.4, units: "RAW" })).toEqual({ value: 140, unit: "%" });
    expect(lineHeightView(undefined).label).toBe("Auto");
  });

  it("names and draws layers by their real type", () => {
    expect(nodeTypeLabel({ guid: "1", type: "VECTOR" })).toBe("Vector path");
    expect(nodeTypeLabel({ guid: "1", type: "BOOLEAN_OPERATION", booleanOperation: "SUBTRACT" })).toBe("Subtract");
    expect(nodeTypeLabel({ guid: "1", type: "TEXT" })).toBe("Text");
    expect(nodeTypeLabel({ guid: "1", type: "INSTANCE" })).toBe("Instance");
    expect(typeLabel([{ guid: "1", type: "SYMBOL" }])).toBe("Component");
    const row = { id: "1", parent: "0:1", name: "V", visible: true, locked: false, group: false, children: [] };
    expect(layerIcon({ ...row, type: "VECTOR" })).toBe("16.vector");
    expect(layerIcon({ ...row, type: "BOOLEAN_OPERATION", booleanOperation: "XOR" })).toBe("16.boolean.exclude");
    expect(layerIcon({ ...row, type: "BOOLEAN_OPERATION" })).toBe("16.boolean.union");
    expect(layerIcon({ ...row, type: "TEXT" })).toBe("16.text");
    expect(layerIcon({ ...row, type: "STAR" })).toBe("16.star");
    expect(layerIcon({ ...row, type: "INSTANCE" })).toBe("16.instance");
  });
});
