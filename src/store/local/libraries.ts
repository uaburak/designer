/**
 * The workspace library registry (docs/data.md §9):
 *
 *   libraries/<lib>/library.json                 LibraryRecord
 *   libraries/<lib>/versions/<n>.json            LibraryVersion: the complete manifest of version n
 *   libraries/<lib>/assets/<key>/<hash>.kiwi     one asset version's payload (snapshot container), written once
 *
 * Consumers keep in-document copies, so everything here is about publishing, finding updates and fetching payloads;
 * nothing a consumer renders depends on the registry being there.
 */
import { promises as fsp } from "node:fs";
import { join } from "node:path";
import { decodeCanvas } from "../../shared/fig/container";
import { codec } from "../../shared/schema/document.generated";
import { messageImageHashes } from "../../shared/schema/patch";
import { StoreError } from "../../shared/store/protocol";
import { diffAgainst, libraryCounts, movedOutOf, movesOf, previewAgainst, toLibraryAsset, validatePublishAssets } from "../../shared/store/libraryRules";
import type { LibraryEvent } from "../../shared/store/repositories";
import {
  isAssetKey,
  isFileKey,
  type AssetPayload,
  type FileKey,
  type FileMeta,
  type LibraryAsset,
  type LibraryDiff,
  type LibraryRecord,
  type LibraryVersion,
  type PublishAsset,
  type PublishPreview,
  type PublishRequest,
  type Redirect,
} from "../../shared/store/types";
import { nodeCodecs, own } from "../kiwi/codecs";
import { decodeWithSchema, isCurrentSchema } from "../kiwi/schemas";
import { pngSize, type LocalBlobs } from "./blobs";
import { Emitter } from "./emitter";
import type { FileStore } from "./fileStore";
import { atomicWrite, ensureDir, exists, readJsonOrNull, writeJsonAtomic } from "./fsutil";
import type { Clock, HlcClock } from "./ids";
import { SerialQueue } from "./queue";
import { encodeSnapshot } from "./snapshot";
import type { LocalWorkspace, Log, WorkspaceDirs } from "./workspace";

export interface LibrariesDeps {
  dirs: WorkspaceDirs;
  workspace: LocalWorkspace;
  files: FileStore;
  blobs: LocalBlobs;
  hlc: HlcClock;
  clock: Clock;
  log: Log;
}

export class LocalLibraries {
  readonly events = new Emitter<LibraryEvent>();
  readonly queue = new SerialQueue();
  private readonly records = new Map<FileKey, LibraryRecord>();

  constructor(private readonly d: LibrariesDeps) {}

  private dir(lib: FileKey): string {
    return join(this.d.dirs.libraries, lib);
  }

  private payloadPath(lib: FileKey, key: string, versionHash: string): string {
    return join(this.dir(lib), "assets", key, `${versionHash}.kiwi`);
  }

  async load(): Promise<void> {
    for (const lib of await fsp.readdir(this.d.dirs.libraries).catch(() => [] as string[])) {
      if (!isFileKey(lib)) continue;
      const r = await readJsonOrNull<LibraryRecord>(join(this.dir(lib), "library.json"));
      if (r && r.libraryFileKey === lib) this.records.set(lib, r);
      else this.d.log("warn", `library ${lib} has no readable library.json`);
    }
  }

  private async saveRecord(r: LibraryRecord): Promise<void> {
    await ensureDir(this.dir(r.libraryFileKey));
    await writeJsonAtomic(this.d.dirs.tmp, join(this.dir(r.libraryFileKey), "library.json"), r);
    this.records.set(r.libraryFileKey, r);
  }

  private stamp(r: LibraryRecord, fields: string[]): void {
    const h = this.d.hlc.now();
    for (const f of fields) r._clk[f] = h;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------------------------------------------------

  listAvailable(forFileKey?: FileKey): LibraryRecord[] {
    const ws = this.d.workspace;
    return [...this.records.values()]
      .filter((r) => r.status === "published" && r.libraryFileKey !== forFileKey)
      .filter((r) => {
        const m = ws.files.get(r.libraryFileKey);
        return !!m && !ws.isFileTrashed(m);
      })
      .map((r) => structuredClone(r));
  }

  getRecord(lib: FileKey): LibraryRecord | null {
    const r = this.records.get(lib);
    return r ? structuredClone(r) : null;
  }

  async getVersion(lib: FileKey, version?: number): Promise<LibraryVersion> {
    const r = this.records.get(lib);
    if (!r || r.status === "deleted") throw new StoreError("not-found", `${lib} is not a library`);
    const n = version ?? r.latestVersion;
    const v = await readJsonOrNull<LibraryVersion>(join(this.dir(lib), "versions", `${n}.json`));
    if (!v) throw new StoreError("not-found", `library ${lib} has no version ${n}`);
    return v;
  }

  private async latest(lib: FileKey): Promise<LibraryVersion | null> {
    const r = this.records.get(lib);
    if (!r || r.latestVersion < 1 || r.status === "deleted") return null;
    return this.getVersion(lib, r.latestVersion).catch(() => null);
  }

  /** Redirects recorded by other libraries for assets that moved out of `lib`. */
  private movedOutOf(lib: FileKey): Redirect[] {
    return movedOutOf(this.records.values(), lib);
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Publishing (§9.3)
  // -------------------------------------------------------------------------------------------------------------------

  private validateAssets(assets: PublishAsset[]): void {
    validatePublishAssets(assets);
  }

  private toAsset(a: PublishAsset, thumbnail: LibraryAsset["thumbnail"]): LibraryAsset {
    return toLibraryAsset(a, thumbnail);
  }

  async previewPublish(lib: FileKey, assets: PublishAsset[]): Promise<PublishPreview> {
    this.d.workspace.getMeta(lib);
    this.validateAssets(assets);
    return previewAgainst(await this.latest(lib), assets, this.movedOutOf(lib));
  }

  async publish(req: PublishRequest): Promise<LibraryVersion> {
    const lib = req.libraryFileKey;
    const meta = this.d.workspace.getMeta(lib);
    if (this.d.workspace.isFileTrashed(meta)) throw new StoreError("trashed", "This file is in Trash");
    if (meta.folderId === null) throw new StoreError("draft-cannot-publish", "Move this file to a folder to publish it as a library");
    this.validateAssets(req.assets);
    for (const m of req.moves ?? []) {
      if (!req.assets.some((a) => a.key === m.key)) throw new StoreError("invalid", `moved asset ${m.key} is not in this publish`);
      if (!isFileKey(m.fromLibraryFileKey) || !isAssetKey(m.fromKey) || (m.mode !== "move" && m.mode !== "copy")) throw new StoreError("invalid", "bad move");
    }
    return this.queue.run(async () => {
      const preview = await this.previewPublish(lib, req.assets);
      const prev = await this.latest(lib);
      const now = this.d.clock.now();
      // 1. Payloads (once per asset version) and thumbnails (blobs).
      const assets: LibraryAsset[] = [];
      for (const a of req.assets) {
        const path = this.payloadPath(lib, a.key, a.versionHash);
        if (!(await exists(path))) {
          if (!(a.payload instanceof Uint8Array)) throw new StoreError("invalid", `asset ${a.key} needs its payload`);
          try {
            codec.decodeMessage(a.payload);
          } catch {
            throw new StoreError("invalid", `asset ${a.key}'s payload is not a NODE_CHANGES message`);
          }
          await ensureDir(join(this.dir(lib), "assets", a.key));
          await atomicWrite(this.d.dirs.tmp, path, encodeSnapshot(a.payload));
        }
        let thumbnail: LibraryAsset["thumbnail"] = prev?.assets.find((p) => p.key === a.key && p.versionHash === a.versionHash)?.thumbnail ?? null;
        if (a.thumbnailPng instanceof Uint8Array) {
          const dims = pngSize(a.thumbnailPng);
          if (!dims) throw new StoreError("invalid", `asset ${a.key}'s thumbnail must be a PNG`);
          const put = await this.d.blobs.put(a.thumbnailPng, { mime: "image/png" });
          thumbnail = { sha1: put.sha1, width: dims.width, height: dims.height };
        }
        assets.push(this.toAsset(a, thumbnail));
      }
      // 2. The manifest, then the record (in that order: a record never points at a missing manifest).
      const record = this.records.get(lib);
      const n = (record?.latestVersion ?? 0) + 1;
      const moves: Redirect[] = movesOf(req.moves, lib, n, now, record?.movedIn);
      const version: LibraryVersion = {
        libraryFileKey: lib,
        version: n,
        publishedAt: now,
        description: typeof req.description === "string" ? req.description : "",
        changes: {
          created: preview.created.map((a) => a.key),
          modified: preview.modified.map((a) => a.key),
          removed: preview.removed.map((a) => a.key),
          moved: [...preview.moved, ...moves],
        },
        assets,
      };
      await ensureDir(join(this.dir(lib), "versions"));
      await writeJsonAtomic(this.d.dirs.tmp, join(this.dir(lib), "versions", `${n}.json`), version);
      const next: LibraryRecord = record
        ? { ...record, _clk: { ...record._clk }, movedIn: [...record.movedIn, ...moves] }
        : { libraryFileKey: lib, status: "published", latestVersion: 0, firstPublishedAt: now, lastPublishedAt: now, counts: { components: 0, styles: 0, variables: 0 }, movedIn: moves, _clk: {} };
      next.status = "published";
      next.latestVersion = n;
      next.lastPublishedAt = now;
      next.counts = libraryCounts(assets);
      this.stamp(next, ["status", "latestVersion", "lastPublishedAt", "counts", ...(moves.length ? ["movedIn"] : []), ...(record ? [] : ["firstPublishedAt"])]);
      await this.saveRecord(next);
      // 3. The library file's history and record.
      await this.d.files.addVersion(lib, { kind: "publish", title: null, description: version.description || null, restoredFrom: null, libraryVersion: n }).catch((e) => this.d.log("warn", `${lib}: publish version entry`, e));
      const ws = this.d.workspace;
      await ws.queue.run(() => ws.patchFile(lib, { library: { status: "published", latestVersion: n } }));
      this.events.emit({ type: "published", libraryFileKey: lib, version: n });
      return version;
    });
  }

  async unpublish(lib: FileKey): Promise<void> {
    await this.queue.run(async () => {
      const r = this.records.get(lib);
      if (!r || r.status === "deleted") throw new StoreError("not-found", `${lib} is not a library`);
      if (r.status === "unpublished") return;
      const next = { ...r, status: "unpublished" as const, _clk: { ...r._clk } };
      this.stamp(next, ["status"]);
      await this.saveRecord(next);
      const ws = this.d.workspace;
      await ws.queue.run(() => ws.patchFile(lib, { library: { status: "unpublished", latestVersion: r.latestVersion } }));
      this.events.emit({ type: "status", libraryFileKey: lib, status: "unpublished" });
    });
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Consuming (§9.4)
  // -------------------------------------------------------------------------------------------------------------------

  async setEnabled(fileKey: FileKey, lib: FileKey, enabled: boolean): Promise<FileMeta> {
    const ws = this.d.workspace;
    const meta = ws.getMeta(fileKey);
    if (fileKey === lib) throw new StoreError("invalid", "A file can't use itself as a library");
    if (enabled) {
      const r = this.records.get(lib);
      if (!r || r.status !== "published") throw new StoreError("not-found", "That library isn't published");
    }
    const has = meta.enabledLibraries.includes(lib);
    if (has === enabled) return { ...meta };
    return ws.queue.run(() => ws.patchFile(fileKey, { enabledLibraries: enabled ? [...meta.enabledLibraries, lib] : meta.enabledLibraries.filter((k) => k !== lib) }));
  }

  private async readPayload(lib: FileKey, key: string, versionHash: string): Promise<Uint8Array> {
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await fsp.readFile(this.payloadPath(lib, key, versionHash)));
    } catch {
      throw new StoreError("not-found", `library ${lib} has no asset ${key}@${versionHash}`);
    }
    const c = decodeCanvas(bytes, nodeCodecs);
    if (isCurrentSchema(c.schema)) return own(c.message);
    return codec.encodeMessage(decodeWithSchema(c.schema, c.message).message);
  }

  /** The manifest entry for (key, versionHash), searching versions newest first, and that manifest. */
  private async findEntry(lib: FileKey, key: string, versionHash: string): Promise<{ asset: LibraryAsset; manifest: LibraryVersion } | null> {
    const r = this.records.get(lib);
    if (!r) return null;
    for (let n = r.latestVersion; n >= 1; n--) {
      const v = await readJsonOrNull<LibraryVersion>(join(this.dir(lib), "versions", `${n}.json`));
      const a = v?.assets.find((x) => x.key === key && x.versionHash === versionHash);
      if (v && a) return { asset: a, manifest: v };
    }
    return null;
  }

  async getPayloads(lib: FileKey, wants: { key: string; versionHash: string }[], opts: { withDependencies: boolean }): Promise<AssetPayload[]> {
    const r = this.records.get(lib);
    if (!r || r.status === "deleted") throw new StoreError("not-found", `${lib} is not a library`);
    const out: AssetPayload[] = [];
    const done = new Set<string>();
    const queue = [...wants];
    while (queue.length) {
      const w = queue.shift()!;
      if (done.has(w.key)) continue;
      done.add(w.key);
      out.push({ key: w.key, versionHash: w.versionHash, message: await this.readPayload(lib, w.key, w.versionHash) });
      if (!opts.withDependencies) continue;
      const entry = await this.findEntry(lib, w.key, w.versionHash);
      for (const dep of entry?.asset.dependencies ?? []) {
        const da = entry!.manifest.assets.find((a) => a.key === dep);
        if (da && !done.has(dep)) queue.push({ key: dep, versionHash: da.versionHash });
      }
    }
    return out;
  }

  async diff(lib: FileKey, have: { key: string; versionHash: string }[]): Promise<LibraryDiff> {
    const r = this.records.get(lib);
    const latestVersion = r?.latestVersion ?? 0;
    if (!r || r.status !== "published") return { latestVersion, updated: [], removed: [], moved: [] };
    return diffAgainst(await this.latest(lib), latestVersion, have, this.movedOutOf(lib));
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Library files trashed, restored, deleted (§9.6)
  // -------------------------------------------------------------------------------------------------------------------

  async fileTrashed(lib: FileKey): Promise<void> {
    await this.setStatus(lib, "trashed");
  }

  async fileRestored(lib: FileKey): Promise<void> {
    const m = this.d.workspace.files.get(lib);
    const r = this.records.get(lib);
    if (!r || r.status !== "trashed" || !m) return;
    await this.setStatus(lib, m.library.status === "unpublished" ? "unpublished" : "published");
  }

  async fileDeleted(lib: FileKey): Promise<void> {
    const r = this.records.get(lib);
    if (!r) return;
    await this.setStatus(lib, "deleted");
    await fsp.rm(join(this.dir(lib), "versions"), { recursive: true, force: true });
    await fsp.rm(join(this.dir(lib), "assets"), { recursive: true, force: true });
  }

  private async setStatus(lib: FileKey, status: LibraryRecord["status"]): Promise<void> {
    await this.queue.run(async () => {
      const r = this.records.get(lib);
      if (!r || r.status === status || r.status === "deleted") return;
      const next = { ...r, status, _clk: { ...r._clk } };
      this.stamp(next, ["status"]);
      await this.saveRecord(next);
      this.events.emit({ type: "status", libraryFileKey: lib, status });
    });
  }

  // -------------------------------------------------------------------------------------------------------------------
  // GC
  // -------------------------------------------------------------------------------------------------------------------

  /** Thumbnails of every manifest and the images inside every stored payload. */
  async blobRefs(): Promise<Set<string>> {
    const refs = new Set<string>();
    for (const lib of this.records.keys()) {
      const versionsDir = join(this.dir(lib), "versions");
      for (const n of await fsp.readdir(versionsDir).catch(() => [] as string[])) {
        const v = await readJsonOrNull<LibraryVersion>(join(versionsDir, n));
        for (const a of v?.assets ?? []) if (a.thumbnail) refs.add(a.thumbnail.sha1);
      }
      const assetsDir = join(this.dir(lib), "assets");
      for (const key of await fsp.readdir(assetsDir).catch(() => [] as string[])) {
        for (const f of await fsp.readdir(join(assetsDir, key)).catch(() => [] as string[])) {
          try {
            const c = decodeCanvas(new Uint8Array(await fsp.readFile(join(assetsDir, key, f))), nodeCodecs);
            for (const h of messageImageHashes(decodeWithSchema(c.schema, c.message).message)) refs.add(h);
          } catch (e) {
            this.d.log("warn", `library payload ${lib}/${key}/${f} is unreadable`, e);
          }
        }
      }
    }
    return refs;
  }
}
