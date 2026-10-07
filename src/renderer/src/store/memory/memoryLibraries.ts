/**
 * The library registry of the browser dev store (docs/data.md §9): the store's own rules (`libraryRules.ts`, shared
 * with `LocalLibraries`) over localStorage records instead of files —
 *
 *   lib.<lib>                       LibraryRecord
 *   libver.<lib>.<n>                LibraryVersion (the complete manifest of version n)
 *   libasset.<lib>.<key>.<hash>     one asset version's payload (kiwi NODE_CHANGES bytes), written once
 *
 * Records are read from the storage on every call, so a library published in one tab of the demo is seen by the
 * editor in another (and a `storage` event of a new record becomes a `published` event here).
 */
import { decodeMessage } from "../../../../shared/schema/codec";
import { Emitter } from "../../../../shared/store/emitter";
import { diffAgainst, libraryCounts, movedOutOf, movesOf, previewAgainst, toLibraryAsset, validatePublishAssets, withDependencies } from "../../../../shared/store/libraryRules";
import { StoreError } from "../../../../shared/store/protocol";
import type { LibraryEvent, LibraryRegistry } from "../../../../shared/store/repositories";
import { isAssetKey, type AssetPayload, type FileKey, type FileMeta, type Hlc, type LibraryAsset, type LibraryRecord, type LibraryVersion, type PublishRequest, type VersionRecord } from "../../../../shared/store/types";
import type { WorkspaceModel } from "../../../../shared/store/workspaceModel";
import { KV_PREFIX, parseWithBytes, stringifyWithBytes, type KeyValueStorage } from "./kv";

export const LIB_KEYS = {
  record: (lib: FileKey) => `${KV_PREFIX}lib.${lib}`,
  version: (lib: FileKey, n: number) => `${KV_PREFIX}libver.${lib}.${n}`,
  payload: (lib: FileKey, key: string, hash: string) => `${KV_PREFIX}libasset.${lib}.${key}.${hash}`,
};

export interface MemoryLibrariesDeps {
  storage: KeyValueStorage;
  ws: WorkspaceModel;
  clock: { now(): number };
  hlc: { now(): Hlc };
  putBlob(bytes: Uint8Array, hint?: { mime?: string }): Promise<{ sha1: string }>;
  pngSize(bytes: Uint8Array): { width: number; height: number } | null;
  addVersion(fileKey: FileKey, input: Pick<VersionRecord, "kind" | "title" | "description" | "restoredFrom" | "libraryVersion">): void;
  log(level: "warn", message: string, detail?: unknown): void;
}

export class MemoryLibraries {
  readonly events = new Emitter<LibraryEvent>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly d: MemoryLibrariesDeps) {}

  private read<T>(key: string): T | null {
    const v = this.d.storage.get(key);
    if (v === null) return null;
    try {
      return parseWithBytes<T>(v);
    } catch {
      return null;
    }
  }

  /**
   * Writes a record or throws (`io`) when the browser's storage refuses it (quota): a publish then stops before its
   * record moves on, as `LocalLibraries` does on a failed file write — never a record pointing at a missing manifest.
   */
  private write(key: string, value: unknown): void {
    if (!this.d.storage.set(key, stringifyWithBytes(value))) {
      this.d.log("warn", `the browser's storage is full; ${key} wasn't kept`);
      throw new StoreError("io", "The browser's storage is full");
    }
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  private records(): LibraryRecord[] {
    return this.d.storage
      .keys(`${KV_PREFIX}lib.`)
      .map((k) => this.read<LibraryRecord>(k))
      .filter((r): r is LibraryRecord => !!r?.libraryFileKey);
  }

  private record(lib: FileKey): LibraryRecord | null {
    return this.read<LibraryRecord>(LIB_KEYS.record(lib));
  }

  /** The record's status follows its file: trashed with it, deleted with it (§9.6). */
  private status(r: LibraryRecord): LibraryRecord["status"] {
    const m = this.d.ws.files.get(r.libraryFileKey);
    if (!m) return "deleted";
    if (this.d.ws.isFileTrashed(m)) return "trashed";
    return r.status;
  }

  private version(lib: FileKey, n: number): LibraryVersion | null {
    return this.read<LibraryVersion>(LIB_KEYS.version(lib, n));
  }

  private latest(lib: FileKey): LibraryVersion | null {
    const r = this.record(lib);
    if (!r || r.latestVersion < 1 || this.status(r) === "deleted") return null;
    return this.version(lib, r.latestVersion);
  }

  /** Another page wrote a record (the storage event): its new version is a `published` event here. */
  noteExternalWrite(key: string, value: string | null): void {
    if (!key.startsWith(`${KV_PREFIX}lib.`) || value === null) return;
    try {
      const r = JSON.parse(value) as LibraryRecord;
      if (r.status === "published") this.events.emit({ type: "published", libraryFileKey: r.libraryFileKey, version: r.latestVersion });
      else this.events.emit({ type: "status", libraryFileKey: r.libraryFileKey, status: r.status });
    } catch {
      /* not a record */
    }
  }

  registry(): LibraryRegistry {
    return {
      listAvailable: async (forFileKey) => this.records().filter((r) => r.libraryFileKey !== forFileKey && this.status(r) === "published"),
      getRecord: async (lib) => {
        const r = this.record(lib);
        return r ? { ...r, status: this.status(r) } : null;
      },
      getVersion: async (lib, version) => {
        const r = this.record(lib);
        if (!r || this.status(r) === "deleted") throw new StoreError("not-found", `${lib} is not a library`);
        const v = this.version(lib, version ?? r.latestVersion);
        if (!v) throw new StoreError("not-found", `library ${lib} has no version ${version ?? r.latestVersion}`);
        return v;
      },
      previewPublish: async (lib, assets) => {
        this.d.ws.getMeta(lib);
        validatePublishAssets(assets);
        return previewAgainst(this.latest(lib), assets, movedOutOf(this.records(), lib));
      },
      publish: (req) => this.publish(req),
      unpublish: (lib) =>
        this.serial(async () => {
          const r = this.record(lib);
          if (!r || this.status(r) === "deleted") throw new StoreError("not-found", `${lib} is not a library`);
          if (r.status === "unpublished") return;
          this.write(LIB_KEYS.record(lib), { ...r, status: "unpublished", _clk: { ...r._clk, status: this.d.hlc.now() } });
          await this.d.ws.queue.run(() => this.d.ws.patchFile(lib, { library: { status: "unpublished", latestVersion: r.latestVersion } }));
          this.events.emit({ type: "status", libraryFileKey: lib, status: "unpublished" });
        }),
      setEnabled: (fileKey, lib, enabled) => this.setEnabled(fileKey, lib, enabled),
      getPayloads: async (lib, wants, opts) => {
        const r = this.record(lib);
        if (!r || this.status(r) === "deleted") throw new StoreError("not-found", `${lib} is not a library`);
        const list = opts?.withDependencies ? withDependencies((key, hash) => this.findEntry(lib, key, hash), wants ?? []) : [...(wants ?? [])];
        return list.map((w): AssetPayload => {
          const bytes = this.read<{ message: Uint8Array }>(LIB_KEYS.payload(lib, w.key, w.versionHash));
          if (!bytes) throw new StoreError("not-found", `library ${lib} has no asset ${w.key}@${w.versionHash}`);
          return { key: w.key, versionHash: w.versionHash, message: bytes.message };
        });
      },
      diff: async (lib, have) => {
        const r = this.record(lib);
        const latestVersion = r?.latestVersion ?? 0;
        if (!r || this.status(r) !== "published") return { latestVersion, updated: [], removed: [], moved: [] };
        return diffAgainst(this.latest(lib), latestVersion, have ?? [], movedOutOf(this.records(), lib));
      },
      watch: (listener) => this.events.on(listener),
    };
  }

  private findEntry(lib: FileKey, key: string, versionHash: string): { asset: LibraryAsset; manifest: LibraryVersion } | null {
    const r = this.record(lib);
    for (let n = r?.latestVersion ?? 0; n >= 1; n--) {
      const v = this.version(lib, n);
      const a = v?.assets.find((x) => x.key === key && x.versionHash === versionHash);
      if (v && a) return { asset: a, manifest: v };
    }
    return null;
  }

  private async publish(req: PublishRequest): Promise<LibraryVersion> {
    const lib = req?.libraryFileKey;
    const meta = this.d.ws.getMeta(lib);
    if (this.d.ws.isFileTrashed(meta)) throw new StoreError("trashed", "This file is in Trash");
    if (meta.folderId === null) throw new StoreError("draft-cannot-publish", "Move this file to a folder to publish it as a library");
    validatePublishAssets(req.assets);
    for (const m of req.moves ?? []) {
      if (!req.assets.some((a) => a.key === m.key)) throw new StoreError("invalid", `moved asset ${m.key} is not in this publish`);
      if (!isAssetKey(m.fromKey) || (m.mode !== "move" && m.mode !== "copy")) throw new StoreError("invalid", "bad move");
    }
    return this.serial(async () => {
      const prev = this.latest(lib);
      const preview = previewAgainst(prev, req.assets, movedOutOf(this.records(), lib));
      const now = this.d.clock.now();
      const assets: LibraryAsset[] = [];
      // What this publish wrote, taken back if a later write fails (§9.3: payloads, then the manifest, then the
      // record — a failure anywhere leaves the library as it was).
      const written: string[] = [];
      try {
        for (const a of req.assets) {
          const key = LIB_KEYS.payload(lib, a.key, a.versionHash);
          if (this.d.storage.get(key) === null) {
            if (!(a.payload instanceof Uint8Array)) throw new StoreError("invalid", `asset ${a.key} needs its payload`);
            try {
              decodeMessage(a.payload);
            } catch {
              throw new StoreError("invalid", `asset ${a.key}'s payload is not a NODE_CHANGES message`);
            }
            this.write(key, { message: a.payload });
            written.push(key);
          }
          let thumbnail: LibraryAsset["thumbnail"] = prev?.assets.find((p) => p.key === a.key && p.versionHash === a.versionHash)?.thumbnail ?? null;
          if (a.thumbnailPng instanceof Uint8Array) {
            const dims = this.d.pngSize(a.thumbnailPng);
            if (!dims) throw new StoreError("invalid", `asset ${a.key}'s thumbnail must be a PNG`);
            const put = await this.d.putBlob(a.thumbnailPng, { mime: "image/png" });
            thumbnail = { sha1: put.sha1, width: dims.width, height: dims.height };
          }
          assets.push(toLibraryAsset(a, thumbnail));
        }
        const record = this.record(lib);
        const n = (record?.latestVersion ?? 0) + 1;
        const moves = movesOf(req.moves, lib, n, now, record?.movedIn);
        const version: LibraryVersion = {
          libraryFileKey: lib,
          version: n,
          publishedAt: now,
          description: typeof req.description === "string" ? req.description : "",
          changes: { created: preview.created.map((a) => a.key), modified: preview.modified.map((a) => a.key), removed: preview.removed.map((a) => a.key), moved: [...preview.moved, ...moves] },
          assets,
        };
        this.write(LIB_KEYS.version(lib, n), version);
        written.push(LIB_KEYS.version(lib, n));
        const h = this.d.hlc.now();
        const next: LibraryRecord = record
          ? { ...record, movedIn: [...record.movedIn, ...moves], _clk: { ...record._clk } }
          : { libraryFileKey: lib, status: "published", latestVersion: 0, firstPublishedAt: now, lastPublishedAt: now, counts: { components: 0, styles: 0, variables: 0 }, movedIn: moves, _clk: { firstPublishedAt: h } };
        next.status = "published";
        next.latestVersion = n;
        next.lastPublishedAt = now;
        next.counts = libraryCounts(assets);
        for (const f of ["status", "latestVersion", "lastPublishedAt", "counts", ...(moves.length ? ["movedIn"] : [])]) next._clk[f] = h;
        this.write(LIB_KEYS.record(lib), next);
        written.length = 0; // published: nothing to take back
        try {
          this.d.addVersion(lib, { kind: "publish", title: null, description: version.description || null, restoredFrom: null, libraryVersion: n });
        } catch (e) {
          this.d.log("warn", `${lib}: publish version entry`, e);
        }
        await this.d.ws.queue.run(() => this.d.ws.patchFile(lib, { library: { status: "published", latestVersion: n } }));
        this.events.emit({ type: "published", libraryFileKey: lib, version: n });
        return version;
      } finally {
        for (const k of written) this.d.storage.remove(k);
      }
    });
  }

  private async setEnabled(fileKey: FileKey, lib: FileKey, enabled: boolean): Promise<FileMeta> {
    const ws = this.d.ws;
    const meta = ws.getMeta(fileKey);
    if (fileKey === lib) throw new StoreError("invalid", "A file can't use itself as a library");
    if (enabled) {
      const r = this.record(lib);
      if (!r || this.status(r) !== "published") throw new StoreError("not-found", "That library isn't published");
    }
    const has = meta.enabledLibraries.includes(lib);
    if (has === enabled) return { ...meta };
    return ws.queue.run(() => ws.patchFile(fileKey, { enabledLibraries: enabled ? [...meta.enabledLibraries, lib] : meta.enabledLibraries.filter((k) => k !== lib) }));
  }

  /** The library's records and payloads go with its file (deleted forever). */
  forget(lib: FileKey): void {
    for (const k of [...this.d.storage.keys(`${KV_PREFIX}libver.${lib}.`), ...this.d.storage.keys(`${KV_PREFIX}libasset.${lib}.`)]) this.d.storage.remove(k);
    const r = this.record(lib);
    try {
      if (r) this.write(LIB_KEYS.record(lib), { ...r, status: "deleted" });
    } catch {
      /* logged; the record follows the file anyway (`status()`: no file → deleted) */
    }
  }
}
