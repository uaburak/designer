/**
 * Auto layout padding (help.figma.com 31289464393751): a frame's four sides are kiwi's stackHorizontalPadding
 * (left), stackVerticalPadding (top), stackPaddingRight and stackPaddingBottom. The panel shows horizontal and
 * vertical (Mixed when a pair differs), "Individual padding" shows the four, and any padding field takes CSS
 * shorthand: "8" all sides, "8 16" vertical / horizontal, "8 16 4" top / horizontal / bottom, "1 2 3 4" (or
 * "1,2,3,4") top / right / bottom / left.
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
 * CSS shorthand typed in a padding field: two to four numbers (or expressions) apart by spaces or commas; null
 * when the text is a single value (the field's own number) or isn't numbers. Negative paddings become 0.
 */
export function parsePaddingShorthand(raw: string): Padding | null {
  const parts = raw.trim().split(/[\s,]+/).filter(Boolean);
  if (parts.length < 2 || parts.length > 4) return null;
  const v = parts.map((p) => evaluate(p));
  if (v.some((n) => !Number.isFinite(n))) return null;
  const n = v.map((x) => Math.max(0, Math.round(x * 100) / 100));
  const [top, right = top, bottom = top, left = right] = n;
  return { top, right, bottom, left };
}
