/**
 * NumericInput's arithmetic, ported from figma/ui.tsx (the legacy editor
 * keeps its own copy until it is replaced).
 *
 * A field's number: plain ("12", "1,5") or arithmetic on numbers — + − × ÷
 * * / and parentheses ("100+20", "(48-8)/2") — NaN for anything else (it is
 * dropped). Parsed by hand: nothing typed is ever run as code.
 */
export function evaluate(raw: string): number {
  const src = raw.replace(/,/g, ".").replace(/\s+/g, "").replace(/×/g, "*").replace(/÷/g, "/").replace(/−/g, "-");
  if (!src || !/^[0-9.+\-*/()]+$/.test(src)) return NaN;
  let at = 0;
  const peek = () => src[at];
  const number = (): number => {
    if (peek() === "(") {
      at++;
      const v = sum();
      if (peek() !== ")") return NaN;
      at++;
      return v;
    }
    if (peek() === "-") { at++; return -number(); }
    if (peek() === "+") { at++; return number(); }
    // "12", "1.5", ".5", "5." (the original's `\d*\.?\d+` first refused "5.")
    const m = /^\d+\.?\d*|^\.\d+/.exec(src.slice(at));
    if (!m) return NaN;
    at += m[0].length;
    return Number(m[0]);
  };
  const product = (): number => {
    let v = number();
    while (peek() === "*" || peek() === "/") {
      const op = src[at++];
      const r = number();
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

/** A trailing unit typed along ("50%", "45°", "12px") dropped, so it types as its number. */
export function stripUnit(raw: string, unit?: string): string {
  const t = raw.trim();
  if (unit && t.endsWith(unit)) return t.slice(0, -unit.length).trim();
  return t.replace(/(px|%|°)$/i, "").trim();
}

/** Rounded to `precision` decimals, kept within [min, max]. */
export function clampRound(n: number, min: number, max: number, precision = 2): number {
  const f = 10 ** precision;
  return Math.min(max, Math.max(min, Math.round(n * f) / f));
}

/** What a field commits for what was typed: a number, "clear" (emptied a set value), or null (nothing to do). */
export function commitTyped(raw: string, current: number | null, opts: { min?: number; max?: number; precision?: number; unit?: string } = {}): number | "clear" | null {
  const { min = -Infinity, max = Infinity, precision = 2, unit } = opts;
  if (!raw.trim()) return current === null ? null : "clear";
  const n = evaluate(stripUnit(raw, unit));
  if (!Number.isFinite(n)) return null;
  const v = clampRound(n, min, max, precision);
  return v === current ? null : v;
}

/** A value as the field writes it: at most `precision` decimals, no trailing zeros. */
export function formatNumber(n: number, precision = 2): string {
  const f = 10 ** precision;
  return String(Math.round(n * f) / f);
}
