/**
 * ThumbHash — Evan Wallace's compact image placeholder, the ~20–28 bytes Figma
 * keeps in `Paint.thumbHash` (schema field 25) "to show while the real image is
 * loading". A TypeScript port of the reference implementation:
 *
 *   https://evanw.github.io/thumbhash/ — https://github.com/evanw/thumbhash (MIT,
 *   Copyright (c) 2023 Evan Wallace), `js/thumbhash.js`.
 *
 * The encoder takes straight (non-premultiplied) RGBA of an image at most
 * 100 × 100 px; the decoder gives straight RGBA at most 32 px on the longer
 * side. Same bit layout as the reference, so hashes written by Figma decode
 * here and ours decode anywhere else. Pure data; no browser APIs.
 */

const { PI, round, max, min, cos, abs } = Math;

/** The largest image the encoder takes (a bigger one gains nothing and is slow). */
export const THUMBHASH_MAX_INPUT = 100;

/**
 * Encodes an RGBA image (straight alpha, row-major, 4 bytes per pixel) into a ThumbHash.
 * `w` and `h` must each be ≤ 100.
 */
export function rgbaToThumbHash(w: number, h: number, rgba: ArrayLike<number>): Uint8Array {
  if (w > THUMBHASH_MAX_INPUT || h > THUMBHASH_MAX_INPUT) throw new Error(`${w}x${h} doesn't fit in ${THUMBHASH_MAX_INPUT}x${THUMBHASH_MAX_INPUT}`);
  if (w < 1 || h < 1 || rgba.length < w * h * 4) throw new Error("rgbaToThumbHash: bad input");

  // The average colour (alpha-weighted).
  let avgR = 0;
  let avgG = 0;
  let avgB = 0;
  let avgA = 0;
  for (let i = 0, j = 0; i < w * h; i++, j += 4) {
    const alpha = rgba[j + 3] / 255;
    avgR += (alpha / 255) * rgba[j];
    avgG += (alpha / 255) * rgba[j + 1];
    avgB += (alpha / 255) * rgba[j + 2];
    avgA += alpha;
  }
  if (avgA) {
    avgR /= avgA;
    avgG /= avgA;
    avgB /= avgA;
  }

  const hasAlpha = avgA < w * h;
  const lLimit = hasAlpha ? 5 : 7; // fewer luminance terms when there is alpha
  const lx = max(1, round((lLimit * w) / max(w, h)));
  const ly = max(1, round((lLimit * h) / max(w, h)));
  const l: number[] = []; // luminance
  const p: number[] = []; // yellow − blue
  const q: number[] = []; // red − green
  const a: number[] = []; // alpha

  // RGBA → LPQA, composited atop the average colour.
  for (let i = 0, j = 0; i < w * h; i++, j += 4) {
    const alpha = rgba[j + 3] / 255;
    const r = avgR * (1 - alpha) + (alpha / 255) * rgba[j];
    const g = avgG * (1 - alpha) + (alpha / 255) * rgba[j + 1];
    const b = avgB * (1 - alpha) + (alpha / 255) * rgba[j + 2];
    l[i] = (r + g + b) / 3;
    p[i] = (r + g) / 2 - b;
    q[i] = r - g;
    a[i] = alpha;
  }

  // The DCT of a channel: its DC (constant) term and normalized AC (varying) terms.
  const encodeChannel = (channel: number[], nx: number, ny: number): [number, number[], number] => {
    let dc = 0;
    const ac: number[] = [];
    let scale = 0;
    const fx: number[] = [];
    for (let cy = 0; cy < ny; cy++) {
      for (let cx = 0; cx * ny < nx * (ny - cy); cx++) {
        let f = 0;
        for (let x = 0; x < w; x++) fx[x] = cos((PI / w) * cx * (x + 0.5));
        for (let y = 0; y < h; y++) {
          const fy = cos((PI / h) * cy * (y + 0.5));
          for (let x = 0; x < w; x++) f += channel[x + y * w] * fx[x] * fy;
        }
        f /= w * h;
        if (cx || cy) {
          ac.push(f);
          scale = max(scale, abs(f));
        } else dc = f;
      }
    }
    if (scale) for (let i = 0; i < ac.length; i++) ac[i] = 0.5 + (0.5 / scale) * ac[i];
    return [dc, ac, scale];
  };
  const [lDc, lAc, lScale] = encodeChannel(l, max(3, lx), max(3, ly));
  const [pDc, pAc, pScale] = encodeChannel(p, 3, 3);
  const [qDc, qAc, qScale] = encodeChannel(q, 3, 3);
  const [aDc, aAc, aScale] = hasAlpha ? encodeChannel(a, 5, 5) : [0, [] as number[], 0];

  // The constants.
  const isLandscape = w > h;
  const header24 = round(63 * lDc) | (round(31.5 + 31.5 * pDc) << 6) | (round(31.5 + 31.5 * qDc) << 12) | (round(31 * lScale) << 18) | ((hasAlpha ? 1 : 0) << 23);
  const header16 = (isLandscape ? ly : lx) | (round(63 * pScale) << 3) | (round(63 * qScale) << 9) | ((isLandscape ? 1 : 0) << 15);
  const hash: number[] = [header24 & 255, (header24 >> 8) & 255, header24 >> 16, header16 & 255, header16 >> 8];
  const acStart = hasAlpha ? 6 : 5;
  if (hasAlpha) hash.push(round(15 * aDc) | (round(15 * aScale) << 4));

  // The varying factors, a nibble each.
  let acIndex = 0;
  for (const ac of hasAlpha ? [lAc, pAc, qAc, aAc] : [lAc, pAc, qAc]) {
    for (const f of ac) {
      const at = acStart + (acIndex >> 1);
      hash[at] = (hash[at] ?? 0) | (round(15 * f) << ((acIndex++ & 1) << 2));
    }
  }
  return Uint8Array.from(hash);
}

/** Decodes a ThumbHash to straight RGBA at most 32 px on the longer side. */
export function thumbHashToRGBA(hash: ArrayLike<number>): { w: number; h: number; rgba: Uint8Array } {
  if (hash.length < 5) throw new Error("thumbHashToRGBA: not a ThumbHash");

  // The constants.
  const header24 = hash[0] | (hash[1] << 8) | (hash[2] << 16);
  const header16 = hash[3] | (hash[4] << 8);
  const lDc = (header24 & 63) / 63;
  const pDc = ((header24 >> 6) & 63) / 31.5 - 1;
  const qDc = ((header24 >> 12) & 63) / 31.5 - 1;
  const lScale = ((header24 >> 18) & 31) / 31;
  const hasAlpha = (header24 >> 23) !== 0;
  const pScale = ((header16 >> 3) & 63) / 63;
  const qScale = ((header16 >> 9) & 63) / 63;
  const isLandscape = (header16 >> 15) !== 0;
  const lx = max(3, isLandscape ? (hasAlpha ? 5 : 7) : header16 & 7);
  const ly = max(3, isLandscape ? header16 & 7 : hasAlpha ? 5 : 7);
  const aDc = hasAlpha ? (hash[5] & 15) / 15 : 1;
  const aScale = hasAlpha ? (hash[5] >> 4) / 15 : 0;

  // The varying factors (saturation boosted 1.25× to make up for the quantization).
  const acStart = hasAlpha ? 6 : 5;
  let acIndex = 0;
  const decodeChannel = (nx: number, ny: number, scale: number): number[] => {
    const ac: number[] = [];
    for (let cy = 0; cy < ny; cy++)
      for (let cx = cy ? 0 : 1; cx * ny < nx * (ny - cy); cx++) {
        const nibble = ((hash[acStart + (acIndex >> 1)] ?? 0) >> ((acIndex++ & 1) << 2)) & 15;
        ac.push((nibble / 7.5 - 1) * scale);
      }
    return ac;
  };
  const lAc = decodeChannel(lx, ly, lScale);
  const pAc = decodeChannel(3, 3, pScale * 1.25);
  const qAc = decodeChannel(3, 3, qScale * 1.25);
  const aAc = hasAlpha ? decodeChannel(5, 5, aScale) : [];

  // The inverse DCT into RGB.
  const ratio = thumbHashToApproximateAspectRatio(hash);
  const w = round(ratio > 1 ? 32 : 32 * ratio);
  const h = round(ratio > 1 ? 32 / ratio : 32);
  const rgba = new Uint8Array(w * h * 4);
  const fx: number[] = [];
  const fy: number[] = [];
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i += 4) {
      let l = lDc;
      let p = pDc;
      let q = qDc;
      let a = aDc;

      // The coefficients of this pixel.
      for (let cx = 0, n = max(lx, hasAlpha ? 5 : 3); cx < n; cx++) fx[cx] = cos((PI / w) * (x + 0.5) * cx);
      for (let cy = 0, n = max(ly, hasAlpha ? 5 : 3); cy < n; cy++) fy[cy] = cos((PI / h) * (y + 0.5) * cy);

      // L
      for (let cy = 0, j = 0; cy < ly; cy++) {
        const fy2 = fy[cy] * 2;
        for (let cx = cy ? 0 : 1; cx * ly < lx * (ly - cy); cx++, j++) l += lAc[j] * fx[cx] * fy2;
      }
      // P and Q
      for (let cy = 0, j = 0; cy < 3; cy++) {
        const fy2 = fy[cy] * 2;
        for (let cx = cy ? 0 : 1; cx < 3 - cy; cx++, j++) {
          const f = fx[cx] * fy2;
          p += pAc[j] * f;
          q += qAc[j] * f;
        }
      }
      // A
      if (hasAlpha)
        for (let cy = 0, j = 0; cy < 5; cy++) {
          const fy2 = fy[cy] * 2;
          for (let cx = cy ? 0 : 1; cx < 5 - cy; cx++, j++) a += aAc[j] * fx[cx] * fy2;
        }

      // LPQ → RGB
      const b = l - (2 / 3) * p;
      const r = (3 * l - b + q) / 2;
      const g = r - q;
      rgba[i] = max(0, 255 * min(1, r));
      rgba[i + 1] = max(0, 255 * min(1, g));
      rgba[i + 2] = max(0, 255 * min(1, b));
      rgba[i + 3] = max(0, 255 * min(1, a));
    }
  }
  return { w, h, rgba };
}

/** The image's average colour (0…1 each) from the hash's constant terms alone. */
export function thumbHashToAverageRGBA(hash: ArrayLike<number>): { r: number; g: number; b: number; a: number } {
  const header = hash[0] | (hash[1] << 8) | (hash[2] << 16);
  const l = (header & 63) / 63;
  const p = ((header >> 6) & 63) / 31.5 - 1;
  const q = ((header >> 12) & 63) / 31.5 - 1;
  const hasAlpha = (header >> 23) !== 0;
  const a = hasAlpha ? (hash[5] & 15) / 15 : 1;
  const b = l - (2 / 3) * p;
  const r = (3 * l - b + q) / 2;
  const g = r - q;
  return { r: max(0, min(1, r)), g: max(0, min(1, g)), b: max(0, min(1, b)), a };
}

/** The image's aspect ratio (width / height), approximately: the hash keeps it in whole DCT term counts. */
export function thumbHashToApproximateAspectRatio(hash: ArrayLike<number>): number {
  const header = hash[3];
  const hasAlpha = (hash[2] & 0x80) !== 0;
  const isLandscape = (hash[4] & 0x80) !== 0;
  const lx = isLandscape ? (hasAlpha ? 5 : 7) : header & 7;
  const ly = isLandscape ? header & 7 : hasAlpha ? 5 : 7;
  return lx / ly;
}

/** Does the hash carry an alpha channel (the image had transparent pixels)? */
export const thumbHashHasAlpha = (hash: ArrayLike<number>): boolean => (hash[2] & 0x80) !== 0;

/** The decoded placeholder with its alpha premultiplied: what a texture upload (the engine's `addImageRgba`) wants. */
export function thumbHashToPremultipliedRGBA(hash: ArrayLike<number>): { w: number; h: number; rgba: Uint8Array } {
  const out = thumbHashToRGBA(hash);
  if (thumbHashHasAlpha(hash)) {
    const px = out.rgba;
    for (let i = 0; i < px.length; i += 4) {
      const a = px[i + 3];
      if (a === 255) continue;
      px[i] = (px[i] * a + 127) / 255;
      px[i + 1] = (px[i + 1] * a + 127) / 255;
      px[i + 2] = (px[i + 2] * a + 127) / 255;
    }
  }
  return out;
}
