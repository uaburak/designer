/**
 * The desktop store's side of branches (docs/data.md §15.2, §15.5): a branch's files beside its journal —
 *
 *   files/<branch>/branch/branch.json   the BranchRecord
 *   files/<branch>/branch/base.kiwi     the base: main's "branch" version (a hard link of it), or main's head at the
 *                                       last Update from main (a snapshot container like any other)
 *
 * — and the FileStore / workspace calls the service needs.
 */
import { promises as fsp } from "node:fs";
import { join } from "node:path";
import { NodeTable } from "../../shared/schema/patch";
import type { BranchRecord, FileKey } from "../../shared/store/types";
import type { FileStore } from "../local/fileStore";
import { atomicWrite, ensureDir, linkOrCopy, readJsonOrNull, writeJsonAtomic } from "../local/fsutil";
import { newFileKey, type Clock } from "../local/ids";
import { currentMessage, encodeSnapshot, readSnapshotFile } from "../local/snapshot";
import { newMeta, type LocalWorkspace, type Log, type WorkspaceDirs } from "../local/workspace";
import type { MultiplayerService } from "../multiplayer/service";
import { RemoteBranches } from "./remote";
import { libraryVersionOf, type BranchHost } from "./service";

export interface LocalBranchDeps {
  dirs: WorkspaceDirs;
  ws: LocalWorkspace;
  files: FileStore;
  libraries: Parameters<typeof libraryVersionOf>[0];
  multiplayer: MultiplayerService | null;
  clock: Clock;
  log: Log;
  timers: { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(h: unknown): void };
}

export function localBranchHost(d: LocalBranchDeps): BranchHost {
  const dir = (key: FileKey) => join(d.dirs.files, key, "branch");
  const basePath = (key: FileKey) => join(dir(key), "base.kiwi");
  const mp = d.multiplayer;
  return {
    now: () => d.clock.now(),
    log: d.log,
    getMeta: (key) => (d.ws.files.has(key) ? d.ws.getMeta(key) : null),
    metas: () => [...d.ws.files.values()],
    patchMeta: (key, patch) => d.ws.queue.run(() => d.ws.patchFile(key, patch)),
    flush: (key) => d.files.flush(key),
    headTable: (key) => d.files.headTable(key),
    headSeq: (key) => d.files.headSeqOf(key),
    addVersion: (key, input) => d.files.addVersion(key, { ...input, restoredFrom: null, libraryVersion: null }),
    appendSystem: async (key, message, opts) => (await d.files.appendSystem(key, message, opts)).seq,
    reserveSessionBlock: (key, size) => d.files.reserveSessionBlock(key, size),
    async createBranchFile(input) {
      const { record, path } = await d.files.getVersion(input.fromFileKey, input.versionId);
      const key = newFileKey();
      await d.files.createFileFromSnapshot(key, path, record.blobRefs, record.derivedDataVersion ?? 0, { nextLocal: input.sessions.start, blockEnd: input.sessions.end });
      const meta = newMeta(key, input.name, input.folderId, d.clock.now());
      meta.enabledLibraries = [...input.enabledLibraries];
      meta.branch = { ...input.branch };
      // Main's thumbnail until the branch makes its own.
      const thumb = d.ws.files.get(input.fromFileKey)?.thumbnail;
      if (thumb) {
        try {
          await fsp.copyFile(join(d.dirs.files, input.fromFileKey, "thumbnail.png"), join(d.dirs.files, key, "thumbnail.png"));
          meta.thumbnail = { version: 1, width: thumb.width, height: thumb.height };
        } catch {
          /* none */
        }
      }
      return d.ws.queue.run(() => d.ws.addFile(meta));
    },
    loadRecord: (key) => readJsonOrNull<BranchRecord>(join(dir(key), "branch.json")),
    async saveRecord(record) {
      await ensureDir(dir(record.branchFileKey));
      await writeJsonAtomic(d.dirs.tmp, join(dir(record.branchFileKey), "branch.json"), record);
    },
    async writeBaseFromVersion(branchFileKey, mainFileKey, versionId) {
      const { path } = await d.files.getVersion(mainFileKey, versionId);
      await ensureDir(dir(branchFileKey));
      await fsp.rm(basePath(branchFileKey), { force: true });
      await linkOrCopy(path, basePath(branchFileKey));
    },
    async writeBase(branchFileKey, snapshot) {
      await ensureDir(dir(branchFileKey));
      // A new file, never the old one rewritten (it may be a hard link of main's version).
      await fsp.rm(basePath(branchFileKey), { force: true });
      await atomicWrite(d.dirs.tmp, basePath(branchFileKey), encodeSnapshot(snapshot));
    },
    readBase: async (key) => NodeTable.fromMessage(currentMessage(await readSnapshotFile(basePath(key)))),
    libraryVersionOf: (lib, assetKey, hash) => libraryVersionOf(d.libraries, lib, assetKey, hash),
    fileChanges: d.files.changes,
    workspaceEvents: d.ws.events,
    user: () => ({ id: mp?.userId ?? null, name: null }),
    setTimeout: (fn, ms) => d.timers.setTimeout(fn, ms),
    clearTimeout: (h) => d.timers.clearTimeout(h),
    remote: mp
      ? new RemoteBranches({
          call: (method, path, body) => mp.call(method, path, body),
          syncState: (key) => mp.syncState(key),
          shareTo: (key, input, register, roomKey) => mp.shareTo(key, input, register, roomKey),
          newRoomKey: (base) => mp.newRoomKey(base),
          linkedCopies: () => mp.linkedCopies(),
          headSeq: (key) => d.files.headSeqOf(key),
          signedIn: () => mp.signedIn,
        })
      : null,
  };
}
