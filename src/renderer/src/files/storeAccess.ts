/**
 * Home's one door to the workspace (docs/home.md "Data flow"): the data layer's helper (`@/store`) — the store
 * process's client in the desktop app (the port main brokers), the dev store (localStorage, seeded with demo files)
 * in a plain browser. Everything Home reads or changes goes through `workspace` (the local space) and `org` (the
 * organizations' spaces, docs/multiplayer.md §14.6); tests pass their own backend.
 */
import { getStoreClient, mergedDocument, messageToKiwi, storeMode, thumbnailUrl } from "@/store";
import { encodeMessage } from "@shared/schema/codec";
import type { AdminRepository, FileRepository, OrgsRepository, ProjectsRepository, TeamsRepository, WorkspaceRepository } from "@shared/store/repositories";
import type { FileKey, FileListItem, FileMeta, FolderId } from "@shared/store/types";
import type { BranchesRepository } from "@shared/merge/branches";

/** The org spaces (StoreApi.orgs / teams / projects / admin) and the two calls Home adds around them. */
export interface OrgBackend {
  orgs: OrgsRepository;
  teams: TeamsRepository;
  projects: ProjectsRepository;
  admin: AdminRepository;
  /** An org file's local copy: made from its room the first time (`multiplayer.openShared`), linked after */
  openShared(key: string): Promise<{ fileKey: FileKey }>;
  /** A local file's whole document and its head seq, for "Move to" a folder (§14.6: the snapshot goes up with it) */
  snapshotOf(fileKey: FileKey): Promise<{ snapshot: Uint8Array; headSeq: number }>;
}

export interface FilesBackend {
  workspace: WorkspaceRepository;
  /** "store": the store process (desktop); "dev": the browser's dev store; "memory": a test double */
  source: "store" | "dev" | "memory";
  /** The card's image, or null for an empty thumbnail */
  thumbnailUrl(file: FileListItem): string | null;
  /** A `.fig` from a file input or a drop (bytes, no path): `files.importFigBytes` */
  importFigBytes?: (file: File, folderId: FolderId | null) => Promise<FileMeta>;
  /** Absent: no organizations (Home shows the local space only) */
  org?: OrgBackend;
  /** Branches (docs/data.md §15): the tiles' counts, their dropdown and the Branches modal; absent: none shown */
  branches?: BranchesRepository;
}

/** The store's snapshot with its journal applied, as one kiwi Message (the editor hands the same to `multiplayer.share`). */
export async function localSnapshot(files: Pick<FileRepository, "open">, fileKey: FileKey): Promise<{ snapshot: Uint8Array; headSeq: number }> {
  const opened = await files.open(fileKey, { mode: "view" });
  if (!opened.journal.length) return { snapshot: opened.snapshot, headSeq: opened.headSeq };
  return { snapshot: encodeMessage(messageToKiwi(mergedDocument(opened))), headSeq: opened.headSeq };
}

let shared: FilesBackend | null = null;

export function filesBackend(): Promise<FilesBackend> {
  const client = getStoreClient();
  shared ??= {
    workspace: client.workspace,
    source: storeMode() === "desktop" ? "store" : "dev",
    thumbnailUrl: (f) => thumbnailUrl(f),
    importFigBytes: async (file, folderId) => client.files.importFigBytes(new Uint8Array(await file.arrayBuffer()), file.name, folderId),
    org: {
      orgs: client.orgs,
      teams: client.teams,
      projects: client.projects,
      admin: client.admin,
      openShared: (key) => client.multiplayer.openShared(key),
      snapshotOf: (fileKey) => localSnapshot(client.files, fileKey),
    },
    branches: client.branches,
  };
  return Promise.resolve(shared);
}
