/**
 * Pixel maths of the image tools (docs/ai.md §2.6), pure: straight RGBA images, resizing, the models' tensors, mattes,
 * lasso masks, feathering, compositing, and Expand's padded canvas and re-composite. No DOM: the worker, the tools
 * and the tests share it.
 */

/** Straight RGBA8, rows top to bottom (the engine's Pixels has the same layout as `pixels`). */
export interface Rgba {
  width: number;
  height: number;
  data: Uint8Array;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export const blank = (width: number, height: number): Rgba => ({ width, height, data: new Uint8Array(width * height * 4) });

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** Bilinear resize, weighted by alpha (no dark fringes at transparent edges). */
export function resize(src: Rgba, width: number, height: number): Rgba {
  width = Math.max(1, Math.round(width));
  height = Math.max(1, Math.round(height));
  if (width === src.width && height === src.height) return { width, height, data: src.data.slice() };
  const out = blank(width, height);
  const sx = src.width / width;
  const sy = src.height / height;
  const s = src.data;
  // A strong shrink averages the box it covers; otherwise bilinear.
  if (sx >= 2 || sy >= 2) {
    for (let y = 0; y < height; y++) {
      const y0 = Math.floor(y * sy);
      const y1 = Math.max(y0 + 1, Math.min(src.height, Math.floor((y + 1) * sy)));
      for (let x = 0; x < width; x++) {
        const x0 = Math.floor(x * sx);
        const x1 = Math.max(x0 + 1, Math.min(src.width, Math.floor((x + 1) * sx)));
        let r = 0, g = 0, b = 0, a = 0, n = 0;
        for (let yy = y0; yy < y1; yy++)
          for (let xx = x0; xx < x1; xx++) {
            const i = (yy * src.width + xx) * 4;
            const al = s[i + 3];
            r += s[i] * al;
            g += s[i + 1] * al;
            b += s[i + 2] * al;
            a += al;
            n++;
          }
        const o = (y * width + x) * 4;
        if (a > 0) {
          out.data[o] = Math.round(r / a);
          out.data[o + 1] = Math.round(g / a);
          out.data[o + 2] = Math.round(b / a);
        }
        out.data[o + 3] = Math.round(a / n);
      }
    }
    return out;
  }
  for (let y = 0; y < height; y++) {
    const fy = clamp((y + 0.5) * sy - 0.5, 0, src.height - 1);
    const y0 = Math.floor(fy);
    const y1 = Math.min(src.height - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < width; x++) {
      const fx = clamp((x + 0.5) * sx - 0.5, 0, src.width - 1);
      const x0 = Math.floor(fx);
      const x1 = Math.min(src.width - 1, x0 + 1);
      const tx = fx - x0;
      const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty), w01 = (1 - tx) * ty, w11 = tx * ty;
      const i00 = (y0 * src.width + x0) * 4, i10 = (y0 * src.width + x1) * 4, i01 = (y1 * src.width + x0) * 4, i11 = (y1 * src.width + x1) * 4;
      const a00 = s[i00 + 3] * w00, a10 = s[i10 + 3] * w10, a01 = s[i01 + 3] * w01, a11 = s[i11 + 3] * w11;
      const a = a00 + a10 + a01 + a11;
      const o = (y * width + x) * 4;
      if (a > 0)
        for (let c = 0; c < 3; c++) out.data[o + c] = Math.round((s[i00 + c] * a00 + s[i10 + c] * a10 + s[i01 + c] * a01 + s[i11 + c] * a11) / a);
      out.data[o + 3] = Math.round(a);
    }
  }
  return out;
}

/** A single-channel map (a matte, a mask) resized bilinearly. */
export function resizeMap(src: Uint8Array, sw: number, sh: number, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height);
  const sx = sw / width, sy = sh / height;
  for (let y = 0; y < height; y++) {
    const fy = clamp((y + 0.5) * sy - 0.5, 0, sh - 1);
    const y0 = Math.floor(fy), y1 = Math.min(sh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < width; x++) {
      const fx = clamp((x + 0.5) * sx - 0.5, 0, sw - 1);
      const x0 = Math.floor(fx), x1 = Math.min(sw - 1, x0 + 1), tx = fx - x0;
      const v = src[y0 * sw + x0] * (1 - tx) * (1 - ty) + src[y0 * sw + x1] * tx * (1 - ty) + src[y1 * sw + x0] * (1 - tx) * ty + src[y1 * sw + x1] * tx * ty;
      out[y * width + x] = Math.round(v);
    }
  }
  return out;
}

export function crop(src: Rgba, r: Rect): Rgba {
  const out = blank(r.width, r.height);
  for (let y = 0; y < r.height; y++) {
    const sy = r.y + y;
    if (sy < 0 || sy >= src.height) continue;
    for (let x = 0; x < r.width; x++) {
      const sx = r.x + x;
      if (sx < 0 || sx >= src.width) continue;
      const i = (sy * src.width + sx) * 4, o = (y * r.width + x) * 4;
      out.data[o] = src.data[i];
      out.data[o + 1] = src.data[i + 1];
      out.data[o + 2] = src.data[i + 2];
      out.data[o + 3] = src.data[i + 3];
    }
  }
  return out;
}

/** `src` copied into `dst` at (x, y) — exact pixels, no blending. */
export function paste(dst: Rgba, src: Rgba, x: number, y: number): void {
  for (let yy = 0; yy < src.height; yy++) {
    const dy = y + yy;
    if (dy < 0 || dy >= dst.height) continue;
    for (let xx = 0; xx < src.width; xx++) {
      const dx = x + xx;
      if (dx < 0 || dx >= dst.width) continue;
      const i = (yy * src.width + xx) * 4, o = (dy * dst.width + dx) * 4;
      dst.data[o] = src.data[i];
      dst.data[o + 1] = src.data[i + 1];
      dst.data[o + 2] = src.data[i + 2];
      dst.data[o + 3] = src.data[i + 3];
    }
  }
}

/** RGB as a CHW float tensor: (v / 255 − mean) / std per channel. */
export function toChw(src: Rgba, mean: readonly number[] = [0, 0, 0], std: readonly number[] = [1, 1, 1]): Float32Array {
  const n = src.width * src.height;
  const out = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) out[c * n + i] = (src.data[i * 4 + c] / 255 - mean[c]) / std[c];
  return out;
}

/** A CHW RGB tensor back to opaque RGBA: value × `scale` (1 for 0…255 outputs, 255 for 0…1). */
export function fromChw(t: ArrayLike<number>, width: number, height: number, scale: number): Rgba {
  const n = width * height;
  const out = blank(width, height);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) out.data[i * 4 + c] = clamp(Math.round(t[c * n + i] * scale), 0, 255);
    out.data[i * 4 + 3] = 255;
  }
  return out;
}

/** Probabilities (0…1) → a 0…255 matte. */
export function matteFromProbabilities(t: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(t.length);
  for (let i = 0; i < t.length; i++) out[i] = Math.round(255 * Math.min(1, Math.max(0, t[i])));
  return out;
}

/** The matte (same size) as the picture's alpha: alpha × matte / 255. */
export function applyMatte(src: Rgba, matte: Uint8Array): Rgba {
  const out = { width: src.width, height: src.height, data: src.data.slice() };
  for (let i = 0; i < matte.length; i++) out.data[i * 4 + 3] = Math.round((out.data[i * 4 + 3] * matte[i]) / 255);
  return out;
}

/** A closed polygon as a 0 / 255 mask (pixel centres inside, even-odd). */
export function rasterizePolygon(points: readonly Point[], width: number, height: number): Uint8Array {
  const mask = new Uint8Array(width * height);
  if (points.length < 3) return mask;
  const xs: number[] = [];
  for (let y = 0; y < height; y++) {
    const cy = y + 0.5;
    xs.length = 0;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const a = points[i], b = points[j];
      if (a.y > cy !== b.y > cy) xs.push(a.x + ((cy - a.y) / (b.y - a.y)) * (b.x - a.x));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const from = Math.max(0, Math.ceil(xs[k] - 0.5));
      const to = Math.min(width - 1, Math.floor(xs[k + 1] - 0.5));
      for (let x = from; x <= to; x++) mask[y * width + x] = 255;
    }
  }
  return mask;
}

/** A mask grown by `r` px (any pixel within r of one set). */
export function dilate(mask: Uint8Array, width: number, height: number, r: number): Uint8Array {
  if (r <= 0) return mask.slice();
  const tmp = new Uint8Array(mask.length);
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      let m = 0;
      for (let k = Math.max(0, x - r); k <= Math.min(width - 1, x + r) && !m; k++) m = mask[y * width + k];
      tmp[y * width + x] = m;
    }
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      let m = 0;
      for (let k = Math.max(0, y - r); k <= Math.min(height - 1, y + r) && !m; k++) m = tmp[k * width + x];
      out[y * width + x] = m;
    }
  return out;
}

/** A soft edge: a box blur of radius r, twice (≈ a Gaussian). */
export function feather(mask: Uint8Array, width: number, height: number, r: number): Uint8Array {
  if (r <= 0) return mask.slice();
  let cur = Float32Array.from(mask);
  for (let pass = 0; pass < 2; pass++) {
    const h = new Float32Array(cur.length);
    for (let y = 0; y < height; y++) {
      let sum = 0;
      const row = y * width;
      for (let x = -r; x <= r; x++) sum += cur[row + clamp(x, 0, width - 1)];
      for (let x = 0; x < width; x++) {
        h[row + x] = sum / (2 * r + 1);
        sum += cur[row + clamp(x + r + 1, 0, width - 1)] - cur[row + clamp(x - r, 0, width - 1)];
      }
    }
    const v = new Float32Array(cur.length);
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let y = -r; y <= r; y++) sum += h[clamp(y, 0, height - 1) * width + x];
      for (let y = 0; y < height; y++) {
        v[y * width + x] = sum / (2 * r + 1);
        sum += h[clamp(y + r + 1, 0, height - 1) * width + x] - h[clamp(y - r, 0, height - 1) * width + x];
      }
    }
    cur = v;
  }
  return Uint8Array.from(cur, (x) => Math.round(x));
}

/** The smallest rectangle holding every set pixel, or null. */
export function maskBounds(mask: Uint8Array, width: number, height: number): Rect | null {
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (mask[y * width + x]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  return x1 < 0 ? null : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

/** A rectangle grown by `m` and kept inside width × height. */
export function grow(r: Rect, m: number, width: number, height: number): Rect {
  const x = Math.max(0, r.x - m), y = Math.max(0, r.y - m);
  return { x, y, width: Math.min(width, r.x + r.width + m) - x, height: Math.min(height, r.y + r.height + m) - y };
}

/** `over` (placed at x, y) mixed into `base` by `mask` (over's size, 0…255): base × (1 − m) + over × m. */
export function blendMasked(base: Rgba, over: Rgba, mask: Uint8Array, x: number, y: number): Rgba {
  const out = { width: base.width, height: base.height, data: base.data.slice() };
  for (let yy = 0; yy < over.height; yy++) {
    const dy = y + yy;
    if (dy < 0 || dy >= base.height) continue;
    for (let xx = 0; xx < over.width; xx++) {
      const dx = x + xx;
      if (dx < 0 || dx >= base.width) continue;
      const m = mask[yy * over.width + xx] / 255;
      if (!m) continue;
      const i = (yy * over.width + xx) * 4, o = (dy * base.width + dx) * 4;
      for (let c = 0; c < 4; c++) out.data[o + c] = Math.round(out.data[o + c] * (1 - m) + over.data[i + c] * m);
    }
  }
  return out;
}

// ---- Blur (docs/studio.md §6.2) ---------------------------------------------------------------------------------------

/** A Gaussian blur of σ px (separable, the kernel to 3σ, edges repeated), alpha weighted like `resize`. */
export function gaussianBlur(src: Rgba, sigma: number): Rgba {
  const { width, height } = src;
  const r = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float32Array(2 * r + 1);
  let total = 0;
  for (let i = -r; i <= r; i++) total += k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
  for (let i = 0; i < k.length; i++) k[i] /= total;
  // Premultiplied, so transparent pixels don't darken their neighbours
  const pre = new Float32Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const a = src.data[i * 4 + 3] / 255;
    pre[i * 4] = src.data[i * 4] * a;
    pre[i * 4 + 1] = src.data[i * 4 + 1] * a;
    pre[i * 4 + 2] = src.data[i * 4 + 2] * a;
    pre[i * 4 + 3] = src.data[i * 4 + 3];
  }
  const pass = (from: Float32Array, horizontal: boolean) => {
    const to = new Float32Array(from.length);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
        for (let i = -r; i <= r; i++) {
          const j = horizontal ? y * width + clamp(x + i, 0, width - 1) : clamp(y + i, 0, height - 1) * width + x;
          const w = k[i + r];
          s0 += from[j * 4] * w;
          s1 += from[j * 4 + 1] * w;
          s2 += from[j * 4 + 2] * w;
          s3 += from[j * 4 + 3] * w;
        }
        const o = (y * width + x) * 4;
        to[o] = s0;
        to[o + 1] = s1;
        to[o + 2] = s2;
        to[o + 3] = s3;
      }
    return to;
  };
  return unpremultiply(pass(pass(pre, true), false), width, height);
}

/** Each `block` × `block` square as its average (a lower-resolution print), alpha weighted. */
export function pixelate(src: Rgba, block: number): Rgba {
  const { width, height } = src;
  const out = new Float32Array(width * height * 4);
  for (let by = 0; by < height; by += block)
    for (let bx = 0; bx < width; bx += block) {
      const x1 = Math.min(width, bx + block), y1 = Math.min(height, by + block);
      let s0 = 0, s1 = 0, s2 = 0, s3 = 0, n = 0;
      for (let y = by; y < y1; y++)
        for (let x = bx; x < x1; x++) {
          const i = (y * width + x) * 4, a = src.data[i + 3] / 255;
          s0 += src.data[i] * a;
          s1 += src.data[i + 1] * a;
          s2 += src.data[i + 2] * a;
          s3 += src.data[i + 3];
          n++;
        }
      for (let y = by; y < y1; y++)
        for (let x = bx; x < x1; x++) {
          const o = (y * width + x) * 4;
          out[o] = s0 / n;
          out[o + 1] = s1 / n;
          out[o + 2] = s2 / n;
          out[o + 3] = s3 / n;
        }
    }
  return unpremultiply(out, width, height);
}

function unpremultiply(pre: Float32Array, width: number, height: number): Rgba {
  const out = blank(width, height);
  for (let i = 0; i < width * height; i++) {
    const a = pre[i * 4 + 3];
    const k = a > 0 ? 255 / a : 0;
    out.data[i * 4] = clamp(Math.round(pre[i * 4] * k), 0, 255);
    out.data[i * 4 + 1] = clamp(Math.round(pre[i * 4 + 1] * k), 0, 255);
    out.data[i * 4 + 2] = clamp(Math.round(pre[i * 4 + 2] * k), 0, 255);
    out.data[i * 4 + 3] = clamp(Math.round(a), 0, 255);
  }
  return out;
}

/** The pixelation's block: the area at a quarter of its resolution (§6.2's "4×"). */
export const BLUR_BLOCK = 4;

/** Blur's σ for an area: 1.5 % of its short side (px), at least half a pixel. */
export const blurSigma = (r: Pick<Rect, "width" | "height">) => Math.max(0.5, 0.015 * Math.min(r.width, r.height));

/**
 * Blur (docs/studio.md §6.2): the area under `mask` (the picture's size, 0 / 255) as a low-resolution print — a Gaussian
 * of σ (default: 1.5 % of the area's short side) mixed half and half with a 4× pixelation of it, put back through the
 * mask with a soft edge that stays inside it. Every pixel outside the mask is left exactly as it was.
 */
export function blurArea(image: Rgba, mask: Uint8Array, sigma?: number): Rgba {
  const bounds = maskBounds(mask, image.width, image.height);
  if (!bounds) return { ...image, data: image.data.slice() };
  const s = sigma ?? blurSigma(bounds);
  const region = grow(bounds, Math.ceil(s * 3) + BLUR_BLOCK, image.width, image.height);
  const blurred = gaussianBlur(crop(image, region), s);
  const blocky = pixelate(blurred, BLUR_BLOCK);
  const mixed = blank(region.width, region.height);
  for (let i = 0; i < mixed.data.length; i++) mixed.data[i] = Math.round((blurred.data[i] + blocky.data[i]) / 2);
  const sub = new Uint8Array(region.width * region.height);
  for (let y = 0; y < region.height; y++) sub.set(mask.subarray((region.y + y) * image.width + region.x, (region.y + y) * image.width + region.x + region.width), y * region.width);
  const soft = feather(sub, region.width, region.height, Math.max(1, Math.round(s)));
  for (let i = 0; i < soft.length; i++) soft[i] = sub[i] ? Math.max(1, Math.min(soft[i], sub[i])) : 0;
  return blendMasked(image, mixed, soft, region.x, region.y);
}

/** Blur on rectangles of the picture (px), each with its own σ. */
export function blurRects(image: Rgba, rects: readonly Rect[]): Rgba {
  let out = image;
  for (const r of rects) {
    const x0 = clamp(Math.floor(r.x), 0, image.width), y0 = clamp(Math.floor(r.y), 0, image.height);
    const x1 = clamp(Math.ceil(r.x + r.width), 0, image.width), y1 = clamp(Math.ceil(r.y + r.height), 0, image.height);
    if (x1 <= x0 || y1 <= y0) continue;
    const mask = new Uint8Array(image.width * image.height);
    for (let y = y0; y < y1; y++) mask.fill(255, y * image.width + x0, y * image.width + x1);
    out = blurArea(out, mask, blurSigma({ width: x1 - x0, height: y1 - y0 }));
  }
  return out === image ? { ...image, data: image.data.slice() } : out;
}

// ---- Expand (docs/ai.md §2.6, owner §10.1) --------------------------------------------------------------------------

export interface Insets {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * The picture on its larger canvas — the new area transparent — and the API's mask (OpenAI's convention: transparent
 * = to change, so the new area transparent and the original opaque).
 */
export function expandCanvas(src: Rgba, pad: Insets): { canvas: Rgba; mask: Rgba; at: Point } {
  const width = src.width + pad.left + pad.right;
  const height = src.height + pad.top + pad.bottom;
  const canvas = blank(width, height);
  paste(canvas, src, pad.left, pad.top);
  const mask = blank(width, height);
  for (let y = 0; y < src.height; y++)
    for (let x = 0; x < src.width; x++) {
      const o = ((y + pad.top) * width + x + pad.left) * 4;
      mask.data[o] = mask.data[o + 1] = mask.data[o + 2] = 0;
      mask.data[o + 3] = 255;
    }
  return { canvas, mask, at: { x: pad.left, y: pad.top } };
}

/**
 * The model's answer brought to the canvas's size, with the untouched original pasted back exactly where it was (so it
 * never shifts or changes), and the new area made opaque. The answer may come at another size or aspect: it is
 * stretched to the canvas (the instruction asked for the same framing).
 */
export function recomposite(answer: Rgba, original: Rgba, canvasWidth: number, canvasHeight: number, at: Point): Rgba {
  const out = resize(answer, canvasWidth, canvasHeight);
  for (let i = 3; i < out.data.length; i += 4) out.data[i] = 255;
  seamBand(out, original, at);
  paste(out, original, at.x, at.y);
  return out;
}

/**
 * The new area next to the original fades into the original's edge colours over a narrow band (4 % of its short side,
 * 4–64 px), outside it, so the original stays untouched. Run for real (2026-10-12), Antigravity's fill came in another
 * tone than the original and left a hard seam along its edges.
 */
function seamBand(out: Rgba, original: Rgba, at: Point) {
  const band = Math.max(4, Math.min(64, Math.round(0.04 * Math.min(original.width, original.height))));
  const x0 = at.x, y0 = at.y, x1 = at.x + original.width, y1 = at.y + original.height;
  for (let y = Math.max(0, y0 - band); y < Math.min(out.height, y1 + band); y++)
    for (let x = Math.max(0, x0 - band); x < Math.min(out.width, x1 + band); x++) {
      if (x >= x0 && x < x1 && y >= y0 && y < y1) continue;
      const dx = x < x0 ? x0 - x : x >= x1 ? x - x1 + 1 : 0;
      const dy = y < y0 ? y0 - y : y >= y1 ? y - y1 + 1 : 0;
      const d = Math.hypot(dx, dy);
      if (d > band) continue;
      const t = 1 - d / (band + 1);
      const w = t * t * (3 - 2 * t);
      const sx = Math.min(original.width - 1, Math.max(0, x - x0)), sy = Math.min(original.height - 1, Math.max(0, y - y0));
      const o = (y * out.width + x) * 4, s = (sy * original.width + sx) * 4;
      // The original's edge pixel weighted by its own alpha (a transparent edge leaves the answer as it is)
      const k = w * (original.data[s + 3] / 255);
      for (let c = 0; c < 3; c++) out.data[o + c] = Math.round(out.data[o + c] * (1 - k) + original.data[s + c] * k);
    }
}

/** The padding a target aspect needs around w × h (the least growth, centred), or none for freeform. */
export function insetsForAspect(width: number, height: number, aspect: number | null): Insets {
  if (!aspect || !(aspect > 0)) return { left: 0, top: 0, right: 0, bottom: 0 };
  const r = width / height;
  if (Math.abs(r - aspect) < 1e-6) return { left: 0, top: 0, right: 0, bottom: 0 };
  if (r < aspect) {
    const extra = height * aspect - width;
    return { left: Math.floor(extra / 2), right: Math.ceil(extra / 2), top: 0, bottom: 0 };
  }
  const extra = width / aspect - height;
  return { left: 0, right: 0, top: Math.floor(extra / 2), bottom: Math.ceil(extra / 2) };
}

// ---- Float16 (fp16 models' inputs on the wasm backend) -----------------------------------------------------------------

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

/** IEEE half-precision bits of a float (round to nearest). */
export function toHalf(v: number): number {
  f32[0] = v;
  const x = u32[0];
  const sign = (x >>> 16) & 0x8000;
  const exp = ((x >>> 23) & 0xff) - 127 + 15;
  let mant = x & 0x7fffff;
  if (exp >= 31) return sign | 0x7c00 | (((x >>> 23) & 0xff) === 0xff && mant ? 0x200 : 0);
  if (exp <= 0) {
    if (exp < -10) return sign;
    mant |= 0x800000;
    const shift = 14 - exp;
    let h = mant >> shift;
    if ((mant >> (shift - 1)) & 1) h++;
    return sign | h;
  }
  let h = sign | (exp << 10) | (mant >> 13);
  if (mant & 0x1000) h++;
  return h;
}

export function fromHalf(h: number): number {
  const sign = h & 0x8000 ? -1 : 1;
  const exp = (h >> 10) & 0x1f;
  const mant = h & 0x3ff;
  if (exp === 0) return sign * 2 ** -14 * (mant / 1024);
  if (exp === 31) return mant ? NaN : sign * Infinity;
  return sign * 2 ** (exp - 15) * (1 + mant / 1024);
}

export const toHalfArray = (a: Float32Array): Uint16Array => Uint16Array.from(a, toHalf);
export const fromHalfArray = (a: Uint16Array): Float32Array => Float32Array.from(a, fromHalf);
