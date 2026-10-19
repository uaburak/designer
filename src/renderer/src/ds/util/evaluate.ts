/**
 * NumericInput's arithmetic (help.figma.com 360039956914, "Use math in fields"): a plain number ("12", "1,5") or
 * an expression with + − × ÷ * /, `^` (exponent, right-associative, above × and ÷) and parentheses ("100+20",
 * "(48-8)/2", "2^3"). "Mixed" stands for each selected layer's own value ("Mixed+100" adds 100 to every layer;
 * `evaluateWith` / `parseExpression`). Figma's postfix operators (docs/research/atlas/02-editor-chrome.md §4.5,
 * above every other): `%` is a percent of the current value ("50%" of 200 is 100), `x` a multiple of it ("2x"), `px`
 * nothing ("10px+5"). NaN for anything else (it is dropped). Parsed by hand: nothing typed is ever run as code.
 */
export function evaluate(raw: string): number {
  return evaluateWith(raw, undefined);
}

/**
 * `raw` with "Mixed" (any case) read as `x`, the field's current value (each layer's on a Mixed field), and `%` / `x`
 * after a term relative to it; NaN when it needs `x` and none is given.
 */
export function evaluateWith(raw: string, x: number | undefined): number {
  const src = normalize(raw);
  if (!src || !/^[0-9.+\-*/()^m%x]+$/.test(src.replace(/px/g, ""))) return NaN;
  let at = 0;
  const peek = () => src[at];
  const operand = (): number => {
    if (peek() === "(") {
      at++;
      const v = sum();
      if (peek() !== ")") return NaN;
      at++;
      return v;
    }
    if (peek() === "m") {
      at++;
      return x === undefined ? NaN : x;
    }
    // "12", "1.5", ".5", "5."
    const m = /^\d+\.?\d*|^\.\d+/.exec(src.slice(at));
    if (!m) return NaN;
    at += m[0].length;
    return Number(m[0]);
  };
  const atom = (): number => {
    let v = operand();
    for (;;) {
      if (src.startsWith("px", at)) at += 2;
      else if (peek() === "%") {
        at++;
        v = x === undefined ? NaN : (x * v) / 100;
      } else if (peek() === "x") {
        at++;
        v = x === undefined ? NaN : x * v;
      } else return v;
    }
  };
  // Exponent binds tighter than a sign ("-2^2" is −4) and associates right ("2^3^2" is 2^9).
  const power = (): number => {
    const base = atom();
    if (peek() === "^") {
      at++;
      return base ** unary();
    }
    return base;
  };
  const unary = (): number => {
    if (peek() === "-") {
      at++;
      return -unary();
    }
    if (peek() === "+") {
      at++;
      return unary();
    }
    return power();
  };
  const product = (): number => {
    let v = unary();
    while (peek() === "*" || peek() === "/") {
      const op = src[at++];
      const r = unary();
      v = op === "*" ? v * r : v / r;
    }
    return v;
  };
  const sum = (): number => {
    let v = product();
    while (peek() === "+" || peek() === "-") {
      const op = src[at++];
      const r = product();
      v = op === "+" ? v + r : v - r;
    }
    return v;
  };
  const v = sum();
  return at === src.length && Number.isFinite(v) ? v : NaN;
}

/** "Mixed" as the field shows it in each UI language (English, Turkish "Karışık"). */
const MIXED_WORD = /mixed|karışık/gi;

/** Commas as decimal points, no spaces, × ÷ − as * / -, "Mixed" as the one-letter variable `m`, lower case ("2X", "PX"). */
function normalize(raw: string): string {
  return raw.replace(/,/g, ".").replace(/\s+/g, "").replace(/×/g, "*").replace(/÷/g, "/").replace(/−/g, "-").replace(MIXED_WORD, "m").toLowerCase();
}

/** Does the text refer to each layer's own value ("Mixed")? */
export const usesMixed = (raw: string): boolean => new RegExp(MIXED_WORD.source, "i").test(raw);

/** Does the text use the current value: "Mixed", or a `%` / `x` after a term ("50%", "2x")? */
export const usesCurrent = (raw: string): boolean => usesMixed(raw) || /[%xX]/.test(raw.replace(new RegExp(MIXED_WORD.source, "gi"), ""));

/**
 * What typed text means: a number, or — when it uses the current value ("Mixed", "50%", "2x") — a function of each
 * layer's value; null when it isn't an expression.
 */
export function parseExpression(raw: string, unit?: string): number | ((x: number) => number) | null {
  const t = stripUnit(raw, unit);
  if (usesCurrent(t)) {
    if (!Number.isFinite(evaluateWith(t, 1))) return null;
    return (x: number) => evaluateWith(t, x);
  }
  const n = evaluate(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * The field's own unit typed along ("50%" in an opacity field, "45°") dropped, so it types as its number; elsewhere a
 * trailing "°" or "px" goes too, while `%` stays Figma's percent of the current value.
 */
export function stripUnit(raw: string, unit?: string): string {
  const t = raw.trim();
  if (unit && t.endsWith(unit)) return t.slice(0, -unit.length).trim();
  return t.replace(/(px|°)$/i, "").trim();
}

/** Rounded to `precision` decimals, kept within [min, max]. */
export function clampRound(n: number, min: number, max: number, precision = 2): number {
  const f = 10 ** precision;
  return Math.min(max, Math.max(min, Math.round(n * f) / f));
}

export type Committed = number | "clear" | { each: (x: number) => number } | null;

/**
 * What a field commits for what was typed: a number, "clear" (emptied a set value), `{ each }` (a "Mixed"
 * expression: applied to every layer's own value, clamped and rounded), or null (nothing to do).
 */
export function commitTyped(raw: string, current: number | null, opts: { min?: number; max?: number; precision?: number; unit?: string } = {}): Committed {
  const { min = -Infinity, max = Infinity, precision = 2, unit } = opts;
  if (!raw.trim()) return current === null ? null : "clear";
  const e = parseExpression(raw, unit);
  if (e === null) return null;
  if (typeof e === "function") {
    // One value: "Mixed" is that value.
    if (current !== null) {
      const v = clampRound(e(current), min, max, precision);
      return Number.isFinite(v) && v !== current ? v : null;
    }
    return { each: (x: number) => clampRound(e(x), min, max, precision) };
  }
  const v = clampRound(e, min, max, precision);
  return v === current ? null : v;
}

/** A value as the field writes it: at most `precision` decimals, no trailing zeros. */
export function formatNumber(n: number, precision = 2): string {
  const f = 10 ** precision;
  return String(Math.round(n * f) / f);
}
