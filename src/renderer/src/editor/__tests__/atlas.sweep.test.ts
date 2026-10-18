// The Atlas sweep of 2026-10-18 (chapters 02, 04, 05, 07, 08 and Draw's "not done" lists): the chrome's pure rules.
import { describe, expect, it } from "vitest";
import { toolbarChoice } from "../canvas/BottomToolbar";
import { swatchColors } from "../panels/design/Paints";
import { exponentialSlider } from "../draw/panels/DrawSliders";

describe("the toolbar (atlas 02 §2)", () => {
  it("Comment chosen again while it is the tool goes back to Move; other tools stay", () => {
    expect(toolbarChoice("comment", "comment")).toBe("move");
    expect(toolbarChoice("comment", "move")).toBe("comment");
    expect(toolbarChoice("rectangle", "rectangle")).toBe("rectangle");
  });
});

describe("Draw's exponential sliders (atlas 08 §6.3–6.4)", () => {
  it("Figma's EXPONENTIAL transform over 0.01–100: a thousandth of the range at the left, a tenth at 2/3, and back", () => {
    const s = exponentialSlider(0.01, 100);
    expect([s.toValue(0.01), s.toValue(66.67), s.toValue(100), s.toValue(200)]).toEqual([0.11, 10.01, 100, 100]);
    expect([s.fromValue(10.01), s.fromValue(100), s.fromValue(0.01), s.fromValue(0)]).toEqual([66.67, 100, 0.01, 0.01]);
  });
});

describe("swatch sets (atlas 07 §5.6)", () => {
  it("colour variables in order, then fill styles' top visible solid paint, each colour once", () => {
    const red = { r: 1, g: 0, b: 0, a: 1 };
    const values = new Map<string, unknown>([
      ["v1", red],
      ["v2", { r: 0, g: 0, b: 1, a: 0.5 }],
      ["v3", 12],
    ]);
    const variables = [
      { id: "v1", type: "COLOR" },
      { id: "v2", type: "COLOR" },
      { id: "v3", type: "FLOAT" },
    ];
    const styles = [
      { kind: "FILL", node: { fillPaints: [{ type: "SOLID", color: { r: 0, g: 1, b: 0, a: 1 }, visible: true }, { type: "SOLID", color: red, visible: false }] } },
      { kind: "FILL", node: { fillPaints: [{ type: "SOLID", color: red, opacity: 1, visible: true }] } },
      { kind: "TEXT", node: {} },
    ];
    expect(swatchColors(variables, styles, (id) => values.get(id))).toEqual(["#ff0000", "rgba(0, 0, 255, 0.5)", "#00ff00"]);
  });
});
