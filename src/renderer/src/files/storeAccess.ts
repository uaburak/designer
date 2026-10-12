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
import type { LibraryAnalyticsRepository, OrgLibrariesRepository } from "@shared/libraries/orgTypes";
import type { SharedFontsApi } from "@shared/desktop";
import type { GovernanceRepository, IdentityRepository } from "@shared/org/repositories";
import type { PluginsRepository } from "@shared/plugins/types";
import type { SessionEnded } from "@shared/multiplayer/types";

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
  /** Libraries in the org (docs/data.md §16): the team's libraries, which files are libraries; absent: not shown */
  orgLibraries?: OrgLibrariesRepository;
  /** Library analytics (§17): All teams › Libraries, a library's Library analytics */
  analytics?: LibraryAnalyticsRepository;
  /** Team fonts through main (docs/desktop.md §14.3; Home's preload `designer.fonts`); absent in a browser */
  fonts?: SharedFontsApi;
  /** Admin › Settings › Login and provisioning, Data storage localization (docs/multiplayer.md §15.18); absent: unavailable */
  identity?: IdentityRepository;
  /** Admin › Settings › Extensions and Resources › Plugins / Widgets (docs/plugins.md §10); absent: unavailable */
  plugins?: PluginsRepository;
  /** Governance+ (docs/governance.md §4): the members' policy calls Home's gates use; absent: policies can't be agreed to */
  governance?: Pick<GovernanceRepository, "acknowledgePolicy">;
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
  /** The server ended the session (`multiplayer.watchSession`, docs/multiplayer.md §15.18): Home signs out and says why */
  watchSession?: (listener: (e: SessionEnded) => void) => () => void;
}

/** The store's snapshot with its journal applied, as one kiwi Message (the editor hands the same to `multiplayer.share`). */
export async function localSnapshot(files: Pick<FileRepository, "open">, fileKey: FileKey): Promise<{ snapshot: Uint8Array; headSeq: number }> {
  const opened = await files.open(fileKey, { mode: "view" });
  if (!opened.journal.length) return { snapshot: opened.snapshot, headSeq: opened.headSeq };
  return { snapshot: encodeMessage(messageToKiwi(mergedDocument(opened))), headSeq: opened.headSeq };
}

/** Home's preload fonts API when it has the shared-font channels (the desktop app), else undefined */
function sharedFontsBridge(): SharedFontsApi | undefined {
  if (typeof window === "undefined") return undefined;
  const fonts = (window as unknown as { designer?: { fonts?: Partial<SharedFontsApi> } }).designer?.fonts;
  return fonts?.sharedList && fonts.sharedPick && fonts.sharedUpload && fonts.sharedRemove ? (fonts as SharedFontsApi) : undefined;
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
      orgLibraries: client.orgLibraries,
      analytics: client.analytics,
      fonts: sharedFontsBridge(),
      identity: client.identity,
      plugins: client.plugins,
      governance: client.governance,
    },
    branches: client.branches,
    watchSession: (listener) => client.multiplayer.watchSession(listener),
  };
  return Promise.resolve(shared);
}
