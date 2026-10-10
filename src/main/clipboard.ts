import { clipboard } from "electron";
import { inflateSync, constants as zlib } from "node:zlib";
import type { VectorClipboard } from "../shared/ipc";
import { pdfToSvg } from "../shared/vectorImport/pdf";

/**
 * Vector artwork on the macOS pasteboard (docs/desktop.md §13 "Vector paste"), read in main because Chromium's
 * paste event only sees the standard types. Adobe Illustrator writes, for one copy (verified on Illustrator 30.8,
 * 2026-10-10, through Electron's `clipboard.read()`): `com.adobe.illustrator.svg` (its SVG with text as outlines and
 * `<style>` classes; `…svgm` the same), the classic flavour `'svg '` (= `public.svg-image`: SVG with presentation
 * attributes and `<text>`), `com.adobe.pdf` (a PDF of the selection, with Illustrator's private data; also as
 * "Apple PDF pasteboard type"), `com.adobe.illustrator.aicb` / `.pgf.14.0` / `.ate2` / `.stxt` (its own formats),
 * PNG, TIFF and plain text. The SVG flavours exist only while Illustrator ▸ Settings ▸ Clipboard Handling has SVG
 * ticked; the PDF one with PDF ticked. Chromium's own "image/svg+xml" there holds the PNG, so every SVG is checked.
 *
 * Taken in this order: Illustrator's SVG, any SVG, then the PDF converted to SVG here (zlib) — the system's PDF
 * flavour only next to Illustrator's own types, so a page copied from Preview still pastes as a picture. Null when
 * there is no vector flavour (the view then places the picture, as before).
 */

const MAX_BYTES = 256 * 1024 * 1024;

/** A raw pasteboard type as Electron's clipboard names it. */
const raw = (uti: string) => `electron application/osclipboard;format="${uti}"`;

const SVG_TYPES = [raw("com.adobe.illustrator.svg"), raw("com.adobe.illustrator.svgm"), raw("public.svg-image"), raw("CorePasteboardFlavorType 0x73766720"), "image/svg+xml"];
const PDF_TYPES = [raw("com.adobe.pdf")];
const SYSTEM_PDF_TYPES = [raw("public.pdf"), raw("Apple PDF pasteboard type"), "application/pdf"];

/** The clipboard's types and a way to read one. */
export interface Pasteboard {
  types: readonly string[];
  read(type: string): Promise<Uint8Array | null>;
}

async function systemPasteboard(): Promise<Pasteboard> {
  const items = await clipboard.read().catch(() => []);
  const owner = new Map<string, Electron.ClipboardItem>();
  for (const item of items) for (const t of item.types) if (!owner.has(t)) owner.set(t, item);
  return {
    types: [...owner.keys()],
    read: async (type) => {
      const blob = await owner.get(type)?.getType(type).catch(() => null);
      return blob instanceof Blob && blob.size > 0 && blob.size <= MAX_BYTES ? new Uint8Array(await blob.arrayBuffer()) : null;
    },
  };
}

const inflate = (b: Uint8Array) => new Uint8Array(inflateSync(b, { finishFlush: zlib.Z_SYNC_FLUSH }));

export async function readVectorClipboard(pb?: Pasteboard): Promise<VectorClipboard | null> {
  const board = pb ?? (await systemPasteboard());
  const has = (t: string) => board.types.includes(t);
  for (const type of SVG_TYPES.filter(has)) {
    const bytes = await board.read(type);
    if (!bytes) continue;
    const svg = decodeText(bytes);
    if (/^\s*(<\?xml[\s\S]*?\?>\s*)?(<!--[\s\S]*?-->\s*|<!DOCTYPE[\s\S]*?>\s*)*<svg[\s>]/i.test(svg.slice(0, 8192))) return { svg, source: formatOf(type), skipped: { text: 0, images: 0 } };
  }
  const adobe = board.types.some((t) => t.includes('format="com.adobe.illustrator.'));
  for (const type of (adobe ? [...PDF_TYPES, ...SYSTEM_PDF_TYPES] : PDF_TYPES).filter(has)) {
    const bytes = await board.read(type);
    if (!bytes) continue;
    try {
      const r = pdfToSvg(bytes, inflate);
      if (r && r.paths > 0) return { svg: r.svg, source: formatOf(type), skipped: r.skipped };
    } catch (err) {
      console.warn(`[clipboard] ${formatOf(type)} could not be read:`, err);
    }
  }
  return null;
}

const formatOf = (type: string) => /format="([^"]+)"/.exec(type)?.[1] ?? type;

/** UTF-8, or UTF-16 with its byte-order mark. */
function decodeText(b: Uint8Array): string {
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder("utf-16le").decode(b);
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder("utf-16be").decode(b);
  return new TextDecoder("utf-8").decode(b);
}
