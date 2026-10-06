/**
 * Home's context menus, in Figma's wording and order (docs/home.md "Menus"). Pure: the entries for what was
 * right-clicked and the selection; FilesApp runs the picked id.
 */
import type { MenuEntry } from "@/ds/util/menu";
import { keys } from "@/ds/util/keys";
import { FOLDER_COLOR_IDS, FOLDER_COLOR_LABEL } from "@/ds/util/folderColor";
import type { FolderColor } from "@shared/store/types";
import type { Location } from "./model";

export type MenuId =
  | "open"
  | "open-new-tab"
  | "copy-link"
  | "star"
  | "unstar"
  | "duplicate"
  | "rename"
  | "move"
  | "remove-from-recents"
  | "trash"
  | "restore"
  | "delete-forever"
  | "new-folder"
  | "new-file"
  | "import"
  | "empty-trash"
  | `color:${FolderColor}`;

export interface MenuContext {
  location: Location;
  /** Selected files and folders (the right-clicked item is part of the selection) */
  files: number;
  folders: number;
  /** Every selected item is starred */
  allStarred: boolean;
  /** The single folder's colour, when one folder is selected */
  color?: FolderColor;
}

const item = (id: MenuId, label: string, extra: Partial<Exclude<MenuEntry, "-" | { header: string }>> = {}): MenuEntry => ({ id, label, ...extra });

/** Right-click on files and/or folders. */
export function itemMenu(ctx: MenuContext): MenuEntry[] {
  const n = ctx.files + ctx.folders;
  const one = n === 1;
  if (ctx.location.kind === "trash") {
    return [item("restore", "Restore"), "-", item("delete-forever", "Delete forever")];
  }
  const star = ctx.allStarred ? item("unstar", "Remove from starred") : item("star", "Add to starred");
  if (ctx.folders && !ctx.files) {
    return [
      item("open", "Open", { disabled: !one }),
      "-",
      item("new-folder", "New folder", { disabled: !one }),
      star,
      "-",
      item("rename", "Rename", { disabled: !one }),
      item("color:none", "Change color", { disabled: !one, items: FOLDER_COLOR_IDS.map((c) => item(`color:${c}`, FOLDER_COLOR_LABEL[c], { checked: ctx.color === c })) }),
      item("move", "Move to folder…"),
      "-",
      item("trash", "Move to trash", { shortcut: keys(["backspace"]) }),
    ];
  }
  return [
    item("open", "Open", { disabled: !!ctx.folders }),
    item("open-new-tab", "Open in new tab", { disabled: !!ctx.folders }),
    "-",
    item("copy-link", "Copy link", { disabled: !one }),
    "-",
    star,
    "-",
    item("duplicate", "Duplicate", { disabled: !!ctx.folders }),
    item("rename", "Rename", { disabled: !one }),
    item("move", "Move to folder…"),
    ...(ctx.location.kind === "recents" && !ctx.folders ? [item("remove-from-recents", "Remove from recents")] : []),
    "-",
    item("trash", "Move to trash", { shortcut: keys(["backspace"]) }),
  ];
}

/** Right-click on the empty area. */
export function blankMenu(location: Location, trashEmpty: boolean): MenuEntry[] {
  switch (location.kind) {
    case "trash":
      return [item("empty-trash", "Empty trash…", { disabled: trashEmpty })];
    case "folders":
      return [item("new-folder", "New folder")];
    case "folder":
      return [item("new-file", "New design file"), item("new-folder", "New folder"), "-", item("import", "Import…")];
    case "drafts":
    case "recents":
      return [item("new-file", "New design file"), "-", item("import", "Import…")];
    default:
      return [];
  }
}

/** Right-click on "All folders" in the sidebar. */
export const allFoldersMenu = (): MenuEntry[] => [item("new-folder", "New folder")];

/** Right-click on "Trash" in the sidebar. */
export const trashMenu = (trashEmpty: boolean): MenuEntry[] => [item("empty-trash", "Empty trash…", { disabled: trashEmpty })];
