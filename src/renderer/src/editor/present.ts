/**
 * Present (▶ in the right panel's header, ⌥⌘↩; R8 §9): the prototype from the selected frame (else the page's first
 * flow, else its first frame). Figma's desktop app opens the presentation view in a new tab: the desktop shell's
 * prototype tab when it has one, a browser tab for a file of the store; otherwise — and for "Present in this tab" —
 * over the editor, on an engine of its own fed by this one's document and its changes.
 */
import type { Guid } from "@/engine/codec";
import type { PresentationSource } from "@/present/PresentationView";
import type { EditorController } from "./controller";

export interface PresentOptions {
  /** A frame (or a layer in one) to start at; default: the selection's top-level frame */
  node?: Guid;
  /** Over the editor instead of a new tab */
  here?: boolean;
}

type DesktopNav = { openPrototype?: (fileKey: string, pageId: string, startNodeId?: string, title?: string) => Promise<unknown> };

/** The selection's top-level frame (the first selected layer's), or undefined. */
export function presentStart(ed: EditorController): Guid | undefined {
  const page = ed.store.page;
  let cur: Guid | undefined = ed.selection[0];
  for (let guard = 0; cur && guard < 256; guard++) {
    const n = ed.engine.readNode(cur, { fields: ["parentIndex"] });
    const parent = n?.parentIndex?.guid;
    if (!parent) return undefined;
    if (parent === page) return cur;
    cur = parent;
  }
  return undefined;
}

export function present(ed: EditorController, opts: PresentOptions = {}): void {
  const page = ed.store.page;
  const node = opts.node ?? presentStart(ed);
  const fileKey = (ed.source as { fileKey?: string }).fileKey;
  if (!opts.here && fileKey) {
    const nav = (window as unknown as { designer?: { nav?: DesktopNav } }).designer?.nav;
    if (nav?.openPrototype) {
      void ed.source.flush().then(() => nav.openPrototype!(fileKey, page, node, ed.ui.get().fileName || ed.source.fileName));
      return;
    }
    if (!(window as unknown as { designer?: unknown }).designer) {
      // A browser: the store's file in a new tab (the dev store keeps the workspace in localStorage, shared by tabs).
      const url = `${location.pathname}?present&file=${encodeURIComponent(fileKey)}&page=${encodeURIComponent(page)}${node ? `&node=${encodeURIComponent(node)}` : ""}`;
      void ed.source.flush().then(() => window.open(url, "_blank"));
      return;
    }
  }
  ed.ui.set({ presenting: { page, node: node ?? null } });
}

/** Opens or closes the inline preview (⇧Space; InlinePreview.tsx) at the selection's frame. */
export function togglePreview(ed: EditorController): void {
  if (ed.ui.get().preview) {
    ed.ui.set({ preview: null });
    return;
  }
  ed.ui.set({ preview: { page: ed.store.page, node: presentStart(ed) ?? null } });
}

/** This editor's document, and its changes as they commit, for a presentation over it. */
export function editorPresentationSource(ed: EditorController): PresentationSource {
  return {
    fileName: ed.ui.get().fileName || ed.source.fileName,
    load: async () => ({ bytes: ed.engine.encodeDocumentKiwi() }),
    subscribe: (apply) => ed.engine.on("DOCUMENT_CHANGED", (e) => e.bytes && apply(e.bytes)),
    images: ed.source.images ? (hash) => ed.source.images!.get(hash) : undefined,
  };
}
