/**
 * The store's view of the workspace for Home: the records the current location needs, reloaded whenever the
 * workspace's watch reports a change (another view renamed a file, the editor saved a thumbnail, a tab trashed…).
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { WorkspaceRepository } from "@shared/store/repositories";
import type { FileListItem, Folder, FolderId, Prefs, Workspace } from "@shared/store/types";
import { FolderIndex, fileQuery, type Location } from "./model";

export interface WorkspaceData {
  /** The first load finished */
  ready: boolean;
  error: string | null;
  workspace: Workspace | null;
  prefs: Prefs | null;
  /** Every folder, trashed ones included */
  folders: Folder[];
  /** The location's files */
  files: FileListItem[];
  /** For the sidebar's Starred group */
  starredFiles: FileListItem[];
  /** Live files directly in each live folder */
  counts: Record<FolderId, number>;
  /** The four most recently edited files of each live folder (its card's previews) */
  previews: Record<FolderId, FileListItem[]>;
  /** The location the files belong to */
  location: Location | null;
  /** When this was loaded (relative times start from here) */
  loadedAt: number;
}

const EMPTY: WorkspaceData = { ready: false, error: null, workspace: null, prefs: null, folders: [], files: [], starredFiles: [], counts: {}, previews: {}, location: null, loadedAt: 0 };

/** At most this many folders get a file count per reload. */
const MAX_COUNTED = 200;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function loadWorkspaceData(repo: WorkspaceRepository, location: Location): Promise<WorkspaceData> {
  const q = fileQuery(location);
  // A location's own query may fail (its folder was deleted forever) while the rest still loads.
  let error: string | null = null;
  const [workspace, prefs, folders, files, starredFiles] = await Promise.all([
    repo.getWorkspace(),
    repo.getPrefs(),
    repo.listFolders(),
    q ? repo.listFiles(q).catch((e) => ((error = message(e)), [] as FileListItem[])) : Promise.resolve([]),
    repo.listFiles({ in: "starred" }),
  ]);
  const index = new FolderIndex(folders);
  const live = folders.filter((f) => !index.hidden(f.id)).slice(0, MAX_COUNTED);
  const lists = await Promise.all(live.map((f) => repo.listFiles({ in: "folder", folderId: f.id }).then((l) => [f.id, l] as const, () => [f.id, [] as FileListItem[]] as const)));
  const counts = Object.fromEntries(lists.map(([id, l]) => [id, l.length]));
  const previews = Object.fromEntries(lists.map(([id, l]) => [id, [...l].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 4)]));
  return { ready: true, error, workspace, prefs, folders, files, starredFiles, counts, previews, location, loadedAt: Date.now() };
}

export function useWorkspaceData(repo: WorkspaceRepository | null, location: Location): { data: WorkspaceData; reload: () => void; setPrefs: (p: Prefs) => void } {
  const [data, setData] = useState<WorkspaceData>(EMPTY);
  const seq = useRef(0);
  const locRef = useRef(location);
  useLayoutEffect(() => {
    locRef.current = location;
  });

  const reload = useCallback(() => {
    if (!repo) return;
    const mine = ++seq.current;
    loadWorkspaceData(repo, locRef.current).then(
      (d) => mine === seq.current && setData(d),
      (e) => mine === seq.current && setData((cur) => ({ ...cur, ready: true, error: message(e) })),
    );
  }, [repo]);

  // A new location: load it now.
  const key = JSON.stringify(location);
  useEffect(() => {
    reload();
  }, [reload, key]);

  // Live updates: coalesce a burst of events (a folder trash emits one per file) into one reload.
  useEffect(() => {
    if (!repo) return;
    let timer: number | undefined;
    const off = repo.watch(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(reload, 16);
    });
    return () => {
      window.clearTimeout(timer);
      off();
    };
  }, [repo, reload]);

  const setPrefs = useCallback((prefs: Prefs) => setData((cur) => ({ ...cur, prefs })), []);
  return { data, reload, setPrefs };
}
