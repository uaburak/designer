/** A folder's glyph in its colour (the DS's `--ds-color-folder-*` tokens). */
import { FolderGlyph as DsFolderGlyph, folderColor } from "@/ds";
import type { FolderColor } from "@shared/store/types";

export function FolderGlyph({ color, size = 24 }: { color: FolderColor; size?: 16 | 24 | 48 }) {
  return (
    <span data-folder-color={color} style={{ display: "inline-flex" }} aria-hidden>
      <DsFolderGlyph color={folderColor(color)} size={size} />
    </span>
  );
}
