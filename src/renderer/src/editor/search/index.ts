/**
 * Visual search (docs/ai.md §6). `openVisualSearch()` opens the view in this editor — Actions' "Visual search (AI
 * beta)" button (no options), "Find more like" (`{selection: true}`), an image handed in (`{image}`: PNG / JPEG
 * bytes, "Upload"). `VisualSearchHost` (in the editor's overlays) renders it and runs the open file's indexer.
 */
import { createElement, useEffect, useSyncExternalStore } from "react";
import { useEditor } from "../controller";
import { attachSearchIndexer } from "./runtime";
import { VisualSearch, type VisualSearchRequest } from "./VisualSearch";

let request: VisualSearchRequest | null = null;
let seq = 0;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

export function openVisualSearch(opts?: { selection?: boolean; image?: Uint8Array }): void {
  request = { ...(opts?.selection ? { selection: true } : {}), ...(opts?.image ? { image: opts.image } : {}), seq: ++seq };
  notify();
}

/** "Find more like": the selection's look */
export const findMoreLike = (): void => openVisualSearch({ selection: true });

export function closeVisualSearch(): void {
  request = null;
  notify();
}

export const visualSearchRequest = (): VisualSearchRequest | null => request;

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** The view while open, and the open file's indexer for as long as the editor is up */
export function VisualSearchHost() {
  const ed = useEditor();
  const open = useSyncExternalStore(subscribe, visualSearchRequest);
  useEffect(() => attachSearchIndexer(ed), [ed]);
  return open ? createElement(VisualSearch, { key: open.seq, ed, request: open, onClose: closeVisualSearch }) : null;
}
