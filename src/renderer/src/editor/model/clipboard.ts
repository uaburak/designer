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
import type { Guid, Message, NodeChange, Vector } from "@/engine/codec";
import { deflateRawStored, isZstd, inflateRawStored, type FigCodecs } from "../../../../shared/fig/compression";
import { figmaMetaOf, type FigmaClipboardMeta } from "../../../../shared/fig/figmaClipboard";
import { withoutOurPrototypeValues } from "../../../../shared/fig/figmaExport";
import { decodeCanvas, figContainer, readCanvasChunks } from "../../../../shared/fig/container";
import { decodeMessage, DOCUMENT_FORMAT_VERSION, encodeMessage, SCHEMA_BINARY, type Message as KiwiMessage } from "../../../../shared/schema/codec";
import { guidKey } from "../../../../shared/schema/guid";
import { nodeToEngine, nodeToKiwi } from "../../store/engineMessage";
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

// ---- Copy / Paste properties ----------------------------------------------------------------------------------------

/** What Copy properties put on the clipboard: the copied fields (and the layer's type), and the file they came from. */
export interface CopiedProperties {
  node: NodeChange;
  fileKey?: string;
}

/**
 * Copy properties' formats (atlas 15 §10): Figma's STYLE Message (`MessageType.STYLE` 5) — one CREATED node at GUID
 * 0:0 holding the copied fields (and the layer's type), and `pasteFileKey` — as a fig-kiwi archive in the clipboard's
 * `(figma)` envelope, as Figma writes it, so ⌥⌘V works in another file or window. ⌘V never pastes it as layers
 * (`readClipboard` skips it, the paste refuses a STYLE Message).
 */
export function encodePropertiesClipboard(node: NodeChange, fileKey: string | null): Record<string, string> {
  const message: KiwiMessage = {
    type: "STYLE",
    sessionID: 0,
    nodeChanges: [nodeToKiwi({ ...node, guid: "0:0", phase: "CREATED" })],
    ...(fileKey ? { pasteFileKey: fileKey } : {}),
  };
  return encodeClipboardKiwi(encodeMessage(message), { fileKey });
}

/** A clipboard Message's copied properties: a STYLE Message's node (the engine's form), or null for anything else. */
export function propertiesOfMessage(message: KiwiMessage): CopiedProperties | null {
  const node = message.type === "STYLE" ? message.nodeChanges?.[0] : undefined;
  return node ? { node: nodeToEngine(node), ...(message.pasteFileKey ? { fileKey: message.pasteFileKey } : {}) } : null;
}

/** An archive written with our schema and stored deflate (ours): its Message bytes, synchronously; else null. */
function ownArchiveMessage(archive: Uint8Array): Uint8Array | null {
  try {
    const canvas = decodeCanvas(archive, STORED);
    return canvas.schema.length === SCHEMA_BINARY.length && canvas.schema.every((b, i) => b === SCHEMA_BINARY[i]) ? canvas.message : null;
  } catch {
    return null;
  }
}

/**
 * Whether kiwi Message bytes are a STYLE Message (Copy properties), read from the first field without decoding the
 * rest: kiwi writes a message's fields in their schema order, and `type` is field 1 (an enum, a varuint).
 */
export function isStyleMessage(bytes: Uint8Array): boolean {
  return bytes.length > 1 && bytes[0] === 1 && bytes[1] === 5;
}

/**
 * The copied properties on a clipboard, from whichever format holds them — an archive of ours, or the interim JSON
 * payload an older build wrote; null when it holds none. Figma's own archives (another schema, compressed) are read
 * asynchronously by the caller (clipboardIO.ts `readPropertiesClipboard`).
 */
export function decodePropertiesClipboard(read: (type: string) => string | null | undefined): CopiedProperties | null {
  const payload = readClipboard(read, { properties: true });
  if (payload?.kind === "archive") {
    const message = ownArchiveMessage(payload.archive);
    return message ? propertiesOfMessage(decodeMessage(message)) : null;
  }
  for (const b64 of [read(CLIPBOARD_TYPE), envelopeOf(read("text/html")), envelopeOf(read("text/plain"))]) {
    if (!b64) continue;
    try {
      const value = JSON.parse(base64ToUtf8(b64.trim())) as { type?: string; nodeChanges?: NodeChange[]; pasteFileKey?: string };
      const node = value?.type === "STYLE" ? value.nodeChanges?.[0] : undefined;
      if (node) return { node, ...(value.pasteFileKey ? { fileKey: value.pasteFileKey } : {}) };
    } catch {
      /* not ours */
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
export function encodeClipboardKiwi(bytes: Uint8Array, meta: { fileKey?: string | null; pasteID?: number; /** the text/plain (default: the copied layers' names) */ plain?: string } = {}): Record<string, string> {
  const message = decodeMessage(bytes);
  const plain = meta.plain ?? plainTextOfKiwi(message);
  const archive = bytesToB64(figContainer(SCHEMA_BINARY, bytes, DOCUMENT_FORMAT_VERSION, STORED));
  // Figma's envelope leaves out what only Wecra plays (an On double click: Figma has no such trigger); our own type
  // keeps everything for a paste into Wecra, which reads it first.
  const forFigma = withoutOurPrototypeValues(message);
  const envelope = forFigma === message ? archive : bytesToB64(figContainer(SCHEMA_BINARY, encodeMessage(forFigma), DOCUMENT_FORMAT_VERSION, STORED));
  const metaB64 = utf8ToBase64(JSON.stringify({ fileKey: meta.fileKey ?? message.pasteFileKey ?? "", pasteID: meta.pasteID ?? message.pasteID ?? 0, dataType: "scene", app: "designerv2" }));
  return {
    [CLIPBOARD_TYPE]: archive,
    "text/html":
      `<meta charset="utf-8"><div><span data-metadata="<!--(figmeta)${metaB64}(/figmeta)-->"></span>` +
      `<span data-buffer="<!--(figma)${envelope}(/figma)-->"></span></div>` +
      `<span style="white-space:pre-wrap;">${escapeHtml(plain)}</span>`,
    "text/plain": plain,
  };
}

/**
 * What a clipboard holds of ours or Figma's: our interim JSON Message, or a fig-kiwi archive with its `(figmeta)`
 * metadata (`app: "designerv2"` on ours; Figma's has none).
 */
export type ClipboardPayload = { kind: "json"; message: Message } | { kind: "archive"; archive: Uint8Array; meta: FigmaClipboardMeta | null };

/**
 * The clipboard's payload, from whichever format decodes first (an archive before the JSON); null when none is there.
 * An archive of ours holding Copy properties' STYLE Message isn't layers: skipped unless `properties` asks for it.
 */
export function readClipboard(read: (type: string) => string | null | undefined, options: { properties?: boolean } = {}): ClipboardPayload | null {
  const archiveOf = (b64: string | null | undefined): Uint8Array | null => {
    if (!b64) return null;
    try {
      const bytes = b64ToBytes(b64.trim());
      if (bytes.length <= 12 || String.fromCharCode(...bytes.subarray(0, 4)) !== "fig-") return null;
      const own = options.properties ? null : ownArchiveMessage(bytes);
      return own && isStyleMessage(own) ? null : bytes;
    } catch {
      return null;
    }
  };
  const own = read(CLIPBOARD_TYPE);
  const ownArchive = archiveOf(own);
  if (ownArchive) return { kind: "archive", archive: ownArchive, meta: { app: "designerv2" } };
  for (const type of ["text/html", "text/plain"]) {
    const text = read(type);
    const m = text ? FIG_ENVELOPE.exec(text) : null;
    const archive = archiveOf(m?.[1]);
    if (archive) return { kind: "archive", archive, meta: figmaMetaOf(text) };
  }
  const message = decodeClipboard(read);
  return message ? { kind: "json", message } : null;
}

/**
 * A fig-kiwi archive → our kiwi Message bytes: ours as they are; Figma's (another schema) converted as a `.fig`
 * import is (`convert`, given by the caller: `src/shared/fig/figmaClipboard.ts decodeFigmaClipboard`). Stored-deflate
 * chunks (ours) inflate synchronously; compressed ones (Figma's) through `inflate` (a `DecompressionStream`), a zstd
 * data chunk (Figma's newer archives) through `zstd` (fzstd).
 */
export async function archiveMessage(
  archive: Uint8Array,
  options: {
    inflate?: (data: Uint8Array) => Promise<Uint8Array>;
    zstd?: (data: Uint8Array) => Promise<Uint8Array> | Uint8Array;
    convert?: (schema: Uint8Array, message: Uint8Array) => KiwiMessage;
  } = {}
): Promise<Uint8Array | null> {
  let canvas;
  try {
    canvas = decodeCanvas(archive, STORED);
  } catch {
    if (!options.inflate) return null;
    // Compressed chunks (Figma's): inflated with the given codec, zstd ones with the zstd decoder.
    try {
      const c = readCanvasChunks(archive);
      if (c.chunks.length < 2) return null;
      const [schema, message] = await Promise.all(
        c.chunks.slice(0, 2).map(async (ch) => {
          if (!isZstd(ch)) return options.inflate!(ch);
          if (!options.zstd) throw new Error("no zstd decoder");
          return options.zstd(ch);
        })
      );
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
