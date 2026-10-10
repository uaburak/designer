/**
 * Auto layout padding (help.figma.com 31289464393751): a frame's four sides are kiwi's stackHorizontalPadding
 * (left), stackVerticalPadding (top), stackPaddingRight and stackPaddingBottom. The panel shows horizontal and
 * vertical ("19, 22" when a pair differs: `paddingDisplay`), "Individual padding" shows the four, ⌘-click on any of
 * them one field over all four ("18, 22, 17, 19": top, right, bottom, left). Several numbers typed into a field
 * (live/behaviour/fields.md): the horizontal field takes the first two as left / right ("1,2,3,4" → left 1, right
 * 2, top and bottom kept), the vertical field as top / bottom; the one field over all four sides reads CSS
 * shorthand ("8 16" vertical / horizontal, "8 16 4" top / horizontal / bottom, "1 2 3 4" top / right / bottom /
 * left).
 */
import { evaluate, formatNumber } from "@/ds/util/evaluate";

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

/** The one padding field's sides, in its text's order: CSS's top, right, bottom, left (live 53 / 55.png). */
export const ALL_SIDES = ["top", "right", "bottom", "left"] as const satisfies readonly (keyof Padding)[];

/**
 * What a padding field over `sides` shows for the layers' paddings `pads` (round 16, live Figma 53–55.png): one
 * number when every side it covers is the same on every layer; the sides' values apart by ", " when they differ but
 * every layer has the same ones (horizontal "19, 22" = left, right; vertical "18, 17" = top, bottom; the one field
 * "18, 22, 17, 19" = top, right, bottom, left); Mixed when the layers differ.
 */
export function paddingDisplay(pads: readonly Padding[], sides: readonly (keyof Padding)[]): { value: number } | { text: string } | { mixed: true } {
  if (!pads.length || !sides.length) return { mixed: true };
  const same = (a: number, b: number) => Math.abs(a - b) <= 0.005;
  const first = sides.map((s) => pads[0][s]);
  if (!pads.every((p) => sides.every((s, i) => same(p[s], first[i])))) return { mixed: true };
  if (first.every((v) => same(v, first[0]))) return { value: first[0] };
  return { text: first.map((v) => formatNumber(v)).join(", ") };
}

/** The padding sides' highlight bits on the canvas (engine `SPACING_HIGHLIGHT`: left 1, top 2, right 4, bottom 8). */
export function paddingHighlight(sides: readonly (keyof Padding)[]): number {
  const bit = { left: 1, top: 2, right: 4, bottom: 8 } as const;
  return sides.reduce((m, s) => m | bit[s], 0);
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
