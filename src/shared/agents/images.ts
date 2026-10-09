/**
 * Images an agent puts on the canvas (place_image, and `image` in create_nodes / update_nodes): PNG, JPEG, WebP or GIF,
 * known by their bytes (never by a name or a claimed type), at most MAX_IMAGE_BYTES. Main reads a path into base64
 * (src/main/agents/imageArgs.ts); the editor imports the bytes into the file's images (mcpTools.ts).
 */

export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

export type ImageMime = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

export function sniffImage(b: Uint8Array): ImageMime | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return "image/gif";
  return null;
}

/** An image the editor receives: its bytes as base64 (main has read a path already), with its file name. */
export interface ImageData {
  data: string;
  name?: string;
}

/** The `image` argument as an agent writes it: a path (in its working folder) or base64 bytes ("data:" URLs too). */
export interface ImageArg {
  path?: string;
  data?: string;
  name?: string;
  scaleMode?: string;
}

export const isImageArg = (v: unknown): v is ImageArg => !!v && typeof v === "object" && !Array.isArray(v) && (typeof (v as ImageArg).path === "string" || typeof (v as ImageArg).data === "string");

/** Base64 (or a data: URL) → bytes; null when it isn't base64. */
export function base64Bytes(s: string): Uint8Array | null {
  const body = s.replace(/^data:[^;,]*;base64,/, "").replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(body) || !body.length) return null;
  const std = body.replace(/-/g, "+").replace(/_/g, "/");
  try {
    const bin = atob(std);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}
