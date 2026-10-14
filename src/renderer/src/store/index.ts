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
import { completeWebSignIn, connectWebSession, currentWebSession, onWebSessionDropped } from "./webAccount";
import { downloadBytes, figFileName, isWebApp, WEB_CACHE_LIMIT_BYTES, webCacheName } from "../app/webApp";
import { deleteIdbStorage, openIdbStorage, type IdbStorage } from "./memory/idbStorage";
import { memoryStorage, type KeyValueStorage } from "./memory/kv";
import type { FileKey, FileMeta } from "../../../shared/store/types";
import { storeClient, type StoreClient } from "./client";
import { createDevStore, type DevStore } from "./devStore";
import { openStoreDocument, type StoreDocumentSource, type StoreDocumentSourceOptions } from "./documentSource";
import { t } from "@/i18n";

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
    const params = typeof location !== "undefined" ? new URLSearchParams(location.search) : new URLSearchParams();
    // The web app (docs/cloud.md §7): the signed-in account's Drafts from the server, cached in its own IndexedDB
    // database (1 GB by default); no demo files. Elsewhere the dev store's demo workspace in localStorage.
    const uid = isWebApp() ? currentWebSession()?.userId : undefined;
    currentCacheOwner = uid ?? null;
    dev = createDevStore({
      role: params.has("editor") ? "editor" : "home",
      // Newer Figma files compress their data with zstd, which browsers can't inflate: fzstd (pure JS), loaded on the first such import
      zstdDecompress: async (data) => (await import("fzstd")).decompress(data),
      ...(isWebApp()
        ? {
            seed: false,
            personalDrafts: true,
            cacheLimitBytes: WEB_CACHE_LIMIT_BYTES,
            openStorage: () =>
              uid
                ? openIdbStorage({ name: webCacheName(uid) }).then(
                    (s) => {
                      // Another tab logged this account out (its cache deleted) or a newer version took it: start over
                      s.onClosedElsewhere = () => location.reload();
                      return s as KeyValueStorage;
                    },
                    (e: unknown) => {
                      console.warn("[cache] IndexedDB is unavailable; nothing is kept between page loads", e);
                      return memoryStorage();
                    },
                  )
                : Promise.resolve(memoryStorage()),
          }
        : {}),
    });
    client = dev.client;
    // The browser's account (docs/multiplayer.md §2): finish a sign-in coming back from Google, then hand the session to
    // the store — this tab joins the room of the file it edits.
    const done = completeWebSignIn();
    void dev.ready.then(async (s) => {
      await done;
      connectWebSession(s, params.has("editor") ? params.get("file") : null);
    });
  }
  return client;
}

/**
 * The web app's sign-out (docs/cloud.md §7): the account's cache is deleted — its records, documents and images — and
 * the page starts over on the welcome page. Other tabs of the account let go of the database and reload too.
 */
export async function clearWebCache(uid: string): Promise<void> {
  const mine = dev;
  if (mine && currentCacheOwner === uid) {
    const storage = (await mine.storage.catch(() => null)) as Partial<IdbStorage> | null;
    mine.close();
    if (storage?.destroy) await storage.destroy();
  }
  await deleteIdbStorage(webCacheName(uid));
}

let currentCacheOwner: string | null = null;

if (isWebApp() && typeof window !== "undefined")
  onWebSessionDropped((uid) => {
    void clearWebCache(uid).finally(() => {
      // A store closed under the page: Home (the welcome page now) starts afresh at the next sign-in
      if (currentCacheOwner === uid) location.replace(location.pathname);
    });
  });

/** Before the page leaves (Home → a file's page): every write of the browser's store is kept */
export async function flushWebStore(): Promise<void> {
  const s = dev ? ((await dev.storage.catch(() => null)) as Partial<IdbStorage> | null) : null;
  await s?.flush?.();
}

/** The web app's Save local copy…: the file as a `.fig` download (the desktop app's is main's Save dialog) */
export async function downloadFig(fileKey: FileKey): Promise<void> {
  const files = getStoreClient().files;
  if (!files.exportFigBytes) throw new Error(t("Saving a local copy isn't available here"));
  const [bytes, meta] = await Promise.all([files.exportFigBytes(fileKey), getStoreClient().workspace.getFile(fileKey)]);
  downloadBytes(bytes, figFileName(meta.name));
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
