/**
 * The load worker: the opened file's snapshot and journal → what the engine loads, off the main thread. Two messages
 * back: the document's facts as soon as it is decoded (its fonts by page, the node types the engine may not know,
 * whether it carries derived data — the editor requests the shown page's fonts ahead of `engine_load`), then the
 * bytes (transferred, not copied) — or none, when a kiwi-reading engine takes the store's snapshot and frames as
 * they are and the worker's decode served the facts alone.
 */
/// <reference lib="webworker" />
import { prepareEngineDocument, type DocumentFacts, type EngineWireFormat, type OpenedDocument, type PreparedDocument } from "./loadDocument";

export type LoadWorkerRequest = { id: number; opened: OpenedDocument; format?: EngineWireFormat };
export type LoadWorkerReply = ({ id: number; type: "facts" } & DocumentFacts) | { id: number; type: "done"; document: PreparedDocument } | { id: number; type: "error"; error: string };

const scope = self as unknown as { onmessage: ((e: MessageEvent<LoadWorkerRequest>) => void) | null; postMessage(message: LoadWorkerReply, transfer?: Transferable[]): void };

scope.onmessage = (e) => {
  const { id, opened, format } = e.data;
  try {
    const document = prepareEngineDocument(opened, (facts) => scope.postMessage({ id, type: "facts", ...facts }), format ?? "json");
    scope.postMessage({ id, type: "done", document }, document.bytes ? [document.bytes.buffer] : []);
  } catch (err) {
    scope.postMessage({ id, type: "error", error: err instanceof Error ? err.message : String(err) });
  }
};
