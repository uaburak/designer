/**
 * The load worker: the opened file's snapshot and journal → the engine's wire bytes, off the main thread (the kiwi
 * decode, the node table, the conversion and the JSON encode were ~1.5 s of blocked main thread on a 32k-layer
 * file; here they overlap the Wasm compile and the chrome's modules). Two messages back: the fonts as soon as the
 * table is built (the editor requests them ahead of `engine_load`), then the bytes (transferred, not copied).
 */
/// <reference lib="webworker" />
import { prepareEngineDocument, type FontRef, type OpenedDocument, type PreparedDocument } from "./loadDocument";

export type LoadWorkerRequest = { id: number; opened: OpenedDocument };
export type LoadWorkerReply = { id: number; type: "fonts"; fonts: FontRef[]; needsFallbackFont: boolean } | { id: number; type: "done"; document: PreparedDocument } | { id: number; type: "error"; error: string };

const scope = self as unknown as { onmessage: ((e: MessageEvent<LoadWorkerRequest>) => void) | null; postMessage(message: LoadWorkerReply, transfer?: Transferable[]): void };

scope.onmessage = (e) => {
  const { id, opened } = e.data;
  try {
    const document = prepareEngineDocument(opened, (fonts, needsFallbackFont) => scope.postMessage({ id, type: "fonts", fonts, needsFallbackFont }));
    scope.postMessage({ id, type: "done", document }, [document.bytes.buffer]);
  } catch (err) {
    scope.postMessage({ id, type: "error", error: err instanceof Error ? err.message : String(err) });
  }
};
