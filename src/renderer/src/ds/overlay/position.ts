import type { Placement } from "../types";

/** Floating placement (pure): beside an anchor, flipped and shifted to stay 8px inside the view. */
export type Rect = { left: number; top: number; right: number; bottom: number };
export type Size = { width: number; height: number };
export type Align = "start" | "center" | "end";

export const EDGE = 8;

export function place(anchor: Rect, box: Size, view: Size, side: Placement = "bottom", align: Align = "center", gap = 6): { x: number; y: number; side: Placement } {
  const room: Record<Placement, number> = {
    bottom: view.height - anchor.bottom - gap - EDGE,
    top: anchor.top - gap - EDGE,
    right: view.width - anchor.right - gap - EDGE,
    left: anchor.left - gap - EDGE,
  };
  const opposite: Record<Placement, Placement> = { top: "bottom", bottom: "top", left: "right", right: "left" };
  const need = side === "top" || side === "bottom" ? box.height : box.width;
  const final = room[side] < need && room[opposite[side]] > room[side] ? opposite[side] : side;
  let x: number;
  let y: number;
  if (final === "top" || final === "bottom") {
    y = final === "bottom" ? anchor.bottom + gap : anchor.top - gap - box.height;
    x = align === "start" ? anchor.left : align === "end" ? anchor.right - box.width : (anchor.left + anchor.right) / 2 - box.width / 2;
  } else {
    x = final === "right" ? anchor.right + gap : anchor.left - gap - box.width;
    y = align === "start" ? anchor.top : align === "end" ? anchor.bottom - box.height : (anchor.top + anchor.bottom) / 2 - box.height / 2;
  }
  x = Math.max(EDGE, Math.min(x, view.width - EDGE - box.width));
  y = Math.max(EDGE, Math.min(y, view.height - EDGE - box.height));
  return { x: Math.round(x), y: Math.round(y), side: final };
}

/**
 * A menu at a point (context menu) or beside an item (submenu): right/down
 * from it; when it would reach past the view, to the left of `flipX` (the
 * item's left edge) and up (§4.8).
 */
export function placeMenu(x: number, y: number, box: Size, view: Size, flipX?: number, edges: { top: number; bottom: number } = { top: EDGE, bottom: EDGE }): { x: number; y: number } {
  const left = x + box.width > view.width - EDGE ? Math.max(EDGE, (flipX ?? view.width - EDGE) - box.width) : x;
  const top = y + box.height > view.height - edges.bottom ? Math.max(edges.top, view.height - edges.bottom - box.height) : y;
  return { x: left, y: top };
}

/** A Select's list under its trigger (flush, 8 left of it), or above it without the room (8 from the view's edges). */
export function placeBelow(trigger: Rect, box: Size, view: Size): { x: number; y: number } {
  const fits = trigger.bottom + box.height <= view.height - EDGE;
  const y = fits ? trigger.bottom : trigger.top - box.height;
  return {
    x: Math.round(Math.max(EDGE, Math.min(trigger.left - 8, view.width - EDGE - box.width))),
    y: Math.round(Math.max(EDGE, Math.min(y, view.height - EDGE - box.height))),
  };
}

/** A Select's list over its trigger: the checked item's row centred on the trigger, clamped into the view. */
export function placeOverTrigger(trigger: Rect, itemTop: number | null, itemHeight: number, box: Size, view: Size): { x: number; y: number } {
  const h = trigger.bottom - trigger.top;
  const yWanted = itemTop === null ? trigger.bottom + 4 : trigger.top - itemTop + (h - itemHeight) / 2;
  // Live capture (constraint / stroke position / colour format lists): the item's box over the field's — the list 8 to the left.
  const xWanted = trigger.left - (itemTop === null ? 0 : 8);
  return {
    x: Math.round(Math.max(EDGE, Math.min(xWanted, view.width - EDGE - box.width))),
    y: Math.round(Math.max(EDGE, Math.min(yWanted, view.height - EDGE - box.height))),
  };
}
