/**
 * Home's one door to the workspace (docs/home.md "Data flow"): the data layer's helper (`@/store`) — the store
 * process's client in the desktop app (the port main brokers), the dev store (localStorage, seeded with demo files)
 * in a plain browser. Everything Home reads or changes goes through `workspace`; tests pass their own backend.
 */
import { getStoreClient, storeMode, thumbnailUrl } from "@/store";
import type { WorkspaceRepository } from "@shared/store/repositories";
import type { FileListItem, FileMeta, FolderId } from "@shared/store/types";

export interface FilesBackend {
  workspace: WorkspaceRepository;
  /** "store": the store process (desktop); "dev": the browser's dev store; "memory": a test double */
  source: "store" | "dev" | "memory";
  /** The card's image, or null for an empty thumbnail */
  thumbnailUrl(file: FileListItem): string | null;
  /** A `.fig` from a file input or a drop (bytes, no path): `files.importFigBytes` */
  importFigBytes?: (file: File, folderId: FolderId | null) => Promise<FileMeta>;
}

let shared: FilesBackend | null = null;

export function filesBackend(): Promise<FilesBackend> {
  const client = getStoreClient();
  shared ??= {
    workspace: client.workspace,
    source: storeMode() === "desktop" ? "store" : "dev",
    thumbnailUrl: (f) => thumbnailUrl(f),
    importFigBytes: async (file, folderId) => client.files.importFigBytes(new Uint8Array(await file.arrayBuffer()), file.name, folderId),
  };
  return Promise.resolve(shared);
}
