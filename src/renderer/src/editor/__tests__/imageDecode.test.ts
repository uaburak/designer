import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  classifyIccProfile,
  COLOR_PROFILE_DISPLAY_P3,
  COLOR_PROFILE_SRGB,
  isMultiFrameGif,
  isSvg,
  jpegIccProfile,
  prepareImage,
  stripPngColorChunks,
  webpIccProfile,
} from "../imageDecode";

// ---- Synthetic files ----------------------------------------------------------------------------------------------

const P3 = [
  [0.515102, 0.241196, -0.00105],
  [0.291965, 0.692245, 0.041881],
  [0.157153, 0.066561, 0.784073],
];
const SRGB = [
  [0.436066, 0.222488, 0.013916],
  [0.385147, 0.716873, 0.097076],
  [0.143066, 0.060608, 0.714096],
];

const be32 = (v: number) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
const text = (s: string) => [...s].map((c) => c.charCodeAt(0));

/** A minimal ICC profile: the header ('acsp' at 36) and a tag table of XYZ colorants and/or a description. */
function icc(opts: { colorants?: number[][]; desc?: string; mluc?: string }): Uint8Array {
  const tags: { sig: string; data: number[] }[] = [];
  if (opts.colorants)
    ["rXYZ", "gXYZ", "bXYZ"].forEach((sig, c) =>
      tags.push({ sig, data: [...text("XYZ "), 0, 0, 0, 0, ...opts.colorants![c].flatMap((v) => be32(Math.round(v * 65536) >>> 0))] })
    );
  if (opts.desc !== undefined) tags.push({ sig: "desc", data: [...text("desc"), 0, 0, 0, 0, ...be32(opts.desc.length + 1), ...text(opts.desc), 0] });
  if (opts.mluc !== undefined) {
    const utf16 = [...opts.mluc].flatMap((c) => [0, c.charCodeAt(0)]);
    tags.push({ sig: "desc", data: [...text("mluc"), 0, 0, 0, 0, ...be32(1), ...be32(12), ...text("enUS"), ...be32(utf16.length), ...be32(28), ...utf16] });
  }
  const header = new Array(128).fill(0);
  header.splice(36, 4, ...text("acsp"));
  const table = [...be32(tags.length)];
  let offset = 128 + 4 + 12 * tags.length;
  const body: number[] = [];
  for (const t of tags) {
    table.push(...text(t.sig), ...be32(offset), ...be32(t.data.length));
    body.push(...t.data);
    while (body.length % 4) body.push(0);
    offset = 128 + 4 + 12 * tags.length + body.length;
  }
  const out = [...header, ...table, ...body];
  out.splice(0, 4, ...be32(out.length));
  return new Uint8Array(out);
}

function pngChunk(type: string, data: number[] | Uint8Array): number[] {
  return [...be32(data.length), ...text(type), ...data, 0, 0, 0, 0]; // CRC not checked here
}

function png(colorChunks: number[][]): Uint8Array {
  return new Uint8Array([
    137, 80, 78, 71, 13, 10, 26, 10,
    ...pngChunk("IHDR", new Array(13).fill(1)),
    ...colorChunks.flat(),
    ...pngChunk("IDAT", [1, 2, 3]),
    ...pngChunk("tEXt", text("after")),
    ...pngChunk("IEND", []),
  ]);
}

function iccpChunk(profile: Uint8Array): number[] {
  return pngChunk("iCCP", [...text("Display P3"), 0, 0, ...deflateSync(profile)]);
}

// ---- Tests --------------------------------------------------------------------------------------------------------

describe("image decode, Figma's way (docs/research/rea/canvas.md §2.6)", () => {
  it("classifies a profile by its colorants: Display P3, else sRGB", () => {
    expect(classifyIccProfile(icc({ colorants: P3 }))).toBe(COLOR_PROFILE_DISPLAY_P3);
    expect(classifyIccProfile(icc({ colorants: SRGB }))).toBe(COLOR_PROFILE_SRGB);
    // Adobe RGB, or anything else: sRGB (Figma's default).
    expect(classifyIccProfile(icc({ colorants: [[0.6097, 0.3111, 0.0195], [0.2053, 0.6257, 0.0609], [0.1492, 0.0632, 0.7446]] }))).toBe(COLOR_PROFILE_SRGB);
    // Colorants win over the name.
    expect(classifyIccProfile(icc({ colorants: SRGB, desc: "Display P3" }))).toBe(COLOR_PROFILE_SRGB);
    // Without colorants: the description (v2 'desc', v4 'mluc').
    expect(classifyIccProfile(icc({ desc: "Display P3" }))).toBe(COLOR_PROFILE_DISPLAY_P3);
    expect(classifyIccProfile(icc({ mluc: "Display P3" }))).toBe(COLOR_PROFILE_DISPLAY_P3);
    expect(classifyIccProfile(icc({ desc: "sRGB IEC61966-2.1" }))).toBe(COLOR_PROFILE_SRGB);
    expect(classifyIccProfile(null)).toBe(COLOR_PROFILE_SRGB);
    expect(classifyIccProfile(new Uint8Array(40))).toBe(COLOR_PROFILE_SRGB);
  });

  it("PNG: takes out sRGB, gAMA, cHRM and iCCP before IDAT and hands back the profile", () => {
    const profile = icc({ colorants: P3 });
    const file = png([pngChunk("sRGB", [0]), pngChunk("gAMA", be32(45455)), pngChunk("cHRM", new Array(32).fill(0)), iccpChunk(profile)]);
    const { png: out, iccp } = stripPngColorChunks(file);
    expect(out).toEqual(png([]));
    expect(iccp && Buffer.from(iccp)).toEqual(deflateSync(profile));
    // Nothing to take out: the same bytes.
    const plain = png([]);
    expect(stripPngColorChunks(plain).png).toBe(plain);
    // Not a PNG, or cut short: as it is.
    const cut = file.subarray(0, 40);
    expect(stripPngColorChunks(cut).png).toBe(cut);
  });

  it("PNG end to end: an iCCP Display P3 profile tags the image, the decoded bytes have no colour chunks", async () => {
    const p = await prepareImage(png([iccpChunk(icc({ colorants: P3 })), pngChunk("gAMA", be32(45455))]));
    expect(p.colorProfile).toBe(COLOR_PROFILE_DISPLAY_P3);
    expect(p.bytes).toEqual(png([]));
    expect((await prepareImage(png([pngChunk("sRGB", [0])]))).colorProfile).toBe(COLOR_PROFILE_SRGB);
  });

  it("JPEG: the ICC_PROFILE APP2 segments are put together in their order", async () => {
    const profile = icc({ colorants: P3 });
    const half = Math.ceil(profile.length / 2);
    const app2 = (seq: number, part: Uint8Array) => {
      const data = [...text("ICC_PROFILE"), 0, seq, 2, ...part];
      return [0xff, 0xe2, ...[(data.length + 2) >> 8, (data.length + 2) & 255], ...data];
    };
    // Out of order on purpose; an APP0 before them; the scan after.
    const file = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0, 4, 1, 2,
      ...app2(2, profile.subarray(half)),
      ...app2(1, profile.subarray(0, half)),
      0xff, 0xda, 0, 2, 9, 9, 9, 0xff, 0xd9,
    ]);
    expect(jpegIccProfile(file)).toEqual(profile);
    expect((await prepareImage(file)).colorProfile).toBe(COLOR_PROFILE_DISPLAY_P3);
    expect(jpegIccProfile(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2, 0xff, 0xd9]))).toBeNull();
  });

  it("WebP: the ICCP chunk", () => {
    const profile = icc({ colorants: P3 });
    const chunk = (type: string, data: number[] | Uint8Array) => [...text(type), data.length & 255, (data.length >> 8) & 255, 0, 0, ...data, ...(data.length & 1 ? [0] : [])];
    const body = [...text("WEBP"), ...chunk("VP8X", new Array(10).fill(0)), ...chunk("ICCP", profile), ...chunk("VP8L", [1, 2, 3])];
    const file = new Uint8Array([...text("RIFF"), body.length & 255, (body.length >> 8) & 255, 0, 0, ...body]);
    expect(webpIccProfile(file)).toEqual(profile);
  });

  it("GIF: multi-frame when a second image descriptor appears", () => {
    const gif = (frames: number) => {
      const out = [...text("GIF89a"), 1, 0, 1, 0, 0x80, 0, 0, 0, 0, 0, 255, 255, 255]; // 2-colour global table
      out.push(0x21, 0xff, 3, 1, 2, 3, 0); // an application extension
      for (let f = 0; f < frames; f++) out.push(0x21, 0xf9, 4, 0, 0, 0, 0, 0, 0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 0x01, 0);
      out.push(0x3b);
      return new Uint8Array(out);
    };
    expect(isMultiFrameGif(gif(1))).toBe(false);
    expect(isMultiFrameGif(gif(2))).toBe(true);
    expect(isMultiFrameGif(new Uint8Array([1, 2, 3]))).toBe(false);
  });

  it("SVG markup is recognised (it stays the browser's decode: sniffImageMime has no SVG)", () => {
    expect(isSvg(new Uint8Array(text('<svg xmlns="http://www.w3.org/2000/svg"/>')))).toBe(true);
    expect(isSvg(new Uint8Array([0xef, 0xbb, 0xbf, ...text('\n  <?xml version="1.0"?><svg/>')]))).toBe(true);
    expect(isSvg(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]))).toBe(false);
    expect(isSvg(new Uint8Array([]))).toBe(false);
  });
});
