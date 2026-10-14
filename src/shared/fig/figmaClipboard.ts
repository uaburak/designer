/**
 * Paste from Figma (docs/desktop.md §13 "Paste from Figma"). Figma's ⌘C writes `text/html` holding
 * `<span data-metadata="<!--(figmeta)BASE64-JSON(/figmeta)-->">` (fileKey, pasteID, dataType) and
 * `<span data-buffer="<!--(figma)BASE64(/figma)-->">`: a fig-kiwi archive (Figma's schema, deflate-raw; the data chunk
 * deflate-raw or zstd) whose Message carries the copied layers under their own parents (`clipboardSelectionRegions`
 * with each parent's page offset), the mains their instances use and the styles they reference on the Internal Only
 * Canvas, and the vector blobs. Image bytes are not in it: paints name images by hash.
 *
 * The Message is converted as a `.fig` import is (`decodeAnySchema` → convert.ts), then made ready for the engine's
 * cross-file paste (`Editor::pasteWith`, which gives every node a fresh GUID, places the layers by Figma's rules and
 * selects them in one undo step) by `prepareFigmaPaste`.
 */
import type { ClipboardSelectionRegion, Message, NodeChange, Paint } from "../schema/document.generated";
import { guidKey } from "../schema/guid";
import { MODEL } from "../schema/model";
import { mapValue } from "../schema/visit";
import type { ImportReport } from "./convert";
import { decodeAnySchema } from "./importFig";

/** `(figmeta)` JSON: what Figma says about a copy. */
export interface FigmaClipboardMeta {
  fileKey?: string;
  pasteID?: number;
  dataType?: string;
  /** Ours writes `"designerv2"`; Figma writes none */
  app?: string;
}

const META = /\(figmeta\)([A-Za-z0-9+/=]+)\(\/figmeta\)/;

/** The `(figmeta)` metadata in some clipboard text, or null. */
export function figmaMetaOf(text: string | null | undefined): FigmaClipboardMeta | null {
  const m = text ? META.exec(text) : null;
  if (!m) return null;
  try {
    const bin = atob(m[1]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const value = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    return value && typeof value === "object" ? (value as FigmaClipboardMeta) : null;
  } catch {
    return null;
  }
}

/** The prefix of `pasteFileKey` on a paste from Figma: never one of our library keys, so the paste is cross-file. */
export const FIGMA_FILE_KEY_PREFIX = "figma:";

/** The asset identity a pasted node drops: Figma's libraries aren't ours, so its components and styles come in as this file's own. */
const IDENTITY = ["key", "version", "publishedVersion", "sourceLibraryKey", "libraryMoveInfo"] as const;

export interface FigmaPasteReport {
  /** Instances whose main wasn't in the clipboard, pasted as frames */
  detached: number;
  /** The images the pasted paints name (hex SHA-1, Figma's imageRef): fetched from Figma when this file lacks them */
  images: string[];
  /** The Figma file the layers were copied from (`(figmeta)` fileKey, else the Message's pasteFileKey) */
  fileKey?: string;
}

/**
 * A Message converted from Figma's clipboard → what the engine's paste takes:
 * - `pasteFileKey` set (`figma:<fileKey>`), so the paste is cross-file — Figma's GUIDs are never taken for this file's;
 *   `isCut` cleared (a cut in Figma moves nothing here);
 * - `clipboardSelectionRegions` made when absent: the layers directly on a page that isn't the Internal Only Canvas;
 * - library identity cleared (key, version, publishedVersion, sourceLibraryKey, libraryMoveInfo), keeping publishID:
 *   mains, sets and styles come in once as this file's own (pasted again, they are found by their Figma GUID);
 * - an instance whose main isn't in the clipboard becomes a frame (detached: its own fills, strokes, size, layout);
 * - an image paint's `imageThumbnail` dropped (Figma's tier isn't here): the full image when the file has it, else
 *   the paint's ThumbHash or Figma's grey placeholder.
 */
export function prepareFigmaPaste(message: Message, meta: FigmaClipboardMeta | null = null): { message: Message; report: FigmaPasteReport } {
  const report: FigmaPasteReport = { detached: 0, images: [] };
  const nodes = message.nodeChanges ?? [];
  const byId = new Map(nodes.filter((n) => n.guid).map((n) => [guidKey(n.guid!), n]));
  const mains = new Set(nodes.filter((n) => n.guid && n.type === "SYMBOL" && n.phase !== "REMOVED").map((n) => guidKey(n.guid!)));
  const images = new Set<string>();
  const paints = new Set(["Paint"]);
  const out: NodeChange[] = nodes.map((n) => {
    let m: NodeChange = { ...n };
    for (const f of IDENTITY) delete (m as Record<string, unknown>)[f];
    if (m.type === "INSTANCE" && !(m.symbolData?.symbolID && mains.has(guidKey(m.symbolData.symbolID)))) {
      m.type = "FRAME";
      delete m.symbolData;
      delete m.componentPropAssignments;
      delete m.derivedSymbolData;
      delete m.overriddenSymbolID;
      report.detached++;
    }
    m = mapValue(MODEL, "NodeChange", m, paints, (_d, p: Paint) => {
      if (p?.type !== "IMAGE") return p;
      const h = p.image?.hash;
      if (h instanceof Uint8Array && h.length) images.add([...h].map((b) => b.toString(16).padStart(2, "0")).join(""));
      if (!p.imageThumbnail) return p;
      const { imageThumbnail: _drop, ...rest } = p;
      return rest;
    }) as NodeChange;
    return m;
  });
  let regions: ClipboardSelectionRegion[] | undefined = message.clipboardSelectionRegions?.filter((r) => r.parent && r.nodes?.length);
  if (!regions?.length) {
    const pages = new Map<string, ClipboardSelectionRegion>();
    for (const n of out) {
      const parent = n.parentIndex?.guid;
      const p = parent ? byId.get(guidKey(parent)) : undefined;
      if (!parent || !n.guid || p?.type !== "CANVAS" || p.internalOnly || n.phase === "REMOVED") continue;
      const k = guidKey(parent);
      if (!pages.has(k)) pages.set(k, { parent, nodes: [], enclosingFrameOffset: { x: 0, y: 0 } });
      pages.get(k)!.nodes!.push(n.guid);
    }
    regions = [...pages.values()];
  }
  report.images = [...images];
  const source = meta?.fileKey || message.pasteFileKey;
  if (source) report.fileKey = source;
  const key = message.pasteFileKey || meta?.fileKey || "clipboard";
  return {
    message: { ...message, nodeChanges: out, clipboardSelectionRegions: regions, pasteFileKey: `${FIGMA_FILE_KEY_PREFIX}${key}`, isCut: false },
    report,
  };
}

/** True for our own archive (our schema, `app: "designerv2"`), false for Figma's. */
export const isOwnMeta = (meta: FigmaClipboardMeta | null): boolean => meta?.app === "designerv2";

/** A Figma clipboard archive's chunks (schema + Message, decompressed) → our Message ready to paste. */
export function decodeFigmaClipboard(schema: Uint8Array, message: Uint8Array, meta: FigmaClipboardMeta | null = null): { message: Message; report: FigmaPasteReport; convert: ImportReport | null } {
  const decoded = decodeAnySchema(schema, message, { clipboard: true });
  const prepared = prepareFigmaPaste(decoded.message, meta);
  return { ...prepared, convert: decoded.report };
}
