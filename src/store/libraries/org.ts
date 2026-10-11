/**
 * The org half of the library registry (docs/data.md §16.3): libraries published from org files, kept on the
 * multiplayer server (D1 + one `LibraryObject` per library, §16.2) and reached through §16.10's routes. The router
 * (router.ts) sends it every call whose key is a room key, and every call about an org file's copy.
 *
 * - **Online first.** Every read asks the server; the answers are cached for offline use — `listAvailable` per org
 *   (`library-lists/<orgId>.json`, keyed by the signed-in person), records, manifests (immutable, kept forever) and
 *   payloads (`libraries/<key>/assets/<asset>/<hash>.kiwi`, the container bytes as uploaded). Offline, the cache
 *   answers; with nothing cached the call fails with `offline` (`listAvailable`: an empty list). Because reads never
 *   answer from the cache while online, an Inbox notice has nothing to drop: it becomes a LibraryEvent.
 * - **Publishing** is §16.6's three steps: `missing` → upload payloads and blobs → `versions` (with `baseVersion`; a
 *   stale one is the server's 409 → StoreError `conflict`, the editor previews again).
 * - **Subscriptions** live on the server (`/files/:key/libraries`); the copy's `FileMeta.enabledLibraries` is rewritten
 *   from each answer's effective list (local keys in it are kept).
 *
 * No Node or DOM imports: the desktop store and the browser's dev store both run it (their hosts differ).
 */
import { decodeMessage } from "../../shared/schema/codec";
import type { Message, NodeChange } from "../../shared/schema/document.generated";
import { guidKey } from "../../shared/schema/guid";
import { messageImageHashes } from "../../shared/schema/patch";
import { diffAgainst, previewAgainst, toLibraryAsset, validatePublishAssets, withDependencies } from "../../shared/store/libraryRules";
import { StoreError } from "../../shared/store/protocol";
import type { LibraryEvent, Unsubscribe } from "../../shared/store/repositories";
import { isAssetKey, isSha1, type AssetPayload, type FileKey, type FileMeta, type LibraryAsset, type LibraryDiff, type LibraryVersion, type PublishAsset, type PublishPreview, type PublishRequest } from "../../shared/store/types";
import { isLocalLibraryKey, type CollectionModes, type FileLibraries, type LibraryKey, type LibraryMissing, type LibraryScope, type OrgLibraryRecord, type OrgPublishInput } from "../../shared/libraries/orgTypes";
import type { LibraryNotice, OrgNotice } from "../notifications/service";
import { httpError, type MultiplayerService } from "../multiplayer/service";

// ---- the server ----------------------------------------------------------------------------------------------------

/** The multiplayer server as the libraries see it (the store's MultiplayerService, or a test's fake). */
export interface LibraryServer {
  readonly signedIn: boolean;
  readonly userId: string | null;
  /** The answer whatever its status; signed out or unreachable → StoreError `offline` */
  request(method: string, path: string, body?: unknown): Promise<Response>;
  /** Session changes (caches keyed by person follow them) */
  onSession?(listener: () => void): Unsubscribe;
}

export function libraryServerOf(mp: MultiplayerService): LibraryServer {
  return {
    get signedIn() {
      return mp.signedIn;
    },
    get userId() {
      return mp.userId;
    },
    request: (method, path, body) => mp.request(method, path, body),
    onSession: (listener) => mp.onSession(() => listener()),
  };
}

/** A JSON call: non-2xx → the server's StoreError (§14.12 codes); 204 → undefined */
export async function callJson<T>(server: LibraryServer, method: string, path: string, body?: unknown): Promise<T> {
  const res = await server.request(method, path, body);
  if (!res.ok) throw await httpError(res);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export async function callBytes(server: LibraryServer, method: string, path: string, body?: unknown): Promise<Uint8Array> {
  const res = await server.request(method, path, body);
  if (!res.ok) throw await httpError(res);
  return new Uint8Array(await res.arrayBuffer());
}

export async function callText(server: LibraryServer, method: string, path: string): Promise<string> {
  const res = await server.request(method, path);
  if (!res.ok) throw await httpError(res);
  return res.text();
}

export const isOffline = (e: unknown): boolean => e instanceof StoreError && e.code === "offline";
const isNotFound = (e: unknown): boolean => e instanceof StoreError && e.code === "not-found";

/** A path segment: room keys, asset keys, sha1s, org / team ids */
export function seg(s: unknown, what: string): string {
  if (typeof s !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(s)) throw new StoreError("invalid", `bad ${what}`);
  return s;
}

/**
 * `POST /libraries/:key/payloads`'s answer (§16.10): `[u32 n]` then n × `[u32 jsonLen][{key, versionHash, size}][bytes]`,
 * integers little-endian.
 */
export function parsePayloadFrames(bytes: Uint8Array): { key: string; versionHash: string; bytes: Uint8Array }[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const bad = () => new StoreError("corrupt", "The library's payloads couldn't be read");
  if (bytes.length < 4) throw bad();
  const n = view.getUint32(0, true);
  let at = 4;
  const out: { key: string; versionHash: string; bytes: Uint8Array }[] = [];
  const text = new TextDecoder();
  for (let i = 0; i < n; i++) {
    if (at + 4 > bytes.length) throw bad();
    const len = view.getUint32(at, true);
    at += 4;
    if (at + len > bytes.length) throw bad();
    let head: { key?: unknown; versionHash?: unknown; size?: unknown };
    try {
      head = JSON.parse(text.decode(bytes.subarray(at, at + len))) as typeof head;
    } catch {
      throw bad();
    }
    at += len;
    const size = Number(head.size);
    if (!Number.isInteger(size) || size < 0 || at + size > bytes.length || typeof head.key !== "string" || typeof head.versionHash !== "string") throw bad();
    out.push({ key: head.key, versionHash: head.versionHash, bytes: bytes.slice(at, at + size) });
    at += size;
  }
  return out;
}

/** The inverse (the fake server writes it) */
export function writePayloadFrames(items: { key: string; versionHash: string; bytes: Uint8Array }[]): Uint8Array {
  const enc = new TextEncoder();
  const heads = items.map((i) => enc.encode(JSON.stringify({ key: i.key, versionHash: i.versionHash, size: i.bytes.length })));
  const total = 4 + items.reduce((s, i, n) => s + 4 + heads[n].length + i.bytes.length, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, items.length, true);
  let at = 4;
  items.forEach((i, n) => {
    view.setUint32(at, heads[n].length, true);
    at += 4;
    out.set(heads[n], at);
    at += heads[n].length;
    out.set(i.bytes, at);
    at += i.bytes.length;
  });
  return out;
}

// ---- the host -------------------------------------------------------------------------------------------------------

/** Named cache entries (desktop: files under Workspace/spaces/; browser: localStorage for lists, memory for the rest) */
export interface LibraryCacheStore {
  readJson<T>(name: string): Promise<T | null>;
  writeJson(name: string, value: unknown): Promise<void>;
  readBytes(name: string): Promise<Uint8Array | null>;
  writeBytes(name: string, bytes: Uint8Array): Promise<void>;
}

export interface OrgLibrariesHost {
  server: LibraryServer;
  cache: LibraryCacheStore;
  getMeta(fileKey: FileKey): FileMeta | null;
  /** The local copy of an org file, by its room key */
  copyOf(roomKey: string): FileMeta | null;
  patchFile(fileKey: FileKey, patch: Partial<Pick<FileMeta, "enabledLibraries" | "library">>): Promise<FileMeta>;
  blobs: {
    has(sha1s: string[]): Promise<boolean[]>;
    get(sha1: string): Promise<Uint8Array>;
    put(bytes: Uint8Array, hint?: { mime?: string }): Promise<{ sha1: string }>;
  };
  pngSize(bytes: Uint8Array): { width: number; height: number } | null;
  /** A payload Message (raw kiwi bytes) → the snapshot container uploaded (§9.2) */
  encodePayload(message: Uint8Array): Uint8Array;
  /** A container downloaded → the Message in the current schema */
  decodePayload(bytes: Uint8Array): Promise<Uint8Array>;
  log(level: "debug" | "info" | "warn" | "error", message: string, detail?: unknown): void;
}

/** Where the Inbox's notices come from (NotificationsService) */
export interface LibraryNotices {
  onLibrary(listener: (n: LibraryNotice) => void): Unsubscribe;
  onOrg?(listener: (n: OrgNotice) => void): Unsubscribe;
}

/** One org's cached `listAvailable` answers, per file */
interface ListCache {
  v: 1;
  uid: string | null;
  byFile: Record<string, OrgLibraryRecord[]>;
}

export const CACHE = {
  list: (orgId: string) => `library-lists/${seg(orgId, "org id")}.json`,
  record: (key: string) => `libraries/${seg(key, "library key")}/library.json`,
  version: (key: string, n: number) => `libraries/${seg(key, "library key")}/versions/${n}.json`,
  payload: (key: string, asset: string, hash: string) => `libraries/${seg(key, "library key")}/assets/${seg(asset, "asset key")}/${seg(hash, "version hash")}.kiwi`,
};

const EMPTY_DIFF = (latestVersion = 0): LibraryDiff => ({ latestVersion, updated: [], removed: [], moved: [] });

// ---- the registry ---------------------------------------------------------------------------------------------------

export class OrgLibraries {
  private listeners = new Set<(e: LibraryEvent) => void>();
  private offs: Unsubscribe[] = [];
  /** Manifests read this session, by library then version (dependency closures, offline diffs) */
  private manifests = new Map<string, Map<number, LibraryVersion>>();

  constructor(
    private readonly host: OrgLibrariesHost,
    notices?: LibraryNotices,
  ) {
    if (notices) this.offs.push(notices.onLibrary((n) => this.notice(n)));
  }

  close(): void {
    for (const off of this.offs) off();
    this.offs = [];
    this.listeners.clear();
  }

  watch(listener: (e: LibraryEvent) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(e: LibraryEvent): void {
    for (const l of [...this.listeners]) {
      try {
        l(e);
      } catch (err) {
        this.host.log("warn", "libraries: a listener failed", err);
      }
    }
  }

  /** `{t: "library", libraryKey, version | status}` (§16.7) */
  notice(n: LibraryNotice): void {
    if (typeof n.libraryKey !== "string" || isLocalLibraryKey(n.libraryKey)) return;
    if (typeof n.version === "number") this.emit({ type: "published", libraryFileKey: n.libraryKey, version: n.version });
    else if (n.status) this.emit({ type: "status", libraryFileKey: n.libraryKey, status: n.status });
  }

  private get server(): LibraryServer {
    return this.host.server;
  }

  /** Whether the server can be asked as someone (the router's §16.9 forwarding needs a person) */
  get signedIn(): boolean {
    return this.server.signedIn;
  }

  private call<T>(method: string, path: string, body?: unknown): Promise<T> {
    return callJson<T>(this.server, method, path, body);
  }

  private async cached<T>(name: string): Promise<T | null> {
    return this.host.cache.readJson<T>(name).catch(() => null);
  }

  private keep(name: string, value: unknown): void {
    void this.host.cache.writeJson(name, value).catch((e) => this.host.log("warn", `libraries: couldn't cache ${name}`, e));
  }

  private orgCopy(fileKey: FileKey): FileMeta & { space: NonNullable<FileMeta["space"]> } {
    const meta = this.host.getMeta(fileKey);
    if (!meta) throw new StoreError("not-found", "No such file");
    if (!meta.space) throw new StoreError("invalid", "This file isn't in an organization");
    return meta as FileMeta & { space: NonNullable<FileMeta["space"]> };
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------------------------------------------------

  /** Org libraries usable in this org file (§16.4), relative to it (§16.5); its enabled list follows the server. */
  async listAvailable(fileKey: FileKey): Promise<OrgLibraryRecord[]> {
    const meta = this.orgCopy(fileKey);
    const { orgId, key } = meta.space;
    const name = CACHE.list(orgId);
    try {
      const [answer] = await Promise.all([this.call<{ libraries: OrgLibraryRecord[] }>("GET", `/libraries?file=${encodeURIComponent(key)}`), this.syncEnabled(fileKey).catch((e) => this.host.log("warn", "libraries: the file's enabled libraries", e))]);
      const libraries = (answer?.libraries ?? []).filter((r) => r && typeof r.libraryFileKey === "string");
      const uid = this.server.userId;
      const prev = await this.cached<ListCache>(name);
      const cache: ListCache = { v: 1, uid, byFile: prev?.v === 1 && prev.uid === uid ? { ...prev.byFile } : {} };
      cache.byFile[key] = libraries;
      this.keep(name, cache);
      for (const r of libraries) this.keep(CACHE.record(r.libraryFileKey), r);
      return libraries;
    } catch (e) {
      if (!isOffline(e)) throw e;
      const c = await this.cached<ListCache>(name);
      return c?.v === 1 && c.uid === this.server.userId ? (c.byFile[key] ?? []) : [];
    }
  }

  /** The file's effective libraries (`GET /files/:key/libraries`) into its copy's `enabledLibraries` */
  async syncEnabled(fileKey: FileKey): Promise<FileMeta> {
    const meta = this.orgCopy(fileKey);
    const answer = await this.call<FileLibraries>("GET", `/files/${encodeURIComponent(meta.space.key)}/libraries`);
    return this.adoptEnabled(meta, answer);
  }

  private async adoptEnabled(meta: FileMeta, answer: FileLibraries): Promise<FileMeta> {
    const enabled = [...new Set([...meta.enabledLibraries.filter(isLocalLibraryKey), ...(answer?.enabled ?? []).filter((k) => typeof k === "string")])];
    if (enabled.length === meta.enabledLibraries.length && enabled.every((k, i) => k === meta.enabledLibraries[i])) return { ...meta };
    return this.host.patchFile(meta.fileKey, { enabledLibraries: enabled });
  }

  async getRecord(key: LibraryKey): Promise<OrgLibraryRecord | null> {
    seg(key, "library key");
    try {
      const { library } = await this.call<{ library: OrgLibraryRecord }>("GET", `/libraries/${key}`);
      this.keep(CACHE.record(key), library);
      return library;
    } catch (e) {
      if (isNotFound(e)) return null;
      if (!isOffline(e)) throw e;
      return this.cached<OrgLibraryRecord>(CACHE.record(key));
    }
  }

  async getVersion(key: LibraryKey, version?: number): Promise<LibraryVersion> {
    seg(key, "library key");
    if (version !== undefined) {
      if (!Number.isInteger(version) || version < 1) throw new StoreError("invalid", "bad version");
      const known = this.manifests.get(key)?.get(version) ?? (await this.cached<LibraryVersion>(CACHE.version(key, version)));
      if (known) return this.remember(known);
    }
    try {
      const v = await this.call<LibraryVersion>("GET", `/libraries/${key}/versions/${version ?? "latest"}`);
      this.keep(CACHE.version(key, v.version), v);
      return this.remember(v);
    } catch (e) {
      if (!isOffline(e) || version !== undefined) throw e;
      const latest = await this.cachedLatest(key);
      if (!latest) throw e;
      return latest;
    }
  }

  private remember(v: LibraryVersion): LibraryVersion {
    let m = this.manifests.get(v.libraryFileKey);
    if (!m) this.manifests.set(v.libraryFileKey, (m = new Map()));
    m.set(v.version, v);
    return v;
  }

  /** The newest manifest known offline: the cached record's latest version */
  private async cachedLatest(key: LibraryKey): Promise<LibraryVersion | null> {
    const r = await this.cached<OrgLibraryRecord>(CACHE.record(key));
    const seen = [...(this.manifests.get(key)?.keys() ?? [])];
    const n = Math.max(r?.latestVersion ?? 0, ...seen, 0);
    if (n < 1) return null;
    return this.manifests.get(key)?.get(n) ?? (await this.cached<LibraryVersion>(CACHE.version(key, n)));
  }

  /** The latest manifest online (null: never published), else the cached one */
  private async latest(key: LibraryKey): Promise<LibraryVersion | null> {
    try {
      return await this.getVersion(key);
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }

  async diff(key: LibraryKey, have: { key: string; versionHash: string }[]): Promise<LibraryDiff> {
    seg(key, "library key");
    const list = (Array.isArray(have) ? have : []).filter((h) => isAssetKey(h?.key) && typeof h.versionHash === "string").map((h) => ({ key: h.key, versionHash: h.versionHash }));
    try {
      return await this.call<LibraryDiff>("POST", `/libraries/${key}/diff`, { have: list });
    } catch (e) {
      if (isNotFound(e)) return EMPTY_DIFF();
      if (!isOffline(e)) throw e;
      const latest = await this.cachedLatest(key);
      return latest ? diffAgainst(latest, latest.version, list, []) : EMPTY_DIFF();
    }
  }

  async getPayloads(key: LibraryKey, wants: { key: string; versionHash: string }[], opts: { withDependencies: boolean }): Promise<AssetPayload[]> {
    seg(key, "library key");
    const asked = (Array.isArray(wants) ? wants : []).filter((w) => isAssetKey(w?.key) && typeof w.versionHash === "string");
    // The closure from the manifests known here; what they don't cover the server adds (withDependencies).
    const closure = opts.withDependencies ? withDependencies((k, h) => this.entryOf(key, k, h), asked) : asked;
    const out = new Map<string, AssetPayload>();
    const missing: { key: string; versionHash: string }[] = [];
    for (const w of closure) {
      const bytes = await this.host.cache.readBytes(CACHE.payload(key, w.key, w.versionHash)).catch(() => null);
      if (bytes) out.set(w.key, { key: w.key, versionHash: w.versionHash, message: await this.host.decodePayload(bytes) });
      else missing.push(w);
    }
    if (missing.length) {
      const frames = parsePayloadFrames(await callBytes(this.server, "POST", `/libraries/${key}/payloads`, { wants: missing, withDependencies: opts.withDependencies }));
      for (const f of frames) {
        if (!isAssetKey(f.key) || out.has(f.key)) continue;
        await this.host.cache.writeBytes(CACHE.payload(key, f.key, f.versionHash), f.bytes).catch((e) => this.host.log("warn", "libraries: couldn't cache a payload", e));
        out.set(f.key, { key: f.key, versionHash: f.versionHash, message: await this.host.decodePayload(f.bytes) });
      }
    }
    for (const w of asked) if (!out.has(w.key)) throw new StoreError("not-found", `library ${key} has no asset ${w.key}@${w.versionHash}`);
    await this.fetchImages(key, [...out.values()]);
    // Asked ones first, in order, then their dependencies.
    const order = [...asked.map((w) => w.key), ...[...out.keys()].filter((k) => !asked.some((w) => w.key === k))];
    return [...new Set(order)].map((k) => out.get(k)!);
  }

  /** (asset, versionHash) in the newest manifest known here that holds it */
  private entryOf(key: LibraryKey, asset: string, hash: string): { asset: LibraryAsset; manifest: LibraryVersion } | null {
    const m = this.manifests.get(key);
    if (!m) return null;
    for (const n of [...m.keys()].sort((a, b) => b - a)) {
      const v = m.get(n)!;
      const a = v.assets.find((x) => x.key === asset && x.versionHash === hash);
      if (a) return { asset: a, manifest: v };
    }
    return null;
  }

  /** Images the payloads use, into the local blob store before the payloads are returned (§16.3) */
  private async fetchImages(key: LibraryKey, payloads: AssetPayload[]): Promise<void> {
    const want = new Set<string>();
    for (const p of payloads) {
      try {
        for (const h of messageImageHashes(decodeMessage(p.message))) want.add(h);
      } catch (e) {
        this.host.log("warn", `libraries: ${key}/${p.key} is unreadable`, e);
      }
    }
    const list = [...want].filter(isSha1);
    if (!list.length) return;
    const have = await this.host.blobs.has(list);
    for (const [i, sha1] of list.entries()) {
      if (have[i]) continue;
      try {
        await this.host.blobs.put(await callBytes(this.server, "GET", `/libraries/${key}/blobs/${sha1}`));
      } catch (e) {
        // An image the library can't give: the copy shows it missing, as a file whose blob is gone does.
        if (isOffline(e)) throw e;
        this.host.log("warn", `libraries: image ${sha1} of ${key}`, e);
      }
    }
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Publishing (§16.6)
  // -------------------------------------------------------------------------------------------------------------------

  async previewPublish(key: LibraryKey, assets: PublishAsset[]): Promise<PublishPreview> {
    seg(key, "library key");
    validatePublishAssets(assets);
    // Moves recorded by other libraries are the server's (its diff); the preview shows none.
    return previewAgainst(await this.latest(key), assets, []);
  }

  async publish(req: PublishRequest): Promise<LibraryVersion> {
    const key = seg(req?.libraryFileKey, "library key");
    const copy = this.host.copyOf(key);
    if (!copy) throw new StoreError("not-found", "This file isn't open here");
    validatePublishAssets(req.assets);
    for (const m of req.moves ?? []) {
      if (!req.assets.some((a) => a.key === m.key)) throw new StoreError("invalid", `moved asset ${m.key} is not in this publish`);
      if (typeof m.fromLibraryFileKey !== "string" || !isAssetKey(m.fromKey) || (m.mode !== "move" && m.mode !== "copy")) throw new StoreError("invalid", "bad move");
    }
    if (!this.server.signedIn) throw new StoreError("offline", "Log in to publish");
    const prev = await this.latest(key);
    const preview = previewAgainst(prev, req.assets, []);
    // Manifest entries; thumbnails into the blob store (their sha1 names them in the manifest).
    const assets: LibraryAsset[] = [];
    const blobs = new Set<string>();
    const containers = new Map<string, Uint8Array>();
    const messages = new Map<string, Message>();
    for (const a of req.assets) {
      let thumbnail: LibraryAsset["thumbnail"] = prev?.assets.find((p) => p.key === a.key && p.versionHash === a.versionHash)?.thumbnail ?? null;
      if (a.thumbnailPng instanceof Uint8Array) {
        const dims = this.host.pngSize(a.thumbnailPng);
        if (!dims) throw new StoreError("invalid", `asset ${a.key}'s thumbnail must be a PNG`);
        const put = await this.host.blobs.put(a.thumbnailPng, { mime: "image/png" });
        thumbnail = { sha1: put.sha1, width: dims.width, height: dims.height };
      }
      if (thumbnail) blobs.add(thumbnail.sha1);
      assets.push(toLibraryAsset(a, thumbnail));
      if (a.payload instanceof Uint8Array) {
        let message: Message;
        try {
          message = decodeMessage(a.payload);
        } catch {
          throw new StoreError("invalid", `asset ${a.key}'s payload is not a NODE_CHANGES message`);
        }
        messages.set(a.key, message);
        for (const h of messageImageHashes(message)) blobs.add(h);
        containers.set(a.key, this.host.encodePayload(a.payload));
      }
    }
    // 1. What the library's object lacks.
    const ask: LibraryMissing = { payloads: req.assets.map((a) => ({ key: a.key, versionHash: a.versionHash })), blobs: [...blobs].filter(isSha1) };
    const lacks = await this.call<LibraryMissing>("POST", `/libraries/${key}/missing`, ask);
    // 2. Uploads (content-addressed and idempotent: a retry after a failure sends what is still missing).
    for (const p of lacks?.payloads ?? []) {
      const a = req.assets.find((x) => x.key === p.key && x.versionHash === p.versionHash);
      if (!a) continue;
      const bytes = containers.get(a.key) ?? (await this.host.cache.readBytes(CACHE.payload(key, a.key, a.versionHash)).catch(() => null));
      if (!bytes) throw new StoreError("invalid", `asset ${a.key} needs its payload`);
      await this.send("PUT", `/libraries/${key}/payloads/${seg(a.key, "asset key")}/${seg(a.versionHash, "version hash")}`, bytes);
    }
    for (const sha1 of lacks?.blobs ?? []) {
      if (!isSha1(sha1)) continue;
      const bytes = await this.host.blobs.get(sha1).catch(() => null);
      if (!bytes) throw new StoreError("invalid", `image ${sha1} isn't on this computer`);
      await this.send("PUT", `/libraries/${key}/blobs/${sha1}`, bytes);
    }
    // 3. The commit.
    const scope: LibraryScope = req.scope === "org" || req.scope === "team" ? req.scope : ((await this.cached<OrgLibraryRecord>(CACHE.record(key)))?.org?.scope ?? "team");
    const input: OrgPublishInput = {
      baseVersion: prev?.version ?? 0,
      description: typeof req.description === "string" ? req.description : "",
      scope,
      assets,
      changes: { created: preview.created.map((a) => a.key), modified: preview.modified.map((a) => a.key), removed: preview.removed.map((a) => a.key), moved: preview.moved },
      moves: (req.moves ?? []).map((m) => ({ key: m.key, fromLibraryFileKey: m.fromLibraryFileKey, fromKey: m.fromKey, mode: m.mode })),
      collections: await this.collectionsOf(key, req.assets, messages),
    };
    const { version, library } = await this.call<{ version: LibraryVersion; library: OrgLibraryRecord }>("POST", `/libraries/${key}/versions`, input);
    this.remember(version);
    this.keep(CACHE.version(key, version.version), version);
    if (library) this.keep(CACHE.record(key), library);
    for (const [asset, bytes] of containers) {
      const a = req.assets.find((x) => x.key === asset)!;
      await this.host.cache.writeBytes(CACHE.payload(key, asset, a.versionHash), bytes).catch(() => {});
    }
    await this.host.patchFile(copy.fileKey, { library: { status: "published", latestVersion: version.version } }).catch((e) => this.host.log("warn", "libraries: the copy's record", e));
    this.emit({ type: "published", libraryFileKey: key, version: version.version });
    return version;
  }

  private async send(method: string, path: string, body: Uint8Array): Promise<void> {
    const res = await this.server.request(method, path, body);
    if (!res.ok) throw await httpError(res);
  }

  /** Each published collection's modes, in order (§16.5's default modes need them), read from its payload */
  private async collectionsOf(key: LibraryKey, assets: PublishAsset[], messages: Map<string, Message>): Promise<CollectionModes[]> {
    const out: CollectionModes[] = [];
    for (const a of assets) {
      if (a.kind !== "VARIABLE_COLLECTION" || a.dependencyOnly) continue;
      let message = messages.get(a.key);
      if (!message) {
        const bytes = await this.host.cache.readBytes(CACHE.payload(key, a.key, a.versionHash)).catch(() => null);
        if (bytes) message = decodeMessage(await this.host.decodePayload(bytes));
      }
      const node = message ? collectionNode(message, a) : null;
      if (!node) {
        this.host.log("warn", `libraries: collection ${a.key} has no payload here; its modes aren't sent`);
        continue;
      }
      out.push({ collectionKey: a.key, name: node.name ?? a.name, modes: modesOf(node) });
    }
    return out;
  }

  async unpublish(key: LibraryKey): Promise<void> {
    seg(key, "library key");
    await this.call("POST", `/libraries/${key}/unpublish`);
    const copy = this.host.copyOf(key);
    if (copy) await this.host.patchFile(copy.fileKey, { library: { status: "unpublished", latestVersion: copy.library.latestVersion } }).catch(() => {});
    this.emit({ type: "status", libraryFileKey: key, status: "unpublished" });
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Subscriptions
  // -------------------------------------------------------------------------------------------------------------------

  /** Enable or disable a library in an org file (`PUT /files/:key/libraries/:libraryKey`); null: back to the default */
  async setEnabled(fileKey: FileKey, key: LibraryKey, enabled: boolean | null): Promise<FileMeta> {
    const meta = this.orgCopy(fileKey);
    seg(key, "library key");
    if (key === meta.space.key) throw new StoreError("invalid", "A file can't use itself as a library");
    const answer = await this.call<FileLibraries>("PUT", `/files/${encodeURIComponent(meta.space.key)}/libraries/${key}`, { enabled });
    return this.adoptEnabled(this.host.getMeta(fileKey) ?? meta, answer);
  }
}

/** The VARIABLE_SET node of a collection's payload: the asset's guid, else its key, else the first one */
function collectionNode(message: Message, a: Pick<LibraryAsset, "guid" | "key">): NodeChange | null {
  const sets = (message.nodeChanges ?? []).filter((n) => n.type === "VARIABLE_SET");
  return sets.find((n) => n.guid && guidKey(n.guid) === a.guid) ?? sets.find((n) => n.key === a.key) ?? sets[0] ?? null;
}

/** A collection's modes in their order (the first is its default) */
export function modesOf(node: NodeChange): CollectionModes["modes"] {
  return [...(node.variableSetModes ?? [])]
    .filter((m) => m.id)
    .sort((x, y) => ((x.sortPosition ?? "") < (y.sortPosition ?? "") ? -1 : (x.sortPosition ?? "") > (y.sortPosition ?? "") ? 1 : 0))
    .map((m) => ({ id: guidKey(m.id!), name: m.name ?? "" }));
}
