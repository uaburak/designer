/**
 * The branching UI's state, one per editor: the open file's branch record (null on main or without a backend), main's
 * name for the "‹file› / ‹branch›" title, whether main changed since the base (the notice), and which branching
 * window is open. Kept here, not in UIState, so the shell holds no branching fields but round 10's `branchDialog`
 * (Create branch…).
 */
import { useCallback, useSyncExternalStore } from "react";
import type { BranchEvent, BranchRecord } from "../../../../shared/merge/branches";
import type { FileKey } from "../../../../shared/store/types";
import type { EditorController } from "../controller";
import { backendOf, type BranchingBackend } from "./access";

export type BranchWindow =
  | { kind: "branches"; tab: "active" | "archived" | "yours" }
  | { kind: "review"; branchFileKey: FileKey }
  | { kind: "update"; branchFileKey: FileKey };

export interface BranchingState {
  /** The file's own key */
  fileKey: FileKey | null;
  /** This file's branch record; null on main (or before it loaded) */
  record: BranchRecord | null;
  mainName: string | null;
  /** main's head moved past the branch's base (the notice) */
  mainChanged: boolean;
  /** The notice's × (until main changes again) */
  noticeDismissed: boolean;
  window: BranchWindow | null;
  /** Loaded once the backend answered (commands' enabled states wait for it) */
  loaded: boolean;
}

class StateStore {
  private value: BranchingState = { fileKey: null, record: null, mainName: null, mainChanged: false, noticeDismissed: false, window: null, loaded: false };
  private readonly listeners = new Set<() => void>();
  get = () => this.value;
  set(patch: Partial<BranchingState>) {
    this.value = { ...this.value, ...patch };
    this.listeners.forEach((l) => l());
  }
  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  };
}

const stores = new WeakMap<EditorController, StateStore>();
export function branchingStore(ed: EditorController): StateStore {
  let s = stores.get(ed);
  if (!s) stores.set(ed, (s = new StateStore()));
  return s;
}

export const branching = (ed: EditorController) => branchingStore(ed).get();
export const setBranching = (ed: EditorController, patch: Partial<BranchingState>) => branchingStore(ed).set(patch);
export const openBranchWindow = (ed: EditorController, w: BranchWindow | null) => setBranching(ed, { window: w });

export function useBranching<S>(ed: EditorController, select: (s: BranchingState) => S): S {
  const store = branchingStore(ed);
  const get = useCallback(() => select(store.get()), [store, select]);
  return useSyncExternalStore(store.subscribe, get);
}

/** The editor's file key, from its document source (the store's), else null. */
export const fileKeyOf = (ed: EditorController): FileKey | null => (ed.source as { fileKey?: FileKey }).fileKey ?? null;

/**
 * Loads the file's branch record and main's state, then follows the repository's events. Returns the unsubscribe.
 * Without a backend or a file key nothing happens (the file is plain main).
 */
export function attachBranching(ed: EditorController, backend: BranchingBackend | null = backendOf(ed)): () => void {
  const fileKey = fileKeyOf(ed);
  if (!backend || !fileKey) {
    setBranching(ed, { fileKey, loaded: true });
    return () => {};
  }
  let live = true;
  setBranching(ed, { fileKey });
  const take = async (record: BranchRecord | null) => {
    if (!live) return;
    if (!record || record.branchFileKey !== fileKey) {
      setBranching(ed, { record: null, loaded: true });
      return;
    }
    const prev = branching(ed);
    const mainName = prev.record?.mainFileKey === record.mainFileKey && prev.mainName ? prev.mainName : await backend.fileName(record.mainFileKey);
    const status = record.status === "active" ? await backend.branches.mainStatus(fileKey).catch(() => null) : null;
    if (!live) return;
    setBranching(ed, { record, mainName, mainChanged: !!status?.changed, loaded: true });
  };
  void backend.branches
    .get(fileKey)
    .then(take)
    .catch(() => live && setBranching(ed, { loaded: true }));
  const off = backend.branches.watch((e: BranchEvent) => {
    if (!live) return;
    if (e.type === "branch.main-changed") {
      if (e.branchFileKey === fileKey) setBranching(ed, { mainChanged: true, noticeDismissed: false });
      return;
    }
    if (e.branch.branchFileKey === fileKey) void take(e.branch);
  });
  return () => {
    live = false;
    off();
  };
}

/** Re-reads the record (after an action the events may not have reached yet). */
export async function refreshBranch(ed: EditorController): Promise<void> {
  const backend = backendOf(ed);
  const fileKey = branching(ed).fileKey;
  if (!backend || !fileKey) return;
  const record = await backend.branches.get(fileKey).catch(() => null);
  if (!record) return;
  const status = record.status === "active" ? await backend.branches.mainStatus(fileKey).catch(() => null) : null;
  setBranching(ed, { record, mainChanged: !!status?.changed });
}

/** The open file is an active branch (its branch items show; publishing is off). */
export const isBranch = (ed: EditorController) => branching(ed).record !== null;
export const isActiveBranch = (ed: EditorController) => branching(ed).record?.status === "active";
