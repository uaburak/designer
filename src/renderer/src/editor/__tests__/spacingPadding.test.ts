import { describe, expect, it } from "vitest";
import { ordered, respace, spacingAxes, spacingOf, type SpacingItem } from "../model/spacing";
import { ALL_SIDES, paddingDisplay, paddingFields, paddingFromText, paddingHighlight, paddingOf, parsePaddingList, parsePaddingShorthand } from "../model/padding";

const item = (id: string, x: number, y: number, w: number, h: number): SpacingItem => ({ id, box: { x, y, w, h } });

describe("Spacing (model/spacing.ts)", () => {
  it("reads the gap along the axis the layers line up on (Figma's live panel: 20 side by side, −40 overlapping)", () => {
    const side = [item("a", 0, 0, 60, 80), item("b", 80, 0, 60, 80)];
    expect(spacingAxes(side)).toEqual(["x"]);
    expect(spacingOf(side, "x")).toBe(20);
    // The capture's boolean operands: 0,0 80 × 80 and 40,30 80 × 80.
    const overlap = [item("b1", 0, 0, 80, 80), item("b2", 40, 30, 80, 80)];
    expect(spacingAxes(overlap)).toEqual(["x"]);
    expect(spacingOf(overlap, "x")).toBe(-40);
  });

  it("stacked layers read vertical spacing; neither band: both axes", () => {
    const stack = [item("a", 0, 0, 50, 20), item("b", 10, 30, 50, 20), item("c", 0, 70, 50, 20)];
    expect(spacingAxes(stack)).toEqual(["y"]);
    expect(spacingOf(stack, "y")).toBe("mixed");
    const diagonal = [item("a", 0, 0, 10, 10), item("b", 20, 20, 10, 10)];
    expect(spacingAxes(diagonal)).toEqual(["x", "y"]);
    expect(spacingAxes([item("a", 0, 0, 10, 10)])).toEqual([]);
  });

  it("orders by start, then by size, whatever the selection order", () => {
    const list = [item("c", 200, 0, 10, 10), item("a", 0, 0, 10, 10), item("b", 0, 0, 5, 10)];
    expect(ordered(list, "x").map((i) => i.id)).toEqual(["b", "a", "c"]);
  });

  it("respaces: the first layer stays, each next one moves to the new gap", () => {
    const list = [item("a", 0, 0, 60, 80), item("b", 80, 0, 60, 80), item("c", 150, 0, 30, 80)];
    const moves = respace(list, "x", 8);
    expect(moves.has("a")).toBe(false);
    expect(moves.get("b")).toBe(-12); // 60 + 8 = 68
    expect(moves.get("c")).toBe(-14); // 68 + 60 + 8 = 136
    // Already at the gap: nothing moves.
    expect(respace([item("a", 0, 0, 10, 10), item("b", 18, 0, 10, 10)], "x", 8).size).toBe(0);
  });
});

describe("Padding (model/padding.ts)", () => {
  it("reads kiwi's four sides (the right and bottom default to the left and top)", () => {
    expect(paddingOf({})).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
    expect(paddingOf({ stackHorizontalPadding: 12, stackVerticalPadding: 8 })).toEqual({ top: 8, right: 12, bottom: 8, left: 12 });
    expect(paddingOf({ stackHorizontalPadding: 1, stackVerticalPadding: 2, stackPaddingRight: 3, stackPaddingBottom: 4 })).toEqual({ top: 2, right: 3, bottom: 4, left: 1 });
  });

  it("writes only the sides given", () => {
    expect(paddingFields({ left: 1, right: 2 })).toEqual({ stackHorizontalPadding: 1, stackPaddingRight: 2 });
    expect(paddingFields({ top: 5 })).toEqual({ stackVerticalPadding: 5 });
  });

  it('"1,2,3,4" in the horizontal field sets left 1 and right 2 only (live/behaviour/fields.md)', () => {
    expect(paddingFromText("1,2,3,4", ["left", "right"])).toEqual({ left: 1, right: 2 });
    expect(paddingFromText("8 16", ["top", "bottom"])).toEqual({ top: 8, bottom: 16 });
    // One number is the field's own value, a single side takes no list.
    expect(paddingFromText("8", ["left", "right"])).toBeNull();
    expect(paddingFromText("1 2", ["left"])).toBeNull();
  });

  it("the one field over all four sides reads CSS shorthand", () => {
    const all = ["left", "top", "right", "bottom"] as const;
    expect(paddingFromText("8 16", all)).toEqual({ top: 8, right: 16, bottom: 8, left: 16 });
    expect(paddingFromText("8 16 4", all)).toEqual({ top: 8, right: 16, bottom: 4, left: 16 });
    expect(paddingFromText("1 2 3 4", all)).toEqual({ top: 1, right: 2, bottom: 3, left: 4 });
    expect(parsePaddingShorthand("1 2 3 4 5")).toBeNull();
  });

  it('comma-separated with spaces, as Figma shows them ("12, 18"): a pair, the one field\'s 2, 3 or 4 values', () => {
    expect(paddingFromText("12, 18", ["left", "right"])).toEqual({ left: 12, right: 18 });
    expect(paddingFromText("12, 18", ["top", "bottom"])).toEqual({ top: 12, bottom: 18 });
    expect(paddingFromText("12, 18", ALL_SIDES)).toEqual({ top: 12, right: 18, bottom: 12, left: 18 });
    expect(paddingFromText("12, 18, 4", ALL_SIDES)).toEqual({ top: 12, right: 18, bottom: 4, left: 18 });
    expect(paddingFromText("18, 22, 17, 19", ALL_SIDES)).toEqual({ top: 18, right: 22, bottom: 17, left: 19 });
    expect(paddingFromText("12", ALL_SIDES)).toBeNull(); // one number: the field's own value (every side)
  });

  it("what a field shows: one number, the sides' list when they differ (53 / 55.png), Mixed when the layers differ", () => {
    const p = { top: 18, right: 22, bottom: 17, left: 19 };
    expect(paddingDisplay([p], ["left", "right"])).toEqual({ text: "19, 22" });
    expect(paddingDisplay([p], ["top", "bottom"])).toEqual({ text: "18, 17" });
    expect(paddingDisplay([p], ALL_SIDES)).toEqual({ text: "18, 22, 17, 19" });
    expect(paddingDisplay([p], ["left"])).toEqual({ value: 19 });
    expect(paddingDisplay([p, p], ["left", "right"])).toEqual({ text: "19, 22" });
    expect(paddingDisplay([{ top: 8, right: 8, bottom: 8, left: 8 }], ALL_SIDES)).toEqual({ value: 8 });
    expect(paddingDisplay([p, { ...p, right: 23 }], ["left", "right"])).toEqual({ mixed: true });
    expect(paddingDisplay([p, { ...p, right: 23 }], ["top", "bottom"])).toEqual({ text: "18, 17" });
    expect(paddingDisplay([{ ...p, left: 1.5 }], ["left", "right"])).toEqual({ text: "1.5, 22" });
  });

  it("the canvas highlight's bits for a field's sides", () => {
    expect(paddingHighlight(["left", "right"])).toBe(5);
    expect(paddingHighlight(["top", "bottom"])).toBe(10);
    expect(paddingHighlight(ALL_SIDES)).toBe(15);
  });

  it("takes expressions, clamps at 0 and rounds to 2 decimals", () => {
    expect(parsePaddingList("4*2, -3, 1.234")).toEqual([8, 0, 1.23]);
    expect(parsePaddingList("abc 2")).toBeNull();
    expect(parsePaddingList("10")).toBeNull();
  });
});
