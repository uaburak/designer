/**
 * Where a developer preview comes from (docs/data.md §13):
 *
 * - an exported HTML file: the package is inlined in a `<script id="designer-preview-data">` block, the engine's
 *   Wasm in `<script id="designer-engine-wasm">` (the viewer's build put it there);
 * - Firebase Hosting: `/p/<previewId>`, the files read from Storage
 *   (`https://firebasestorage.googleapis.com/v0/b/<bucket>/o/previews%2F<id>%2F<name>?alt=media`); the bucket comes
 *   from `?bucket=` or the deployed `preview-config.json` (`{"storageBucket": "…"}`);
 * - a folder with the package's files (`?src=<url>`), for development.
 */
import { readCanvasChunks } from "@shared/fig/container";
import { isZstd } from "@shared/fig/compression";
import { isPreviewManifest, PREVIEW_DOC_NAME, PREVIEW_MANIFEST_NAME, previewExpired, previewImageName, type PreviewManifest } from "@shared/preview/format";
import { ENGINE_WASM_ID, fromBase64, PREVIEW_DATA_ID, readInlinePreview } from "@shared/preview/html";
import { DOCUMENT_FORMAT_VERSION } from "@shared/schema/codec";

export interface LoadedPreview {
  manifest: PreviewManifest;
  /** The kiwi Message the engine loads */
  message: Uint8Array;
  /** An image file by SHA-1, or null */
  image(sha1: string): Promise<Uint8Array | null>;
}

export class PreviewError extends Error {
  constructor(
    readonly title: string,
    message: string,
  ) {
    super(message);
  }
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** doc.kiwi → the Message bytes. */
export async function messageOf(doc: Uint8Array): Promise<Uint8Array> {
  const chunks = readCanvasChunks(doc).chunks;
  if (chunks.length < 2) throw new PreviewError("This preview can't be opened", "Its document is damaged.");
  if (isZstd(chunks[1])) throw new PreviewError("This preview can't be opened", "Its document is in a format this viewer doesn't read.");
  return inflateRaw(chunks[1]);
}

function check(manifest: PreviewManifest): void {
  if (previewExpired(manifest, Date.now())) throw new PreviewError("This preview has expired", "Ask the person who shared it for a new link.");
  if (manifest.documentFormatVersion > DOCUMENT_FORMAT_VERSION) throw new PreviewError("This preview can't be opened", "It was made by a newer version of the app.");
}

/** The engine's Wasm when the page carries it (an exported file), else null (fetched next to the script). */
export function inlineWasm(): ArrayBuffer | null {
  const el = document.getElementById(ENGINE_WASM_ID);
  const text = el?.textContent?.trim();
  if (!text) return null;
  const bytes = fromBase64(text);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const r = await fetch(url);
  if (r.status === 403 || r.status === 404) throw new PreviewError("This preview isn't available", "It may have been stopped by the person who shared it.");
  if (!r.ok) throw new PreviewError("This preview can't be opened", `The server answered ${r.status}.`);
  return new Uint8Array(await r.arrayBuffer());
}

/** Reads a package laid out as files under `base` (`name` → URL). */
async function remote(url: (name: string) => string): Promise<LoadedPreview> {
  let manifest: unknown;
  try {
    manifest = JSON.parse(new TextDecoder().decode(await fetchBytes(url(PREVIEW_MANIFEST_NAME))));
  } catch (e) {
    if (e instanceof PreviewError) throw e;
    throw new PreviewError("This preview can't be opened", "Its description is damaged.");
  }
  if (!isPreviewManifest(manifest)) throw new PreviewError("This preview can't be opened", "Its description is damaged.");
  check(manifest);
  const message = await messageOf(await fetchBytes(url(PREVIEW_DOC_NAME)));
  const known = new Set(manifest.images);
  return { manifest, message, image: async (sha1) => (known.has(sha1) ? fetchBytes(url(previewImageName(sha1))).catch(() => null) : null) };
}

async function bucketFromConfig(): Promise<string | null> {
  try {
    const r = await fetch("/preview-config.json");
    if (!r.ok) return null;
    const c = (await r.json()) as { storageBucket?: unknown };
    return typeof c.storageBucket === "string" ? c.storageBucket : null;
  } catch {
    return null;
  }
}

export async function loadPreview(): Promise<LoadedPreview> {
  const inline = document.getElementById(PREVIEW_DATA_ID);
  if (inline?.textContent) {
    let pkg;
    try {
      pkg = readInlinePreview(inline.textContent);
    } catch {
      throw new PreviewError("This preview can't be opened", "The file's data is damaged.");
    }
    check(pkg.manifest);
    const message = await messageOf(pkg.doc);
    return { manifest: pkg.manifest, message, image: async (sha1) => pkg.images.get(sha1) ?? null };
  }
  const params = new URLSearchParams(location.search);
  const src = params.get("src");
  if (src) {
    const base = src.endsWith("/") ? src : `${src}/`;
    return remote((name) => new URL(name, new URL(base, location.href)).href);
  }
  const id = /\/p\/([0-9A-Za-z]{22})\/?$/.exec(location.pathname)?.[1] ?? params.get("p");
  if (!id) throw new PreviewError("No preview here", "Open the link you were sent, or an exported preview file.");
  const bucket = params.get("bucket") ?? (await bucketFromConfig());
  if (!bucket) throw new PreviewError("This preview can't be opened", "The viewer doesn't know where previews are stored.");
  const object = (name: string) => `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(`previews/${id}/${name}`)}?alt=media`;
  return remote(object);
}
