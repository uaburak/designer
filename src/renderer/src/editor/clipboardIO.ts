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
import { pageBounds } from "./actions";
import type { EditorController } from "./controller";
import { decodeClipboard, encodeClipboard } from "./model/clipboard";
import { isEditable } from "./keyboard";


function writeTo(data: DataTransfer, formats: Record<string, string>) {
  for (const [type, value] of Object.entries(formats)) data.setData(type, value);
}

/** The selection's clipboard formats, or null (nothing selected, or no engine support yet). */
function copyFormats(ed: EditorController): Record<string, string> | null {
  const message = ed.engine.encodeSelection();
  return message && message.nodeChanges.length ? encodeClipboard(message) : null;
}

function pasteMessage(ed: EditorController, message: Message, mode: EditorController["pendingPaste"]): void {
  if (mode?.mode === "point") {
    // "Paste here": paste, then move what was pasted so its corner is under the pointer — one undo step.
    ed.batch("Paste here", () => {
      ed.engine.paste(message, {});
      const box = pageBounds(ed, ed.selection);
      if (!box) return;
      const dx = mode.x - box.x;
      const dy = mode.y - box.y;
      for (const n of ed.selectedNodes()) if (n.transform) ed.engine.setProps([n.guid], { transform: { ...n.transform, m02: n.transform.m02 + dx, m12: n.transform.m12 + dy } });
    });
  } else ed.engine.paste(message, { inPlace: mode?.mode === "inPlace" });
  ed.focusCanvas();
}

/** Listens to the document's clipboard events while the editor is mounted. */
export function attachClipboard(ed: EditorController): () => void {
  const onCopy = (e: ClipboardEvent, cut: boolean) => {
    if (isEditable(e.target) || !e.clipboardData) return;
    if (!ed.selection.length) return;
    const formats = copyFormats(ed);
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
    const message = decodeClipboard((type) => data.getData(type)) ?? (data.types.length === 0 && ed.lastCopy ? decodeClipboard((t) => ed.lastCopy?.[t]) : null);
    if (!message) return; // images, SVG, text: later (desktop.md §13 steps 3–6)
    e.preventDefault();
    pasteMessage(ed, message, mode);
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
  const formats = copyFormats(ed);
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
  void readSystemClipboard().then((message) => {
    const m = message ?? (ed.lastCopy ? decodeClipboard((t) => ed.lastCopy?.[t]) : null);
    if (m) pasteMessage(ed, m, mode);
  });
}

async function readSystemClipboard(): Promise<Message | null> {
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      for (const type of ["text/html", "text/plain"]) {
        if (!item.types.includes(type)) continue;
        const text = await (await item.getType(type)).text();
        const m = decodeClipboard((t) => (t === type ? text : null));
        if (m) return m;
      }
    }
  } catch {
    /* no permission, or nothing readable */
  }
  return null;
}
