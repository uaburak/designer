/**
 * Dev Mode's panels in the editor: the developer preview viewer's own (src/viewer — Pages, "Ready for development" and
 * Layers on the left; Inspect on the right: Compare changes, the box model, Code / List, colours, typography, assets,
 * export; hover measurements on the canvas), on the editor's engine. The viewer reads a read-only document and caches
 * every read; here the document changes, so its reader is made again after each committed change.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { Guid } from "@/engine/codec";
import { PREVIEW_FORMAT, PREVIEW_DOC_NAME } from "@shared/preview/format";
import { DOCUMENT_FORMAT_VERSION } from "@shared/schema/codec";
import { ViewerContext, type ViewerState } from "../../../../viewer/context";
import { ViewerDoc } from "../../../../viewer/viewerDoc";
import { LeftPanel as ViewerLeft } from "../../../../viewer/LeftPanel";
import { InspectPanel } from "../../../../viewer/InspectPanel";
import { Measurements } from "../../../../viewer/Measurements";
import type { LoadedPreview } from "../../../../viewer/source";
import { useEditor, type EditorController } from "../controller";
import { useUI } from "../hooks";
import { openFocus } from "./devMode";

/** The viewer's "preview" of the open file: its name and pages, Inspect and export on, images from the file. */
function previewOf(ed: EditorController, fileName: string): LoadedPreview {
  return {
    manifest: {
      format: PREVIEW_FORMAT,
      previewId: "",
      fileName,
      publishedAt: 0,
      expiresAt: null,
      pages: ed.store.pages.map((p) => ({
        id: p.guid,
        name: p.name,
        frames: (ed.engine.readNode(p.guid, { childIds: true, fields: ["name"] }) as { childIds?: Guid[] } | null)?.childIds
          ?.slice()
          .reverse()
          .map((id) => {
            const n = ed.engine.readNode(id, { fields: ["name", "type"] });
            return { id, name: n?.name ?? "", type: n?.type ?? "FRAME" };
          }) ?? [],
      })),
      snapshot: PREVIEW_DOC_NAME,
      documentFormatVersion: DOCUMENT_FORMAT_VERSION,
      derivedDataVersion: 0,
      images: [],
      options: { inspect: true, export: true },
    },
    message: new Uint8Array(),
    image: async (sha1) => (ed.source.images ? ed.source.images.get(sha1) : null),
  };
}

/** The viewer's context on the editor's engine; a new document reader after every committed change (debounced). */
function DevContext({ children }: { children: ReactNode }) {
  const ed = useEditor();
  const fileName = useUI((s) => s.fileName);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const bump = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        setVersion((v) => v + 1);
      }, 120);
    };
    const offs = [ed.engine.on("DOCUMENT_CHANGED", bump), ed.store.subscribe("pages", bump), ed.store.subscribe("page", bump)];
    return () => {
      offs.forEach((off) => off());
      if (timer) clearTimeout(timer);
    };
  }, [ed]);
  const state = useMemo<ViewerState>(
    () => ({
      engine: ed.engine,
      store: ed.store,
      doc: new ViewerDoc(ed.engine),
      preview: previewOf(ed, fileName),
      host: {
        subtitle: "Dev Mode",
        onCompare: (id) => ed.ui.set({ compare: { ref: id } }),
        onFocus: (id) => openFocus(ed, id),
        onStatus: (id, r) => ed.ui.set({ statusMenu: { ref: id, x: r.left, y: r.top, width: r.width, height: r.height } }),
      },
    }),
    // A new reader (and preview) per document version.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ed, fileName, version]
  );
  return <ViewerContext.Provider value={state}>{children}</ViewerContext.Provider>;
}

export function DevLeftPanel() {
  return (
    <DevContext>
      <ViewerLeft />
    </DevContext>
  );
}

export function DevRightPanel() {
  return (
    <DevContext>
      <InspectPanel />
    </DevContext>
  );
}

/** Hover measurements over the canvas (no ⌥ in Dev Mode). */
export function DevMeasurements() {
  return (
    <DevContext>
      <Measurements />
    </DevContext>
  );
}
