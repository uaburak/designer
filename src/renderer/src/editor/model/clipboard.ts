/**
 * The clipboard's formats (docs/desktop.md §13, docs/engine.md §10.7), as pure
 * functions: one copy writes our own type `application/x-designerv2-kiwi`, a
 * `text/html` envelope carrying the same payload in base64 (what survives apps
 * that drop custom types — Figma's own approach), and `text/plain` (the layer
 * names, for text editors). Paste reads the first that decodes: our type, then
 * the envelope in the HTML, then an envelope that arrived as plain text.
 *
 * The payload is Figma's: a fig-kiwi archive (`fig-kiwi` prelude, version,
 * deflate-raw schema, deflate-raw kiwi Message — `src/shared/fig/container.ts`)
 * inside `(figma)…(/figma)` markers with `(figmeta)` metadata, written from the
 * engine's kiwi clipboard Message (`encodeSelectionKiwi`) with no conversion,
 * and pasted the same way (`pasteKiwi`). A paste from real Figma reads the
 * same envelope with Figma's schema (converted as a `.fig` import is). Our
 * interim JSON payload (`(designerv2)` markers) is still read and, with an
 * engine without kiwi, written.
 */
import type { Guid, Message, Vector } from "@/engine/codec";
import { deflateRawStored, inflateRawStored, type FigCodecs } from "../../../../shared/fig/compression";
import { decodeCanvas, figContainer, readCanvasChunks } from "../../../../shared/fig/container";
import { decodeMessage, DOCUMENT_FORMAT_VERSION, encodeMessage, SCHEMA_BINARY, type Message as KiwiMessage } from "../../../../shared/schema/codec";
import { guidKey } from "../../../../shared/schema/guid";
import { boundsOf, IDENTITY, unionBoxes } from "./geometry";

export const CLIPBOARD_TYPE = "application/x-designerv2-kiwi";
const OPEN = "(designerv2)";
const CLOSE = "(/designerv2)";
const ENVELOPE = /\(designerv2\)([A-Za-z0-9+/=]+)\(\/designerv2\)/;
/** Figma's envelope (and ours with kiwi): `(figma)<base64 fig-kiwi archive>(/figma)` */
const FIG_ENVELOPE = /\(figma\)([A-Za-z0-9+/=]+)\(\/figma\)/;

export function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function base64ToUtf8(b64: string): string {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The names of the copied layers that aren't inside another copied layer, one per line. */
export function plainTextOf(message: Message): string {
  const ids = new Set<Guid>(message.nodeChanges.map((n) => n.guid));
  return message.nodeChanges
    .filter((n) => !n.parentIndex || !ids.has(n.parentIndex.guid))
    .map((n) => n.name ?? "")
    .filter(Boolean)
    .join("\n");
}

/** Every format one copy writes, by MIME type. */
export function encodeClipboard(message: Message, plain = plainTextOf(message)): Record<string, string> {
  const b64 = utf8ToBase64(JSON.stringify(message));
  const meta = utf8ToBase64(JSON.stringify({ app: "designerv2", dataType: "scene" }));
  return {
    [CLIPBOARD_TYPE]: b64,
    "text/html":
      `<meta charset="utf-8"><div><span data-metadata="<!--(designerv2meta)${meta}(/designerv2meta)-->"></span>` +
      `<span data-buffer="<!--${OPEN}${b64}${CLOSE}-->"></span></div>` +
      `<span style="white-space:pre-wrap;">${escapeHtml(plain)}</span>`,
    "text/plain": plain,
  };
}

/** A base64 payload as a Message, or null when it isn't one. */
function decodePayload(b64: string): Message | null {
  try {
    const value = JSON.parse(base64ToUtf8(b64.trim())) as Partial<Message>;
    if (value && value.type === "NODE_CHANGES" && Array.isArray(value.nodeChanges)) return value as Message;
  } catch {
    /* not ours */
  }
  return null;
}

/** The envelope's payload in some text (HTML or plain), or null. */
export function envelopeOf(text: string | null | undefined): string | null {
  if (!text) return null;
  const m = ENVELOPE.exec(text);
  return m ? m[1] : null;
}

/** What was copied, from whichever format decodes first; null when the clipboard holds no layers of ours. */
export function decodeClipboard(read: (type: string) => string | null | undefined): Message | null {
  const own = read(CLIPBOARD_TYPE);
  if (own) {
    const m = decodePayload(own);
    if (m) return m;
  }
  for (const type of ["text/html", "text/plain"]) {
    const payload = envelopeOf(read(type));
    if (payload) {
      const m = decodePayload(payload);
      if (m) return m;
    }
  }
  return null;
}

/**
 * The clipboard Message moved so that, pasted in place, its top-left lands on `point` (page px): every source
 * region's offset shifts by the same amount ("Paste here" — the engine's paste can't run inside a transaction, so
 * the move is in the Message, not a second edit).
 */
export function messageAt(message: Message, point: Vector): Message {
  const ids = new Set(message.nodeChanges.map((n) => n.guid));
  const regions = new Map((message.clipboardSelectionRegions ?? []).map((r) => [r.parent, r]));
  const boxes = message.nodeChanges
    .filter((n) => n.phase !== "REMOVED" && !ids.has(n.parentIndex?.guid ?? ""))
    .map((n) => {
      const o = regions.get(n.parentIndex?.guid ?? "")?.enclosingFrameOffset ?? { x: 0, y: 0 };
      const m = n.transform ?? IDENTITY;
      return boundsOf({ ...m, m02: m.m02 + o.x, m12: m.m12 + o.y }, n.size ?? { x: 0, y: 0 });
    });
  const u = unionBoxes(boxes);
  if (!u) return message;
  const d = { x: Math.round(point.x - u.x), y: Math.round(point.y - u.y) };
  const parents = new Set(message.nodeChanges.filter((n) => !ids.has(n.parentIndex?.guid ?? "")).map((n) => n.parentIndex?.guid ?? ""));
  const shifted = [...parents].map((parent) => {
    const r = regions.get(parent);
    const o = r?.enclosingFrameOffset ?? { x: 0, y: 0 };
    return { parent, nodes: r?.nodes ?? message.nodeChanges.filter((n) => n.parentIndex?.guid === parent).map((n) => n.guid), enclosingFrameOffset: { x: o.x + d.x, y: o.y + d.y } };
  });
  return { ...message, clipboardSelectionRegions: shifted };
}

// ---- The fig-kiwi archive (kiwi at the engine's boundary) ---------------------------------------------------------

/** Bytes ⇄ base64 (the archive inside the envelope). */
export function bytesToB64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
export function b64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Stored deflate both ways: synchronous (the `copy` event can't await), and what any inflater reads. */
const STORED: FigCodecs = { deflateRaw: deflateRawStored, inflateRaw: inflateRawStored };

/** The names of the copied layers that aren't inside another copied layer, from a kiwi clipboard Message. */
export function plainTextOfKiwi(message: KiwiMessage): string {
  const nodes = message.nodeChanges ?? [];
  const ids = new Set(nodes.filter((n) => n.guid).map((n) => guidKey(n.guid!)));
  return nodes
    .filter((n) => !n.parentIndex?.guid || !ids.has(guidKey(n.parentIndex.guid)))
    .map((n) => n.name ?? "")
    .filter(Boolean)
    .join("\n");
}

/**
 * Every format one copy writes, from the engine's kiwi clipboard Message (docs/desktop.md §13): the fig-kiwi archive
 * (our schema, stored deflate) in our type and in Figma's `(figma)` envelope with `(figmeta)` metadata.
 */
export function encodeClipboardKiwi(bytes: Uint8Array, meta: { fileKey?: string | null; pasteID?: number } = {}): Record<string, string> {
  const message = decodeMessage(bytes);
  const plain = plainTextOfKiwi(message);
  const archive = bytesToB64(figContainer(SCHEMA_BINARY, bytes, DOCUMENT_FORMAT_VERSION, STORED));
  const metaB64 = utf8ToBase64(JSON.stringify({ fileKey: meta.fileKey ?? message.pasteFileKey ?? "", pasteID: meta.pasteID ?? message.pasteID ?? 0, dataType: "scene", app: "designerv2" }));
  return {
    [CLIPBOARD_TYPE]: archive,
    "text/html":
      `<meta charset="utf-8"><div><span data-metadata="<!--(figmeta)${metaB64}(/figmeta)-->"></span>` +
      `<span data-buffer="<!--(figma)${archive}(/figma)-->"></span></div>` +
      `<span style="white-space:pre-wrap;">${escapeHtml(plain)}</span>`,
    "text/plain": plain,
  };
}

/** What a clipboard holds of ours or Figma's: our interim JSON Message, or a fig-kiwi archive. */
export type ClipboardPayload = { kind: "json"; message: Message } | { kind: "archive"; archive: Uint8Array };

/** The clipboard's payload, from whichever format decodes first (an archive before the JSON); null when none is there. */
export function readClipboard(read: (type: string) => string | null | undefined): ClipboardPayload | null {
  const archiveOf = (b64: string | null | undefined): Uint8Array | null => {
    if (!b64) return null;
    try {
      const bytes = b64ToBytes(b64.trim());
      return bytes.length > 12 && String.fromCharCode(...bytes.subarray(0, 4)) === "fig-" ? bytes : null;
    } catch {
      return null;
    }
  };
  const own = read(CLIPBOARD_TYPE);
  const ownArchive = archiveOf(own);
  if (ownArchive) return { kind: "archive", archive: ownArchive };
  for (const type of ["text/html", "text/plain"]) {
    const text = read(type);
    const m = text ? FIG_ENVELOPE.exec(text) : null;
    const archive = archiveOf(m?.[1]);
    if (archive) return { kind: "archive", archive };
  }
  const message = decodeClipboard(read);
  return message ? { kind: "json", message } : null;
}

/**
 * A fig-kiwi archive → our kiwi Message bytes: ours as they are; Figma's (another schema) converted as a `.fig`
 * import is (`convert`, given by the caller: `src/shared/fig/importFig.ts decodeAnySchema`). Stored-deflate chunks
 * (ours) inflate synchronously; compressed ones (Figma's) through `inflate` (a `DecompressionStream`).
 */
export async function archiveMessage(
  archive: Uint8Array,
  options: { inflate?: (data: Uint8Array) => Promise<Uint8Array>; convert?: (schema: Uint8Array, message: Uint8Array) => KiwiMessage } = {}
): Promise<Uint8Array | null> {
  let canvas;
  try {
    canvas = decodeCanvas(archive, STORED);
  } catch {
    if (!options.inflate) return null;
    // Compressed chunks (Figma's): inflated with the given codec.
    try {
      const c = readCanvasChunks(archive);
      const [schema, message] = await Promise.all(c.chunks.slice(0, 2).map((ch) => options.inflate!(ch)));
      canvas = { schema, message };
    } catch {
      return null;
    }
  }
  if (canvas.schema.length === SCHEMA_BINARY.length && canvas.schema.every((b, i) => b === SCHEMA_BINARY[i])) return canvas.message;
  if (!options.convert) return null;
  try {
    return encodeMessage(options.convert(canvas.schema, canvas.message));
  } catch {
    return null;
  }
}
