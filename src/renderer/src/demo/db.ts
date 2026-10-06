/**
 * The demo's storage: a key-value store in this computer's IndexedDB — every
 * page of the app (the shell, each tab) reads the same one. No Firebase.
 */

const DB = "designer-demo";
const STORE = "kv";

let opening: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return opening;
}

function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = work(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(req.result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      })
  );
}

export const get = <T>(key: string) => run<T | undefined>("readonly", (s) => s.get(key) as IDBRequest<T | undefined>);
export const set = (key: string, value: unknown) => run("readwrite", (s) => s.put(value, key)).then(() => undefined);
export const del = (key: string) => run("readwrite", (s) => s.delete(key)).then(() => undefined);
export const keys = (prefix: string) => run<IDBValidKey[]>("readonly", (s) => s.getAllKeys(IDBKeyRange.bound(prefix, `${prefix}￿`))).then((list) => list.map(String));

/** A moment's wait, as a network's: the app's loading states show in the demo too. */
export const later = <T>(value: T, ms = 120) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));
