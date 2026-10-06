/**
 * The workspace's records on disk (docs/data.md §2–§4): workspace.json, prefs.json, folders/<id>.json and
 * files/<key>/meta.json, read once at start (a few hundred small reads) and kept in memory. The index, the queries and
 * Figma's file-browser rules are `WorkspaceModel` (src/shared/store/workspaceModel.ts, shared with the browser's dev
 * store); this class adds the files and the start-up repair. One serial queue orders all record mutations.
 */
import { promises as fsp } from "node:fs";
import { join } from "node:path";
import { WorkspaceModel } from "../../shared/store/workspaceModel";
import { isFileKey, isFolderId, type FileKey, type FileMeta, type Folder, type Prefs, type Workspace } from "../../shared/store/types";
import { ensureDir, readJsonOrNull, readJsonWithBackup, writeJsonAtomic, writeJsonWithBackup } from "./fsutil";
import { newWid, type Clock, type HlcClock } from "./ids";
import { defaultPrefs, newMeta } from "../../shared/store/workspaceModel";

export { defaultPrefs, newMeta, searchKey } from "../../shared/store/workspaceModel";

export interface WorkspaceDirs {
  root: string;
  tmp: string;
  files: string;
  folders: string;
  blobs: string;
  libraries: string;
  schemas: string;
  trashPending: string;
}

export function workspaceDirs(root: string): WorkspaceDirs {
  return {
    root,
    tmp: join(root, "tmp"),
    files: join(root, "files"),
    folders: join(root, "folders"),
    blobs: join(root, "blobs"),
    libraries: join(root, "libraries"),
    schemas: join(root, "schemas"),
    trashPending: join(root, ".trash-pending"),
  };
}

export type Log = (level: "debug" | "info" | "warn" | "error", message: string, detail?: unknown) => void;

export interface RebuiltMeta {
  name: string;
  createdAt: number;
}

export class LocalWorkspace extends WorkspaceModel {
  private constructor(
    readonly dirs: WorkspaceDirs,
    workspace: Workspace,
    prefs: Prefs,
    hlc: HlcClock,
    clock: Clock,
  ) {
    super(workspace, prefs, {
      hlc,
      clock,
      persist: {
        workspace: (w) => writeJsonWithBackup(dirs.tmp, join(dirs.root, "workspace.json"), w),
        prefs: (p) => writeJsonWithBackup(dirs.tmp, join(dirs.root, "prefs.json"), p),
        folder: (f) => writeJsonAtomic(dirs.tmp, join(dirs.folders, `${f.id}.json`), f),
        removeFolder: (id) => fsp.rm(join(dirs.folders, `${id}.json`), { force: true }),
        meta: (m) => writeJsonAtomic(dirs.tmp, join(dirs.files, m.fileKey, "meta.json"), m),
      },
    });
  }

  /**
   * Reads every record. Corrupt records are repaired as §3.2 says: workspace.json and prefs.json fall back to their
   * .bak; a corrupt folder is dropped and its files move to Drafts; a corrupt meta.json is rebuilt by `rebuildMeta`.
   */
  static async load(opts: {
    dirs: WorkspaceDirs;
    hlc: HlcClock;
    clock: Clock;
    log: Log;
    teamName?: string;
    rebuildMeta: (fileKey: FileKey) => Promise<RebuiltMeta | null>;
  }): Promise<LocalWorkspace> {
    const { dirs, hlc, clock, log } = opts;
    for (const d of [dirs.files, dirs.folders, dirs.blobs, dirs.libraries, dirs.schemas, dirs.tmp, dirs.trashPending]) await ensureDir(d);
    const now = clock.now();
    const wsPath = join(dirs.root, "workspace.json");
    const wsRead = await readJsonWithBackup<Workspace>(wsPath);
    let workspace: Workspace;
    if (wsRead) {
      workspace = wsRead.value;
      if (wsRead.fromBackup) log("warn", "workspace.json was unreadable; using workspace.json.bak");
    } else {
      workspace = { wid: newWid(), formatVersion: 1, teamName: opts.teamName ?? "My team", createdAt: now, defaultLibraries: [], ownerUid: null, _clk: {} };
    }
    const prefsRead = await readJsonWithBackup<Prefs>(join(dirs.root, "prefs.json"));
    if (prefsRead?.fromBackup) log("warn", "prefs.json was unreadable; using prefs.json.bak");
    const prefs = { ...defaultPrefs(), ...(prefsRead?.value ?? {}) };
    const ws = new LocalWorkspace(dirs, workspace, prefs, hlc, clock);
    if (!wsRead) await ws.saveWorkspace();
    if (!prefsRead) await ws.savePrefs();

    for (const name of await fsp.readdir(dirs.folders)) {
      if (!name.endsWith(".json")) continue;
      const f = await readJsonOrNull<Folder>(join(dirs.folders, name));
      if (!f || !isFolderId(f.id) || `${f.id}.json` !== name) {
        log("warn", `dropping corrupt folder record ${name}`);
        await fsp.rm(join(dirs.folders, name), { force: true });
        continue;
      }
      ws.folders.set(f.id, f);
    }
    for (const f of ws.folders.values()) {
      if (f.parentId && !ws.folders.has(f.parentId)) {
        log("warn", `folder ${f.id} lost its parent; moving it to the top level`);
        f.parentId = null;
        await ws.saveFolder(f);
      }
    }
    for (const key of await fsp.readdir(dirs.files)) {
      if (!isFileKey(key)) continue;
      let meta = await readJsonOrNull<FileMeta>(join(dirs.files, key, "meta.json"));
      if (!meta || meta.fileKey !== key) {
        const rebuilt = await opts.rebuildMeta(key);
        if (!rebuilt) {
          log("error", `file ${key} has neither a readable meta.json nor a readable snapshot; skipped`);
          continue;
        }
        log("warn", `rebuilt meta.json of ${key} as "${rebuilt.name}"`);
        meta = newMeta(key, rebuilt.name, null, rebuilt.createdAt);
        await writeJsonAtomic(dirs.tmp, join(dirs.files, key, "meta.json"), meta);
      }
      if (meta.folderId && !ws.folders.has(meta.folderId)) {
        log("warn", `file ${key} lost its folder; moving it to Drafts`);
        meta.folderId = null;
        await ws.saveMeta(meta);
      }
      ws.files.set(key, meta);
    }
    return ws;
  }
}
