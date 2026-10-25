/**
 * A post adapted to another format (docs/social.md §32, the owner 2026-10-25: "moved from the post grid to the stories,
 * its logos and texts should fit it"): not only the frame resized — each of its layers placed again as a designer
 * would. Deterministic (no model):
 * - a background (a layer covering the frame) stretches to the new frame;
 * - a band across the frame (a header, a footer) keeps the frame's width, its height scaled;
 * - everything else (texts, logos, cards, the product) is scaled as a whole — the Scale tool's scale, so its text sizes,
 *   radii and strokes follow — by the smaller of the two axes' ratios, never stretched;
 * - placed by where it was: in the top (left) third it keeps its distance from the safe area's top (left) edge, in the
 *   bottom (right) third from its bottom (right) edge, in the middle its place across the safe area — so a title stays
 *   under a story's top band and a button over its bottom one.
 * The engine writes it in one step (`Engine.adaptFrame`), constraints ignored; layers off the post's box (its own
 * canvas, §32) move with the edge nearest to them.
 */
import type { Guid } from "@/engine/codec";
import { safeAreaOf } from "@shared/social/formats";
import type { Insets } from "@shared/social/types";
import type { EditorController } from "../controller";

export interface AdaptLayer {
  id: Guid;
  /** Its box in the post (the post's own space) */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AdaptStep {
  id: Guid;
  scale: number;
  x: number;
  y: number;
  w?: number;
  h?: number;
}

type Size = { w: number; h: number };

/** A layer covering this much of both of the frame's sides is its background; this much of its width, a band */
const COVER = 0.9;

/**
 * A distance from an edge in the new frame: past the safe area's band, as far past the new one (scaled); inside the
 * band, at the new band's edge when that is deeper (a post's button going to a story stays over its bottom band), else
 * as far into it in proportion (a story's footer going to a post).
 */
function fromEdge(d: number, oldBand: number, newBand: number, s: number): number {
  if (d >= oldBand) return newBand + (d - oldBand) * s;
  if (newBand >= oldBand) return newBand;
  return oldBand > 0 ? (d / oldBand) * newBand : d * s;
}

/** Where a span goes along one axis: by its third of the old frame, against the safe area's edges */
function place(lo: number, len: number, oldLen: number, newLen: number, oldSafe: [number, number], newSafe: [number, number], s: number, newSpan: number): number {
  const mid = (lo + len / 2) / Math.max(1, oldLen);
  if (mid < 1 / 3) return fromEdge(lo, oldSafe[0], newSafe[0], s);
  if (mid > 2 / 3) return newLen - fromEdge(oldLen - (lo + len), oldSafe[1], newSafe[1], s) - newSpan;
  const oldIn = Math.max(1, oldLen - oldSafe[0] - oldSafe[1]);
  const newIn = Math.max(1, newLen - newSafe[0] - newSafe[1]);
  const centre = newSafe[0] + ((lo + len / 2 - oldSafe[0]) / oldIn) * newIn;
  return centre - newSpan / 2;
}

/** Each layer's scale and place in the frame at its new size (pure: the tests' and adaptPost's). */
export function planAdapt(layers: readonly AdaptLayer[], from: Size, to: Size, safeFrom: Insets, safeTo: Insets): AdaptStep[] {
  const sx = to.w / Math.max(1, from.w);
  const sy = to.h / Math.max(1, from.h);
  const s = Math.min(sx, sy);
  const xs = (safe: Insets): [number, number] => [safe.left, safe.right];
  const ys = (safe: Insets): [number, number] => [safe.top, safe.bottom];
  return layers.map((l) => {
    const wide = l.w >= from.w * COVER;
    const tall = l.h >= from.h * COVER;
    if (wide && tall) return { id: l.id, scale: 1, x: l.x * sx, y: l.y * sy, w: l.w * sx, h: l.h * sy };
    if (wide) {
      const h = l.h * s;
      return { id: l.id, scale: s, x: l.x * sx, y: place(l.y, l.h, from.h, to.h, ys(safeFrom), ys(safeTo), s, h), w: l.w * sx, h };
    }
    const w = l.w * s;
    const h = l.h * s;
    return { id: l.id, scale: s, x: place(l.x, l.w, from.w, to.w, xs(safeFrom), xs(safeTo), s, w), y: place(l.y, l.h, from.h, to.h, ys(safeFrom), ys(safeTo), s, h) };
  });
}

/** A layer's box in its parent from its transform and size */
function boxOf(t: { m00: number; m01: number; m02: number; m10: number; m11: number; m12: number }, w: number, h: number): { x: number; y: number; w: number; h: number } {
  const xs = [0, w * t.m00, h * t.m01, w * t.m00 + h * t.m01].map((v) => v + t.m02);
  const ys = [0, w * t.m10, h * t.m11, w * t.m10 + h * t.m11].map((v) => v + t.m12);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/**
 * Adapts a post to another size (and format): the frame resized and its layers placed again (`planAdapt`). Inside the
 * write that is open. False when the engine refused (nothing written).
 */
export function adaptPost(ed: EditorController, id: Guid, to: { width: number; height: number; formatId: string }, fromFormatId: string): boolean {
  const post = ed.engine.readNode(id, { fields: ["size"], childIds: true }) as { size?: { x: number; y: number }; childIds?: Guid[] } | null;
  if (!post?.size) return false;
  const from = { w: post.size.x, h: post.size.y };
  const children = (ed.engine.readNodes(post.childIds ?? [], { fields: ["transform", "size", "visible"] }) as { guid: Guid; transform?: { m00: number; m01: number; m02: number; m10: number; m11: number; m12: number }; size?: { x: number; y: number } }[])
    .filter((n) => n.transform && n.size)
    .map((n) => ({ id: n.guid, ...boxOf(n.transform!, n.size!.x, n.size!.y) }));
  const steps = planAdapt(children, from, { w: to.width, h: to.height }, safeAreaOf(fromFormatId, from.w, from.h).insets, safeAreaOf(to.formatId, to.width, to.height).insets);
  return ed.engine.adaptFrame(id, { x: to.width, y: to.height }, steps) === 0;
}
