/**
 * Where the browser's dev store keeps its records between page loads: one key per record (the workspace, prefs, each
 * folder, each file's meta, each file's data, each blob), so two pages of the demo (Home in one browser tab, an editor
 * in another) write different keys and see each other's writes through the `storage` event.
 */

export interface KeyValueStorage {
  get(key: string): string | null;
  /** False when the value couldn't be stored (quota) */
  set(key: string, value: string): boolean;
  remove(key: string): void;
  keys(prefix: string): string[];
  /** Another page changed a key (the `storage` event); null where pages can't share */
  watch?(listener: (key: string, value: string | null) => void): () => void;
}

/** Keys live in their own namespace, so `reset` never touches the rest of the origin's storage. */
export const KV_PREFIX = "designer.devStore.v1.";

export function memoryStorage(): KeyValueStorage & { readonly map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get: (k) => map.get(k) ?? null,
    set: (k, v) => {
      map.set(k, v);
      return true;
    },
    remove: (k) => void map.delete(k),
    keys: (prefix) => [...map.keys()].filter((k) => k.startsWith(prefix)),
  };
}

/** `window.localStorage`, or null where there is none (or it is blocked). */
export function browserStorage(): KeyValueStorage | null {
  let ls: Storage;
  try {
    ls = globalThis.localStorage;
    if (!ls) return null;
    ls.getItem(KV_PREFIX);
  } catch {
    return null;
  }
  return {
    get: (k) => ls.getItem(k),
    set: (k, v) => {
      try {
        ls.setItem(k, v);
        return true;
      } catch {
        return false;
      }
    },
    remove: (k) => ls.removeItem(k),
    keys: (prefix) => {
      const out: string[] = [];
      for (let i = 0; i < ls.length; i++) {
        const k = ls.key(i);
        if (k && k.startsWith(prefix)) out.push(k);
      }
      return out;
    },
    watch: (listener) => {
      const onStorage = (e: StorageEvent) => {
        if (e.storageArea === ls && e.key && e.key.startsWith(KV_PREFIX)) listener(e.key, e.newValue);
      };
      globalThis.addEventListener?.("storage", onStorage);
      return () => globalThis.removeEventListener?.("storage", onStorage);
    },
  };
}

// --- JSON with bytes ---

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** JSON that keeps Uint8Arrays (as {"$u8": base64}). */
export function stringifyWithBytes(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => (v instanceof Uint8Array ? { $u8: toBase64(v) } : v));
}

export function parseWithBytes<T>(text: string): T {
  return JSON.parse(text, (_k, v: unknown) => (v && typeof v === "object" && typeof (v as { $u8?: unknown }).$u8 === "string" ? fromBase64((v as { $u8: string }).$u8) : v)) as T;
}
