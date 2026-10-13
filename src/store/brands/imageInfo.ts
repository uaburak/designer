/**
 * What a library picture is, read from its bytes (docs/studio.md §3.1): PNG, JPEG or WebP (never by name or claimed
 * type), at most 20 MB, and its size from the header.
 */
import { sniffImage } from "../../shared/agents/images";
import type { BrandImage } from "../../shared/studio/types";

export const MAX_BRAND_IMAGE_BYTES = 20 * 1024 * 1024;

export type BrandMime = BrandImage["mime"];
export const EXTENSION: Record<BrandMime, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

const u16be = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1];
const u32be = (b: Uint8Array, i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const u24le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);

function pngSize(b: Uint8Array): { width: number; height: number } | null {
  return b.length >= 24 && u32be(b, 12) === 0x49484452 ? { width: u32be(b, 16), height: u32be(b, 20) } : null;
}

function jpegSize(b: Uint8Array): { width: number; height: number } | null {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1];
    if (marker === 0xff) {
      i++;
      continue;
    }
    // Start-of-frame markers (not DHT 0xC4, JPG 0xC8, DAC 0xCC)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { height: u16be(b, i + 5), width: u16be(b, i + 7) };
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) i += 2;
    else i += 2 + u16be(b, i + 2);
  }
  return null;
}

function webpSize(b: Uint8Array): { width: number; height: number } | null {
  if (b.length < 30) return null;
  const kind = String.fromCharCode(b[12], b[13], b[14], b[15]);
  if (kind === "VP8X") return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
  if (kind === "VP8L") {
    if (b[20] !== 0x2f) return null;
    const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (kind === "VP8 ") return b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a ? { width: (b[26] | (b[27] << 8)) & 0x3fff, height: (b[28] | (b[29] << 8)) & 0x3fff } : null;
  return null;
}

/** The picture's type and size, or null when it isn't a PNG, JPEG or WebP we can read (or it's empty-sized). */
export function readBrandImage(bytes: Uint8Array): { mime: BrandMime; width: number; height: number } | null {
  if (!bytes.length || bytes.length > MAX_BRAND_IMAGE_BYTES) return null;
  const mime = sniffImage(bytes);
  if (mime !== "image/png" && mime !== "image/jpeg" && mime !== "image/webp") return null;
  const size = mime === "image/png" ? pngSize(bytes) : mime === "image/jpeg" ? jpegSize(bytes) : webpSize(bytes);
  return size && size.width > 0 && size.height > 0 ? { mime, ...size } : null;
}
