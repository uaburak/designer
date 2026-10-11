/** A folder's glyph in its colour (the DS's `--ds-color-folder-*` tokens); a team's square icon. */
import { FolderGlyph as DsFolderGlyph, folderColor, initials } from "@/ds";
import type { FolderColor } from "@shared/store/types";
import styles from "./Files.module.css";

export function FolderGlyph({ color, size = 24 }: { color: FolderColor; size?: 16 | 24 | 48 }) {
  return (
    <span data-folder-color={color} style={{ display: "inline-flex" }} aria-hidden>
      <DsFolderGlyph color={folderColor(color)} size={size} />
    </span>
  );
}

/**
 * A team's icon (1.png: the team page's 40 square, radius 5, its initial in white on green; the sidebar's 16 circle):
 * the team's uploaded icon when it has one.
 */
export function TeamIcon({ name, src, size = 16 }: { name: string; src?: string | null; size?: 16 | 24 | 40 }) {
  return (
    // The initial is drawn by CSS (attr): it isn't part of the row's text or its accessible name
    <span data-team-icon="" className={styles.teamIcon} data-size={size} data-initial={src ? undefined : initials(name, 1)} aria-hidden>
      {src && <img src={src} alt="" />}
    </span>
  );
}
