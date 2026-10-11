/**
 * Branches in Home, the pure part (help.figma.com "View and manage branches", docs/data.md §15.9): a main file's tile
 * carries the branch icon and its number of active branches, whose dropdown switches between the main file and its
 * branches (or creates one); a branch's own tile (Recents, Starred) reads "‹file› / ‹branch›" as the editor's title does.
 */
import type { MenuEntry } from "@/ds/util/menu";
import type { BranchRecord } from "@shared/merge/branches";
import type { FileListItem } from "@shared/store/types";
import { fileSubtitle, plural } from "./model";

/** The tile's dropdown: the main file, its active branches (newest first), then Create branch… and See all branches. */
export function branchSwitchMenu(rows: readonly BranchRecord[], opts: { canCreate: boolean }): MenuEntry[] {
  const branches = [...rows].filter((b) => b.status === "active").sort((a, b) => b.createdAt - a.createdAt);
  return [
    { id: "main", label: "Main file", checked: true },
    ...(branches.length ? (["-", { header: "Branches" }] as MenuEntry[]) : []),
    ...branches.map((b): MenuEntry => ({ id: `branch:${b.branchFileKey || b.branchKey}`, label: b.name })),
    "-",
    { id: "create", label: "Create branch…", disabled: !opts.canCreate },
    { id: "see-all", label: "See all branches" },
  ];
}

/** The branch a dropdown / modal id names */
export const branchOf = (rows: readonly BranchRecord[], id: string): BranchRecord | undefined => {
  const k = id.startsWith("branch:") ? id.slice(7) : id;
  return rows.find((b) => (b.branchFileKey || b.branchKey) === k);
};

/** "3 branches" (the count under the name) */
export const branchCountLabel = (n: number) => plural(n, "branch").replace(/branchs$/, "branches");

/** A branch's tile: "‹file› / ‹branch›" (R21 [guide]); its main's name unknown → the branch's name alone */
export function branchTileTitle(f: Pick<FileListItem, "name" | "branch">, mainName: string | null | undefined): string {
  if (!f.branch) return f.name;
  return mainName ? `${mainName} / ${f.branch.name}` : f.branch.name;
}

/** A branch's tile's second line: archived and merged ones say so ("Merged" / "Archived", as their badge) */
export function branchTileSubtitle(f: FileListItem, now = Date.now()): string {
  const base = fileSubtitle(f, now);
  if (!f.branch || f.branch.status === "active" || f.trashedAt !== null) return base;
  return `${f.branch.status === "merged" ? "Merged" : "Archived"} · ${base}`;
}

/** The main files of a listing whose branches Home counts: not branches, not in Trash. */
export const branchCountTargets = (files: readonly FileListItem[]): string[] => [...new Set(files.filter((f) => !f.branch && f.trashedAt === null).map((f) => f.fileKey))].sort();
