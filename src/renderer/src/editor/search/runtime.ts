/**
 * Visual search in an editor view (docs/ai.md §6): the shared embedder (made once the models are on this computer),
 * the indexer of the open file, images in and out (PNG thumbnails, uploaded / pasted pictures), and a result's
 * actions — "Open the file", "Insert".
 */
import type { Guid } from "@/engine/codec";
import { Status } from "@/engine/abi";
import { Engine } from "@/engine/Engine";
import { messageToEngine } from "@/store/engineMessage";
import { getStoreClient } from "@/store";
import type { SearchHit, SearchRepository } from "../../../../shared/ai/types";
import { decodeMessage } from "../../../../shared/schema/codec";
import { localSnapshot } from "../../files/storeAccess";
import { editorUrl } from "../../files/desktop";
import type { EditorController } from "../controller";
import { engineCall } from "../engineCompat";
import { insertInstance } from "../components";
import { insertLibraryComponent } from "../libraries";
import { WorkerEmbedder, type Embedder, type RgbaImage } from "./embedder";
import { SearchIndexer } from "./indexer";
import { indexingOn, modelsApi, searchModels } from "./models";
import { editorSearchSource } from "./source";

// ---- the embedder ----

let shared: Embedder | null = null;
/** Tests put a fake here */
let override: (() => Promise<Embedder | null>) | null = null;

export function setEmbedderForTests(get: (() => Promise<Embedder | null>) | null): void {
  override = get;
}

/** The models' embedder when both are on this computer, else null */
export async function readyEmbedder(): Promise<Embedder | null> {
  if (override) return override();
  if ((await searchModels(modelsApi())).state !== "ready") return null;
  return (shared ??= new WorkerEmbedder());
}

export const searchRepo = (): SearchRepository => getStoreClient().search;

/** The open file's key (the store's files; null for a memory document) */
export const fileKeyOf = (ed: EditorController): string | null => (ed.source as { fileKey?: string }).fileKey ?? null;

// ---- images ----

function canvasOf(w: number, h: number): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

export async function encodePng(image: RgbaImage): Promise<Uint8Array> {
  const c = canvasOf(image.width, image.height);
  const ctx = c.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) throw new Error("No 2D canvas");
  ctx.putImageData(new ImageData(new Uint8ClampedArray(image.pixels), image.width, image.height), 0, 0);
  const blob = c instanceof HTMLCanvasElement ? await new Promise<Blob | null>((r) => c.toBlob(r, "image/png")) : await c.convertToBlob({ type: "image/png" });
  if (!blob) throw new Error("The thumbnail couldn't be encoded");
  return new Uint8Array(await blob.arrayBuffer());
}

/** A picture (an upload, a paste) as RGBA fitted into `max` px */
export async function decodeImage(blob: Blob, max = 448): Promise<RgbaImage> {
  const bitmap = await createImageBitmap(blob);
  const k = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * k));
  const h = Math.max(1, Math.round(bitmap.height * k));
  const c = canvasOf(w, h);
  const ctx = c.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) throw new Error("No 2D canvas");
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  return { width: w, height: h, pixels: new Uint8Array(ctx.getImageData(0, 0, w, h).data.buffer) };
}

/** A thumbnail's PNG as an object URL (the caller revokes it) */
export const pngUrl = (png: Uint8Array): string => URL.createObjectURL(new Blob([png as BlobPart], { type: "image/png" }));

// ---- the indexer ----

/** Starts indexing the open file (a store file only); returns the stop. */
export function attachSearchIndexer(ed: EditorController): () => void {
  const fileKey = fileKeyOf(ed);
  if (!fileKey || ed.engine.destroyed) return () => undefined;
  const indexer = new SearchIndexer({
    source: editorSearchSource(ed, fileKey),
    repo: searchRepo(),
    embedder: readyEmbedder,
    enabled: () => indexingOn(),
    encodePng,
    now: () => Date.now(),
    idle: (fn) => (typeof requestIdleCallback === "function" ? requestIdleCallback(() => fn(), { timeout: 5000 }) : setTimeout(fn, 0)),
    log: (message, detail) => console.warn(message, detail),
  });
  current = indexer;
  const off = ed.engine.on("NODES_CHANGED", (e) => indexer.touch(e.refs));
  indexer.start();
  return () => {
    off();
    indexer.stop();
    if (current === indexer) current = null;
  };
}

let current: SearchIndexer | null = null;
/** The open file's indexer: an index pass now (after the models arrive) */
export const indexNow = (): void => void current?.runNow().catch(() => undefined);

// ---- a result's actions ----

/** "Open the file": its tab in the app (at the node), a browser tab else */
export async function openHitFile(hit: SearchHit): Promise<void> {
  const nav = (window as unknown as { designer?: { nav?: { openFile?: (f: { fileKey: string; title?: string; pageId?: string; nodeId?: string }) => Promise<unknown> } } }).designer?.nav;
  if (nav?.openFile) {
    await nav.openFile({ fileKey: hit.doc.fileKey, title: hit.doc.fileName, pageId: hit.doc.pageId, nodeId: hit.doc.nodeId });
    return;
  }
  window.open(editorUrl(hit.doc.fileKey, { nodeId: hit.doc.nodeId }), "_blank", "noopener");
}

/**
 * "Insert": a component as an instance (this file's, or an enabled library's), anything else as a copy through the
 * clipboard's path — the node encoded with what it references (from this file, or from the other file's document in a
 * headless engine) and pasted in the middle of the view. One undo step (the paste's / the insert's). Null: it couldn't.
 */
export async function insertHit(ed: EditorController, hit: SearchHit): Promise<Guid | null> {
  const { doc } = hit;
  const here = fileKeyOf(ed) === doc.fileKey;
  if (doc.kind !== "frame") {
    if (here) {
      const target = doc.kind === "componentSet" ? (ed.components.assets().find((a) => a.id === doc.nodeId)?.target ?? null) : doc.nodeId;
      return target ? insertInstance(ed, target) : null;
    }
    const lib = ed.libraries.get();
    const manifest = lib.manifests.get(doc.fileKey);
    const asset = manifest?.assets.find((a) => a.guid === doc.nodeId && !a.dependencyOnly);
    if (asset && lib.enabled.includes(doc.fileKey)) return insertLibraryComponent(ed, doc.fileKey, asset);
  }
  const bytes = here ? encodeHere(ed, doc.nodeId) : await encodeFromFile(doc.fileKey, doc.pageId, doc.nodeId);
  if (!bytes || ed.engine.destroyed) return null;
  const pasteKiwi = engineCall<(b: Uint8Array, o: object) => number>(ed.engine, "pasteKiwi", "set_wire_format");
  if (pasteKiwi) pasteKiwi(bytes, {});
  else ed.engine.paste(messageToEngine(decodeMessage(bytes)), {});
  ed.focusCanvas();
  return ed.selection[0] ?? null;
}

/** This file's node as clipboard bytes (the selection put back as it was) */
function encodeHere(ed: EditorController, nodeId: Guid): Uint8Array | null {
  const before = [...ed.selection];
  ed.engine.setSelection([nodeId]);
  try {
    return ed.engine.encodeSelectionKiwi() ?? null;
  } finally {
    ed.engine.setSelection(before);
  }
}

/** Another file's node as clipboard bytes, from its stored document in a headless engine */
async function encodeFromFile(fileKey: string, pageId: Guid, nodeId: Guid): Promise<Uint8Array | null> {
  const { snapshot } = await localSnapshot(getStoreClient().files, fileKey as never);
  const engine = await Engine.create(null, { sessionID: 1, wire: "kiwi" });
  try {
    if (engine.loadKiwi(snapshot, { page: pageId }) !== Status.OK) return null;
    engine.setFileKey(fileKey);
    engine.setCurrentPage(pageId);
    engine.setSelection([nodeId]);
    return engine.encodeSelectionKiwi() ?? null;
  } finally {
    engine.destroy();
  }
}
