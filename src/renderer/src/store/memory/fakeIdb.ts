/**
 * A small in-memory IndexedDB for tests (idbStorage.ts's part of the API): databases of object stores with out-of-line
 * keys, readonly / readwrite transactions that complete after their requests, `versionchange` on open connections when
 * a database is deleted, and a way to look inside (`dump`). Not a general IndexedDB.
 */
type Store = Map<string, unknown>;

interface FakeDb {
  stores: Map<string, Store>;
  version: number;
  connections: Set<FakeConnection>;
}

const later = (fn: () => void) => setTimeout(fn, 0);

class FakeRequest<T> {
  result!: T;
  error: unknown = null;
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onupgradeneeded: (() => void) | null = null;
  onblocked: (() => void) | null = null;
}

class FakeConnection {
  onversionchange: (() => void) | null = null;
  closed = false;
  constructor(
    readonly db: FakeDb,
    readonly name: string,
  ) {}
  get objectStoreNames() {
    return { contains: (n: string) => this.db.stores.has(n) };
  }
  createObjectStore(n: string) {
    this.db.stores.set(n, new Map());
  }
  close() {
    this.closed = true;
    this.db.connections.delete(this);
  }
  transaction(names: string | string[], mode: "readonly" | "readwrite" = "readonly") {
    if (this.closed) throw new Error("InvalidStateError: the connection is closed");
    const list = Array.isArray(names) ? names : [names];
    let pending = 0;
    const writes: (() => void)[] = [];
    const tx = {
      oncomplete: null as (() => void) | null,
      onerror: null as (() => void) | null,
      onabort: null as (() => void) | null,
      error: null as unknown,
      objectStore: (n: string) => {
        if (!list.includes(n)) throw new Error(`NotFoundError: ${n} isn't in this transaction`);
        const store = this.db.stores.get(n)!;
        const request = <T>(fn: () => T) => {
          const r = new FakeRequest<T>();
          pending++;
          later(() => {
            r.result = fn();
            r.onsuccess?.();
            if (--pending === 0) finish();
          });
          return r;
        };
        const write = (fn: () => void) => {
          if (mode !== "readwrite") throw new Error("ReadOnlyError");
          writes.push(fn);
          return request(() => undefined);
        };
        return {
          get: (k: string) => request(() => structuredClone(store.get(k))),
          getAll: () => request(() => [...store.values()].map((v) => structuredClone(v))),
          getAllKeys: () => request(() => [...store.keys()]),
          put: (v: unknown, k: string) => write(() => store.set(k, structuredClone(v))),
          delete: (k: string) => write(() => store.delete(k)),
        };
      },
    };
    const finish = () =>
      later(() => {
        for (const w of writes) w();
        tx.oncomplete?.();
      });
    // A transaction with no requests completes too
    later(() => {
      if (pending === 0) finish();
    });
    return tx;
  }
}

export interface FakeIdb {
  factory: IDBFactory;
  /** A database's stores as plain maps (undefined when there is none) */
  dump(name: string): Record<string, Record<string, unknown>> | undefined;
  names(): string[];
}

export function fakeIndexedDb(): FakeIdb {
  const dbs = new Map<string, FakeDb>();
  const factory = {
    open(name: string, version = 1) {
      const r = new FakeRequest<FakeConnection>();
      later(() => {
        let db = dbs.get(name);
        const fresh = !db;
        if (!db) dbs.set(name, (db = { stores: new Map(), version, connections: new Set() }));
        const conn = new FakeConnection(db, name);
        db.connections.add(conn);
        r.result = conn;
        if (fresh || version > db.version) {
          db.version = version;
          r.onupgradeneeded?.();
        }
        r.onsuccess?.();
      });
      return r;
    },
    deleteDatabase(name: string) {
      const r = new FakeRequest<undefined>();
      later(() => {
        const db = dbs.get(name);
        for (const c of [...(db?.connections ?? [])]) c.onversionchange?.();
        if (db?.connections.size) {
          r.onblocked?.();
          // Deleted once the others close (as a real one goes on waiting)
          const wait = () => (db.connections.size ? later(wait) : (dbs.delete(name), r.onsuccess?.()));
          return later(wait);
        }
        dbs.delete(name);
        r.onsuccess?.();
      });
      return r;
    },
  };
  return {
    factory: factory as unknown as IDBFactory,
    dump(name) {
      const db = dbs.get(name);
      if (!db) return undefined;
      return Object.fromEntries([...db.stores].map(([n, s]) => [n, Object.fromEntries(s)]));
    },
    names: () => [...dbs.keys()],
  };
}
