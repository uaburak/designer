import { createHash } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PluginStorageCall } from "../../shared/ipc";

/**
 * `figma.clientStorage` (docs/plugins.md §3.3): one JSON file per plugin in `userData/plugins/storage/`, at most
 * 5 MB per plugin — each key's length plus its value's JSON size, strings and `Uint8Array`s counted by their length
 * (Figma's rule). Values are what Figma takes: JSON-like data and `Uint8Array`s (kept in the file as `{"$bytes": base64}`).
 * Writes are queued per plugin and atomic (temp + rename).
 */

export const STORAGE_QUOTA_BYTES = 5 * 1024 * 1024;
const MAX_KEY = 1024;
const MAX_DEPTH = 64;

/** Figma's message when a plugin's storage is full (docs/research/atlas/17-plugins.md §8) */
export const QUOTA_TEXT = "Client storage quota (5 MB) exceeded for this plugin ID. Please use less client storage.";

type Stored = Record<string, unknown>;

/** The value's size by Figma's rule, and a JSON-safe copy of it (throws for what clientStorage can't keep). */
export function encodeValue(value: unknown, depth = 0): { json: unknown; size: number } {
  if (depth > MAX_DEPTH) throw new Error("clientStorage: the value is nested too deeply");
  if (value instanceof Uint8Array) return { json: { $bytes: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64") }, size: value.byteLength };
  // Figma counts a string by its length (not its JSON, quotes and escapes).
  if (typeof value === "string") return { json: value, size: value.length };
  if (value === null || typeof value === "boolean") return { json: value, size: JSON.stringify(value).length };
  if (typeof value === "number") return Number.isFinite(value) ? { json: value, size: JSON.stringify(value).length } : { json: null, size: 4 };
  if (Array.isArray(value)) {
    let size = 2;
    const json = value.map((v, i) => {
      const e = encodeValue(v === undefined ? null : v, depth + 1);
      size += e.size + (i ? 1 : 0);
      return e.json;
    });
    return { json, size };
  }
  if (typeof value === "object") {
    let size = 2;
    const json: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue;
      const e = encodeValue(v, depth + 1);
      json[k === "$bytes" ? "$$bytes" : k] = e.json;
      size += JSON.stringify(k).length + 1 + e.size + 1;
    }
    return { json, size };
  }
  throw new Error(`clientStorage: a ${typeof value} can't be stored`);
}

export function decodeValue(json: unknown): unknown {
  if (Array.isArray(json)) return json.map(decodeValue);
  if (json && typeof json === "object") {
    const o = json as Record<string, unknown>;
    const keys = Object.keys(o);
    if (keys.length === 1 && keys[0] === "$bytes" && typeof o.$bytes === "string") return new Uint8Array(Buffer.from(o.$bytes, "base64"));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) out[k === "$$bytes" ? "$bytes" : k] = decodeValue(v);
    return out;
  }
  return json;
}

const entrySize = (key: string, json: unknown) => key.length + encodeValue(decodeValue(json)).size;

/** The file a plugin's storage lives in: its id when that is a safe name, else a hash of it. */
export const storageFileName = (pluginId: string) => (/^[A-Za-z0-9_-]{1,100}$/.test(pluginId) ? pluginId : `h-${createHash("sha1").update(pluginId).digest("hex")}`) + ".json";

export class ClientStorage {
  private readonly cache = new Map<string, Stored>();
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly dir: string, private readonly quota = STORAGE_QUOTA_BYTES) {}

  private async load(pluginId: string): Promise<Stored> {
    const hit = this.cache.get(pluginId);
    if (hit) return hit;
    let data: Stored = {};
    try {
      const json = JSON.parse(await readFile(join(this.dir, storageFileName(pluginId)), "utf8")) as unknown;
      if (json && typeof json === "object" && !Array.isArray(json)) data = json as Stored;
    } catch {
      /* none yet */
    }
    this.cache.set(pluginId, data);
    return data;
  }

  private async persist(pluginId: string, data: Stored) {
    const file = join(this.dir, storageFileName(pluginId));
    await mkdir(this.dir, { recursive: true });
    if (!Object.keys(data).length) return void (await unlink(file).catch(() => undefined));
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(data));
    await rename(tmp, file);
  }

  /** One call at a time per plugin (a set waits for the one before it). */
  private serial<T>(pluginId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(pluginId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.queues.set(pluginId, next.catch(() => undefined));
    return next;
  }

  /** Bytes in use by Figma's rule */
  async used(pluginId: string): Promise<number> {
    const data = await this.load(pluginId);
    return Object.entries(data).reduce((n, [k, v]) => n + entrySize(k, v), 0);
  }

  call(raw: PluginStorageCall): Promise<unknown> {
    const pluginId = typeof raw?.pluginId === "string" && raw.pluginId.length > 0 && raw.pluginId.length <= 200 ? raw.pluginId : null;
    if (!pluginId) return Promise.reject(new Error("clientStorage: no plugin"));
    const key = raw.key;
    const needKey = () => {
      if (typeof key !== "string" || key.length > MAX_KEY) throw new Error("clientStorage: the key must be a string");
      return key;
    };
    return this.serial(pluginId, async () => {
      const data = await this.load(pluginId);
      switch (raw.op) {
        case "get": {
          const k = needKey();
          return Object.prototype.hasOwnProperty.call(data, k) ? decodeValue(data[k]) : undefined;
        }
        case "keys":
          return Object.keys(data);
        case "delete": {
          const k = needKey();
          if (!Object.prototype.hasOwnProperty.call(data, k)) return undefined;
          const next = { ...data };
          delete next[k];
          await this.persist(pluginId, next);
          this.cache.set(pluginId, next);
          return undefined;
        }
        case "set": {
          const k = needKey();
          if (raw.value === undefined) throw new Error("clientStorage: the value can't be undefined");
          const { json, size } = encodeValue(raw.value);
          let used = k.length + size;
          for (const [other, v] of Object.entries(data)) if (other !== k) used += entrySize(other, v);
          if (used > this.quota) throw new Error(QUOTA_TEXT);
          const next = { ...data, [k]: json };
          await this.persist(pluginId, next);
          this.cache.set(pluginId, next);
          return undefined;
        }
        default:
          throw new Error("clientStorage: get, set, delete or keys");
      }
    });
  }
}
