// Where a collage's stage sits on its tile: scaled to fit inside the tile (never above 1×) and centred, so nothing a
// scene shows is ever cut off. Only on a narrow tile (a phone), where fitting would make the UI unreadable, the stage
// is scaled to cover it, keeping at least `safe` px of the stage's width in view, and is cropped around `focus`.

export interface StageBox {
  s: number;
  x: number;
  y: number;
}

/** Tiles narrower than this (px) are phones. */
export const NARROW = 640;

export function stageBox(W: number, H: number, w: number, h: number, focus: readonly [number, number] = [0.5, 0.5], safe = w * 0.45): StageBox {
  const fit = Math.min(1, W / w, H / h);
  // A phone: cover the tile, but keep `safe` px of the width in view (the old crop, readable at that size)
  const s = W >= NARROW ? fit : Math.max(fit, Math.min(1, Math.max(W / w, H / h), Math.max(W / w, W / safe)));
  const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
  const x = w * s <= W ? (W - w * s) / 2 : clamp(W / 2 - focus[0] * w * s, W - w * s, 0);
  const y = h * s <= H ? (H - h * s) / 2 : clamp(H / 2 - focus[1] * h * s, H - h * s, 0);
  return { s, x: Math.round(x), y: Math.round(y) };
}
