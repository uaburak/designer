/**
 * Fractional indexing, exactly as docs/schema.md §10.2 (the reference the engine's base/FractionalIndex must match).
 *
 * A position is a non-empty string over the 95 printable ASCII characters 0x20 (' ' = digit 0) .. 0x7E ('~' = 94):
 * the base-95 digits of a fraction in (0, 1) with the leading "0." left off (Figma's format). It never ends with
 * digit 0, so each fraction has one spelling. Order is plain byte-wise comparison; ties (only after import or merge)
 * are broken by GUID.
 */

const D = (s: string, i: number) => s.charCodeAt(i) - 32;
const C = (d: number) => String.fromCharCode(d + 32);
export type Bias = "LOW" | "MID" | "HIGH";

/** Keys longer than this make the writer rebalance the whole sibling list instead (§10.3). */
export const MAX_KEY_LENGTH = 24;

/** Shortest key k with lo < k < hi. lo = "" means 0; hi = null means 1. */
export function keyBetween(lo: string, hi: string | null, bias: Bias = "MID"): string {
  let out = "";
  for (let i = 0; ; i++) {
    const dl = i < lo.length ? D(lo, i) : 0;
    const dh = hi === null ? 95 : i < hi.length ? D(hi, i) : 0;
    if (dl === dh) {
      if (hi !== null && i >= lo.length && i >= hi.length) throw new Error("keyBetween: lo == hi");
      out += C(dl);
      continue;
    }
    if (dl > dh) throw new Error("keyBetween: lo > hi");
    if (dh - dl >= 2) return out + C(bias === "LOW" ? dl + 1 : bias === "HIGH" ? dh - 1 : (dl + dh) >> 1);
    out += C(dl); // no digit fits here: keep lo's digit; everything after it is below hi
    hi = null;
  }
}

/** n keys strictly between lo and hi, ascending. */
export function keysBetween(lo: string, hi: string | null, n: number): string[] {
  if (n <= 0) return [];
  if (hi === null) {
    const r: string[] = [];
    let k = lo;
    for (let i = 0; i < n; i++) r.push((k = keyBetween(k, null, "LOW")));
    return r;
  }
  if (lo === "") {
    const r: string[] = [];
    let k = hi;
    for (let i = 0; i < n; i++) r.unshift((k = keyBetween("", k, "HIGH")));
    return r;
  }
  const left = (n - 1) >> 1,
    m = keyBetween(lo, hi, "MID");
  return [...keysBetween(lo, m, left), m, ...keysBetween(m, hi, n - 1 - left)];
}

/** Evenly spaced keys for n siblings, used by rebalancing. Integer arithmetic, exact below 2^53. */
export function rebalancedKeys(n: number): string[] {
  let L = 1;
  while (95 ** L < n + 1) L++;
  const P = 95 ** L,
    keys: string[] = [];
  for (let i = 1; i <= n; i++) {
    let v = Math.floor((i * P) / (n + 1)),
      k = "";
    for (let j = 0; j < L; j++) {
      k = C(v % 95) + k;
      v = Math.floor(v / 95);
    }
    keys.push(k.replace(/ +$/, ""));
  }
  return keys;
}

/** The key to append after the last sibling (`last` = "" for an empty parent): "!" for a first child, as Figma. */
export const keyAfter = (last: string) => keyBetween(last, null, "LOW");
/** The key to prepend before the first sibling. */
export const keyBefore = (first: string) => keyBetween("", first, "HIGH");

/** True for a well-formed position: non-empty, printable ASCII, no trailing digit 0 (' '). */
export function isValidKey(key: string): boolean {
  if (!key || key.endsWith(" ")) return false;
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    if (c < 0x20 || c > 0x7e) return false;
  }
  return true;
}

/** Byte-wise comparison (= numeric order of the fractions). */
export function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Positions for inserting `count` nodes between two siblings, rebalancing when a key would exceed MAX_KEY_LENGTH.
 * `siblings` are the parent's current keys in order; the result says which existing siblings need new keys.
 */
export function insertKeys(
  siblings: readonly string[],
  index: number,
  count: number,
): { keys: string[]; rebalance: string[] | null } {
  const lo = index > 0 ? siblings[index - 1] : "";
  const hi = index < siblings.length ? siblings[index] : null;
  const keys = keysBetween(lo, hi, count);
  if (keys.every((k) => k.length <= MAX_KEY_LENGTH)) return { keys, rebalance: null };
  // §10.3: rewrite every sibling (order unchanged) with evenly spaced keys, the new ones in place.
  const all = rebalancedKeys(siblings.length + count);
  return { keys: all.slice(index, index + count), rebalance: [...all.slice(0, index), ...all.slice(index + count)] };
}
