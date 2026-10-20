/**
 * Present (▶ in the right panel's header, ⌥⌘↩; R8 §9): the prototype from the selected frame (else the page's first
 * flow, else its first frame). Figma's desktop app opens the presentation view in a new tab: the desktop shell's
 * prototype tab when it has one, a browser tab for a file of the store; otherwise — and for "Present in this tab" —
 * over the editor, on an engine of its own fed by this one's document and its changes.
 */
import type { Guid } from "@/engine/codec";
import type { Engine } from "@/engine/Engine";
import { followSource, type PresentationSource } from "@/present/PresentationView";
import type { EditorController } from "./controller";

export interface PresentOptions {
  /** A frame (or a layer in one) to start at; default: the selection's top-level frame */
  node?: Guid;
  /** Over the editor instead of a new tab */
  here?: boolean;
}

type DesktopNav = { openPrototype?: (fileKey: string, pageId: string, startNodeId?: string, title?: string) => Promise<unknown> };

/**
 * The selection's top-level frame (the first selected layer's, or `from`'s), or undefined. A frame in a section (nested
 * sections too) is top-level, as in Figma (the player's `screenOf`).
 */
export function presentStart(ed: EditorController, from?: Guid): Guid | undefined {
  const page = ed.store.page;
  const chain: { guid: Guid; section: boolean }[] = [];
  let cur: Guid | undefined = from ?? ed.selection[0];
  for (let guard = 0; cur && guard < 256; guard++) {
    const read = ed.engine.readNode(cur, { fields: ["parentIndex", "type"] });
    const n = read ? (ed.withRealType(read) as { parentIndex?: { guid?: Guid }; type?: string }) : null;
    const parent = n?.parentIndex?.guid;
    if (!parent) return undefined;
    chain.push({ guid: cur, section: n?.type === "SECTION" });
    if (parent === page) return chain.reverse().find((c) => !c.section)?.guid;
    cur = parent;
  }
  return undefined;
}

/**
 * What Play starts from for the selection (or `from`): its top-level frame, else the section that holds it — the player
 * starts a section at its first flow's frame, else its first frame (proto::sectionStart: one frame, never the section).
 */
export function presentNode(ed: EditorController, from?: Guid): Guid | undefined {
  const frame = presentStart(ed, from);
  if (frame) return frame;
  for (let cur: Guid | undefined = from ?? ed.selection[0], guard = 0; cur && cur !== ed.store.page && guard < 256; guard++) {
    const n = ed.engine.readNode(cur, { fields: ["parentIndex", "type"] }) as { parentIndex?: { guid?: Guid }; type?: string } | null;
    if (n?.type === "SECTION") return cur;
    cur = n?.parentIndex?.guid;
  }
  return undefined;
}

export function present(ed: EditorController, opts: PresentOptions = {}): void {
  const page = ed.store.page;
  const node = opts.node ?? presentNode(ed);
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
  // The closed inline preview kept for this page hands its engine over (and goes, in the same commit).
  const ui = ed.ui.get();
  if (!ui.preview && ui.previewKept?.page === page) {
    handOverPresentation(ed, page);
    ed.ui.set({ presenting: { page, node: node ?? null }, previewKept: null });
    return;
  }
  ed.ui.set({ presenting: { page, node: node ?? null } });
}

/**
 * A flow's link (the Prototype panel's "Copy flow link"): the presentation view of this file starting at `frame`,
 * Figma's `starting-point-node-id` (presentUrlOptions reads it).
 */
export function flowLink(ed: EditorController, frame: Guid): string {
  const fileKey = (ed.source as { fileKey?: string }).fileKey;
  const url = new URL(location.href);
  url.search = "";
  return `${url.origin}${url.pathname}?present${fileKey ? `&file=${encodeURIComponent(fileKey)}` : ""}&page=${encodeURIComponent(ed.store.page)}&starting-point-node-id=${encodeURIComponent(frame.replace(":", "-"))}`;
}

/** Opens or closes the inline preview (⇧Space; InlinePreview.tsx) at the selection's frame. */
export function togglePreview(ed: EditorController): void {
  if (ed.ui.get().preview) {
    ed.ui.set({ preview: null });
    return;
  }
  ed.ui.set({ preview: { page: ed.store.page, node: presentNode(ed) ?? null } });
}

/**
 * This editor's document, and its changes as they commit, for a presentation of `page` over it: only what a prototype
 * on that page needs (Engine.encodePageKiwi — the page, the internal canvas, the components and destinations it
 * reaches elsewhere), as Figma's viewer loads only the page it presents. A heavy file's other pages cost nothing.
 */
export function editorPresentationSource(ed: EditorController, page: Guid): PresentationSource {
  const source: PresentationSource = {
    fileName: ed.ui.get().fileName || ed.source.fileName,
    load: async () => ({ bytes: ed.engine.encodePageKiwi(page) }),
    // Both engines are in this module: the page's nodes go across directly (no Message written and read).
    loadInto: (engine) => void engine.loadPageOf(ed.engine, page),
    subscribe: (apply) => ed.engine.on("DOCUMENT_CHANGED", (e) => e.bytes && apply(e.bytes)),
    images: ed.source.images ? (hash) => ed.source.images!.get(hash) : undefined,
    partial: { has: (id) => !ed.engine.destroyed && ed.engine.readNode(id, { fields: ["type"] }) !== null },
    takeEngine: () => {
      const p = parked.get(ed);
      if (!p || p.page !== page || p.engine.destroyed) return null;
      parked.delete(ed);
      p.stop();
      return p.engine;
    },
    keepEngine: (engine, back) => {
      if (!back && handing.get(ed) !== page) return false;
      handing.delete(ed);
      dropParked(ed);
      parked.set(ed, { page, engine, stop: followSource(engine, source, page) });
      return true;
    },
  };
  return source;
}

/**
 * The prototype engine handed between the inline preview and Present here (one per editor): Present here takes the
 * closed inline preview's, and closing Present here leaves its own for the next ⇧Space — no second load of the page
 * (B2C: 0.35 s), no 0.2–0.4 s destroy. Parked, it follows the editor's changes.
 */
interface Parked {
  page: Guid;
  engine: Engine;
  stop: () => void;
}
const parked = new WeakMap<EditorController, Parked>();
/** The page whose presentation engine goes to the next view of it, at its view's unmount. */
const handing = new WeakMap<EditorController, Guid>();

/** The view of `page` closing now hands its engine to the next one (Present here, the inline preview). */
export function handOverPresentation(ed: EditorController, page: Guid): void {
  handing.set(ed, page);
}

/** A parked presentation engine goes (memory pressure, the editor closing). */
export function dropParked(ed: EditorController): void {
  const p = parked.get(ed);
  if (!p) return;
  parked.delete(ed);
  p.stop();
  p.engine.destroy();
}
