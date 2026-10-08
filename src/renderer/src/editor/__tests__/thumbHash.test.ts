// ThumbHash (Evan Wallace's placeholder, Paint.thumbHash): the TypeScript port encodes a small image into a few
// bytes whose decode has the image's aspect and average colour; opaque images carry no alpha channel; stable.
import { describe, expect, it } from "vitest";
import { rgbaToThumbHash, thumbHashHasAlpha, thumbHashToApproximateAspectRatio, thumbHashToAverageRGBA, thumbHashToPremultipliedRGBA, thumbHashToRGBA } from "../thumbHash";

/** A w × h image whose colour runs from `from` (left) to `to` (right), straight RGBA. */
function gradient(w: number, h: number, from: [number, number, number, number], to: [number, number, number, number]): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const t = w > 1 ? x / (w - 1) : 0;
      const i = (y * w + x) * 4;
      for (let c = 0; c < 4; c++) out[i + c] = Math.round(from[c] + (to[c] - from[c]) * t);
    }
  return out;
}

/** The average of a straight-RGBA buffer (0…1 each), alpha-weighted like the encoder's. */
function average(rgba: Uint8Array) {
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    const alpha = rgba[i + 3] / 255;
    r += (alpha * rgba[i]) / 255;
    g += (alpha * rgba[i + 1]) / 255;
    b += (alpha * rgba[i + 2]) / 255;
    a += alpha;
  }
  return { r: r / a, g: g / a, b: b / a, a: a / (rgba.length / 4) };
}

describe("ThumbHash", () => {
  it("a 100×64 red→blue gradient: a hash of a few bytes, the right aspect, the average colour", () => {
    const rgba = gradient(100, 64, [255, 0, 0, 255], [0, 0, 255, 255]);
    const hash = rgbaToThumbHash(100, 64, rgba);
    // 5 header bytes + a nibble per AC term: 7 × 4 luminance terms (18) + 5 + 5 chroma = 28 nibbles = 14 bytes.
    expect(hash.length).toBeGreaterThanOrEqual(19);
    expect(hash.length).toBeLessThanOrEqual(28);
    expect(thumbHashHasAlpha(hash)).toBe(false);
    expect(thumbHashToApproximateAspectRatio(hash)).toBeCloseTo(7 / 4, 5);
    const { w, h, rgba: out } = thumbHashToRGBA(hash);
    expect(w).toBe(32);
    expect(h).toBe(Math.round(32 / (7 / 4)));
    expect(out.length).toBe(w * h * 4);
    // The average colour of the decode and of the header's constants both match the source (within the quantization).
    const want = average(rgba);
    const avg = thumbHashToAverageRGBA(hash);
    expect(Math.abs(avg.r - want.r)).toBeLessThan(0.08);
    expect(Math.abs(avg.g - want.g)).toBeLessThan(0.08);
    expect(Math.abs(avg.b - want.b)).toBeLessThan(0.08);
    expect(avg.a).toBe(1);
    const got = average(out);
    expect(Math.abs(got.r - want.r)).toBeLessThan(0.1);
    expect(Math.abs(got.b - want.b)).toBeLessThan(0.1);
    // The gradient's direction survives: red on the left, blue on the right, every pixel opaque.
    const left = out.subarray(0, 4);
    const right = out.subarray((w - 1) * 4, w * 4);
    expect(left[0]).toBeGreaterThan(left[2]);
    expect(right[2]).toBeGreaterThan(right[0]);
    for (let i = 3; i < out.length; i += 4) expect(out[i]).toBe(255);
  });

  it("an opaque image has no alpha channel in the hash; a transparent one does, and the decode is premultipliable", () => {
    const opaque = rgbaToThumbHash(50, 50, gradient(50, 50, [20, 200, 40, 255], [20, 200, 40, 255]));
    expect(thumbHashHasAlpha(opaque)).toBe(false);
    expect(opaque.length).toBe(5 + Math.ceil((27 + 5 + 5) / 2)); // 7 × 7 luminance terms (27) + chroma
    expect(thumbHashToApproximateAspectRatio(opaque)).toBe(1);
    const translucent = rgbaToThumbHash(64, 100, gradient(64, 100, [255, 255, 255, 0], [255, 255, 255, 255]));
    expect(thumbHashHasAlpha(translucent)).toBe(true);
    expect(translucent.length).toBeGreaterThan(opaque.length - 5);
    expect(thumbHashToApproximateAspectRatio(translucent)).toBeCloseTo(3 / 5, 5);
    const avg = thumbHashToAverageRGBA(translucent);
    expect(avg.a).toBeGreaterThan(0.3);
    expect(avg.a).toBeLessThan(0.7);
    const { w, h, rgba } = thumbHashToPremultipliedRGBA(translucent);
    expect(w).toBeLessThan(h);
    expect(h).toBe(32);
    // Premultiplied: no channel exceeds its alpha; the left edge is nearly clear, the right edge nearly solid.
    for (let i = 0; i < rgba.length; i += 4) for (let c = 0; c < 3; c++) expect(rgba[i + c]).toBeLessThanOrEqual(rgba[i + 3] + 1);
    expect(rgba[3]).toBeLessThan(rgba[(w - 1) * 4 + 3]);
  });

  it("round trip is stable: re-encoding the decode gives the same hash", () => {
    const hash = rgbaToThumbHash(100, 64, gradient(100, 64, [255, 0, 0, 255], [0, 0, 255, 255]));
    const { w, h, rgba } = thumbHashToRGBA(hash);
    const again = rgbaToThumbHash(w, h, rgba);
    expect(again.length).toBe(hash.length);
    // The constants (average colour, luminance scale, no alpha) and the aspect are identical. The chroma scales
    // (bytes 3–4) grow a little: the reference decoder boosts saturation 1.25× to make up for the quantization.
    expect([...again.subarray(0, 3)]).toEqual([...hash.subarray(0, 3)]);
    expect(thumbHashToApproximateAspectRatio(again)).toBe(thumbHashToApproximateAspectRatio(hash));
    expect(thumbHashToAverageRGBA(again)).toEqual(thumbHashToAverageRGBA(hash));
    // The two decodes are the same picture (mean difference under 3 %).
    const twice = thumbHashToRGBA(again);
    expect([twice.w, twice.h]).toEqual([w, h]);
    let diff = 0;
    for (let i = 0; i < rgba.length; i++) diff += Math.abs(twice.rgba[i] - rgba[i]);
    expect(diff / rgba.length / 255).toBeLessThan(0.03);
    // Encoding the same pixels twice is bit-identical.
    expect([...rgbaToThumbHash(w, h, rgba)]).toEqual([...again]);
    // Inputs over 100 px are refused (the reference's rule).
    expect(() => rgbaToThumbHash(101, 10, new Uint8Array(101 * 10 * 4))).toThrow();
  });
});
