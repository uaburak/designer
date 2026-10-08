/**
 * Auto layout padding (help.figma.com 31289464393751): a frame's four sides are kiwi's stackHorizontalPadding
 * (left), stackVerticalPadding (top), stackPaddingRight and stackPaddingBottom. The panel shows horizontal and
 * vertical (Mixed when a pair differs), "Individual padding" shows the four. Several numbers typed into a field
 * (live/behaviour/fields.md): the horizontal field takes the first two as left / right ("1,2,3,4" → left 1, right
 * 2, top and bottom kept), the vertical field as top / bottom; the one field over all four sides reads CSS
 * shorthand ("8 16" vertical / horizontal, "8 16 4" top / horizontal / bottom, "1 2 3 4" top / right / bottom /
 * left).
 */
import { evaluate } from "@/ds/util/evaluate";

export interface Padding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface PaddingNode {
  stackHorizontalPadding?: number;
  stackVerticalPadding?: number;
  stackPaddingRight?: number;
  stackPaddingBottom?: number;
}

/** A frame's four paddings (Figma's defaults: 0). */
export function paddingOf(n: PaddingNode): Padding {
  const left = n.stackHorizontalPadding ?? 0;
  const top = n.stackVerticalPadding ?? 0;
  return { top, right: n.stackPaddingRight ?? left, bottom: n.stackPaddingBottom ?? top, left };
}

/** The fields that write a padding (only the sides given). */
export function paddingFields(p: Partial<Padding>): PaddingNode {
  const out: PaddingNode = {};
  if (p.left !== undefined) out.stackHorizontalPadding = p.left;
  if (p.top !== undefined) out.stackVerticalPadding = p.top;
  if (p.right !== undefined) out.stackPaddingRight = p.right;
  if (p.bottom !== undefined) out.stackPaddingBottom = p.bottom;
  return out;
}

/**
 * Several numbers (or expressions) typed in a padding field, apart by spaces or commas; null when the text is a
 * single value (the field's own number) or isn't numbers. Negative paddings become 0, decimals round to 2.
 */
export function parsePaddingList(raw: string): number[] | null {
  const parts = raw.trim().split(/[\s,]+/).filter(Boolean);
  if (parts.length < 2) return null;
  const v = parts.map((p) => evaluate(p));
  if (v.some((n) => !Number.isFinite(n))) return null;
  return v.map((x) => Math.max(0, Math.round(x * 100) / 100));
}

/** CSS shorthand (2–4 numbers) for the one field over all four sides; null otherwise. */
export function parsePaddingShorthand(raw: string): Padding | null {
  const n = parsePaddingList(raw);
  if (!n || n.length > 4) return null;
  const [top, right = top, bottom = top, left = right] = n;
  return { top, right, bottom, left };
}

/**
 * What several numbers typed into the field over `sides` write: all four sides → CSS shorthand; a pair
 * (horizontal: left, right; vertical: top, bottom) → its two sides from the first two numbers, the rest ignored;
 * a single side → null (not taken).
 */
export function paddingFromText(raw: string, sides: readonly (keyof Padding)[]): Partial<Padding> | null {
  if (sides.length === 4) return parsePaddingShorthand(raw);
  if (sides.length !== 2) return null;
  const n = parsePaddingList(raw);
  if (!n) return null;
  return { [sides[0]]: n[0], [sides[1]]: n[1] };
}
