import { describe, expect, it } from "vitest";
import { evaluate } from "../ui";

describe("a number field's arithmetic", () => {
  it("reads numbers and decimal commas", () => {
    expect(evaluate("12")).toBe(12);
    expect(evaluate("1,5")).toBe(1.5);
    expect(evaluate(" -4 ")).toBe(-4);
  });
  it("does + − × ÷ and parentheses, in their order", () => {
    expect(evaluate("100+20")).toBe(120);
    expect(evaluate("(48-8)/2")).toBe(20);
    expect(evaluate("2+3*4")).toBe(14);
    expect(evaluate("10×2÷4")).toBe(5);
  });
  it("refuses anything else (nothing runs as code)", () => {
    expect(evaluate("abc")).toBeNaN();
    expect(evaluate("2*(3")).toBeNaN();
    expect(evaluate("alert(1)")).toBeNaN();
    expect(evaluate("1/0")).toBeNaN();
  });
});
