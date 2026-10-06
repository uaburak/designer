/**
 * The two backends the FirestoreAdapter talks to, as narrow interfaces: the real ones wrap the Firebase JS SDK
 * (modular, Node builds, in the store process only, docs/data.md §12.2) and are loaded lazily, only when sync is
 * configured and turned on — the SDK is never imported at build time, so it can leave package.json without breaking
 * the store. The in-memory ones back the tests.
 */
import type { SyncConfig } from "./config";
import { plainBytes, type BytesCodec } from "./fieldCodec";

export type DocData = Record<string, unknown>;

export interface FirestoreTx {
  get(path: string): Promise<DocData | null>;
  set(path: string, data: DocData, opts?: { merge?: boolean }): void;
  delete(path: string): void;
}

export interface FirestoreDriver {
  get(path: string): Promise<DocData | null>;
  set(path: string, data: DocData, opts?: { merge?: boolean }): Promise<void>;
  delete(path: string): Promise<void>;
  /** Documents of a collection, optionally `where(field op value)` and ordered by a field */
  list(collection: string, where?: { field: string; op: ">" | "=="; value: unknown }, orderBy?: string): Promise<{ id: string; data: DocData }[]>;
  transaction<T>(fn: (tx: FirestoreTx) => Promise<T>): Promise<T>;
  serverTimestamp(): unknown;
  deleteField(): unknown;
  /** A stored `_t` (the server timestamp) as a string that sorts like it (store.json's pullCursor) */
  cursorOf(t: unknown): string | null;
  /** …and back, for `where("_t", ">", …)` */
  cursorValue(cursor: string): unknown;
  readonly bytes: BytesCodec;
}

export interface StorageDriver {
  put(path: string, bytes: Uint8Array, meta?: { contentType?: string; cacheControl?: string; custom?: Record<string, string> }): Promise<void>;
  get(path: string): Promise<Uint8Array>;
  exists(path: string): Promise<boolean>;
  delete(path: string): Promise<void>;
}

export interface FirebaseDrivers {
  firestore: FirestoreDriver;
  storage: StorageDriver;
  /** Firebase sign-in with a Google ID token main obtained (docs/data.md §12.3) */
  signIn(googleIdToken: string): Promise<{ uid: string }>;
}

// ---------------------------------------------------------------------------------------------------------------------
// The Firebase JS SDK, loaded lazily
// ---------------------------------------------------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any -- the SDK is loaded by name at runtime, untyped on purpose */

const load = (name: string): Promise<any> => import(/* @vite-ignore */ name);

export async function loadFirebaseDrivers(config: SyncConfig): Promise<FirebaseDrivers> {
  const [appMod, fsMod, stMod, authMod] = await Promise.all([load("firebase/app"), load("firebase/firestore"), load("firebase/storage"), load("firebase/auth")]);
  const app = appMod.initializeApp(config.firebase, "designer-store");
  const db = fsMod.initializeFirestore(app, { localCache: fsMod.memoryLocalCache() });
  const storage = stMod.getStorage(app);
  const auth = authMod.initializeAuth(app, { persistence: authMod.inMemoryPersistence });
  const ref = (path: string) => fsMod.doc(db, path);
  const bytes: BytesCodec = { wrap: (b) => fsMod.Bytes.fromUint8Array(b), unwrap: (v) => (v as any).toUint8Array() };
  const firestore: FirestoreDriver = {
    bytes,
    async get(path) {
      const s = await fsMod.getDoc(ref(path));
      return s.exists() ? (s.data() as DocData) : null;
    },
    set: (path, data, opts) => fsMod.setDoc(ref(path), data, opts?.merge ? { merge: true } : {}),
    delete: (path) => fsMod.deleteDoc(ref(path)),
    async list(collection, where, orderBy) {
      const parts: any[] = [];
      if (where) parts.push(fsMod.where(where.field, where.op, where.value));
      if (orderBy) parts.push(fsMod.orderBy(orderBy));
      const snap = await fsMod.getDocs(fsMod.query(fsMod.collection(db, collection), ...parts));
      return snap.docs.map((d: any) => ({ id: d.id, data: d.data() as DocData }));
    },
    transaction: (fn) =>
      fsMod.runTransaction(db, (t: any) =>
        fn({
          get: async (path) => {
            const s = await t.get(ref(path));
            return s.exists() ? (s.data() as DocData) : null;
          },
          set: (path, data, opts) => void t.set(ref(path), data, opts?.merge ? { merge: true } : {}),
          delete: (path) => void t.delete(ref(path)),
        }),
      ),
    serverTimestamp: () => fsMod.serverTimestamp(),
    deleteField: () => fsMod.deleteField(),
    cursorOf: (t) => (t && typeof t === "object" && "seconds" in (t as any) ? `${(t as any).seconds}.${String((t as any).nanoseconds ?? 0).padStart(9, "0")}` : null),
    cursorValue: (c) => {
      const [sec, nanos] = c.split(".");
      return new fsMod.Timestamp(Number(sec), Number(nanos ?? 0));
    },
  };
  const sref = (path: string) => stMod.ref(storage, path);
  const storageDriver: StorageDriver = {
    put: async (path, data, meta) => {
      await stMod.uploadBytes(sref(path), data, { contentType: meta?.contentType, cacheControl: meta?.cacheControl, customMetadata: meta?.custom });
    },
    get: async (path) => new Uint8Array(await stMod.getBytes(sref(path))),
    exists: async (path) => {
      try {
        await stMod.getMetadata(sref(path));
        return true;
      } catch {
        return false;
      }
    },
    delete: (path) => stMod.deleteObject(sref(path)),
  };
  return {
    firestore,
    storage: storageDriver,
    async signIn(idToken) {
      const cred = await authMod.signInWithCredential(auth, authMod.GoogleAuthProvider.credential(idToken));
      return { uid: cred.user.uid };
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// In memory (tests)
// ---------------------------------------------------------------------------------------------------------------------

const DELETE = Symbol("deleteField");

function applyWrite(store: Map<string, DocData>, path: string, data: DocData, merge: boolean, now: () => number): void {
  const base: DocData = merge ? { ...(store.get(path) ?? {}) } : {};
  for (const [k, v] of Object.entries(data)) {
    if (v === DELETE) delete base[k];
    else if (v && typeof v === "object" && (v as { $serverTimestamp?: boolean }).$serverTimestamp) base[k] = now();
    else base[k] = structuredClone(v);
  }
  store.set(path, base);
}

export class MemoryFirestore implements FirestoreDriver {
  readonly docs = new Map<string, DocData>();
  readonly bytes = plainBytes;
  writes = 0;
  private tick = 0;
  private readonly now = () => ++this.tick;

  async get(path: string): Promise<DocData | null> {
    const d = this.docs.get(path);
    return d ? structuredClone(d) : null;
  }
  async set(path: string, data: DocData, opts?: { merge?: boolean }): Promise<void> {
    this.writes++;
    applyWrite(this.docs, path, data, !!opts?.merge, this.now);
  }
  async delete(path: string): Promise<void> {
    this.docs.delete(path);
  }
  async list(collection: string, where?: { field: string; op: ">" | "=="; value: unknown }, orderBy?: string): Promise<{ id: string; data: DocData }[]> {
    const prefix = `${collection}/`;
    let out = [...this.docs.entries()]
      .filter(([p]) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/"))
      .map(([p, d]) => ({ id: p.slice(prefix.length), data: structuredClone(d) }));
    if (where) out = out.filter((d) => (where.op === "==" ? d.data[where.field] === where.value : (d.data[where.field] as number) > (where.value as number)));
    if (orderBy) out.sort((a, b) => (a.data[orderBy] as number) - (b.data[orderBy] as number));
    return out;
  }
  async transaction<T>(fn: (tx: FirestoreTx) => Promise<T>): Promise<T> {
    const writes: (() => void)[] = [];
    const result = await fn({
      get: (p) => this.get(p),
      set: (p, d, o) => writes.push(() => applyWrite(this.docs, p, d, !!o?.merge, this.now)),
      delete: (p) => writes.push(() => this.docs.delete(p)),
    });
    this.writes += writes.length;
    for (const w of writes) w();
    return result;
  }
  serverTimestamp(): unknown {
    return { $serverTimestamp: true };
  }
  deleteField(): unknown {
    return DELETE;
  }
  cursorOf(t: unknown): string | null {
    return typeof t === "number" ? String(t) : null;
  }
  cursorValue(cursor: string): unknown {
    return Number(cursor);
  }
}

export class MemoryStorage implements StorageDriver {
  readonly objects = new Map<string, Uint8Array>();
  async put(path: string, bytes: Uint8Array): Promise<void> {
    this.objects.set(path, bytes.slice());
  }
  async get(path: string): Promise<Uint8Array> {
    const b = this.objects.get(path);
    if (!b) throw new Error(`no object ${path}`);
    return b.slice();
  }
  async exists(path: string): Promise<boolean> {
    return this.objects.has(path);
  }
  async delete(path: string): Promise<void> {
    this.objects.delete(path);
  }
}
