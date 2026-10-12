/**
 * Personal Drafts in the cloud (docs/cloud.md §2, Wecra 1.1): the server's half (`GET /me/drafts`) and the store's
 * repository for the cache that the local workspace became. Every file of the person's Drafts is a server file; this
 * computer keeps a bounded cache of them (LRU by last opened) so files opened before stay openable offline.
 */
import type { Unsubscribe } from "./repositories";

/** A file in the person's Drafts as `GET /me/drafts` lists it (server/src/personal/routes.ts) */
export interface PersonalFile {
  /** The file's room key */
  key: string;
  name: string;
  editorType: "design" | "figjam" | "slides" | "buzz" | "sites" | "make";
  createdAt: number;
  updatedAt: number;
  trashedAt: number | null;
}

/**
 * `FileMeta.cloud`: the local record caches a draft of this account's personal Drafts on the server. Absent or null: a
 * local file (signed out, the browser's dev store) or an org file's copy (`FileMeta.space`).
 */
export interface CloudFile {
  /** The account (server user id) whose Drafts hold it: listings show only the signed-in account's */
  uid: string;
  /** Its room key — reserved before it is registered (`pendingCreate`), so a registration tried again is the same draft;
   *  null only when a new one is to be reserved */
  key: string | null;
  /** Created offline, or a local file not uploaded yet (the 1.1 migration): registered with `POST /me/drafts` when online */
  pendingCreate?: true;
  /** Listed by the server but its document isn't on this computer (never opened here, or evicted from the cache):
   *  opening it downloads it; offline it can't open */
  remote?: true;
}

/** Bytes the cache may hold by default (docs/cloud.md §2: 5 GB) */
export const DEFAULT_CACHE_LIMIT_BYTES = 5 * 1024 ** 3;
/** The sizes Settings › Account offers */
export const CACHE_LIMIT_CHOICES: readonly number[] = [1, 2, 5, 10, 20, 50].map((g) => g * 1024 ** 3);

export interface CacheInfo {
  /** Bytes the cached documents (their journals, snapshots and versions) take */
  usedBytes: number;
  limitBytes: number;
  /** Cached files (with their document here) and of those, files that can't be evicted now (open, unsent edits, waiting to upload) */
  files: number;
  pinned: number;
}

export interface CloudStatus {
  /** The signed-in account whose Drafts Home shows; null signed out (the local workspace as before 1.1) */
  uid: string | null;
  /** Reached the server on the last try */
  online: boolean;
  /** The server was tried since the sign-in (until then `online` says nothing: Home shows no offline state) */
  checked: boolean;
  /** When the Drafts were last listed from the server */
  syncedAt: number | null;
  /** The 1.1 migration of local files into the account's Drafts (null: nothing to migrate) */
  migration: { total: number; done: number; failed: number } | null;
}

export type CloudEvent = { type: "status"; status: CloudStatus } | { type: "cache"; cache: CacheInfo };

/** `StoreApi.cloud`: the cache and its sync (Home's offline badges, Settings › Account › Offline cache). */
export interface CloudRepository {
  status(): Promise<CloudStatus>;
  /** Lists the Drafts and the trash from the server now (Home calls it when shown; the store also does on its own) */
  refresh(): Promise<CloudStatus>;
  cacheInfo(): Promise<CacheInfo>;
  /** The cache's bound (≥ 256 MB); files over it are evicted, least recently opened first */
  setCacheLimit(bytes: number): Promise<CacheInfo>;
  /** Evicts every cached file that can go (not open, nothing unsent): they stay listed and download when opened */
  clearCache(): Promise<CacheInfo>;
  watch(listener: (e: CloudEvent) => void): Unsubscribe;
}
