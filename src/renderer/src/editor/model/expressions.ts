/**
 * Prototype expressions (help.figma.com 15253194385943 "Use expressions in prototypes", 15253220891799 "Multiple actions
 * and conditionals"): what the Conditional's "If" field and Set variable's value hold, typed as text and stored as the
 * schema's VariableData (EXPRESSION: `{expressionFunction, expressionArguments}`, ALIAS, or a literal).
 *
 * - Numbers: `+ - * /`; strings: `+` (joins); booleans: `== != and or > < >= <=`; `!` or `not` negates a boolean, `-` a
 *   number; parentheses group.
 * - Precedence: parentheses, `* /`, `+ -`, comparisons, `and`, `or`; left to right.
 * - Strings in quotes (`"…"` or `'…'`); `true` / `false`; variables by name (the longest name that matches, so names
 *   with spaces and slashes work).
 * - A variable's value in a mode named explicitly: `name:mode` (help.figma.com 15253268379799 — "variableName:modeName"),
 *   stored as VAR_MODE_LOOKUP [ALIAS the variable, STRING the mode's id] (the argument encoding is ours; the engine
 *   evaluates the same).
 */
import type { Guid } from "@/engine/codec";
import { guidJson, guidOf, type VariableDataJson } from "./prototype";

export interface ExpressionVariable {
  id: Guid;
  name: string;
  resolvedType?: string;
  /** Its collection's modes (for `name:mode`) */
  modes?: readonly { id: Guid; name: string }[];
}

export type ParseResult = { ok: true; data: VariableDataJson } | { ok: false; error: string; at: number };

type Token =
  | { kind: "num"; value: number; at: number }
  | { kind: "str"; value: string; at: number }
  | { kind: "bool"; value: boolean; at: number }
  | { kind: "var"; id: Guid; at: number; mode?: Guid }
  | { kind: "op"; value: string; at: number }
  | { kind: "(" | ")"; at: number };

const OPS = ["==", "!=", "<=", ">=", "<", ">", "+", "-", "*", "/", "!"];
const WORDS: Record<string, string> = { and: "and", or: "or", not: "!" };

function tokenize(text: string, vars: readonly ExpressionVariable[]): Token[] | { error: string; at: number } {
  const byLength = [...vars].sort((a, b) => b.name.length - a.name.length);
  const out: Token[] = [];
  let i = 0;
  const wordEnd = (k: number) => k >= text.length || !/[A-Za-z0-9_]/.test(text[k]);
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "(" || c === ")") {
      out.push({ kind: c, at: i });
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      const end = text.indexOf(c, i + 1);
      if (end < 0) return { error: "A string isn't closed", at: i };
      out.push({ kind: "str", value: text.slice(i + 1, end), at: i });
      i = end + 1;
      continue;
    }
    const num = /^\d+(\.\d+)?|^\.\d+/.exec(text.slice(i));
    if (num) {
      out.push({ kind: "num", value: Number(num[0]), at: i });
      i += num[0].length;
      continue;
    }
    // A variable: the longest name that matches here.
    const v = byLength.find((x) => x.name && text.startsWith(x.name, i) && (wordEnd(i + x.name.length) || !/[A-Za-z0-9_]/.test(x.name[x.name.length - 1])));
    if (v) {
      i += v.name.length;
      // `name:mode`: the longest of its modes' names after the colon.
      if (text[i] === ":" && v.modes?.length) {
        const m = [...v.modes].sort((a, b) => b.name.length - a.name.length).find((x) => x.name && text.startsWith(x.name, i + 1));
        if (!m) return { error: `“${v.name}” has no such mode`, at: i + 1 };
        out.push({ kind: "var", id: v.id, at: i - v.name.length, mode: m.id });
        i += 1 + m.name.length;
        continue;
      }
      out.push({ kind: "var", id: v.id, at: i - v.name.length });
      continue;
    }
    const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i));
    if (word) {
      const w = word[0];
      if (w === "true" || w === "false") out.push({ kind: "bool", value: w === "true", at: i });
      else if (WORDS[w.toLowerCase()]) out.push({ kind: "op", value: WORDS[w.toLowerCase()], at: i });
      else return { error: `No variable named “${w}”`, at: i };
      i += w.length;
      continue;
    }
    const op = OPS.find((o) => text.startsWith(o, i));
    if (op) {
      out.push({ kind: "op", value: op, at: i });
      i += op.length;
      continue;
    }
    return { error: `Unexpected “${c}”`, at: i };
  }
  return out;
}

const FN: Record<string, string> = {
  "+": "ADDITION",
  "-": "SUBTRACTION",
  "*": "MULTIPLY",
  "/": "DIVIDE",
  "==": "EQUALS",
  "!=": "NOT_EQUAL",
  "<": "LESS_THAN",
  "<=": "LESS_THAN_OR_EQUAL",
  ">": "GREATER_THAN",
  ">=": "GREATER_THAN_OR_EQUAL",
  and: "AND",
  or: "OR",
};

const expr = (fn: string, args: VariableDataJson[]): VariableDataJson => ({
  value: { expressionValue: { expressionFunction: fn, expressionArguments: args } },
  dataType: "EXPRESSION",
});

/** Parses an expression; the result is the VariableData to store. */
export function parseExpression(text: string, vars: readonly ExpressionVariable[]): ParseResult {
  const toks = tokenize(text, vars);
  if (!Array.isArray(toks)) return { ok: false, ...toks };
  if (!toks.length) return { ok: false, error: "Type an expression", at: 0 };
  let p = 0;
  const peek = () => toks[p];
  const isOp = (...ops: string[]) => {
    const t = peek();
    return !!t && t.kind === "op" && ops.includes(t.value);
  };
  class Fail {
    constructor(
      readonly error: string,
      readonly at: number
    ) {}
  }
  const binary = (next: () => VariableDataJson, ops: string[]) => (): VariableDataJson => {
    let left = next();
    while (isOp(...ops)) {
      const op = (toks[p++] as { value: string }).value;
      const right = next();
      // and / or chains are one n-ary call, as Figma stores them.
      const fn = FN[op];
      const l = left.value?.expressionValue as { expressionFunction?: string; expressionArguments?: VariableDataJson[] } | undefined;
      if ((fn === "AND" || fn === "OR") && l?.expressionFunction === fn) left = expr(fn, [...(l.expressionArguments ?? []), right]);
      else left = expr(fn, [left, right]);
    }
    return left;
  };
  const primary = (): VariableDataJson => {
    const t = toks[p++];
    if (!t) throw new Fail("The expression isn't finished", text.length);
    switch (t.kind) {
      case "num":
        return { value: { floatValue: t.value }, dataType: "FLOAT" };
      case "str":
        return { value: { textValue: t.value }, dataType: "STRING" };
      case "bool":
        return { value: { boolValue: t.value }, dataType: "BOOLEAN" };
      case "var":
        if (t.mode)
          return expr("VAR_MODE_LOOKUP", [
            { value: { alias: { guid: guidJson(t.id) } }, dataType: "ALIAS" },
            { value: { textValue: t.mode }, dataType: "STRING" },
          ]);
        return { value: { alias: { guid: guidJson(t.id) } }, dataType: "ALIAS" };
      case "(": {
        const inner = or();
        const close = toks[p++];
        if (!close || close.kind !== ")") throw new Fail("A “(” isn't closed", t.at);
        return inner;
      }
      default:
        throw new Fail(`Unexpected “${t.kind === "op" ? t.value : t.kind}”`, t.at);
    }
  };
  const unary = (): VariableDataJson => {
    if (isOp("!")) {
      p++;
      return expr("NOT", [unary()]);
    }
    if (isOp("-")) {
      p++;
      const inner = unary();
      if (inner.dataType === "FLOAT" && typeof inner.value?.floatValue === "number") return { value: { floatValue: -inner.value.floatValue }, dataType: "FLOAT" };
      return expr("NEGATE", [inner]);
    }
    return primary();
  };
  const mul = binary(unary, ["*", "/"]);
  const add = binary(mul, ["+", "-"]);
  const cmp = binary(add, ["==", "!=", "<", "<=", ">", ">="]);
  const and = binary(cmp, ["and"]);
  const or = binary(and, ["or"]);
  try {
    const data = or();
    if (p < toks.length) {
      const t = toks[p];
      return { ok: false, error: "Unexpected text after the expression", at: t.at };
    }
    return { ok: true, data };
  } catch (e) {
    if (e instanceof Fail) return { ok: false, error: e.error, at: e.at };
    throw e;
  }
}

const SYMBOL: Record<string, string> = Object.fromEntries(Object.entries(FN).map(([s, f]) => [f, s]));
const LEVEL: Record<string, number> = {
  OR: 1,
  AND: 2,
  EQUALS: 3,
  NOT_EQUAL: 3,
  LESS_THAN: 3,
  LESS_THAN_OR_EQUAL: 3,
  GREATER_THAN: 3,
  GREATER_THAN_OR_EQUAL: 3,
  ADDITION: 4,
  SUBTRACTION: 4,
  MULTIPLY: 5,
  DIVIDE: 5,
};

/** An expression's text (variables by name; "?" for one that's gone; `name:mode` with `modeNameOf`). */
export function formatExpression(d: VariableDataJson | undefined, nameOf: (id: Guid) => string | null, modeNameOf: (id: Guid) => string | null = () => null): string {
  const go = (x: VariableDataJson | undefined, parent: number): string => {
    if (!x) return "";
    const v = x.value ?? {};
    if (x.dataType === "BOOLEAN" || typeof v.boolValue === "boolean") return v.boolValue ? "true" : "false";
    if (x.dataType === "FLOAT" || typeof v.floatValue === "number") return String(Math.round((v.floatValue ?? 0) * 1e6) / 1e6);
    if (x.dataType === "STRING" || typeof v.textValue === "string") return JSON.stringify(v.textValue ?? "");
    if (v.alias) {
      const id = guidOf(v.alias.guid ?? null);
      return (id && nameOf(id)) ?? "?";
    }
    const e = v.expressionValue as { expressionFunction?: string; expressionArguments?: VariableDataJson[] } | undefined;
    if (!e?.expressionFunction) return "";
    const args = e.expressionArguments ?? [];
    const fn = e.expressionFunction;
    if (fn === "NOT") return `!${go(args[0], 6)}`;
    if (fn === "NEGATE") return `-${go(args[0], 6)}`;
    if (fn === "VAR_MODE_LOOKUP") {
      const mode = args[1]?.value?.textValue;
      return `${go(args[0], 6)}:${(mode && modeNameOf(mode)) ?? "?"}`;
    }
    const level = LEVEL[fn];
    if (level === undefined) return fn.toLowerCase();
    // Left to right: the right operand of the same level needs parentheses (a − (b − c)).
    const text = args.map((a, i) => go(a, i === 0 ? level : level + 0.5)).join(` ${SYMBOL[fn]} `);
    return level < parent ? `(${text})` : text;
  };
  return go(d, 0);
}
