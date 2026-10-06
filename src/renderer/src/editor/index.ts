/**
 * The editor's public entry (what the desktop integration and the store's
 * DocumentSource use): `<EditorApp source={…} onBackToFiles={…} />` and the
 * DocumentSource contract (docs/editor.md).
 */
export { EditorApp, type EditorAppProps } from "./EditorApp";
export { memoryDocumentSource, applyMessage, orderParentsFirst, type DocumentSource, type MemoryDocumentSource } from "./documentSource";
export type { EditorController } from "./controller";
