/**
 * Folder colours for Home (folders, the sidebar, the list view). The ids are
 * the store's `FolderColor` (src/shared/store/types.ts, checked by a test);
 * each maps to a `--ds-color-folder-*` token, light and dark. "none" is the
 * plain folder glyph colour.
 */
export const FOLDER_COLOR_IDS = ["none", "red", "orange", "yellow", "green", "teal", "blue", "purple", "pink", "gray"] as const;
export type FolderColorId = (typeof FOLDER_COLOR_IDS)[number];

/** A CSS colour per id (a `var()`), for FolderCard / FolderGlyph `color` or any style. */
export const FOLDER_COLOR_VARS: Record<FolderColorId, string> = {
  none: "var(--figma-color-icon-secondary)",
  red: "var(--ds-color-folder-red)",
  orange: "var(--ds-color-folder-orange)",
  yellow: "var(--ds-color-folder-yellow)",
  green: "var(--ds-color-folder-green)",
  teal: "var(--ds-color-folder-teal)",
  blue: "var(--ds-color-folder-blue)",
  purple: "var(--ds-color-folder-purple)",
  pink: "var(--ds-color-folder-pink)",
  gray: "var(--ds-color-folder-gray)",
};

/** Menu wording ("Change color" submenu). */
export const FOLDER_COLOR_LABEL: Record<FolderColorId, string> = {
  none: "No color",
  red: "Red",
  orange: "Orange",
  yellow: "Yellow",
  green: "Green",
  teal: "Teal",
  blue: "Blue",
  purple: "Purple",
  pink: "Pink",
  gray: "Gray",
};

/** The colour for a stored id; undefined (the default glyph colour) for "none" or an unknown id. */
export function folderColor(id: string | null | undefined): string | undefined {
  return id && id !== "none" && id in FOLDER_COLOR_VARS ? FOLDER_COLOR_VARS[id as FolderColorId] : undefined;
}
