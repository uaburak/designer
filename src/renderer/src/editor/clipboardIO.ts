/**
 * The system clipboard (docs/desktop.md §13): copy and cut are written in the
 * DOM `copy`/`cut` event — one atomic DataTransfer with our type, the HTML
 * envelope and plain text — and paste is read in the DOM `paste` event. The
 * keyboard (⌘C ⌘X ⌘V ⇧⌘V) and the app menu's Edit roles fire those events
 * natively; the editor's own menus fire them with execCommand. A paste with
 * no clipboard event behind it (a menu in a browser) reads the async
 * Clipboard API's HTML, then the last copy made in this tab.
 *
 * Vector artwork from other apps (§13 "Vector paste"): SVG text on the clipboard, else what main finds on the
 * pasteboard — Illustrator's SVG, or its PDF converted to SVG — becomes editable layers (model/svgImport.ts) in
 * the middle of the view; only when there is none does a picture on the clipboard become an image.
 *
 * Also as Figma (atlas 15 §10–12): a spreadsheet's HTML table pastes as a grid of texts (model/tablePaste.ts); a
 * URL or e-mail address pasted onto selected characters links them; Copy / Paste properties go through the system
 * clipboard (Figma's STYLE Message), so they work across files and windows; a menu paste with no layers on the
 * clipboard takes its picture (`web image/png`, then `image/png`) before its text.
 */
import { t, tp } from "@/i18n";
import type { Message, NodeChange } from "@/engine/codec";
import type { PasteOptions } from "@/engine/Engine";
import { messageToEngine } from "@/store/engineMessage";
import { decodeAnySchema } from "../../../shared/fig/importFig";
import { decodeFigmaClipboard, isOwnMeta, type FigmaPasteReport } from "../../../shared/fig/figmaClipboard";
import { decodeMessage } from "../../../shared/schema/codec";
import type { EditorController } from "./controller";
import { engineCall } from "./engineCompat";
import {
  archiveMessage,
  decodePropertiesClipboard,
  encodeClipboard,
  encodeClipboardKiwi,
  encodePropertiesClipboard,
  messageAt,
  readClipboard,
  type ClipboardPayload,
  type CopiedProperties,
} from "./model/clipboard";
import { isSpreadsheetHtml, spreadsheetCells, spreadsheetToMessage } from "./model/tablePaste";
import { fields } from "./panels/design/shared";
import { isEditable } from "./keyboard";
import { isMediaFile } from "./images";
import { frameAt, placeImages, toPage } from "./placeImages";
import { looksLikeSvg, svgToMessage } from "./model/svgImport";
import { pastableText, textToMessage } from "./model/textPaste";
import { bringPastedFigmaImages } from "./figmaImages";
import { viewCentre } from "./canvas/viewInsets";
import { editorBridge } from "./desktop";
import { movedAmong } from "./libraries";
import { showToast } from "@/ds";


function writeTo(data: DataTransfer, formats: Record<string, string>) {
  for (const [type, value] of Object.entries(formats)) data.setData(type, value);
}

/**
 * The selection's clipboard formats, or null (nothing selected, or no engine support yet). The engine writes Figma's
 * `pasteFileKey` (this file, `setFileKey`) and `isCut` (⌘X) into the Message and, after the selection, the mains,
 * styles and variables it references (docs/engine-build.md "Clipboard (cross-file)").
 */
function copyFormats(ed: EditorController, cut = false): Record<string, string> | null {
  // Kiwi at the engine's boundary: the engine's clipboard Message goes into Figma's fig-kiwi archive as it is.
  const kiwi = engineCall<(o: { cut?: boolean }) => Uint8Array | null>(ed.engine, "encodeSelectionKiwi", "set_wire_format");
  if (kiwi) {
    const bytes = kiwi({ cut });
    return bytes && bytes.length ? encodeClipboardKiwi(bytes, { fileKey: ed.source.libraries?.libraryKey ?? null }) : null;
  }
  const message = ed.engine.encodeSelection({ cut });
  return message && message.nodeChanges.length ? encodeClipboard(message) : null;
}

/** A DecompressionStream inflate (Figma's compressed archives). */
async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** zstd (Figma's newer clipboard archives compress their data chunk with it): fzstd, loaded on the first such paste. */
async function zstdDecompress(data: Uint8Array): Promise<Uint8Array> {
  return (await import("fzstd")).decompress(data);
}

/**
 * A clipboard payload pasted: an archive's kiwi Message to the engine as it is (`pasteKiwi`; Figma's converted as a
 * `.fig` import is, then made ready for a cross-file paste — `decodeFigmaClipboard`), the interim JSON as before.
 * "Paste here" moves the Message first, so it goes through the JSON.
 */
async function pastePayload(ed: EditorController, payload: ClipboardPayload, mode: EditorController["pendingPaste"]): Promise<void> {
  if (payload.kind === "json") return pasteMessage(ed, payload.message, mode);
  const figma: { report: FigmaPasteReport | null } = { report: null };
  const bytes = await archiveMessage(payload.archive, {
    inflate: typeof DecompressionStream === "function" ? inflateRaw : undefined,
    zstd: zstdDecompress,
    convert: (schema, message) => {
      // An archive of ours written with an older schema: converted, nothing else. Figma's: ready for the paste.
      if (isOwnMeta(payload.meta)) return decodeAnySchema(schema, message).message;
      const decoded = decodeFigmaClipboard(schema, message, payload.meta);
      figma.report = decoded.report;
      return decoded.message;
    },
  });
  if (!bytes || ed.engine.destroyed) return;
  const pasteKiwi = engineCall<(b: Uint8Array, o: PasteOptions) => number>(ed.engine, "pasteKiwi", "set_wire_format");
  if (!pasteKiwi || mode?.mode === "point") {
    pasteMessage(ed, messageToEngine(decodeMessage(bytes)), mode);
  } else {
    const fileKey = ed.source.libraries?.libraryKey ?? null;
    const from = decodeMessage(bytes).pasteFileKey;
    pasteKiwi(bytes, pasteOptions(mode));
    ed.focusCanvas();
    movedToast(ed, fileKey && from && from !== fileKey ? movedAmong(ed, ed.selection) : 0);
  }
  if (figma.report) void figmaPasteToast(ed, figma.report);
}

/**
 * After a paste from Figma: what couldn't come along. Images travel by hash (Figma keeps the bytes on its servers):
 * those this file doesn't have are brought with the person's Figma token, or the dialog explains how to make one
 * (figmaImages.ts); instances whose main wasn't copied became frames.
 */
async function figmaPasteToast(ed: EditorController, report: FigmaPasteReport): Promise<void> {
  if (report.detached) showToast({ message: tp(report.detached, "An instance was pasted as a frame: its main component wasn't copied.", "{n} instances were pasted as frames: their main components weren't copied.") });
  if (report.images.length) await bringPastedFigmaImages(ed, report.fileKey, report.images);
}

function movedToast(ed: EditorController, moved: number): void {
  if (!moved) return;
  showToast({
    message: tp(moved, "Pasted a published component. Publish this file to move it here.", "Pasted {n} published components. Publish this file to move them here."),
    action: ed.source.libraries?.inDrafts() ? undefined : { label: t("Publish…"), onAction: () => ed.ui.set({ publishOpen: true }) },
  });
}

/**
 * A paste: from another file the engine sorts published components, styles and variables out itself (library
 * copies; a cut published main is moved here, `libraryMoveInfo`) — a moved component's toast offers Publish….
 */
function pasteMessage(ed: EditorController, message: Message, mode: EditorController["pendingPaste"]): void {
  const fileKey = ed.source.libraries?.libraryKey ?? null;
  const from = (message as Message & { pasteFileKey?: string }).pasteFileKey;
  pasteInto(ed, message, mode);
  movedToast(ed, fileKey && from && from !== fileKey ? movedAmong(ed, ed.selection) : 0);
}

function pasteInto(ed: EditorController, message: Message, mode: EditorController["pendingPaste"]): void {
  if (mode?.mode === "point") {
    // "Paste here": the Message moved so its corner is under the pointer, pasted in place in the frame there.
    const cam = ed.engine.getCamera();
    const frame = frameAt(ed, mode.x * cam.zoom + cam.x, mode.y * cam.zoom + cam.y);
    ed.engine.setSelection(frame ? [frame] : []);
    ed.engine.paste(messageAt(message, { x: mode.x, y: mode.y }), { inPlace: true });
  } else ed.engine.paste(message, pasteOptions(mode));
  ed.focusCanvas();
}

/** A paste mode as the engine's options: ⇧⌘V in place just above the selection; ⇧⌘R in each selected layer's place. */
export function pasteOptions(mode: EditorController["pendingPaste"]): PasteOptions {
  // ⇧⌘V: on top of the selection at its position (help.figma.com "Copy and paste objects"; round 8).
  if (mode?.mode === "over") return { over: true };
  if (mode?.mode === "replace") return { replace: true };
  return { inPlace: mode?.mode === "inPlace" };
}

/**
 * SVG pasted as layers, like any paste: in the middle of the view (or into the selected frame, the engine's rule),
 * at the pointer for "Paste here", over / in place of the selection for ⇧⌘V / ⇧⌘R. One undo step (the engine's
 * paste). `skipped`: what the PDF conversion left out, added to the SVG's own. False when the SVG drew nothing.
 */
export function pasteSvg(ed: EditorController, svg: string, mode: EditorController["pendingPaste"], skipped?: { text: number; images: number }): boolean {
  const { message, skipped: own } = svgToMessage(svg);
  if (!message || ed.engine.destroyed) return false;
  if (mode?.mode !== "point") {
    // The top layer is placed on the page: its middle at the view's middle.
    const top = message.nodeChanges[0];
    const mid = viewCentre(ed.canvas);
    const centre = toPage(ed, mid.x, mid.y);
    const size = top.size ?? { x: 0, y: 0 };
    top.transform = { m00: 1, m01: 0, m02: Math.round(centre.x - size.x / 2), m10: 0, m11: 1, m12: Math.round(centre.y - size.y / 2) };
  }
  pasteInto(ed, message, mode);
  const text = own.text + (skipped?.text ?? 0), images = own.images + (skipped?.images ?? 0);
  if (text || images) {
    showToast({
      message: text
        ? t("Text was left out. In Illustrator, use Type › Create Outlines before copying to paste it as vectors.")
        : tp(images, "An image in the artwork was left out.", "{n} images in the artwork were left out."),
    });
  }
  return true;
}

/**
 * Plain text pasted as a new text layer (Figma's "Copy as text", a text editor's copy): in the middle of the view, or
 * into the selected frame / at the pointer / over the selection as any paste. One undo step (the engine's paste).
 */
export function pasteText(ed: EditorController, text: string, mode: EditorController["pendingPaste"]): boolean {
  const chars = pastableText(text);
  if (!chars || ed.engine.destroyed) return false;
  const message = textToMessage(chars);
  if (mode?.mode !== "point") {
    const top = message.nodeChanges[0];
    const mid = viewCentre(ed.canvas);
    const centre = toPage(ed, mid.x, mid.y);
    const size = top.size ?? { x: 0, y: 0 };
    top.transform = { m00: 1, m01: 0, m02: Math.round(centre.x - size.x / 2), m10: 0, m11: 1, m12: Math.round(centre.y - size.y / 2) };
  }
  pasteInto(ed, message, mode);
  return true;
}

/**
 * A spreadsheet's copy (Google Sheets, Excel, or HTML that is one table) pasted as a grid of text layers
 * (model/tablePaste.ts), placed as any paste. False when the HTML holds no table.
 */
export function pasteSpreadsheet(ed: EditorController, html: string, mode: EditorController["pendingPaste"]): boolean {
  const rows = spreadsheetCells(html);
  if (!rows || ed.engine.destroyed) return false;
  const message = spreadsheetToMessage(rows);
  if (mode?.mode !== "point") {
    const top = message.nodeChanges[0];
    const centre = toPage(ed, viewCentre(ed.canvas).x, viewCentre(ed.canvas).y);
    top.transform = { m00: 1, m01: 0, m02: Math.round(centre.x), m10: 0, m11: 1, m12: Math.round(centre.y) };
  }
  pasteInto(ed, message, mode);
  return true;
}

/** A URL or an e-mail address as a link's target ("https://…", "www.…" → https, "a@b.co" → mailto:), or null. */
export function pastedLink(text: string): string | null {
  const s = text.trim();
  if (/\s/.test(s) || !s) return null;
  if (/^https?:\/\/[^/\s]+\.[^\s]+$/i.test(s)) return s;
  if (/^www\.[\w-]+(\.[\w-]+)+([/?#]\S*)?$/i.test(s)) return `https://${s}`;
  if (/^mailto:[^@\s]+@[\w-]+(\.[\w-]+)+$/i.test(s)) return s;
  if (/^[^@\s:/]+@[\w-]+(\.[\w-]+)+$/.test(s)) return `mailto:${s}`;
  return null;
}

/**
 * Text pasted while characters of a text layer are selected: a URL or an e-mail address links them (Figma's
 * `url_pasted_on_selected_text`, `paste_hyperlink_into_text_range`) — underlined, as Create link does — instead of
 * replacing them. False (the text goes in as typed) otherwise.
 */
export function pasteLinkOnText(ed: EditorController, text: string): boolean {
  const ref = ed.engine.textEdit?.ref;
  const url = pastedLink(text);
  if (!ref || !url || !ed.engine.textSelection()) return false;
  ed.setProps([ref], fields({ hyperlink: { url }, textDecoration: "UNDERLINE" }), "Create link");
  return true;
}

// ---- Copy / Paste properties through the system clipboard ----

/** Copy properties' clipboard write (model/clipboard.ts `encodePropertiesClipboard`); false when the browser refused it. */
export async function writePropertiesClipboard(ed: EditorController, node: NodeChange): Promise<boolean> {
  const formats = encodePropertiesClipboard(node, ed.source.libraries?.libraryKey ?? null);
  ed.lastCopy = formats;
  try {
    const item = new ClipboardItem({ "text/html": new Blob([formats["text/html"]], { type: "text/html" }), "text/plain": new Blob([formats["text/plain"]], { type: "text/plain" }) });
    await navigator.clipboard.write([item]);
    return true;
  } catch {
    return false;
  }
}

/** The copied properties on the system clipboard: null when it holds none, undefined when it can't be read. */
export async function readPropertiesClipboard(): Promise<CopiedProperties | null | undefined> {
  try {
    for (const item of await navigator.clipboard.read()) {
      if (!item.types.includes("text/html")) continue;
      const html = await (await item.getType("text/html")).text();
      const found = decodePropertiesClipboard((type) => (type === "text/html" ? html : null));
      if (found) return found;
    }
    return null;
  } catch {
    return undefined;
  }
}

/** An image on the system clipboard as Figma reads one: `web image/png` first, then `image/png`, as "image.png". */
async function readClipboardImage(): Promise<File | null> {
  try {
    for (const item of await navigator.clipboard.read()) {
      const type = ["web image/png", "image/png"].find((x) => item.types.includes(x));
      if (type) return new File([await item.getType(type)], "image.png", { type: "image/png" });
    }
  } catch {
    /* no permission, or nothing readable */
  }
  return null;
}

/** SVG markup in a DataTransfer (another app's "Copy as SVG", an SVG file's text), or null. */
function svgInTransfer(data: DataTransfer): string | null {
  const svg = data.getData("image/svg+xml");
  if (looksLikeSvg(svg)) return svg;
  const text = data.getData("text/plain");
  return looksLikeSvg(text) ? text : null;
}

/**
 * Not our own payload: SVG text, else main's vector flavours (Illustrator), else the clipboard's pictures. `files`
 * are taken from the event before it ends (the DataTransfer empties afterwards).
 */
async function pasteForeign(ed: EditorController, svgText: string | null, files: File[], mode: EditorController["pendingPaste"], text: string | null = null, html: string | null = null): Promise<void> {
  if (svgText && pasteSvg(ed, svgText, mode)) return;
  if (html && pasteSpreadsheet(ed, html, mode)) return;
  const vector = await editorBridge()?.clipboard?.readVector().catch(() => null);
  if (ed.engine.destroyed) return;
  if (vector && pasteSvg(ed, vector.svg, mode, vector.skipped)) return;
  if (!files.length) {
    if (text) pasteText(ed, text, mode);
    return;
  }
  const images = await ed.images.import(files);
  if (images.length && !ed.engine.destroyed) placeImages(ed, images);
  ed.focusCanvas();
}

/** Listens to the document's clipboard events while the editor is mounted. */
export function attachClipboard(ed: EditorController): () => void {
  const onCopy = (e: ClipboardEvent, cut: boolean) => {
    if (isEditable(e.target) || !e.clipboardData) return;
    if (!ed.selection.length) return;
    const formats = copyFormats(ed, cut);
    e.preventDefault();
    if (!formats) return;
    writeTo(e.clipboardData, formats);
    ed.lastCopy = formats;
    if (cut) ed.engine.command("DELETE");
  };
  const copy = (e: ClipboardEvent) => onCopy(e, false);
  const cut = (e: ClipboardEvent) => onCopy(e, true);
  const onPaste = (e: ClipboardEvent) => {
    if (isEditable(e.target) || !e.clipboardData) return;
    const data = e.clipboardData;
    const mode = ed.pendingPaste;
    ed.pendingPaste = null;
    const message = readClipboard((type) => data.getData(type)) ?? (data.types.length === 0 && ed.lastCopy ? readClipboard((t) => ed.lastCopy?.[t]) : null);
    if (!message) {
      // Vector artwork (SVG text; Illustrator's flavours, read by main), else an image on the clipboard (a
      // screenshot, a copied file) placed like a paste (desktop.md §13 steps 3–4).
      // A spreadsheet's cells come as an HTML table (before their text, which is tab-separated).
      const files = [...data.files].filter(isMediaFile);
      const svg = svgInTransfer(data);
      const html = data.getData("text/html");
      const table = !svg && isSpreadsheetHtml(html) ? html : null;
      const text = svg ? null : pastableText(data.getData("text/plain"));
      if (!svg && !table && !files.length && !text && !editorBridge()) return;
      e.preventDefault();
      void pasteForeign(ed, svg, files, mode, text, table);
      return;
    }
    e.preventDefault();
    void pastePayload(ed, message, mode);
  };
  document.addEventListener("copy", copy);
  document.addEventListener("cut", cut);
  document.addEventListener("paste", onPaste);
  return () => {
    document.removeEventListener("copy", copy);
    document.removeEventListener("cut", cut);
    document.removeEventListener("paste", onPaste);
  };
}

/** Copy / Cut from a menu: the DOM event when the browser fires it, else the async API (no custom type there). */
export function copyFromMenu(ed: EditorController, cut: boolean): void {
  ed.focusCanvas();
  if (document.execCommand(cut ? "cut" : "copy")) return;
  const formats = copyFormats(ed, cut);
  if (!formats) return;
  ed.lastCopy = formats;
  const item = new ClipboardItem({ "text/html": new Blob([formats["text/html"]], { type: "text/html" }), "text/plain": new Blob([formats["text/plain"]], { type: "text/plain" }) });
  void navigator.clipboard?.write([item]).catch(() => {});
  if (cut) ed.engine.command("DELETE");
}

/** Paste from a menu ("Paste", "Paste over selection", "Paste here"). */
export function pasteFromMenu(ed: EditorController, mode: EditorController["pendingPaste"]): void {
  ed.pendingPaste = mode;
  ed.focusCanvas();
  if (document.execCommand("paste")) return; // the paste event did it
  ed.pendingPaste = null;
  void readSystemClipboard().then((payload) => {
    const m = payload ?? (ed.lastCopy ? readClipboard((t) => ed.lastCopy?.[t]) : null);
    if (m) return void pastePayload(ed, m, mode);
    // No layers: a picture (Figma reads `web image/png`, then `image/png`), else the text.
    void readClipboardImage().then(async (image) => {
      if (image) return pasteForeign(ed, null, [image], mode);
      const text = await (navigator.clipboard?.readText() ?? Promise.resolve("")).catch(() => "");
      return pasteForeign(ed, null, [], mode, pastableText(text));
    });
  });
}

async function readSystemClipboard(): Promise<ClipboardPayload | null> {
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      for (const type of ["text/html", "text/plain"]) {
        if (!item.types.includes(type)) continue;
        const text = await (await item.getType(type)).text();
        const m = readClipboard((t) => (t === type ? text : null));
        if (m) return m;
      }
    }
  } catch {
    /* no permission, or nothing readable */
  }
  return null;
}
