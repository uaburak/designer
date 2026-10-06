/**
 * `?editor`: the editor view.
 * - `&file=<fileKey>[&tab=<id>]` (the desktop's editor tabs; a browser opens the dev store's files):
 *   the file on the store, through the data workstream's DocumentSource (`@/store`).
 * - otherwise a document held in memory: the engine's sample, `&doc=reference` (the owner's file as
 *   in the reference screenshots) or `&doc=empty` (a new file).
 * `&rulers=0` starts with the rulers off. The editor is on `window.__designerEditor` for scripts
 * (tools/editor-shot.mjs) and the console.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { showToast } from "@/ds";
import { SAMPLE_DOCUMENT } from "@/engine/sampleDocument";
import { openDocument } from "@/store";
import { memoryDocumentSource, type DocumentSource } from "./documentSource";
import { EditorApp } from "./EditorApp";
import type { EditorController } from "./controller";
import { EMPTY_DOCUMENT, REFERENCE_DOCUMENT } from "./fixtures";
import styles from "./EditorApp.module.css";

declare global {
  interface Window {
    __designerEditor?: EditorController;
  }
}

function memorySource(doc: string | null): DocumentSource {
  if (doc === "reference") return memoryDocumentSource(REFERENCE_DOCUMENT, { fileName: "burakkoc", location: "Drafts" });
  if (doc === "empty") return memoryDocumentSource(EMPTY_DOCUMENT, { fileName: "Untitled", location: "Drafts" });
  return memoryDocumentSource(SAMPLE_DOCUMENT, { fileName: "Sample file", location: "Drafts" });
}

type StoreSource = Awaited<ReturnType<typeof openDocument>>;

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
    acquire(fileKey, tabId)
      .then((source) => {
        if (!live) return;
        if (source.recovery) showToast({ message: "This file was recovered after an unexpected quit" });
        setState({ source, error: null });
      })
      .catch((e: unknown) => {
        if (live) setState({ source: null, error: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      live = false;
      release(fileKey);
    };
  }, [fileKey, tabId]);
  return state;
}

export default function EditorRoute() {
  const params = useMemo(() => new URLSearchParams(location.search), []);
  const doc = params.get("doc");
  const fileKey = params.get("file");
  const stored = useStoreSource(fileKey, params.get("tab") ?? undefined);
  const memory = useMemo(() => (fileKey ? null : memorySource(doc)), [fileKey, doc]);
  const source = memory ?? stored.source;
  const onReady = useCallback(
    (ed: EditorController) => {
      window.__designerEditor = ed;
      if (params.get("rulers") === "0") ed.ui.set({ rulers: false });
    },
    [params]
  );
  if (!source) {
    return <div className={styles.status}>{stored.error ? <span className={styles.error}>The file could not be opened: {stored.error}</span> : null}</div>;
  }
  // The reference screenshots show the page at 100% with "Frame 1" near the canvas's top left.
  return <EditorApp source={source} onReady={onReady} initialView={doc === "reference" && !fileKey ? { zoom: 1, at: { x: 120, y: 95 } } : "fit"} />;
}
