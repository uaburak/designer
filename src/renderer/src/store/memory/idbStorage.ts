/**
 * The web app's cache on disk (docs/cloud.md §7): the browser store's records (kv.ts's keys) in IndexedDB instead of
 * localStorage — no 5 MB ceiling, so the person's Drafts, their documents and images survive a reload without being
 * downloaded again. One database per account (`wecra.cache.<uid>`), deleted when the account logs out.
 *
 * The store reads its records synchronously (`KeyValueStorage.get`), so the small ones are all read at open and kept in
 * memory; images (`blob.*`) and search indexes (`search.*`) are read on demand (`getAsync`) — only their keys and sizes
 * are kept. Writes land in memory at once and reach the database in batches (one transaction per tick); `flush()` waits
 * for them (before the page navigates). Another tab's writes arrive through a BroadcastChannel (`watch`), as
 * localStorage's `storage` event does for the dev store.
 *
 * `idb` is the IndexedDB factory (tests pass a fake); nothing else of the DOM is needed.
 */
import { KV_PREFIX, type KeyValueStorage } from "./kv";

/** Records read on demand, not at open: images and search indexes (the bulk of the bytes) */
export const LAZY_PREFIXES: readonly string[] = [`${KV_PREFIX}blob.`, `${KV_PREFIX}search.`];

const EAGER = "kv";
const LAZY = "lazy";
const SIZES = "sizes";
/** Lazy values kept in memory after a read or a write (most recently used first out) */
const LAZY_MEMORY_BYTES = 64 * 1024 * 1024;

export interface IdbStorage extends KeyValueStorage {
  /** A record's value, read from the database when it isn't in memory */
  getAsync(key: string): Promise<string | null>;
  /** Whether the record exists (known without reading a lazy value) */
  has(key: string): boolean;
  /** A record's size in bytes (its value's length), 0 when there is none */
  sizeOf(key: string): number;
  /** Resolves when every write so far is in the database */
  flush(): Promise<void>;
  /** Stops writing and closes the database (pending writes are flushed first) */
  close(): Promise<void>;
  /** Closes and deletes the database (an account logging out) */
  destroy(): Promise<void>;
  /** Another page deletes or upgrades the database: this one closes; the page should reload */
  onClosedElsewhere?: () => void;
}

export interface IdbStorageOptions {
  /** The database's name */
  name: string;
  /** Default: globalThis.indexedDB */
  idb?: IDBFactory;
  /** Default: a BroadcastChannel named after the database, when the page has them; null: none */
  channel?: (Pick<BroadcastChannel, "postMessage" | "close"> & { onmessage: ((e: MessageEvent) => void) | null }) | null;
  log?: (level: "warn" | "error", message: string, detail?: unknown) => void;
}

const req = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

const done = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("the transaction was aborted"));
  });

const isLazy = (key: string) => LAZY_PREFIXES.some((p) => key.startsWith(p));

function openDb(idb: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = idb.open(name, 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      for (const store of [EAGER, LAZY, SIZES]) if (!db.objectStoreNames.contains(store)) db.createObjectStore(store);
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.onblocked = () => reject(new Error("The cache is held by another tab of an older version"));
  });
}

/** Deletes a database (the account's cache) — after its pages closed it. */
export function deleteIdbStorage(name: string, idb: IDBFactory | undefined = globalThis.indexedDB): Promise<void> {
  if (!idb) return Promise.resolve();
  return new Promise((resolve) => {
    const r = idb.deleteDatabase(name);
    r.onsuccess = () => resolve();
    r.onerror = () => resolve();
    // Another tab still has it open: it closes on `versionchange` (onClosedElsewhere), then this succeeds
    r.onblocked = () => {};
  });
}

export async function openIdbStorage(opts: IdbStorageOptions): Promise<IdbStorage> {
  const idb = opts.idb ?? globalThis.indexedDB;
  if (!idb) throw new Error("This browser has no IndexedDB");
  const log = opts.log ?? ((level, message, detail) => console.warn(`[cache] ${level}: ${message}`, detail ?? ""));
  let db: IDBDatabase | null = await openDb(idb, opts.name);

  // Everything but the lazy values, in one read
  const eager = new Map<string, string>();
  const sizes = new Map<string, number>();
  {
    const tx = db.transaction([EAGER, SIZES], "readonly");
    const [keys, values, sizeKeys, sizeValues] = await Promise.all([
      req(tx.objectStore(EAGER).getAllKeys()),
      req(tx.objectStore(EAGER).getAll()),
      req(tx.objectStore(SIZES).getAllKeys()),
      req(tx.objectStore(SIZES).getAll()),
    ]);
    keys.forEach((k, i) => typeof values[i] === "string" && eager.set(String(k), values[i] as string));
    sizeKeys.forEach((k, i) => sizes.set(String(k), Number(sizeValues[i]) || 0));
  }
  // Lazy values in memory, least recently used first
  const lazyMemory = new Map<string, string>();
  let lazyBytes = 0;
  const remember = (key: string, value: string) => {
    const had = lazyMemory.get(key);
    if (had !== undefined) {
      lazyBytes -= had.length;
      lazyMemory.delete(key);
    }
    if (value.length > LAZY_MEMORY_BYTES / 4) return;
    lazyMemory.set(key, value);
    lazyBytes += value.length;
    for (const [k, v] of lazyMemory) {
      if (lazyBytes <= LAZY_MEMORY_BYTES) break;
      lazyMemory.delete(k);
      lazyBytes -= v.length;
    }
  };
  const forget = (key: string) => {
    const had = lazyMemory.get(key);
    if (had !== undefined) lazyBytes -= had.length;
    lazyMemory.delete(key);
  };

  // Writes not yet in the database (a key's last value wins; null: removed)
  let pending = new Map<string, string | null>();
  let scheduled: Promise<void> | null = null;
  let inFlight: Promise<void> = Promise.resolve();
  const listeners = new Set<(key: string, value: string | null) => void>();
  let channel = opts.channel === undefined ? (typeof BroadcastChannel === "function" ? new BroadcastChannel(`wecra-cache:${opts.name}`) : null) : opts.channel;

  const writeBatch = async (batch: Map<string, string | null>): Promise<void> => {
    if (!db || !batch.size) return;
    const tx = db.transaction([EAGER, LAZY, SIZES], "readwrite");
    const committed = done(tx);
    for (const [key, value] of batch) {
      const store = tx.objectStore(isLazy(key) ? LAZY : EAGER);
      if (value === null) {
        store.delete(key);
        if (isLazy(key)) tx.objectStore(SIZES).delete(key);
      } else {
        store.put(value, key);
        if (isLazy(key)) tx.objectStore(SIZES).put(value.length, key);
      }
    }
    try {
      await committed;
      channel?.postMessage({ keys: [...batch.keys()] });
    } catch (e) {
      log("error", "the browser couldn't keep changes in its cache", e);
    }
  };

  const schedule = () => {
    if (scheduled) return;
    scheduled = Promise.resolve().then(() => {
      scheduled = null;
      const batch = pending;
      pending = new Map();
      inFlight = inFlight.then(() => writeBatch(batch));
      return inFlight;
    });
  };

  const readLazy = async (key: string): Promise<string | null> => {
    if (!db) return null;
    const v = await req(db.transaction(LAZY, "readonly").objectStore(LAZY).get(key));
    return typeof v === "string" ? v : null;
  };

  /** Another tab wrote these keys: the eager ones are read again, then the store hears of each */
  const onRemote = async (keys: string[]) => {
    if (!db) return;
    const tx = db.transaction([EAGER, SIZES], "readonly");
    const reads = keys.map(async (key) => {
      if (pending.has(key)) return null; // this page's own write is newer
      if (isLazy(key)) {
        forget(key);
        const size = await req(tx.objectStore(SIZES).get(key));
        if (size === undefined) sizes.delete(key);
        else sizes.set(key, Number(size) || 0);
        return [key, sizes.has(key) ? "" : null] as const;
      }
      const v = await req(tx.objectStore(EAGER).get(key));
      if (typeof v === "string") eager.set(key, v);
      else eager.delete(key);
      return [key, typeof v === "string" ? v : null] as const;
    });
    for (const r of await Promise.all(reads)) if (r && !isLazy(r[0])) for (const l of listeners) l(r[0], r[1]);
  };
  if (channel) channel.onmessage = (e: MessageEvent) => void onRemote(Array.isArray((e.data as { keys?: unknown })?.keys) ? ((e.data as { keys: unknown[] }).keys.filter((k) => typeof k === "string") as string[]) : []).catch(() => {});

  const close = async () => {
    if (scheduled) await scheduled;
    await inFlight;
    db?.close();
    db = null;
    channel?.close();
    channel = null;
  };

  const storage: IdbStorage = {
    get(key) {
      if (isLazy(key)) return lazyMemory.get(key) ?? null;
      return eager.get(key) ?? null;
    },
    async getAsync(key) {
      if (!isLazy(key)) return eager.get(key) ?? null;
      const p = pending.get(key);
      if (p !== undefined) return p;
      const mem = lazyMemory.get(key);
      if (mem !== undefined) return mem;
      if (!sizes.has(key)) return null;
      const v = await readLazy(key);
      if (v !== null) remember(key, v);
      return v;
    },
    has(key) {
      return isLazy(key) ? sizes.has(key) : eager.has(key);
    },
    sizeOf(key) {
      return isLazy(key) ? (sizes.get(key) ?? 0) : (eager.get(key)?.length ?? 0);
    },
    set(key, value) {
      if (!db) return false;
      if (isLazy(key)) {
        sizes.set(key, value.length);
        remember(key, value);
      } else eager.set(key, value);
      pending.set(key, value);
      schedule();
      return true;
    },
    remove(key) {
      if (isLazy(key)) {
        sizes.delete(key);
        forget(key);
      } else eager.delete(key);
      if (!db) return;
      pending.set(key, null);
      schedule();
    },
    keys(prefix) {
      const out: string[] = [];
      const from = LAZY_PREFIXES.some((p) => p.startsWith(prefix) || prefix.startsWith(p)) ? [eager.keys(), sizes.keys()] : [eager.keys()];
      for (const it of from) for (const k of it) if (k.startsWith(prefix)) out.push(k);
      return out;
    },
    watch(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    async flush() {
      if (scheduled) await scheduled;
      await inFlight;
    },
    close,
    async destroy() {
      await close();
      await deleteIdbStorage(opts.name, idb);
    },
  };
  // Another page deletes (logs out) or upgrades the database: this one lets go and says so
  db.onversionchange = () => {
    db?.close();
    db = null;
    storage.onClosedElsewhere?.();
  };
  return storage;
}
