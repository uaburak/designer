/**
 * Home's context menus, in Figma's wording and order (docs/home.md "Menus"). Pure: the entries for what was
 * right-clicked and the selection; FilesApp runs the picked id.
 */
import type { MenuEntry } from "@/ds/util/menu";
import { keys } from "@/ds/util/keys";
import { FOLDER_COLOR_IDS, FOLDER_COLOR_LABEL } from "@/ds/util/folderColor";
import type { FolderColor } from "@shared/store/types";
import { t } from "@/i18n";
import type { Location } from "./model";

export type MenuId =
  | "open"
  | "open-new-tab"
  | "copy-link"
  | "star"
  | "unstar"
  | "duplicate"
  | "convert-to-social"
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
  | "file-settings"
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
  /** A selected file is shared with the person as a viewer who may not export it (docs/governance.md §2.7): no Duplicate */
  exportRestricted?: boolean;
  /** False: nowhere to move files to (personal Drafts are flat and the person is in no organization — docs/cloud.md §2) */
  canMove?: boolean;
  /** File settings… is offered (the backend has it) */
  fileSettings?: boolean;
  /** Convert to Social file… is offered: one Design file (docs/social.md §18.1) */
  convertToSocial?: boolean;
}

const item = (id: MenuId, label: string, extra: Partial<Exclude<MenuEntry, "-" | { header: string }>> = {}): MenuEntry => ({ id, label, ...extra });

/** Right-click on files and/or folders. */
export function itemMenu(ctx: MenuContext): MenuEntry[] {
  const n = ctx.files + ctx.folders;
  const one = n === 1;
  if (ctx.location.kind === "trash") {
    return [item("restore", t("Restore")), "-", item("delete-forever", t("Delete forever"))];
  }
  const star = ctx.allStarred ? item("unstar", t("Remove from starred")) : item("star", t("Add to starred"));
  if (ctx.folders && !ctx.files) {
    return [
      item("open", t("Open"), { disabled: !one }),
      "-",
      item("new-folder", t("New folder"), { disabled: !one }),
      star,
      "-",
      item("rename", t("Rename"), { disabled: !one }),
      item("color:none", t("Change color"), { disabled: !one, items: FOLDER_COLOR_IDS.map((c) => item(`color:${c}`, t(FOLDER_COLOR_LABEL[c]), { checked: ctx.color === c })) }),
      item("move", t("Move to folder…")),
      "-",
      item("trash", t("Move to trash"), { shortcut: keys(["backspace"]) }),
    ];
  }
  return [
    item("open", t("Open"), { disabled: !!ctx.folders }),
    item("open-new-tab", t("Open in new tab"), { disabled: !!ctx.folders }),
    "-",
    item("copy-link", t("Copy link"), { disabled: !one }),
    "-",
    star,
    "-",
    item("duplicate", t("Duplicate"), { disabled: !!ctx.folders || !!ctx.exportRestricted }),
    ...(ctx.convertToSocial && one && !ctx.folders ? [item("convert-to-social", t("Convert to Social file…"))] : []),
    item("rename", t("Rename"), { disabled: !one }),
    ...(ctx.canMove === false ? [] : [item("move", t("Move to folder…"))]),
    ...(ctx.location.kind === "recents" && !ctx.folders ? [item("remove-from-recents", t("Remove from recents"))] : []),
    "-",
    // Ours (docs/home.md "File settings [ours]"): one file's details, storage, people, activity and options
    ...(ctx.fileSettings && one && !ctx.folders ? [item("file-settings", t("File settings…")), "-" as const] : []),
    item("trash", t("Move to trash"), { shortcut: keys(["backspace"]) }),
  ];
}

/** Right-click on the empty area. */
export function blankMenu(location: Location, trashEmpty: boolean): MenuEntry[] {
  switch (location.kind) {
    case "trash":
      return [item("empty-trash", t("Empty trash…"), { disabled: trashEmpty })];
    case "folders":
      return [item("new-folder", t("New folder"))];
    case "folder":
      return [item("new-file", t("New design file")), item("new-folder", t("New folder")), "-", item("import", t("Import…"))];
    case "drafts":
    case "recents":
      return [item("new-file", t("New design file")), "-", item("import", t("Import…"))];
    default:
      return [];
  }
}

/** Right-click on "All folders" in the sidebar. */
export const allFoldersMenu = (): MenuEntry[] => [item("new-folder", t("New folder"))];

/** Right-click on "Trash" in the sidebar. */
export const trashMenu = (trashEmpty: boolean): MenuEntry[] => [item("empty-trash", t("Empty trash…"), { disabled: trashEmpty })];
