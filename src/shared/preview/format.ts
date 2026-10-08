/**
 * The developer preview's package (docs/data.md §13): what the store makes from an editor's derived snapshot, what a
 * Firebase Storage folder `previews/{previewId}/…` holds, and what an exported HTML file carries inline.
 *
 *   manifest.json   PreviewManifest (written last when publishing; custom metadata `revoked`)
 *   doc.kiwi        the fig-kiwi container: binary schema + the Message (derived data included), deflate-raw
 *   images/{sha1}   the image files the document's paints use
 */

export const PREVIEW_FORMAT = 1 as const;
export const PREVIEW_DOC_NAME = "doc.kiwi";
export const PREVIEW_MANIFEST_NAME = "manifest.json";
export const previewImageName = (sha1: string) => `images/${sha1}`;

/** A layer at the top of a page (a frame, a section, a component…): what the viewer's frame list shows. */
export interface PreviewFrame {
  id: string;
  name: string;
  type: string;
}

export interface PreviewPage {
  id: string;
  name: string;
  /** Top-level layers, in the Layers panel's order (topmost first) */
  frames: PreviewFrame[];
}

export interface PreviewManifest {
  format: typeof PREVIEW_FORMAT;
  previewId: string;
  fileName: string;
  publishedAt: number;
  expiresAt: number | null;
  pages: PreviewPage[];
  snapshot: typeof PREVIEW_DOC_NAME;
  documentFormatVersion: number;
  /** The engine's derived-data stamp in the snapshot (0: none — text then needs fonts) */
  derivedDataVersion: number;
  /** SHA-1s of the images in `images/` */
  images: string[];
  options: { inspect: boolean; export: boolean };
}

/** The whole preview in memory. */
export interface PreviewPackage {
  manifest: PreviewManifest;
  /** doc.kiwi */
  doc: Uint8Array;
  images: Map<string, Uint8Array>;
}

/** Whether a manifest may be shown at `now` (an expired preview is refused, §13 step 4). */
export function previewExpired(manifest: Pick<PreviewManifest, "expiresAt">, now: number): boolean {
  return manifest.expiresAt !== null && manifest.expiresAt <= now;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function expiryOf(expiresInDays: 7 | 30 | null, now: number): number | null {
  return expiresInDays === null ? null : now + expiresInDays * DAY_MS;
}

/** A light check of untrusted JSON (a fetched manifest, an HTML file's data). */
export function isPreviewManifest(v: unknown): v is PreviewManifest {
  const m = v as Partial<PreviewManifest> | null;
  return (
    !!m &&
    m.format === PREVIEW_FORMAT &&
    typeof m.previewId === "string" &&
    typeof m.fileName === "string" &&
    Array.isArray(m.pages) &&
    m.pages.every((p) => p && typeof p.id === "string" && typeof p.name === "string" && Array.isArray(p.frames)) &&
    Array.isArray(m.images) &&
    m.images.every((s) => typeof s === "string" && /^[0-9a-f]{40}$/.test(s)) &&
    (m.expiresAt === null || typeof m.expiresAt === "number")
  );
}
