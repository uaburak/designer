// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { AlignmentMatrix, cellAlignment, cellSelected, type Alignment, type AlignmentMatrixProps } from "../components/AlignmentMatrix";
import { $, $$, click, focus, key, mount, spy, type Mounted } from "./dom";

let m: Mounted | null = null;
afterEach(() => {
  m?.unmount();
  m = null;
});

describe("alignment cells (pure)", () => {
  it("map columns and rows to the primary and counter axes by direction", () => {
    expect(cellAlignment("horizontal", 2, 0, "MIN")).toEqual({ primary: "MAX", counter: "MIN" });
    expect(cellAlignment("vertical", 2, 0, "MIN")).toEqual({ primary: "MIN", counter: "MAX" });
    expect(cellAlignment("horizontal", 2, 1, "SPACE_BETWEEN")).toEqual({ primary: "SPACE_BETWEEN", counter: "CENTER" });
  });
  it("select a whole row (column) with space-between", () => {
    const v: Alignment = { primary: "SPACE_BETWEEN", counter: "MAX" };
    expect([0, 1, 2].map((c) => cellSelected("horizontal", c, 2, v))).toEqual([true, true, true]);
    expect(cellSelected("horizontal", 0, 1, v)).toBe(false);
    expect([0, 1, 2].map((r) => cellSelected("vertical", 2, r, v))).toEqual([true, true, true]);
  });
});

describe("AlignmentMatrix", () => {
  it("chooses a cell, and moves the choice with the arrows", () => {
    const onChange = spy<[Alignment]>();
    m = mount(AlignmentMatrix, { direction: "horizontal", value: { primary: "MIN", counter: "MIN" }, onChange } as AlignmentMatrixProps);
    const cells = $$('[role="radio"]', m.host);
    expect(cells).toHaveLength(9);
    expect(cells.filter((c) => c.getAttribute("aria-checked") === "true").map((c) => c.getAttribute("aria-label"))).toEqual(["Align top left"]);
    click(cells[5]); // row 1, col 2
    expect(onChange.calls.at(-1)).toEqual([{ primary: "MAX", counter: "CENTER" }]);
    focus(cells[0]);
    key(cells[0], "ArrowDown");
    expect(onChange.calls.at(-1)).toEqual([{ primary: "MIN", counter: "CENTER" }]);
    expect($('[aria-checked="true"]', m.host).tabIndex).toBe(0);
  });
});
