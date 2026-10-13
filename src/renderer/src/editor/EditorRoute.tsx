/**
 * `?editor`: the editor view.
 * - `&file=<fileKey>[&tab=<id>]` (the desktop's editor tabs; a browser opens the dev store's files):
 *   the file on the store, through the data workstream's DocumentSource (`@/store`).
 * - neither `file` nor `doc`, in an editor view of the desktop app: the SPARE editor (docs/desktop.md §3.1) —
 *   the page pre-warms (the Wasm module compiled and instantiated, the store port taken, the font index read)
 *   and waits for main to adopt it for a file that opens (`tab:attach`, or an `init()` that already names the
 *   tab), then mounts that file exactly as `&file=…&tab=…` does.
 * - otherwise a document held in memory: the engine's sample, `&doc=reference` (the owner's file as
 *   in the reference screenshots), `&doc=empty` (a new file), `&doc=components` (components, a set, instances), `&doc=variables` (collections, modes, styles, bound layers), `&doc=prototype` (screens, connections, an overlay, an interactive component) or `&doc=types` (Phase 2's sizing, constraints
 *   and layer types).
 * The rulers start off as live Figma's View > Rulers does; `&rulers=1` starts with them on. The editor is on `window.__designerEditor` for scripts
 * (tools/editor-shot.mjs) and the console; the open's timing marks on `window.__designerOpen`
 * (scripts/drive.mjs `open-timing`).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { EditorApi } from "@shared/desktop";
import { showToast } from "@/ds";
import { fonts } from "@/engine/fonts";
import { loadEngine } from "@/engine/loadEngine";
import { SAMPLE_DOCUMENT } from "@/engine/sampleDocument";
import { getStoreClient, openDocument } from "@/store";
import { editorBridge } from "./desktop";
import { memoryDocumentSource, type DocumentSource } from "./documentSource";
import { EditorApp } from "./EditorApp";
import type { EditorController } from "./controller";
import type { ImageStore } from "./images";
import { withImages } from "./sourceImages";
import { CAPTURE_DOCUMENT, CAPTURE_UI_STATE, COMPONENTS_DOCUMENT, EMPTY_DOCUMENT, PAINTS_DOCUMENT, PROTOTYPE_DOCUMENT, REFERENCE_DOCUMENT, TEXT_DOCUMENT, TYPES_DOCUMENT, VARIABLES_DOCUMENT } from "./fixtures";
import { PresentationView } from "@/present/PresentationView";
import { storePresentationSource } from "@/present/PresentRoute";
import { SharePrototypeDialog } from "./SharePrototypeDialog";
import { OpenLoader } from "./OpenLoader";
import { downloadProgress, setOpenProgress } from "./openProgress";
import styles from "./EditorApp.module.css";

/**
 * When the open's steps happened, as `performance.now()` of this page (`timeOrigin` turns them into epoch ms, to set
 * against main's time of the open): the file known (an attach, or the URL at mount), the store's source open, the
 * editor up (`onReady`), the first canvas frame presented.
 */
export interface OpenMarks {
  timeOrigin: number;
  attached?: number;
  sourceOpened?: number;
  ready?: number;
  firstFrame?: number;
}

declare global {
  interface Window {
    __designerEditor?: EditorController;
    __designerOpen?: OpenMarks;
  }
}

/** The first time only: a mark already set stays. */
function mark(name: Exclude<keyof OpenMarks, "timeOrigin">): void {
  const marks = (window.__designerOpen ??= { timeOrigin: performance.timeOrigin });
  marks[name] ??= performance.now();
}

function memorySource(doc: string | null): DocumentSource {
  if (doc === "reference") return memoryDocumentSource(REFERENCE_DOCUMENT, { fileName: "burakkoc", location: "Drafts", versions: true });
  if (doc === "empty") return memoryDocumentSource(EMPTY_DOCUMENT, { fileName: "Untitled", location: "Drafts" });
  if (doc === "types") return memoryDocumentSource(TYPES_DOCUMENT, { fileName: "Layer types", location: "Drafts" });
  if (doc === "capture") return memoryDocumentSource(CAPTURE_DOCUMENT, { fileName: "Untitled", location: "Drafts", uiState: CAPTURE_UI_STATE });
  if (doc === "paints") return memoryDocumentSource(PAINTS_DOCUMENT, { fileName: "Paints and effects", location: "Drafts" });
  if (doc === "components") return memoryDocumentSource(COMPONENTS_DOCUMENT, { fileName: "Components", location: "Drafts" });
  if (doc === "variables") return memoryDocumentSource(VARIABLES_DOCUMENT, { fileName: "Variables and styles", location: "Drafts" });
  if (doc === "prototype") return memoryDocumentSource(PROTOTYPE_DOCUMENT, { fileName: "Prototype", location: "Drafts", versions: true });
  if (doc === "text") return memoryDocumentSource(TEXT_DOCUMENT, { fileName: "Text", location: "Drafts" });
  return memoryDocumentSource(SAMPLE_DOCUMENT, { fileName: "Sample file", location: "Drafts" });
}

type StoreSource = Awaited<ReturnType<typeof openDocument>>;

/** The store's blobs as the editor's image store (docs/data.md §10: content-addressed by SHA-1). */
function storeImages(): ImageStore {
  const blobs = getStoreClient().blobs;
  return {
    put: async (bytes, mime) => (await blobs.put(bytes, { mime })).sha1,
    get: async (hash) => {
      try {
        return await blobs.get(hash);
      } catch {
        return null;
      }
    },
    // A shared file's images arriving after it opened (docs/cloud.md §4.1) are drawn in place of their placeholder
    ...(blobs.watch ? { watch: (listener: (hashes: string[]) => void) => blobs.watch!((e) => listener(e.arrived)) } : {}),
  };
}

/**
 * One open per file per page, shared by every mount (React's StrictMode mounts twice; the store refuses a
 * second open of the same file), closed — flushed, the session ended — a moment after the last mount goes.
 */
const opened = new Map<string, { promise: Promise<StoreSource>; refs: number; timer: number }>();

function acquire(fileKey: string, tabId: string | undefined): Promise<StoreSource> {
  let entry = opened.get(fileKey);
  if (!entry) {
    entry = { promise: openDocument(fileKey, { tabId }), refs: 0, timer: 0 };
    opened.set(fileKey, entry);
  }
  window.clearTimeout(entry.timer);
  entry.refs++;
  return entry.promise;
}

function release(fileKey: string): void {
  const entry = opened.get(fileKey);
  if (!entry || --entry.refs > 0) return;
  entry.timer = window.setTimeout(() => {
    opened.delete(fileKey);
    void entry.promise.then((s) => s.close()).catch(() => {});
  }, 100);
}

/** The store's source for `fileKey`, or the reason it couldn't open. */
function useStoreSource(fileKey: string | null, tabId: string | undefined): { source: DocumentSource | null; error: string | null } {
  const [state, setState] = useState<{ source: DocumentSource | null; error: string | null }>({ source: null, error: null });
  useEffect(() => {
    if (!fileKey) return;
    let live = true;
    setOpenProgress(0.05, 0.3);
    // A shared copy opened early (Home's open of an org or shared file): its document coming down fills the bar
    let stopWatching = () => {};
    try {
      stopWatching = getStoreClient().multiplayer.watch((e) => {
        if (e.fileKey !== fileKey || !e.opening) return;
        if (e.opening.reading || e.opening.done) setOpenProgress(0.72, 0.78);
        else if (e.opening.received !== undefined) downloadProgress(e.opening.received, e.opening.total ?? null);
      });
    } catch {
      // no store (a sample document)
    }
    acquire(fileKey, tabId)
      .then((source) => {
        stopWatching();
        if (!live) return;
        mark("sourceOpened");
        setOpenProgress(0.8, 0.86);
        if (source.recovery) showToast({ message: "This file was recovered after an unexpected quit" });
        setState({ source: withImages(source, storeImages), error: null });
      })
      .catch((e: unknown) => {
        stopWatching();
        if (live) setState({ source: null, error: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      live = false;
      stopWatching();
      release(fileKey);
    };
  }, [fileKey, tabId]);
  return state;
}

/**
 * Whether only a prototype grant reaches this file (docs/editor.md D-6: `FileAccess.prototypeOnly`): null until known.
 * Local files, owners and editors are known at once from the link's state; a viewer's shared file asks the server once
 * (offline or refused: the editor opens as before, read-only by its role).
 */
export function usePrototypeOnly(fileKey: string | null): boolean | null {
  const [state, setState] = useState<{ key: string | null; only: boolean | null }>({ key: null, only: null });
  useEffect(() => {
    if (!fileKey) return;
    let live = true;
    const store = getStoreClient();
    void (async () => {
      const st = await store.multiplayer.fileState(fileKey).catch(() => null);
      if (!st?.shared || st.role !== "viewer") return false;
      const info = await store.multiplayer.fileInfo(fileKey).catch(() => null);
      return info?.access?.prototypeOnly === true;
    })().then((only) => live && setState({ key: fileKey, only }));
    return () => {
      live = false;
    };
  }, [fileKey]);
  if (!fileKey) return false;
  return state.key === fileKey ? state.only : null;
}

/** A prototype-only file: the presentation view alone (no Close into the design), with Share prototype */
function PrototypeOnly({ fileKey }: { fileKey: string }) {
  const source = useMemo(() => storePresentationSource(fileKey), [fileKey]);
  const [sharing, setSharing] = useState<{ node: string | null } | null>(null);
  useEffect(() => mark("ready"), []);
  return (
    <>
      <PresentationView source={source} onShare={(screen) => setSharing({ node: screen })} />
      {sharing && <SharePrototypeDialog fileKey={fileKey} nodeId={sharing.node} onClose={() => setSharing(null)} />}
    </>
  );
}

// ── The spare editor ──────────────────────────────────────────────────────────

interface Adoption {
  fileKey: string;
  tabId: string;
}

/**
 * The spare's adoption, once per page (the preload hands an attach over once, and React's StrictMode runs effects
 * twice): main's `tab:attach`, or an `init()` that already names the tab (a page that came up after the adoption).
 */
let adoption: Promise<Adoption> | null = null;

function awaitAdoption(d: EditorApi): Promise<Adoption> {
  adoption ??= new Promise<Adoption>((resolve) => {
    d.tab.onAttach((a) => resolve({ fileKey: a.fileKey, tabId: a.tabId }));
    void d
      .init()
      .then((info) => {
        if (info.fileKey && info.tabId) resolve({ fileKey: info.fileKey, tabId: info.tabId });
      })
      .catch(() => {});
  });
  return adoption;
}

/**
 * What a spare does before it has a file: the engine's Wasm compiled and instantiated (`Engine.create` itself
 * waits for the file — it takes the session id and the canvas), the store port taken (the handshake with the
 * preload done), the font index read. Each is cached by its module, so the file's open finds them ready.
 */
function prewarm(): void {
  void loadEngine().catch((e: unknown) => console.warn("[spare] the engine could not be loaded ahead:", e));
  try {
    getStoreClient();
  } catch (e) {
    console.warn("[spare] no store client ahead:", e);
  }
  void fonts.list().catch(() => {});
}

/** The spare's file, once main adopts it (null until then); pre-warms meanwhile. */
function useAdoption(spare: boolean): Adoption | null {
  const [adopted, setAdopted] = useState<Adoption | null>(null);
  useEffect(() => {
    if (!spare) return;
    const d = editorBridge();
    if (!d) return;
    prewarm();
    let live = true;
    void awaitAdoption(d).then((a) => {
      if (!live) return;
      mark("attached");
      setAdopted(a);
    });
    return () => {
      live = false;
    };
  }, [spare]);
  return adopted;
}

export default function EditorRoute() {
  const params = useMemo(() => new URLSearchParams(location.search), []);
  const doc = params.get("doc");
  const urlFile = params.get("file");
  // No file and no sample asked for, in the desktop's editor view: the spare, waiting to be adopted.
  const spare = useMemo(() => !urlFile && !doc && editorBridge() !== null, [urlFile, doc]);
  const adopted = useAdoption(spare);
  const fileKey = urlFile ?? adopted?.fileKey ?? null;
  const tabId = urlFile ? (params.get("tab") ?? undefined) : adopted?.tabId;
  // A view made for its file: the file is known from the start.
  useEffect(() => {
    if (urlFile) mark("attached");
  }, [urlFile]);
  // Prototype-only access (docs/editor.md D-6): such a file opens straight into the presentation view, never the editor
  const prototypeOnly = usePrototypeOnly(fileKey);
  const stored = useStoreSource(prototypeOnly === false ? fileKey : null, tabId);
  const memory = useMemo(() => (fileKey || spare ? null : memorySource(doc)), [fileKey, spare, doc]);
  const source = memory ?? stored.source;
  const onReady = useCallback(
    (ed: EditorController) => {
      window.__designerEditor = ed;
      mark("ready");
      // The engine asked for its first frame before the editor was up (load, zoom to fit); it is drawn in the next
      // animation frame and on screen by the one after.
      requestAnimationFrame(() => requestAnimationFrame(() => mark("firstFrame")));
      if (params.get("rulers") === "1") ed.ui.set({ rulers: true });
    },
    [params]
  );
  if (fileKey && prototypeOnly) return <PrototypeOnly fileKey={fileKey} />;
  if (!source) {
    if (stored.error) return <div className={styles.status}><span className={styles.error}>The file could not be opened: {stored.error}</span></div>;
    // Figma's loader, alone on the page until the document is here (the panels' placeholders come with the editor)
    return fileKey ? <OpenLoader /> : null;
  }
  // The reference screenshots show the page at 100% with "Frame 1" near the canvas's top left.
  return <EditorApp source={source} onReady={onReady} initialView={doc === "reference" && !fileKey ? { zoom: 1, at: { x: 120, y: 95 } } : "fit"} />;
}
