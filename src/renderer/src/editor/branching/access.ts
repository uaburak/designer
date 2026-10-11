/**
 * How the branching UI reaches the store (docs/data.md §15.6): `StoreApi.branches` (round 2a), over the store port.
 *
 * `BranchingBackend` is the repository plus what the UI needs around it: file names, people who can review, who the
 * viewer is, opening a file and a branch's link. Tests set their own (`setBranchingBackend`, `fake/`).
 */
import type { StoreApi } from "../../../../shared/store/repositories";
import type { FileKey } from "../../../../shared/store/types";
import type { BranchesRepository, BranchRecord } from "../../../../shared/merge/branches";
import type { EditorController } from "../controller";
import { getStoreClient } from "@/store";
import { fileOps } from "../objectCommands";
import { branchLink } from "./model";

export interface Reviewer {
  userId: string;
  name: string | null;
  email: string;
}

export interface BranchingBackend {
  branches: BranchesRepository;
  /** A file's name (main's, for the "‹file› / ‹branch›" title) */
  fileName(fileKey: FileKey): Promise<string | null>;
  /** People who can edit main: the suggested reviewers ([request]); the viewer is left out */
  reviewers(mainFileKey: FileKey): Promise<Reviewer[]>;
  /** The viewer (null id: signed out — the local user) */
  me(): Promise<{ id: string | null; name: string | null }>;
  /** Whether the viewer can edit main (merges; others request a review) */
  canEditMain(mainFileKey: FileKey): Promise<boolean>;
  openFile(fileKey: FileKey): Promise<void>;
  /** The branch's link; null for a local file (no links) */
  link(branch: BranchRecord): Promise<string | null>;
}

/** The store's branches repository (StoreApi.branches, round 2a); null without a store. */
export function getBranches(store: Pick<StoreApi, "branches"> | null | undefined): BranchesRepository | null {
  return store?.branches ?? null;
}

const backends = new WeakMap<EditorController, BranchingBackend | null>();

/** Tests and the dev playground: this editor's backend (null: none). */
export function setBranchingBackend(ed: EditorController, backend: BranchingBackend | null): void {
  backends.set(ed, backend);
}

type DesktopNav = { designer?: { nav?: { openFile?: (fileKey: string) => Promise<unknown> }; account?: { get(): Promise<{ user: { id: string; name: string | null } | null }> } } };
const desktop = () => (typeof window === "undefined" ? undefined : (window as unknown as DesktopNav).designer);

/** The editor's backend: the one set for it, else the store's when its file lives in the workspace and it has branches. */
export function backendOf(ed: EditorController): BranchingBackend | null {
  if (backends.has(ed)) return backends.get(ed) ?? null;
  const backend = fileOps(ed) ? storeBackend() : null;
  backends.set(ed, backend);
  return backend;
}

function storeBackend(): BranchingBackend | null {
  const store: StoreApi = getStoreClient();
  const branches = getBranches(store);
  if (!branches) return null;
  return {
    branches,
    fileName: async (fileKey) => (await store.workspace.getFile(fileKey).catch(() => null))?.name ?? null,
    reviewers: async (mainFileKey) => {
      const [me, members] = await Promise.all([meOf(), store.multiplayer.members(mainFileKey).catch(() => [])]);
      return members
        .filter((m) => m.userId && !m.pending && m.userId !== me.id && (m.role === "owner" || m.role === "editor"))
        .map((m) => ({ userId: m.userId!, name: m.name, email: m.email }));
    },
    me: meOf,
    canEditMain: async (mainFileKey) => {
      const state = await store.multiplayer.fileState(mainFileKey).catch(() => null);
      return !state?.shared || state.role !== "viewer";
    },
    openFile: async (fileKey) => {
      await desktop()?.nav?.openFile?.(fileKey);
    },
    link: async (b) => {
      if (!b.branchKey) return null;
      const info = await store.multiplayer.fileInfo(b.mainFileKey).catch(() => null);
      return info?.link ? branchLink(info.link, b.branchKey) : null;
    },
  };
}

async function meOf(): Promise<{ id: string | null; name: string | null }> {
  const s = await desktop()?.account?.get().catch(() => null);
  return { id: s?.user?.id ?? null, name: s?.user?.name ?? null };
}
