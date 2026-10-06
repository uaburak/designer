/**
 * The store in a plain browser (`npm run web:demo`, `?files`, `?editor`): a real `StoreClient` talking over a
 * MessageChannel to the same `StoreServer` the utility process runs, backed by the in-memory store
 * (memory/memoryStore.ts) and kept in localStorage, one record per key, so Home in one browser tab and an editor in
 * another share the workspace. An empty storage is seeded with the demo workspace (memory/seed.ts).
 *
 * Pages normally don't call this directly: `getStoreClient()` (index.ts) picks the desktop client when the preload
 * is there and this one otherwise. `resetDevStore()` + a reload starts over from the seed.
 */
import { StoreClient } from "../../../shared/store/client";
import { portTransport, type PortRole } from "../../../shared/store/protocol";
import type { FileKey } from "../../../shared/store/types";
import { StoreServer } from "../../../store/server";
import { browserStorage, KV_PREFIX, memoryStorage, type KeyValueStorage } from "./memory/kv";
import { MemoryStore } from "./memory/memoryStore";
import { seedDemoWorkspace } from "./memory/seed";

export interface DevStoreOptions {
  /** "browser" (localStorage, the default when there is one), "memory" (nothing kept), or your own */
  storage?: "browser" | "memory" | KeyValueStorage;
  /** Seed an empty workspace with the demo files (default true) */
  seed?: boolean;
  /** The role the page's port gets (only main-only methods differ) */
  role?: Exclude<PortRole, "main">;
  teamName?: string;
  clock?: { now(): number };
  /** A zstd decoder for `.fig` imports (see MemoryStoreOptions.zstdDecompress) */
  zstdDecompress?: (data: Uint8Array) => Uint8Array | Promise<Uint8Array>;
}

export interface DevStore {
  /** The page's client: the same class and protocol as in the desktop app */
  readonly client: StoreClient;
  /** The store behind it, once open */
  readonly ready: Promise<MemoryStore>;
  /** An object URL for a file's thumbnail (null while loading or when it has none) */
  thumbnailUrl(fileKey: FileKey): string | null;
  /** An object URL for an image blob ("" when unknown) */
  blobUrl(sha1: string): string;
  close(): void;
}

function objectUrl(bytes: Uint8Array, mime: string): string {
  if (typeof URL !== "undefined" && typeof URL.createObjectURL === "function" && typeof Blob !== "undefined") {
    return URL.createObjectURL(new Blob([bytes.slice().buffer as ArrayBuffer], { type: mime }));
  }
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return `data:${mime};base64,${btoa(s)}`;
}

const revoke = (url: string) => {
  if (url.startsWith("blob:")) URL.revokeObjectURL(url);
};

export function createDevStore(opts: DevStoreOptions = {}): DevStore {
  let store: MemoryStore | null = null;
  let server: StoreServer | null = null;
  const thumbs = new Map<FileKey, { version: number; url: string }>();
  const blobs = new Map<string, string>();
  const blobUrl = (sha1: string): string => {
    let url = blobs.get(sha1);
    if (url) return url;
    const b = store?.blob(sha1);
    if (!b) return "";
    blobs.set(sha1, (url = objectUrl(b.bytes, b.mime)));
    return url;
  };
  const client = new StoreClient({ blobUrl, onError: (e) => console.warn("[dev store]", e) });
  const kv = opts.storage === "memory" ? memoryStorage() : opts.storage && opts.storage !== "browser" ? opts.storage : (browserStorage() ?? memoryStorage());
  const ready = MemoryStore.open({ storage: kv, teamName: opts.teamName ?? "My team", clock: opts.clock, zstdDecompress: opts.zstdDecompress, seed: opts.seed === false ? undefined : seedDemoWorkspace }).then((s) => {
    store = s;
    s.thumbnails.on((key) => {
      const t = thumbs.get(key);
      if (t) revoke(t.url);
      thumbs.delete(key);
    });
    server = new StoreServer(s, { generation: 1 });
    const { port1, port2 } = new MessageChannel();
    server.connect(portTransport(port1), opts.role ?? "home");
    client.attach(portTransport(port2));
    return s;
  });
  ready.catch((e) => console.error("[dev store] couldn't open", e));
  return {
    client,
    ready,
    thumbnailUrl(fileKey) {
      if (!store) return null;
      const version = store.ws.files.get(fileKey)?.thumbnail?.version;
      if (!version) return null;
      const cached = thumbs.get(fileKey);
      if (cached?.version === version) return cached.url;
      const t = store.thumbnail(fileKey);
      if (!t) return null;
      if (cached) revoke(cached.url);
      const url = objectUrl(t.bytes, t.mime);
      thumbs.set(fileKey, { version, url });
      return url;
    },
    blobUrl,
    close() {
      client.close();
      server?.close();
      store?.dispose();
      for (const t of thumbs.values()) revoke(t.url);
      for (const u of blobs.values()) revoke(u);
    },
  };
}

/** Forgets everything the dev store kept in this browser (the next page load seeds the demo again). */
export function resetDevStore(storage: KeyValueStorage | null = browserStorage()): void {
  if (!storage) return;
  for (const k of storage.keys(KV_PREFIX)) storage.remove(k);
}
