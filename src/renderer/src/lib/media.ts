/**
 * What is uploaded, before it is: a picture made web-sized (at most 2560px
 * on its long side, as WebP — a camera's 12 MB JPEG becomes a few hundred
 * KB), checked to be a file the site can show, and named where it goes.
 */

/** The longest side an uploaded picture keeps (a 1440px page at 2× — sharp on any screen the site is read on). */
const MAX_SIDE = 2560;
/** Under this size and within MAX_SIDE, a picture goes up as it is. */
const SMALL_ENOUGH = 400 * 1024;
/** What the bucket takes (see storage.rules). */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/** The kinds of file the editor uploads: pictures a browser draws, a video, a PDF (the CV's). */
const ACCEPTED = /^(image\/(png|jpe?g|gif|webp|avif|svg\+xml)|video\/(mp4|webm)|application\/pdf)$/;

export class UploadRefused extends Error {}

/** Refused with the reason when it isn't a file the site can show, or too big. */
export function checkUpload(file: File) {
  if (!ACCEPTED.test(file.type)) throw new UploadRefused(`“${file.name}” isn't a file the site can show (${file.type || "unknown type"}) — use JPG, PNG, WebP, GIF, SVG, MP4 or PDF.`);
  if (file.size > MAX_UPLOAD_BYTES) throw new UploadRefused(`“${file.name}” is ${Math.round(file.size / 1024 / 1024)} MB — 25 MB at most.`);
}

/**
 * The picture as it goes up: as it is when it is already small (and an SVG,
 * a GIF — an animation would lose its frames), else scaled to MAX_SIDE and
 * encoded as WebP — unless that comes out bigger than the original.
 */
export async function webSized(file: File): Promise<File> {
  if (!file.type.startsWith("image/") || /svg|gif/.test(file.type)) return file;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return file;
  }
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size <= SMALL_ENOUGH) {
    bitmap.close();
    return file;
  }
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.85));
  if (!blob || blob.size >= file.size) return file;
  return new File([blob], file.name.replace(/\.[^.]+$/, "") + ".webp", { type: "image/webp" });
}

/** The extension a file is stored under: its type's (what the Images panel knows a picture by), else its name's. */
const TYPE_EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp", "image/avif": "avif", "image/svg+xml": "svg", "video/mp4": "mp4", "video/webm": "webm", "application/pdf": "pdf" };

/** Where an editor upload goes: the site's shared media, by month, under its time and its name (never overwritten). */
export function mediaPath(file: File, folder = "media"): string {
  const now = new Date();
  const ext = TYPE_EXT[file.type] ?? (file.name.includes(".") ? file.name.split(".").pop()!.toLowerCase() : "bin");
  const base = file.name.replace(/\.[^.]+$/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "file";
  return `${folder}/${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, "0")}/${now.getTime()}-${base}.${ext}`;
}
