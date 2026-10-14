/**
 * The branch items of the Figma menu's File submenu and the file name menu (R21 "Where the items live"): Create
 * branch… on main; Update from main…, Review and merge changes…, Archive on an active branch; See all branches on both.
 */
import type { MenuEntry } from "@/ds";
import { showToast } from "@/ds";
import { t } from "@/i18n";
import type { EditorCommand } from "../commands";
import type { EditorController } from "../controller";
import { fileOps } from "../objectCommands";
import { backendOf } from "./access";
import { branching, isActiveBranch, isBranch, openBranchWindow, refreshBranch } from "./state";

const hasBackend = (ed: EditorController) => !!backendOf(ed) && branching(ed).fileKey !== null;

export const BRANCH_COMMANDS: EditorCommand[] = [
  // Round 10's dialog flag (ui.branchDialog); the dialog is branching/CreateBranch.tsx. Not on a branch (no branches of
  // branches, docs/data.md §15.5).
  { id: "file.create-branch", label: "Create branch…", run: (ed) => ed.ui.set({ branchDialog: true, uiHidden: false }), enabled: (ed) => !!fileOps(ed) && !isBranch(ed) },
  { id: "file.see-all-branches", label: "See all branches", run: (ed) => openBranchWindow(ed, { kind: "branches", tab: "active" }), enabled: hasBackend },
  {
    id: "file.update-from-main",
    label: "Update from main…",
    run: (ed) => {
      const b = branching(ed).record;
      if (b) openBranchWindow(ed, { kind: "update", branchFileKey: b.branchFileKey });
    },
    enabled: isActiveBranch,
  },
  {
    id: "file.review-and-merge",
    label: "Review and merge changes…",
    run: (ed) => {
      const b = branching(ed).record;
      if (b) openBranchWindow(ed, { kind: "review", branchFileKey: b.branchFileKey });
    },
    enabled: isActiveBranch,
  },
  { id: "file.archive-branch", label: "Archive", run: (ed) => void archiveThisBranch(ed), enabled: isActiveBranch },
];

async function archiveThisBranch(ed: EditorController): Promise<void> {
  const b = branching(ed).record;
  const backend = backendOf(ed);
  if (!b || !backend) return;
  try {
    await backend.branches.archive(b.branchFileKey);
    await refreshBranch(ed);
    showToast({ message: t("Branch archived") });
  } catch (e) {
    showToast({ kind: "error", message: t("Couldn’t archive the branch: {error}", { error: e instanceof Error ? e.message : String(e) }) });
  }
}

/**
 * The file name menu's branch rows (R21): on main "Create branch…" and "See all branches"; on a branch "Update from
 * main…", "Review and merge changes…", "See all branches", "Archive". `item` is menus.ts `commandItem`.
 */
export function branchMenuIds(ed: EditorController): string[] {
  if (isBranch(ed)) return isActiveBranch(ed) ? ["file.update-from-main", "file.review-and-merge", "file.see-all-branches", "file.archive-branch"] : ["file.see-all-branches"];
  return hasBackend(ed) ? ["file.create-branch", "file.see-all-branches"] : ["file.create-branch"];
}

export function branchMenuEntries(ed: EditorController, item: (ed: EditorController, id: string) => MenuEntry): MenuEntry[] {
  return ["-", ...branchMenuIds(ed).map((id) => item(ed, id))];
}
