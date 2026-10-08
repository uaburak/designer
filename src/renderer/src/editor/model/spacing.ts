/**
 * The Layout section's "Spacing" for several layers or a group's children (Figma's live panel: "Horizontal
 * spacing" 20 for two layers side by side, −40 for two that overlap, "Mixed" when the gaps differ): the gap
 * between neighbours along the axis the layers line up on, and the moves that make every gap a new value.
 *
 * The axis: horizontal when the layers share a horizontal band (their vertical extents all overlap), vertical
 * when they share a vertical band, both when neither (each then reads Mixed unless its gaps agree).
 */
import type { Box } from "./geometry";

export type SpacingAxis = "x" | "y";
export interface SpacingItem {
  id: string;
  box: Box;
}

const EPS = 0.01;

/** Do the boxes' extents along `axis` all overlap one band? */
function shareBand(items: readonly SpacingItem[], axis: SpacingAxis): boolean {
  const lo = Math.max(...items.map((i) => (axis === "x" ? i.box.x : i.box.y)));
  const hi = Math.min(...items.map((i) => (axis === "x" ? i.box.x + i.box.w : i.box.y + i.box.h)));
  return lo <= hi + EPS;
}

/** The axes the panel shows spacing for (none for fewer than two layers). */
export function spacingAxes(items: readonly SpacingItem[]): SpacingAxis[] {
  if (items.length < 2) return [];
  if (shareBand(items, "y")) return ["x"];
  if (shareBand(items, "x")) return ["y"];
  return ["x", "y"];
}

const start = (b: Box, axis: SpacingAxis) => (axis === "x" ? b.x : b.y);
const extent = (b: Box, axis: SpacingAxis) => (axis === "x" ? b.w : b.h);

/** The items in order along `axis` (by their start, then their end). */
export function ordered(items: readonly SpacingItem[], axis: SpacingAxis): SpacingItem[] {
  return [...items].sort((a, b) => start(a.box, axis) - start(b.box, axis) || extent(a.box, axis) - extent(b.box, axis));
}

/** The gap between neighbours along `axis`: one number when they all agree (rounded to 2 decimals), else "mixed". */
export function spacingOf(items: readonly SpacingItem[], axis: SpacingAxis): number | "mixed" {
  const list = ordered(items, axis);
  const gaps: number[] = [];
  for (let i = 1; i < list.length; i++) gaps.push(start(list[i].box, axis) - (start(list[i - 1].box, axis) + extent(list[i - 1].box, axis)));
  const first = gaps[0] ?? 0;
  if (gaps.some((g) => Math.abs(g - first) > EPS)) return "mixed";
  return Math.round(first * 100) / 100;
}

/** The moves (along `axis`) that put `gap` between every neighbour, the first layer staying where it is. */
export function respace(items: readonly SpacingItem[], axis: SpacingAxis, gap: number): Map<string, number> {
  const list = ordered(items, axis);
  const out = new Map<string, number>();
  let at = list.length ? start(list[0].box, axis) + extent(list[0].box, axis) : 0;
  for (let i = 1; i < list.length; i++) {
    const want = at + gap;
    const d = want - start(list[i].box, axis);
    if (Math.abs(d) > 1e-9) out.set(list[i].id, d);
    at = want + extent(list[i].box, axis);
  }
  return out;
}
