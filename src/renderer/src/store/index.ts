/**
 * The store, as Home and the editor see it — one import for both:
 *
 *   import { getStoreClient, openDocument, thumbnailUrl } from "@/store";
 *   const store = getStoreClient();                        // desktop: the port main brokers; browser: the dev store
 *   const files = await store.workspace.listFiles({ in: "recents" });
 *   const off = store.workspace.watch((e) => …);           // refresh on file.created / renamed / trashed …
 *   <img src={thumbnailUrl(file) ?? undefined} />          // app://designer/_thumb/… or an object URL
 *   const source = await openDocument(fileKey, { tabId }); // the editor's DocumentSource on the store
 *
 * Which store: the desktop client when the page runs under the app's preload (`window.designer`), else the browser's
 * dev store (localStorage, seeded with demo files). `?store=dev` / `?store=desktop` force one.
 */
import type { FileKey, FileMeta } from "../../../shared/store/types";
import { storeClient, type StoreClient } from "./client";
import { createDevStore, type DevStore } from "./devStore";
import { openStoreDocument, type StoreDocumentSource, type StoreDocumentSourceOptions } from "./documentSource";

export { connectStore, storeClient, StoreClient, STORE_PORT_MESSAGE, STORE_PORT_WANTED, type StoreClientOptions } from "./client";
export { createDevStore, resetDevStore, type DevStore, type DevStoreOptions } from "./devStore";
export { mergedDocument, openStoreDocument, RESTORE_LABEL, type ChangeInfo, type DocumentMeta, type EngineChangeKind, type StoreDocumentSource, type StoreDocumentSourceOptions } from "./documentSource";
export { messageToEngine, messageToKiwi } from "./engineMessage";
export { isStoreError, StoreError, type StoreErrorCode } from "../../../shared/store/protocol";
export { FOLDER_COLORS, MAX_FOLDER_DEPTH, MAX_RECENTS } from "../../../shared/store/types";
export type * from "../../../shared/store/types";
export type * from "../../../shared/store/repositories";

export type StoreMode = "desktop" | "dev";

/** "desktop" under the app's preload, "dev" in a plain browser; `?store=dev|desktop` overrides. */
export function storeMode(): StoreMode {
  const forced = typeof location !== "undefined" ? new URLSearchParams(location.search).get("store") : null;
  if (forced === "dev" || forced === "desktop") return forced;
  return typeof window !== "undefined" && (window as { designer?: unknown }).designer ? "desktop" : "dev";
}

let dev: DevStore | null = null;
let client: StoreClient | null = null;

/** The page's one store client (the same object on every call). */
export function getStoreClient(): StoreClient {
  if (client) return client;
  if (storeMode() === "desktop") client = storeClient();
  else {
    dev = createDevStore({ role: typeof location !== "undefined" && new URLSearchParams(location.search).has("editor") ? "editor" : "home" });
    client = dev.client;
  }
  return client;
}

/** The dev store behind `getStoreClient()`, or null on the desktop. */
export function getDevStore(): DevStore | null {
  getStoreClient();
  return dev;
}

/**
 * Where a file card's thumbnail is: `app://designer/_thumb/<key>.png?v=<version>` on the desktop (main serves it
 * read-only), an object URL in the browser; null when the file has none yet (Home draws the empty card).
 */
export function thumbnailUrl(file: Pick<FileMeta, "fileKey" | "thumbnail">): string | null {
  if (!file.thumbnail) return null;
  getStoreClient();
  if (dev) return dev.thumbnailUrl(file.fileKey);
  return `app://designer/_thumb/${file.fileKey}.png?v=${file.thumbnail.version}`;
}

/** Opens a file for editing on the page's store (the editor's DocumentSource). */
export function openDocument(fileKey: FileKey, opts?: StoreDocumentSourceOptions): Promise<StoreDocumentSource> {
  return openStoreDocument(getStoreClient(), fileKey, opts);
}
