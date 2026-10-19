/**
 * Home's one door to the workspace (docs/home.md "Data flow"): the data layer's helper (`@/store`) — the store
 * process's client in the desktop app (the port main brokers), the dev store (localStorage, seeded with demo files)
 * in a plain browser. Everything Home reads or changes goes through `workspace` (the local space) and `org` (the
 * organizations' spaces, docs/multiplayer.md §14.6); tests pass their own backend.
 */
import { getStoreClient, mergedDocument, messageToKiwi, storeMode, thumbnailUrl } from "@/store";
import { encodeMessage } from "@shared/schema/codec";
import type { AdminRepository, FileRepository, OrgsRepository, ProjectsRepository, TeamsRepository, WorkspaceRepository } from "@shared/store/repositories";
import type { FileKey, FileListItem, FileMeta, FolderId, OrgImportPlace } from "@shared/store/types";
import type { BranchesRepository } from "@shared/merge/branches";
import type { LibraryAnalyticsRepository, OrgLibrariesRepository } from "@shared/libraries/orgTypes";
import type { SharedFontsApi } from "@shared/desktop";
import type { GovernanceRepository, IdentityRepository } from "@shared/org/repositories";
import type { PluginsRepository } from "@shared/plugins/types";
import type { SessionEnded } from "@shared/multiplayer/types";
import type { CloudRepository } from "@shared/store/cloud";
import { exportAllowedFor } from "./governance";
import type { UploadSource } from "../uploads/UploadPanel";
import { openSharedFile, type SharedSource } from "./SharedFiles";

/** The org spaces (StoreApi.orgs / teams / projects / admin) and the two calls Home adds around them. */
export interface OrgBackend {
  orgs: OrgsRepository;
  teams: TeamsRepository;
  projects: ProjectsRepository;
  admin: AdminRepository;
  /** An org file's local copy: made from its room the first time (`multiplayer.openShared`), linked after */
  openShared(key: string, opts?: { early?: boolean }): Promise<{ fileKey: FileKey }>;
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
  /** Governance+ (docs/governance.md §4): Home's gates (acknowledgePolicy) and Admin; absent: policies can't be agreed to */
  governance?: GovernanceRepository;
}

export interface FilesBackend {
  workspace: WorkspaceRepository;
  /** "store": the store process (desktop); "dev": the browser's dev store; "memory": a test double */
  source: "store" | "dev" | "memory";
  /** The card's image, or null for an empty thumbnail */
  thumbnailUrl(file: FileListItem): string | null;
  /** A `.fig` from a file input or a drop (bytes, no path): `files.importFigBytes`; `org`: into that org's Drafts or
   *  folder (an org file, uploaded with the upload panel showing it) instead of the local `folderId` */
  importFigBytes?: (file: File, folderId: FolderId | null, org?: OrgImportPlace | null) => Promise<FileMeta>;
  /** Absent: no organizations (Home shows the local space only) */
  org?: OrgBackend;
  /** Branches (docs/data.md §15): the tiles' counts, their dropdown and the Branches modal; absent: none shown */
  branches?: BranchesRepository;
  /** The server ended the session (`multiplayer.watchSession`, docs/multiplayer.md §15.18): Home signs out and says why */
  watchSession?: (listener: (e: SessionEnded) => void) => () => void;
  /**
   * Whether the person may duplicate or save a local copy of a file (docs/governance.md §2.7: false for a shared
   * file's viewer the file's export setting restricts); absent: always
   */
  exportAccess?: (fileKey: FileKey) => Promise<boolean>;
  /** Uploads to the server, for the upload panel (`multiplayer.uploads` and its topic, docs/multiplayer.md §5.1); absent: no panel */
  uploads?: UploadSource;
  /** Personal Drafts in the cloud (docs/cloud.md §2): signed in, the personal space is the person's Drafts and Trash;
   *  absent or no account: the local workspace's team, folders and Drafts */
  cloud?: CloudRepository;
  /** Home › Shared (SharedFiles.tsx): the files shared with the person and by them; absent: the page says so */
  shared?: SharedSource;
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
    importFigBytes: async (file, folderId, org) => client.files.importFigBytes(new Uint8Array(await file.arrayBuffer()), file.name, folderId, org ?? null),
    org: {
      orgs: client.orgs,
      teams: client.teams,
      projects: client.projects,
      admin: client.admin,
      openShared: (key, opts) => client.multiplayer.openShared(key, undefined, undefined, opts),
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
    exportAccess: (fileKey) => exportAllowedFor(client.multiplayer, fileKey),
    uploads: client.multiplayer,
    cloud: client.cloud,
    shared: {
      list: () => client.multiplayer.listRemote(),
      open: (key, intent) => openSharedFile(key, intent),
      thumbnail: (fileKey) => client.workspace.getFile(fileKey).then((f) => thumbnailUrl(f), () => null),
    },
  };
  return Promise.resolve(shared);
}
