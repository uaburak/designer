import type { AiImageRequest } from "../../../shared/ai/types";

/**
 * What an image client is asked (docs/ai.md §2.5) and what it answers. The pictures are bytes here (PNG); the request's
 * base64 is decoded once by the run.
 */
export interface ImageJob {
  action: AiImageRequest["action"];
  /** The words sent: the user's prompt, or the action's own instruction (Expand, Erase) */
  prompt: string;
  /** The picture to edit (PNG) — absent for Make an image */
  image?: Buffer;
  /** PNG, transparent = to change (OpenAI's convention) */
  mask?: Buffer;
  reference?: Buffer;
  /** Studio's reference pictures (docs/studio.md §5.3), in the order the prompt names them ("Image 1: …") */
  references?: { data: Buffer; mime: string; role: string }[];
  /** "4:5", "9:16", … (the request's, else the nearest to `size`) */
  aspectRatio?: string;
  /** The wanted size (Make: the layer's; Expand: the new canvas) */
  size?: { width: number; height: number };
  model?: string;
  signal: AbortSignal;
}

export interface ImageAnswer {
  data: Buffer;
  mime: string;
  width: number;
  height: number;
  model?: string;
}

/** A picture's type and size from its header (PNG, JPEG, WebP, GIF), or null. */
export function imageInfo(b: Buffer): { mime: string; width: number; height: number } | null {
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47) return { mime: "image/png", width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.length >= 10 && b.toString("ascii", 0, 6).startsWith("GIF8")) return { mime: "image/gif", width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  if (b.length >= 30 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") {
    const kind = b.toString("ascii", 12, 16);
    if (kind === "VP8X") return { mime: "image/webp", width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
    if (kind === "VP8 ") return { mime: "image/webp", width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    if (kind === "VP8L") {
      const bits = b.readUInt32LE(21);
      return { mime: "image/webp", width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      const len = b.readUInt16BE(i + 2);
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf))
        return { mime: "image/jpeg", width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
      i += 2 + len;
    }
  }
  return null;
}

/** An answer from bytes, or null when they aren't a picture. */
export function answerOf(data: Buffer, model?: string): ImageAnswer | null {
  const info = imageInfo(data);
  return info ? { data, ...info, ...(model ? { model } : {}) } : null;
}

/** The instruction an action sends when the user typed none (Expand, Erase), or around the prompt (Edit). */
export function jobPrompt(action: ImageJob["action"], prompt: string | undefined): string {
  const p = (prompt ?? "").trim();
  switch (action) {
    case "expand-image":
      return `Fill the empty, transparent area around the picture so it continues the scene naturally: the same style, lighting and perspective. Keep every existing pixel exactly as it is.${p ? ` ${p}` : ""}`;
    case "erase-object":
      return `Remove what is inside the masked area and fill it in so it matches its surroundings, as if it had never been there. Change nothing else.${p ? ` ${p}` : ""}`;
    case "edit-image":
      return p || "Improve this picture.";
    default:
      return p;
  }
}

/** The aspect ratios the image models take (Gemini's imageConfig.aspectRatio): what `aspectRatio` may be. */
export const ASPECT_RATIOS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"] as const;

/** An aspect ratio as a number (width / height). */
export const ratioOf = (a: string): number => {
  const [w, h] = a.split(":").map(Number);
  return w / h;
};

/** A picture's type from its first bytes (PNG, JPEG, WebP), or null. */
export function imageMime(b: Buffer): "image/png" | "image/jpeg" | "image/webp" | null {
  if (b.length >= 8 && b.readUInt32BE(0) === 0x89504e47) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

/** A reference's file name in a CLI's workspace: image-1.png, image-2.jpg, … (the prompt's order). */
export const referenceFile = (i: number, mime: string): string => `image-${i + 1}.${mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : "png"}`;
