// Where a collage's stage sits on its tile: scaled to cover the tile but never above 1×, and never so large that less
// than `safe` px of its width shows (a phone then sees the tile's colour above and below); centred where it fits,
// otherwise cropped around `focus` without showing past the stage's edges.

export interface StageBox {
  s: number;
  x: number;
  y: number;
}

export function stageBox(W: number, H: number, w: number, h: number, focus: readonly [number, number] = [0.5, 0.5], safe = w * 0.45): StageBox {
  const s = Math.min(1, Math.max(W / w, H / h), Math.max(W / w, W / safe));
  const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
  const x = w * s <= W ? (W - w * s) / 2 : clamp(W / 2 - focus[0] * w * s, W - w * s, 0);
  const y = h * s <= H ? (H - h * s) / 2 : clamp(H / 2 - focus[1] * h * s, H - h * s, 0);
  return { s, x: Math.round(x), y: Math.round(y) };
}
