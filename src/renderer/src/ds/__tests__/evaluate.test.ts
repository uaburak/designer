import { describe, expect, it } from "vitest";
import { clampRound, commitTyped, evaluate, evaluateWith, formatNumber, parseExpression, stripUnit } from "../util/evaluate";
import { scrubFrom, scrubRate, scrubSteps, scrubValue, stepValue, SCRUB_PX_PER_STEP } from "../util/scrub";

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
  it("scrubs a whole step per 4 px (live: 90 px → 22), ×10 with Shift, at the pointer's speed (2x, 1x, 1/2, 1/4)", () => {
    expect(SCRUB_PX_PER_STEP).toBe(4);
    expect(scrubValue(-3, 90)).toBe(19);
    expect(scrubValue(100, 3)).toBe(100);
    expect(scrubValue(100, 4)).toBe(101);
    expect(scrubValue(100, 30)).toBe(107);
    expect(scrubValue(100, -30)).toBe(93);
    expect(scrubValue(100, -30, { shift: true })).toBe(30);
    expect(scrubValue(100, 30, { rate: 2 })).toBe(115);
    expect(scrubValue(100, 30, { rate: 0.5 })).toBe(103);
    expect(scrubValue(100, 32, { rate: 0.25 })).toBe(102);
    expect(scrubValue(0, 2000, { max: 100 })).toBe(100);
    expect(scrubSteps(-7)).toBe(-1);
  });
  it("never leaves a fraction: a value off the step grid lands on it at the first step, the way the drag goes", () => {
    expect(scrubValue(61.05, 4)).toBe(62);
    expect(scrubValue(61.05, 8)).toBe(63);
    expect(scrubValue(61.05, -4)).toBe(61);
    expect(scrubValue(61.05, -8)).toBe(60);
    expect(scrubValue(61.05, 2)).toBe(61.05);
    expect(scrubValue(61.05, 4, { shift: true })).toBe(71);
    expect(scrubValue(-2.5, 4)).toBe(-2);
    expect(scrubValue(0.37, 4, { step: 0.1, precision: 2 })).toBe(0.4);
    expect(scrubValue(0.4, 4, { step: 0.1, precision: 2 })).toBe(0.5);
  });
  it("a Mixed scrub moves each value by whole steps from its own, a fraction landing on a whole number first", () => {
    expect(scrubFrom(19, 5)).toBe(24);
    expect(scrubFrom(61.05, 1)).toBe(62);
    expect(scrubFrom(61.05, -1)).toBe(61);
    expect(scrubFrom(61.05, 0)).toBe(61.05);
    expect(scrubFrom(10, 0.5)).toBe(10.5);
  });
  it("picks the speed from how far above or below the start the pointer is", () => {
    expect([scrubRate(-200), scrubRate(-60), scrubRate(0), scrubRate(59), scrubRate(60), scrubRate(179), scrubRate(180)]).toEqual([2, 2, 1, 1, 0.5, 0.5, 0.25]);
  });
});

describe("math in fields (help 360039956914)", () => {
  it("takes ^ above × and ÷, right-associative, under a sign", () => {
    expect(evaluate("2^3")).toBe(8);
    expect(evaluate("2*3^2")).toBe(18);
    expect(evaluate("2^3^2")).toBe(512);
    expect(evaluate("-2^2")).toBe(-4);
    expect(evaluate("(1+1)^(1+2)")).toBe(8);
    expect(evaluate("4^0.5")).toBe(2);
  });
  it("reads Mixed as each layer's value", () => {
    expect(evaluateWith("Mixed+100", 20)).toBe(120);
    expect(evaluateWith("mixed*2", 7)).toBe(14);
    expect(evaluateWith("(Mixed/2)+6", 10)).toBe(11);
    expect(evaluate("Mixed+1")).toBeNaN();
    const e = parseExpression("Mixed + 10%", "%");
    expect(typeof e).toBe("function");
    expect((e as (x: number) => number)(5)).toBe(15);
    expect(parseExpression("12")).toBe(12);
    expect(parseExpression("Mixed+")).toBeNull();
  });
  it("commits a Mixed expression per layer, or on the one value there is", () => {
    const r = commitTyped("Mixed+100", null, { max: 150 });
    expect(r && typeof r === "object" && [r.each(10), r.each(90)]).toEqual([110, 150]);
    expect(commitTyped("Mixed*2", 10)).toBe(20);
    // Figma: "+10" alone replaces the value (relative only after the existing number, or Mixed).
    expect(commitTyped("+10", 50)).toBe(10);
  });
});
