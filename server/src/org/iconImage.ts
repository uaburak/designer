/**
 * Organization and team icons' bytes (docs/multiplayer.md §14.16): what is accepted and how an upload is read. No D1,
 * no bindings — the Worker's routes (org/icons.ts) and the org's object (fonts/fontBox.ts) both use it.
 */
import { HttpError } from "./http";

/** Ours (Figma states a 500 × 500 minimum, not a size): the app crops to 256 × 256, far below it */
export const MAX_ICON_BYTES = 1024 * 1024;
export const ICON_TOO_LARGE = "the image is larger than 1 MB";
export const ICON_BAD_TYPE = "only PNG, JPEG, WebP and GIF images can be used as an icon";

export type IconType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

/** The picture's type from its first bytes (magic numbers); null for anything else (SVG included: it can carry script) */
export function iconType(b: Uint8Array): IconType | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return "image/gif";
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return null;
}

/** Bytes needed before `iconType` can tell (WebP's "WEBP" ends at 12) */
const SNIFF = 12;

/**
 * An icon upload's body, refused as early as possible: past 1 MB by its declared length before anything is read; by
 * its first bytes (the type) before the rest is read; past 1 MB as it streams in (the reading stops there).
 */
export async function readIconBody(req: Request): Promise<{ bytes: Uint8Array; type: IconType }> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_ICON_BYTES) throw new HttpError(413, ICON_TOO_LARGE, "too_large");
  if (!req.body) throw new HttpError(400, ICON_BAD_TYPE, "invalid");
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let type: IconType | null = null;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.length) continue;
      size += value.length;
      if (size > MAX_ICON_BYTES) throw new HttpError(413, ICON_TOO_LARGE, "too_large");
      chunks.push(value);
      if (!type && size >= SNIFF) {
        type = iconType(concatBytes(chunks, size));
        if (!type) throw new HttpError(400, ICON_BAD_TYPE, "invalid");
      }
    }
  } catch (e) {
    void reader.cancel().catch(() => {});
    throw e;
  }
  const bytes = concatBytes(chunks, size);
  type ??= iconType(bytes);
  if (!type) throw new HttpError(400, ICON_BAD_TYPE, "invalid");
  return { bytes, type };
}

function concatBytes(chunks: Uint8Array[], size: number): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
