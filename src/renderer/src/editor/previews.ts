/**
 * Developer previews from the editor (docs/data.md §13): the snapshot a preview is made of — the engine's whole
 * document with its derived data (`encodeDocumentKiwi({derived: true})`: every instance's sublayer layout and every
 * text's glyph outlines, docs/schema.md §4.1 "preview snapshot"), after deriving every page it includes and letting
 * their fonts arrive, so the viewer draws each text exactly as here without the fonts. The store (the only writer)
 * packages it with the file's images: `previews.publish` (Firebase) or main's `file:export-preview` (an HTML file).
 */
import { fonts } from "@/engine/fonts";
import type { Engine } from "@/engine/Engine";
import type { PreviewOptions, PreviewRecord } from "../../../shared/store/types";
import { editorBridge } from "./desktop";
import type { EditorController } from "./controller";

/** How long the snapshot waits for the pages' fonts (texts whose font never comes draw with the fallback, as here). */
const FONT_WAIT_MS = 8000;

/** The preview's options as the Share dialog chooses them. */
export interface SharePreviewOptions {
  pageIds: string[] | "all";
  inspect: boolean;
  export: boolean;
  expiresInDays: PreviewOptions["expiresInDays"];
}

/** Every included page derived (its instances, its texts' layout, its fonts asked for), then the derived snapshot. */
export async function previewSnapshot(engine: Engine, pageIds: string[] | "all"): Promise<Uint8Array> {
  const pages = engine.pages().filter((p) => pageIds === "all" || pageIds.includes(p.guid));
  // A page's first read derives it (docs/engine-build.md "per-page derivation"), and asks for its fonts.
  for (const p of pages) engine.layerTree(p.guid);
  await Promise.race([fonts.settled(), new Promise<void>((r) => setTimeout(r, FONT_WAIT_MS))]);
  engine.pump();
  return engine.encodeDocumentKiwi({ derived: true });
}

/** What the Share dialog can do here: publish (the store says whether Firebase is on), export (the desktop app). */
export interface ShareAccess {
  status(): Promise<{ publish: boolean; reason: string | null }>;
  current(): Promise<PreviewRecord | null>;
  publish(options: SharePreviewOptions): Promise<PreviewRecord>;
  stop(previewId: string): Promise<void>;
  /** null: no desktop app (a browser) to save a file with */
  exportHtml: ((options: SharePreviewOptions) => Promise<{ path: string; bytes: number } | { cancelled: true }>) | null;
}

export function shareAccess(ed: EditorController): ShareAccess {
  const previews = ed.source.previews;
  const bridge = editorBridge();
  const fileKey = previews?.fileKey ?? null;
  return {
    status: async () => (previews ? previews.status() : { publish: false, reason: "Sharing previews needs a file in the workspace" }),
    current: async () => (previews ? ((await previews.list())[0] ?? null) : null),
    publish: async (options) => {
      if (!previews) throw new Error("Sharing previews needs a file in the workspace");
      const snapshot = await previewSnapshot(ed.engine, options.pageIds);
      return previews.publish(snapshot, options);
    },
    stop: async (id) => {
      if (!previews) throw new Error("Sharing previews needs a file in the workspace");
      await previews.stop(id);
    },
    exportHtml:
      bridge && fileKey
        ? async (options) => {
            const snapshot = await previewSnapshot(ed.engine, options.pageIds);
            return bridge.files.exportPreview({ fileKey, snapshot, options: { pageIds: options.pageIds, inspect: options.inspect, export: options.export } });
          }
        : null,
  };
}
