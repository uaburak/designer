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
import { editorDevData, setRound5, useRound5 } from "./round5";
import { DevPluginsPanel } from "./PluginsPanel";
import { t, useLocale } from "@/i18n";
import { commandItem } from "../menus";
import { runEditorCommand } from "../commands";
import { useExportAllowed } from "../exporting";

/** Dev Mode's right sidebar: Inspect, and Plugins (docs/plugins.md §7). */
const renderPlugins = () => <DevPluginsPanel />;

/** The viewer's "preview" of the open file: its name and pages, Inspect and export on, images from the file. */
/** The viewer's preview of the editor's file; `canExport` false hides Assets and Export (docs/governance.md §2.7). */
export function previewOf(ed: EditorController, fileName: string, canExport: boolean): LoadedPreview {
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
      // Assets and Export download files: off for a viewer the file's export setting restricts (docs/governance.md §2.7).
      options: { inspect: true, export: canExport },
    },
    message: new Uint8Array(),
    image: async (sha1) => (ed.source.images ? ed.source.images.get(sha1) : null),
  };
}

const selectCanEdit = (s: { canEdit: boolean }) => s.canEdit;

/**
 * Calls `changed` (debounced, 120 ms) after the document changes: this copy's own transactions (DOCUMENT_CHANGED) and
 * also everything applied from outside — a shared file's other people (the room's frames), an undo, a library update —
 * which reach the engine without a DOCUMENT_CHANGED but move the tree (STRUCTURE_CHANGED) or nodes (NODES_CHANGED).
 * Found running round 5 end to end (2026-10-12): Dev Mode's Layers and Ready for development lists stayed on the
 * document as it was when Dev Mode opened while a designer edited the shared file. Returns the unsubscribe.
 */
export function onDevDocumentChange(ed: EditorController, changed: () => void, delayMs = 120): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const bump = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      changed();
    }, delayMs);
  };
  const offs = [
    ed.engine.on("DOCUMENT_CHANGED", bump),
    ed.engine.on("NODES_CHANGED", bump),
    ed.store.subscribe("structure", bump),
    ed.store.subscribe("pages", bump),
    ed.store.subscribe("page", bump),
  ];
  return () => {
    offs.forEach((off) => off());
    if (timer) clearTimeout(timer);
  };
}

/** The viewer's context on the editor's engine; a new document reader after every change (debounced). */
function DevContext({ children }: { children: ReactNode }) {
  const ed = useEditor();
  const fileName = useUI((s) => s.fileName);
  const canEdit = useRound5(ed, selectCanEdit);
  const canExport = useExportAllowed(ed);
  // Made again when the file's access is known (editorDevData reads it).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const dev = useMemo(() => editorDevData(ed), [ed, canEdit]);
  const [version, setVersion] = useState(0);
  useEffect(() => onDevDocumentChange(ed, () => setVersion((v) => v + 1)), [ed]);
  const state = useMemo<ViewerState>(
    () => ({
      engine: ed.engine,
      store: ed.store,
      doc: new ViewerDoc(ed.engine),
      preview: previewOf(ed, fileName, canExport),
      host: {
        subtitle: "Dev Mode",
        onCompare: (id) => ed.ui.set({ compare: { ref: id } }),
        onFocus: (id) => openFocus(ed, id),
        onStatus: (id, r) => ed.ui.set({ statusMenu: { ref: id, x: r.left, y: r.top, width: r.width, height: r.height } }),
        onReadyView: () => setRound5(ed, { ready: true }),
        // Dev Mode's file name menu (docs/editor.md D-1: Library ▸ Connect components to code)
        fileMenu: {
          entries: () => [commandItem(ed, "file.save-version"), commandItem(ed, "file.version-history"), "-", { id: "library", label: t("Library"), items: [commandItem(ed, "dev.connect-components"), commandItem(ed, "file.library-analytics")] }],
          onSelect: (id) => runEditorCommand(ed, id),
        },
        ...(dev ? { dev } : {}),
      },
    }),
    // A new reader (and preview) per document version.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ed, fileName, version, dev, canExport]
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
  const locale = useLocale();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const pluginsTab = useMemo(() => ({ label: t("Plugins"), render: renderPlugins }), [locale]);
  return (
    <DevContext>
      <InspectPanel extraTab={pluginsTab} />
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
