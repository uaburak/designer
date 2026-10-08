/** Prototype expressions (model/expressions.ts): Figma's operators and precedence, to the schema's VariableData and back. */
import { describe, expect, it } from "vitest";
import { formatExpression, parseExpression } from "../model/expressions";

const vars = [
  { id: "1:1", name: "count" },
  { id: "1:2", name: "is open" },
  { id: "1:3", name: "Cart/total" },
  { id: "1:4", name: "counter" },
];
const nameOf = (id: string) => vars.find((v) => v.id === id)?.name ?? null;
const fnOf = (d: unknown) => (d as { value: { expressionValue: { expressionFunction: string; expressionArguments: unknown[] } } }).value.expressionValue;

describe("prototype expressions", () => {
  it("parses literals and variables by their (longest) names", () => {
    expect(parseExpression("true", vars)).toEqual({ ok: true, data: { value: { boolValue: true }, dataType: "BOOLEAN" } });
    expect(parseExpression("-2.5", vars)).toEqual({ ok: true, data: { value: { floatValue: -2.5 }, dataType: "FLOAT" } });
    expect(parseExpression('"Hi"', vars)).toEqual({ ok: true, data: { value: { textValue: "Hi" }, dataType: "STRING" } });
    const v = parseExpression("is open", vars);
    expect(v.ok && v.data).toEqual({ value: { alias: { guid: { sessionID: 1, localID: 2 } } }, dataType: "ALIAS" });
    const longer = parseExpression("counter", vars);
    expect(longer.ok && (longer.data.value?.alias as { guid: { localID: number } }).guid.localID).toBe(4);
    const slash = parseExpression("Cart/total > 3", vars);
    expect(slash.ok).toBe(true);
  });

  it("follows Figma's precedence: × ÷ before + −, comparisons, and, or; left to right", () => {
    const r = parseExpression("count + 2 * 3 > 10 and is open or false", vars);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const or = fnOf(r.data);
    expect(or.expressionFunction).toBe("OR");
    const and = fnOf(or.expressionArguments[0]);
    expect(and.expressionFunction).toBe("AND");
    const gt = fnOf(and.expressionArguments[0]);
    expect(gt.expressionFunction).toBe("GREATER_THAN");
    const plus = fnOf(gt.expressionArguments[0]);
    expect(plus.expressionFunction).toBe("ADDITION");
    expect(fnOf(plus.expressionArguments[1]).expressionFunction).toBe("MULTIPLY");
    // a − b − c is (a − b) − c.
    const sub = parseExpression("count - 1 - 2", vars);
    expect(sub.ok && fnOf(fnOf(sub.ok ? sub.data : null).expressionArguments[0]).expressionFunction).toBe("SUBTRACTION");
    // and chains are one call.
    const chain = parseExpression("true and false and is open", vars);
    expect(chain.ok && fnOf(chain.ok ? chain.data : null).expressionArguments).toHaveLength(3);
  });

  it("negates with ! or not, groups with parentheses", () => {
    const n = parseExpression("not is open", vars);
    expect(n.ok && fnOf(n.ok ? n.data : null).expressionFunction).toBe("NOT");
    const b = parseExpression("!(count == 3)", vars);
    expect(b.ok && fnOf(b.ok ? b.data : null).expressionFunction).toBe("NOT");
    const neg = parseExpression("-count", vars);
    expect(neg.ok && fnOf(neg.ok ? neg.data : null).expressionFunction).toBe("NEGATE");
  });

  it("refuses what isn't an expression, saying where", () => {
    expect(parseExpression("", vars)).toMatchObject({ ok: false });
    expect(parseExpression("count +", vars)).toMatchObject({ ok: false, error: "The expression isn't finished" });
    expect(parseExpression("price > 3", vars)).toMatchObject({ ok: false, error: "No variable named “price”", at: 0 });
    expect(parseExpression("(count > 3", vars)).toMatchObject({ ok: false, error: "A “(” isn't closed" });
    expect(parseExpression('"open', vars)).toMatchObject({ ok: false });
    expect(parseExpression("count 3", vars)).toMatchObject({ ok: false, error: "Unexpected text after the expression" });
  });

  it("formats stored expressions back as text, with the parentheses they need", () => {
    for (const text of ["count + 2 * 3 > 10 and is open or false", "count - (1 - 2)", "(count + 1) * 2", '!is open and Cart/total != "0"', "-count"]) {
      const r = parseExpression(text, vars);
      expect(r.ok).toBe(true);
      if (r.ok) expect(formatExpression(r.data, nameOf)).toBe(text);
    }
    expect(formatExpression({ value: { alias: { guid: { sessionID: 9, localID: 9 } } }, dataType: "ALIAS" }, nameOf)).toBe("?");
  });

  it("reads `name:mode` as the variable's value in that mode (VAR_MODE_LOOKUP) and writes it back", () => {
    const withModes = [
      { id: "1:1", name: "count", modes: [{ id: "5:1", name: "Light" }, { id: "5:2", name: "Dark mode" }] },
      { id: "1:2", name: "is open" },
    ];
    const r = parseExpression("count:Dark mode + 1", withModes);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const plus = fnOf(r.data);
    expect(plus.expressionFunction).toBe("ADDITION");
    const lookup = fnOf(plus.expressionArguments[0]);
    expect(lookup.expressionFunction).toBe("VAR_MODE_LOOKUP");
    expect(lookup.expressionArguments).toEqual([
      { value: { alias: { guid: { sessionID: 1, localID: 1 } } }, dataType: "ALIAS" },
      { value: { textValue: "5:2" }, dataType: "STRING" },
    ]);
    const modeName = (id: string) => withModes[0].modes!.find((m) => m.id === id)?.name ?? null;
    expect(formatExpression(r.data, nameOf, modeName)).toBe("count:Dark mode + 1");
    const bad = parseExpression("count:Sepia", withModes);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toBe("“count” has no such mode");
  });
});
