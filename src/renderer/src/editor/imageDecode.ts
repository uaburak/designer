/**
 * Image decoding as Figma's image worker does it (docs/research/rea/canvas.md §2.6, docs/engine.md §6.6): the bytes
 * are decoded off the main thread with straight alpha and no colour management, and tagged with their colour
 * profile — SRGB (0) or DISPLAY_P3 (1), anything else counting as sRGB. The engine premultiplies them and converts
 * them into the document's space at upload (engine/src/gfx/ImageColor.h), so an image shows the same in Wecra as in
 * Figma whatever its embedded profile says, and low-alpha pixels keep their colour until the GPU premultiplies them.
 *
 * - **PNG:** the sRGB, gAMA, cHRM and iCCP chunks before IDAT are taken out (the browser then applies none of them);
 *   the iCCP profile is inflated to classify it.
 * - **JPEG:** the ICC_PROFILE APP2 segments are put together to classify the profile (`colorSpaceConversion: "none"`
 *   keeps the browser from applying it).
 * - **WebP:** the ICCP chunk is classified.
 * - **GIF:** multi-frame when a second image descriptor appears (the flag travels with the bitmap).
 * - The profile is Display P3 when its red, green and blue colorants are Display P3's (the reference profiles'
 *   values, D50-adapted), or, without colorants, when its description names Display P3.
 * - SVG never comes here (the main thread's decode, as before); a failed decode falls back to it too.
 */

export const COLOR_PROFILE_SRGB = 0;
export const COLOR_PROFILE_DISPLAY_P3 = 1;
export type ColorProfileTag = typeof COLOR_PROFILE_SRGB | typeof COLOR_PROFILE_DISPLAY_P3;

export interface DecodedImage {
  bitmap: ImageBitmap;
  /** SRGB 0 / DISPLAY_P3 1 (Figma's enum). */
  colorProfile: ColorProfileTag;
  isMultiFrameGIF: boolean;
}

// ---- Container surgery and classification (pure) ----------------------------------------------------------------

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const PNG_COLOR_CHUNKS = new Set(["sRGB", "gAMA", "cHRM", "iCCP"]);

const u32 = (b: Uint8Array, i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const u32le = (b: Uint8Array, i: number) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
const ascii = (b: Uint8Array, i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));

export function isPng(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && PNG_SIGNATURE.every((v, i) => bytes[i] === v);
}

/**
 * A PNG without its colour chunks (sRGB, gAMA, cHRM, iCCP before IDAT), and the iCCP chunk's compressed profile
 * (zlib, after its name and compression method), or null. A malformed file comes back as it is.
 */
export function stripPngColorChunks(bytes: Uint8Array): { png: Uint8Array; iccp: Uint8Array | null } {
  if (!isPng(bytes)) return { png: bytes, iccp: null };
  const keep: Uint8Array[] = [bytes.subarray(0, 8)];
  let iccp: Uint8Array | null = null;
  let i = 8;
  let stripped = false;
  let beforeData = true;
  while (i + 12 <= bytes.length) {
    const length = u32(bytes, i);
    const type = ascii(bytes, i + 4, 4);
    const end = i + 12 + length;
    if (end > bytes.length) return { png: bytes, iccp: null };
    if (type === "IDAT") beforeData = false;
    if (beforeData && PNG_COLOR_CHUNKS.has(type)) {
      stripped = true;
      if (type === "iCCP") {
        const data = bytes.subarray(i + 8, i + 8 + length);
        const nul = data.indexOf(0);
        if (nul >= 0 && nul + 2 <= data.length) iccp = data.subarray(nul + 2); // name, NUL, compression method
      }
    } else {
      keep.push(bytes.subarray(i, end));
    }
    i = end;
    if (type === "IEND") break;
  }
  if (!stripped) return { png: bytes, iccp };
  const out = new Uint8Array(keep.reduce((n, k) => n + k.length, 0));
  let at = 0;
  for (const k of keep) {
    out.set(k, at);
    at += k.length;
  }
  return { png: out, iccp };
}

/** A JPEG's ICC profile from its ICC_PROFILE APP2 segments, in their sequence order; null without one. */
export function jpegIccProfile(bytes: Uint8Array): Uint8Array | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const parts = new Map<number, Uint8Array>();
  let i = 2;
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      i += 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) break; // the image data: no more metadata segments
    const length = (bytes[i + 2] << 8) | bytes[i + 3];
    const start = i + 4;
    const end = i + 2 + length;
    if (length < 2 || end > bytes.length) break;
    if (marker === 0xe2 && length >= 16 && ascii(bytes, start, 11) === "ICC_PROFILE" && bytes[start + 11] === 0) {
      parts.set(bytes[start + 12], bytes.subarray(start + 14, end)); // sequence number, then the count
    }
    i = end;
  }
  if (!parts.size) return null;
  const order = [...parts.keys()].sort((a, b) => a - b);
  const out = new Uint8Array(order.reduce((n, k) => n + parts.get(k)!.length, 0));
  let at = 0;
  for (const k of order) {
    out.set(parts.get(k)!, at);
    at += parts.get(k)!.length;
  }
  return out;
}

/** A WebP's ICC profile (its RIFF ICCP chunk), or null. */
export function webpIccProfile(bytes: Uint8Array): Uint8Array | null {
  if (bytes.length < 12 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WEBP") return null;
  let i = 12;
  while (i + 8 <= bytes.length) {
    const type = ascii(bytes, i, 4);
    const size = u32le(bytes, i + 4);
    if (i + 8 + size > bytes.length) return null;
    if (type === "ICCP") return bytes.subarray(i + 8, i + 8 + size);
    i += 8 + size + (size & 1);
  }
  return null;
}

/** True when a GIF has a second image descriptor (an animation). */
export function isMultiFrameGif(bytes: Uint8Array): boolean {
  if (bytes.length < 13 || ascii(bytes, 0, 3) !== "GIF") return false;
  let i = 13;
  const flags = bytes[10];
  if (flags & 0x80) i += 3 * (1 << ((flags & 7) + 1)); // the global colour table
  let images = 0;
  const skipSubBlocks = () => {
    while (i < bytes.length) {
      const n = bytes[i++];
      if (n === 0) return;
      i += n;
    }
  };
  while (i < bytes.length) {
    const block = bytes[i++];
    if (block === 0x3b) break; // trailer
    if (block === 0x21) {
      i++; // the extension's label
      skipSubBlocks();
    } else if (block === 0x2c) {
      if (++images >= 2) return true;
      if (i + 9 > bytes.length) break;
      const local = bytes[i + 8];
      i += 9;
      if (local & 0x80) i += 3 * (1 << ((local & 7) + 1));
      i++; // LZW minimum code size
      skipSubBlocks();
    } else {
      break;
    }
  }
  return false;
}

// Display P3's and sRGB's colorants (rXYZ / gXYZ / bXYZ, D50-adapted) as their ICC profiles carry them.
const P3_COLORANTS = [
  [0.515102, 0.241196, -0.00105],
  [0.291965, 0.692245, 0.041881],
  [0.157153, 0.066561, 0.784073],
];
const COLORANT_TOLERANCE = 0.004;

/** An ICC profile's tag → [offset, size]. */
function iccTags(icc: Uint8Array): Map<string, [number, number]> {
  const tags = new Map<string, [number, number]>();
  if (icc.length < 132 || ascii(icc, 36, 4) !== "acsp") return tags;
  const n = u32(icc, 128);
  for (let k = 0; k < n && 132 + 12 * (k + 1) <= icc.length; k++) {
    const at = 132 + 12 * k;
    const offset = u32(icc, at + 4), size = u32(icc, at + 8);
    if (offset + size <= icc.length) tags.set(ascii(icc, at, 4), [offset, size]);
  }
  return tags;
}

const s15Fixed16 = (b: Uint8Array, i: number) => (u32(b, i) | 0) / 65536;

/** The profile's description (desc: 'desc' or 'mluc'), best effort. */
function iccDescription(icc: Uint8Array, tags: Map<string, [number, number]>): string {
  const t = tags.get("desc");
  if (!t) return "";
  const [offset, size] = t;
  const type = ascii(icc, offset, 4);
  if (type === "desc" && size >= 12) {
    const n = u32(icc, offset + 8);
    return ascii(icc, offset + 12, Math.max(0, Math.min(n, size - 12))).replace(/\0+$/, "");
  }
  if (type === "mluc" && size >= 28) {
    const length = u32(icc, offset + 20), at = offset + u32(icc, offset + 24);
    let s = "";
    for (let i = at; i + 1 < at + length && i + 1 < icc.length; i += 2) s += String.fromCharCode((icc[i] << 8) | icc[i + 1]);
    return s;
  }
  return "";
}

/** SRGB or DISPLAY_P3 for an ICC profile (Figma's two tags; anything else counts as sRGB). */
export function classifyIccProfile(icc: Uint8Array | null): ColorProfileTag {
  if (!icc) return COLOR_PROFILE_SRGB;
  const tags = iccTags(icc);
  const colorants = ["rXYZ", "gXYZ", "bXYZ"].map((name) => tags.get(name));
  if (colorants.every((t) => t && t[1] >= 20 && ascii(icc, t[0], 4) === "XYZ ")) {
    const p3 = colorants.every((t, c) => [0, 1, 2].every((k) => Math.abs(s15Fixed16(icc, t![0] + 8 + 4 * k) - P3_COLORANTS[c][k]) <= COLORANT_TOLERANCE));
    return p3 ? COLOR_PROFILE_DISPLAY_P3 : COLOR_PROFILE_SRGB;
  }
  return /display\s*p3/i.test(iccDescription(icc, tags)) ? COLOR_PROFILE_DISPLAY_P3 : COLOR_PROFILE_SRGB;
}

/** zlib-inflated bytes (an iCCP profile), or null. */
export async function inflate(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (typeof DecompressionStream === "undefined") return null;
  try {
    const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

/** The bytes to decode (a PNG without its colour chunks), the profile tag and the GIF flag. */
export async function prepareImage(bytes: Uint8Array): Promise<{ bytes: Uint8Array; colorProfile: ColorProfileTag; isMultiFrameGIF: boolean }> {
  if (isPng(bytes)) {
    const { png, iccp } = stripPngColorChunks(bytes);
    return { bytes: png, colorProfile: classifyIccProfile(iccp ? await inflate(iccp) : null), isMultiFrameGIF: false };
  }
  const icc = jpegIccProfile(bytes) ?? webpIccProfile(bytes);
  return { bytes, colorProfile: classifyIccProfile(icc), isMultiFrameGIF: isMultiFrameGif(bytes) };
}

/** Decodes straight and unmanaged, tagged (the worker's job; also the fallback where there are no workers). */
export async function decodeStraight(bytes: Uint8Array): Promise<DecodedImage> {
  const prepared = await prepareImage(bytes);
  const bitmap = await createImageBitmap(new Blob([prepared.bytes as BlobPart]), { premultiplyAlpha: "none", colorSpaceConversion: "none" });
  return { bitmap, colorProfile: prepared.colorProfile, isMultiFrameGIF: prepared.isMultiFrameGIF };
}

// ---- The worker ---------------------------------------------------------------------------------------------------

export interface DecodeRequest {
  id: number;
  bytes: Uint8Array;
}
export type DecodeReply =
  | { id: number; bitmap: ImageBitmap; colorProfile: ColorProfileTag; isMultiFrameGIF: boolean }
  | { id: number; error: string };

let worker: Worker | null = null;
let workerBroken = false;
let nextId = 1;
const waiting = new Map<number, { resolve: (d: DecodedImage | null) => void }>();

function decodeWorker(): Worker | null {
  if (worker || workerBroken) return worker;
  if (typeof Worker === "undefined") return null;
  try {
    worker = new Worker(new URL("./imageDecode.worker.ts", import.meta.url), { type: "module", name: "Image decode" });
  } catch {
    workerBroken = true;
    return null;
  }
  worker.onmessage = (e: MessageEvent<DecodeReply>) => {
    const reply = e.data;
    const w = waiting.get(reply.id);
    if (!w) {
      if ("bitmap" in reply) reply.bitmap.close();
      return;
    }
    waiting.delete(reply.id);
    w.resolve("bitmap" in reply ? { bitmap: reply.bitmap, colorProfile: reply.colorProfile, isMultiFrameGIF: reply.isMultiFrameGIF } : null);
  };
  worker.onerror = () => {
    // The worker can't run (a CSP, a failed load): every decode from now on is the main thread's.
    workerBroken = true;
    worker?.terminate();
    worker = null;
    for (const w of waiting.values()) w.resolve(null);
    waiting.clear();
  };
  return worker;
}

/**
 * Decodes `bytes` straight, unmanaged and tagged, in the image worker (here where there is none). Null when it
 * can't — an SVG, or bytes the browser refuses that way: the caller decodes them as before.
 */
export async function decodeImage(bytes: Uint8Array, mime: string | null): Promise<DecodedImage | null> {
  if (mime === "image/svg+xml" || typeof createImageBitmap === "undefined") return null;
  const w = decodeWorker();
  if (w) {
    const id = nextId++;
    const copy = bytes.slice(); // transferred: the caller keeps its own
    const result = await new Promise<DecodedImage | null>((resolve) => {
      waiting.set(id, { resolve });
      w.postMessage({ id, bytes: copy } satisfies DecodeRequest, [copy.buffer]);
    });
    if (result || !workerBroken) return result;
  }
  try {
    return await decodeStraight(bytes);
  } catch {
    return null;
  }
}
