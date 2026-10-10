/**
 * The viewer's document loader over HTTP (docs/multiplayer.md §9): any document the viewer can show, given where its
 * files are. A developer preview is `{doc: {url: …/doc.kiwi, format: "fig-kiwi"}, manifest: …/manifest.json}`; a
 * shared file's room snapshot (a later `/embed/<fileKey>`) is `{doc: {url: …/snapshot, format: "message"}, manifest:
 * (message) => manifestFromMessage(message, {...})}` with `init` carrying its Authorization header.
 *
 *   const preview = await loadRemote({ doc: { url, format: "fig-kiwi" }, manifest: manifestUrl, image: (sha1) => imageUrl });
 *
 * Refusals come back as `PreviewError`s the viewer shows as they are (404 / 403: not available, 410: expired).
 */
import { readCanvasChunks } from "@shared/fig/container";
import { isZstd } from "@shared/fig/compression";
import { isPreviewManifest, previewExpired, PREVIEW_FORMAT, type PreviewManifest } from "@shared/preview/format";
import { previewPagesOf } from "@shared/preview/package";
import { decodeChangesDown } from "@shared/multiplayer/protocol";
import { codec, DOCUMENT_FORMAT_VERSION } from "@shared/schema/codec";
import { mergeMessages, messageImageHashes } from "@shared/schema/patch";

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

export interface RemoteSource {
  /** The document: a fig-kiwi container (a preview's doc.kiwi) or a bare kiwi Message (a room snapshot) */
  doc: { url: string; format: "fig-kiwi" | "message" };
  /** The manifest's URL, or one made from the document (a room snapshot has none: `manifestFromMessage`) */
  manifest: string | ((message: Uint8Array) => PreviewManifest);
  /** An image's URL by SHA-1 */
  image(sha1: string): string;
  /** Sent with every request (e.g. an Authorization header) */
  init?: RequestInit;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** doc.kiwi (a fig-kiwi container) → the Message bytes. */
export async function messageOf(doc: Uint8Array): Promise<Uint8Array> {
  const chunks = readCanvasChunks(doc).chunks;
  if (chunks.length < 2) throw new PreviewError("This preview can't be opened", "Its document is damaged.");
  if (isZstd(chunks[1])) throw new PreviewError("This preview can't be opened", "Its document is in a format this viewer doesn't read.");
  return inflateRaw(chunks[1]);
}

/** Refuses an expired manifest or one from a newer app. */
export function checkManifest(manifest: PreviewManifest): void {
  if (previewExpired(manifest, Date.now())) throw new PreviewError("This preview has expired", "Ask the person who shared it for a new link.");
  if (manifest.documentFormatVersion > DOCUMENT_FORMAT_VERSION) throw new PreviewError("This preview can't be opened", "It was made by a newer version of the app.");
}

async function fetchBytes(url: string, init?: RequestInit): Promise<Uint8Array> {
  let r: Response;
  try {
    r = await fetch(url, init);
  } catch {
    throw new PreviewError("This preview can't be opened", "The server couldn't be reached.");
  }
  if (r.status === 410) throw new PreviewError("This preview has expired", "Ask the person who shared it for a new link.");
  if (r.status === 403 || r.status === 404) throw new PreviewError("This preview isn't available", "It may have been stopped by the person who shared it.");
  if (!r.ok) throw new PreviewError("This preview can't be opened", `The server answered ${r.status}.`);
  return new Uint8Array(await r.arrayBuffer());
}

/** A manifest for a document that came without one (a room snapshot): every page, Inspect and export as given. */
export function manifestFromMessage(message: Uint8Array, info: { id: string; fileName: string; inspect?: boolean; export?: boolean }): PreviewManifest {
  const decoded = codec.decodeMessage(message);
  return {
    format: PREVIEW_FORMAT,
    previewId: info.id,
    fileName: info.fileName,
    publishedAt: Date.now(),
    expiresAt: null,
    pages: previewPagesOf(decoded),
    snapshot: "doc.kiwi",
    documentFormatVersion: DOCUMENT_FORMAT_VERSION,
    derivedDataVersion: decoded.derivedDataVersion ?? 0,
    images: [...messageImageHashes(decoded)],
    options: { inspect: info.inspect !== false, export: info.export !== false },
  };
}

/** Loads a document from `src` (module comment). */
export async function loadRemote(src: RemoteSource): Promise<LoadedPreview> {
  let manifest: PreviewManifest | null = null;
  if (typeof src.manifest === "string") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(await fetchBytes(src.manifest, src.init)));
    } catch (e) {
      if (e instanceof PreviewError) throw e;
      throw new PreviewError("This preview can't be opened", "Its description is damaged.");
    }
    if (!isPreviewManifest(parsed)) throw new PreviewError("This preview can't be opened", "Its description is damaged.");
    checkManifest((manifest = parsed));
  }
  const bytes = await fetchBytes(src.doc.url, src.init);
  const message = src.doc.format === "fig-kiwi" ? await messageOf(bytes) : bytes;
  if (!manifest) checkManifest((manifest = (src.manifest as (m: Uint8Array) => PreviewManifest)(message)));
  const known = new Set(manifest.images);
  return { manifest, message, image: async (sha1) => (known.has(sha1) ? fetchBytes(src.image(sha1), src.init).catch(() => null) : null) };
}

/**
 * An embedded shared file (`/embed/<key>`, docs/multiplayer.md §3): the room's snapshot and the frames after it, merged
 * here (the server never reads kiwi), shown read-only with Inspect and export.
 */
export async function loadEmbed(server: string, key: string): Promise<LoadedPreview> {
  const base = `${server}/embed/${encodeURIComponent(key)}`;
  let res: Response;
  try {
    res = await fetch(`${base}/snapshot`);
  } catch {
    throw new PreviewError("This file can't be shown", "The server couldn't be reached.");
  }
  if (!res.ok) throw new PreviewError("This file isn't available", "Its owner may have stopped sharing it with anyone who has the link.");
  const seq = Number(res.headers.get("x-seq") ?? "0");
  const fileName = decodeURIComponent(res.headers.get("x-file-name") ?? "Untitled");
  const snapshot = new Uint8Array(await res.arrayBuffer());
  const framesBytes = await fetchBytes(`${base}/frames?since=${seq}`);
  const messages = [codec.decodeMessage(snapshot)];
  const view = new DataView(framesBytes.buffer, framesBytes.byteOffset, framesBytes.byteLength);
  for (let at = 0; at + 4 <= framesBytes.length; ) {
    const n = view.getUint32(at);
    const frame = decodeChangesDown(framesBytes.subarray(at + 4, at + 4 + n));
    if (frame) messages.push(codec.decodeMessage(frame.message));
    at += 4 + n;
  }
  const message = messages.length === 1 ? snapshot : codec.encodeMessage(mergeMessages(messages).table.toMessage());
  const manifest = manifestFromMessage(message, { id: key, fileName });
  const known = new Set(manifest.images);
  return { manifest, message, image: async (sha1) => (known.has(sha1) ? fetchBytes(`${base}/images/${sha1}`).catch(() => null) : null) };
}
