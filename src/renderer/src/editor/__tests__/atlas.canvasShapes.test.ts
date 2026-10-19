// Atlas wave 1, "canvas and shapes" (docs/research/atlas/04-canvas-selection.md §11, 05-shapes-vector.md §14): Figma's
// zoom keys, View › Outlines' options, the ruler's menu, the Arc row's numbers.
import { describe, expect, it } from "vitest";
import { COMMAND_BY_ID, matchesCombo } from "../commands";
import { MAIN_MENU } from "../menus";
import { arcFields, arcFromFields } from "../panels/design/Sections";
import type { PanelNode } from "../panels/design/shared";

const key = (code: string, mods: Partial<Record<"shiftKey" | "altKey" | "ctrlKey" | "metaKey", boolean>> = {}) => ({
  code,
  shiftKey: !!mods.shiftKey,
  altKey: !!mods.altKey,
  ctrlKey: !!mods.ctrlKey,
  metaKey: !!mods.metaKey,
});
const pressed = (id: string, e: ReturnType<typeof key>) => COMMAND_BY_ID.get(id)!.keys!.some((c) => matchesCombo(c, e, true));

describe("atlas wave 1: canvas", () => {
  it("zoom keys as Figma's table: ⇧9 fits too, + and ⇧- zoom, ⌘ with the number pad's keys", () => {
    expect(pressed("view.zoom-fit", key("Digit9", { shiftKey: true }))).toBe(true);
    expect(pressed("view.zoom-fit", key("Digit1", { shiftKey: true }))).toBe(true);
    expect(pressed("view.zoom-in", key("Equal", { shiftKey: true }))).toBe(true);
    expect(pressed("view.zoom-in", key("NumpadAdd", { metaKey: true }))).toBe(true);
    expect(pressed("view.zoom-out", key("Minus", { shiftKey: true }))).toBe(true);
    expect(pressed("view.zoom-out", key("Minus", { metaKey: true, shiftKey: true }))).toBe(true);
    expect(pressed("view.zoom-out", key("NumpadSubtract", { metaKey: true }))).toBe(true);
  });

  it("View › Outlines holds Show outlines, then Show hidden layers and Show object bounds", () => {
    const view = MAIN_MENU.find((s) => typeof s === "object" && "label" in s && s.label === "View") as { items: unknown[] };
    const outlines = view.items.find((s) => typeof s === "object" && s !== null && "label" in s && (s as { label: string }).label === "Outlines") as { items: unknown[] };
    expect(outlines.items).toEqual(["view.outlines", "-", "view.outline-hidden-layers", "view.outline-object-bounds"]);
    expect(COMMAND_BY_ID.get("view.outline-hidden-layers")?.label).toBe("Show hidden layers");
    expect(COMMAND_BY_ID.get("view.outline-object-bounds")?.label).toBe("Show object bounds");
  });

  it("a ruler's menu: its guides removed, Hide rulers", () => {
    expect(COMMAND_BY_ID.has("canvas.remove-horizontal-guides")).toBe(true);
    expect(COMMAND_BY_ID.has("canvas.remove-vertical-guides")).toBe(true);
    expect(COMMAND_BY_ID.has("canvas.hide-rulers")).toBe(true);
  });
});

describe("atlas wave 1: shapes", () => {
  const ellipse = (arcData?: PanelNode["arcData"]) => ({ guid: "1:1", type: "ELLIPSE", arcData }) as unknown as PanelNode;

  it("the Arc row reads Start in degrees, Sweep and Ratio in percent; a whole ellipse is 0° / 100 % / 0 %", () => {
    expect(arcFields(ellipse())).toEqual({ start: 0, sweep: 100, ratio: 0 });
    expect(arcFields(ellipse({ startingAngle: 0, endingAngle: 0, innerRadius: 0 }))).toEqual({ start: 0, sweep: 100, ratio: 0 });
    const quarter = arcFields(ellipse({ startingAngle: Math.PI / 2, endingAngle: Math.PI, innerRadius: 0.5 }));
    expect(quarter.start).toBeCloseTo(90);
    expect(quarter.sweep).toBeCloseTo(25);
    expect(quarter.ratio).toBeCloseTo(50);
  });

  it("the Arc row writes the end from the start and the sweep (−100 … 100 %), the ratio 0 … 100 %", () => {
    const arc = arcFromFields(90, 25, 50);
    expect(arc.startingAngle).toBeCloseTo(Math.PI / 2);
    expect(arc.endingAngle).toBeCloseTo(Math.PI);
    expect(arc.innerRadius).toBeCloseTo(0.5);
    const back = arcFromFields(0, -150, 120);
    expect(back.endingAngle).toBeCloseTo(-2 * Math.PI);
    expect(back.innerRadius).toBe(1);
  });
});
