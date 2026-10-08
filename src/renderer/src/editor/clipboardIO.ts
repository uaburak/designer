/**
 * The system clipboard (docs/desktop.md §13): copy and cut are written in the
 * DOM `copy`/`cut` event — one atomic DataTransfer with our type, the HTML
 * envelope and plain text — and paste is read in the DOM `paste` event. The
 * keyboard (⌘C ⌘X ⌘V ⇧⌘V) and the app menu's Edit roles fire those events
 * natively; the editor's own menus fire them with execCommand. A paste with
 * no clipboard event behind it (a menu in a browser) reads the async
 * Clipboard API's HTML, then the last copy made in this tab.
 */
import type { Message } from "@/engine/codec";
import { messageToEngine } from "@/store/engineMessage";
import { decodeAnySchema } from "../../../shared/fig/importFig";
import { decodeMessage } from "../../../shared/schema/codec";
import type { EditorController } from "./controller";
import { engineCall } from "./engineCompat";
import { archiveMessage, encodeClipboard, encodeClipboardKiwi, messageAt, readClipboard, type ClipboardPayload } from "./model/clipboard";
import { isEditable } from "./keyboard";
import { isImageFile } from "./images";
import { frameAt, placeImages } from "./placeImages";
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
    return bytes && bytes.length ? encodeClipboardKiwi(bytes, { fileKey: ed.source.libraries?.fileKey ?? null }) : null;
  }
  const message = ed.engine.encodeSelection({ cut });
  return message && message.nodeChanges.length ? encodeClipboard(message) : null;
}

/** A DecompressionStream inflate (Figma's compressed archives). */
async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * A clipboard payload pasted: an archive's kiwi Message to the engine as it is (`pasteKiwi`; Figma's converted as a
 * `.fig` import is), the interim JSON as before. "Paste here" moves the Message first, so it goes through the JSON.
 */
async function pastePayload(ed: EditorController, payload: ClipboardPayload, mode: EditorController["pendingPaste"]): Promise<void> {
  if (payload.kind === "json") return pasteMessage(ed, payload.message, mode);
  const bytes = await archiveMessage(payload.archive, { inflate: typeof DecompressionStream === "function" ? inflateRaw : undefined, convert: (schema, message) => decodeAnySchema(schema, message).message });
  if (!bytes || ed.engine.destroyed) return;
  const pasteKiwi = engineCall<(b: Uint8Array, o: { inPlace?: boolean }) => number>(ed.engine, "pasteKiwi", "set_wire_format");
  if (!pasteKiwi || mode?.mode === "point") return pasteMessage(ed, messageToEngine(decodeMessage(bytes)), mode);
  const fileKey = ed.source.libraries?.fileKey ?? null;
  const from = decodeMessage(bytes).pasteFileKey;
  pasteKiwi(bytes, { inPlace: mode?.mode === "inPlace" });
  ed.focusCanvas();
  movedToast(ed, fileKey && from && from !== fileKey ? movedAmong(ed, ed.selection) : 0);
}

function movedToast(ed: EditorController, moved: number): void {
  if (!moved) return;
  showToast({
    message: moved === 1 ? "Pasted a published component. Publish this file to move it here." : `Pasted ${moved} published components. Publish this file to move them here.`,
    action: ed.source.libraries?.inDrafts() ? undefined : { label: "Publish…", onAction: () => ed.ui.set({ publishOpen: true }) },
  });
}

/**
 * A paste: from another file the engine sorts published components, styles and variables out itself (library
 * copies; a cut published main is moved here, `libraryMoveInfo`) — a moved component's toast offers Publish….
 */
function pasteMessage(ed: EditorController, message: Message, mode: EditorController["pendingPaste"]): void {
  const fileKey = ed.source.libraries?.fileKey ?? null;
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
  } else ed.engine.paste(message, { inPlace: mode?.mode === "inPlace" });
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
      // An image on the clipboard (a screenshot, a copied file): placed like a paste (desktop.md §13 step 4).
      const files = [...data.files].filter(isImageFile);
      if (!files.length) return; // SVG, text: later (desktop.md §13 steps 3, 5, 6)
      e.preventDefault();
      void ed.images.import(files).then((images) => {
        if (images.length && !ed.engine.destroyed) placeImages(ed, images);
        ed.focusCanvas();
      });
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
    if (m) void pastePayload(ed, m, mode);
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
