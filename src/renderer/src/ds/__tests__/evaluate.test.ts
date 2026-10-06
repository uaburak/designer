import { describe, expect, it } from "vitest";
import { clampRound, commitTyped, evaluate, formatNumber, stripUnit } from "../util/evaluate";
import { scrubValue, stepValue } from "../util/scrub";

describe("a numeric field's arithmetic (ported from figma/ui.tsx)", () => {
  it("reads numbers and decimal commas", () => {
    expect(evaluate("12")).toBe(12);
    expect(evaluate("1,5")).toBe(1.5);
    expect(evaluate(" -4 ")).toBe(-4);
    expect(evaluate(".5")).toBe(0.5);
    expect(evaluate("5.")).toBe(5);
  });
  it("does + − × ÷ * / and parentheses, in their order", () => {
    expect(evaluate("100+20")).toBe(120);
    expect(evaluate("(48-8)/2")).toBe(20);
    expect(evaluate("2+3*4")).toBe(14);
    expect(evaluate("10×2÷4")).toBe(5);
    expect(evaluate("10−4")).toBe(6);
    expect(evaluate("-(2+3)")).toBe(-5);
    expect(evaluate("((1))")).toBe(1);
  });
  it("refuses anything else (nothing runs as code)", () => {
    expect(evaluate("")).toBeNaN();
    expect(evaluate("abc")).toBeNaN();
    expect(evaluate("2*(3")).toBeNaN();
    expect(evaluate("alert(1)")).toBeNaN();
    expect(evaluate("1/0")).toBeNaN();
    expect(evaluate("1..2")).toBeNaN();
    expect(evaluate("2 3")).toBe(23); // spaces are dropped, as before
  });
});

describe("committing what was typed", () => {
  it("ignores a typed unit", () => {
    expect(stripUnit("50%", "%")).toBe("50");
    expect(stripUnit("45°")).toBe("45");
    expect(stripUnit("12px")).toBe("12");
    expect(commitTyped("50%", 10, { unit: "%" })).toBe(50);
  });
  it("clamps and rounds to the precision", () => {
    expect(clampRound(1.23456, 0, 10, 2)).toBe(1.23);
    expect(clampRound(-5, 0, 10)).toBe(0);
    expect(clampRound(1e9, -1e6, 1e6)).toBe(1e6);
    expect(commitTyped("150", 10, { max: 100 })).toBe(100);
    expect(commitTyped("1.006", 0, { precision: 2 })).toBe(1.01);
  });
  it("drops invalid and unchanged input; an emptied field clears", () => {
    expect(commitTyped("abc", 10)).toBeNull();
    expect(commitTyped("10", 10)).toBeNull();
    expect(commitTyped("  ", 10)).toBe("clear");
    expect(commitTyped("", null)).toBeNull();
    expect(commitTyped("5*2", null)).toBe(10);
  });
  it("writes values without trailing zeros", () => {
    expect(formatNumber(1.5)).toBe("1.5");
    expect(formatNumber(2)).toBe("2");
    expect(formatNumber(1.23456, 2)).toBe("1.23");
  });
});

describe("stepping and scrubbing (contract §4.5)", () => {
  it("steps by 1, or 10 with Shift", () => {
    expect(stepValue(10, 1)).toBe(11);
    expect(stepValue(10, -1, { shift: true })).toBe(0);
    expect(stepValue(0, -1, { min: 0 })).toBe(0);
    expect(stepValue(1, 1, { step: 0.5, bigStep: 5, shift: true })).toBe(6);
  });
  it("scrubs 1 unit per px, ×10 with Shift, ×0.1 with Alt when decimals are kept", () => {
    expect(scrubValue(100, 30)).toBe(130);
    expect(scrubValue(100, -30, { shift: true })).toBe(-200);
    expect(scrubValue(100, 30, { alt: true })).toBe(103);
    expect(scrubValue(100, 30, { alt: true, precision: 0 })).toBe(130);
    expect(scrubValue(0, 500, { max: 100 })).toBe(100);
  });
});
