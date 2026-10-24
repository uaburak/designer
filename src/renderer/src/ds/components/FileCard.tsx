import { useRef } from "react";
import { Icon } from "../icons/Icon";
import { STRINGS } from "../strings";
import { t, useT } from "@/i18n";
import { IconButton } from "./Button";
import { TextInput } from "./TextInput";
import styles from "./FileCard.module.css";

export interface FileCardProps {
  id: string;
  title: string;
  /** "Edited 2 hours ago" */
  subtitle: string;
  /** A thumbnail URL */
  thumbnail?: string;
  starred?: boolean;
  selected?: boolean;
  renaming?: boolean;
  onOpen?: () => void;
  onSelect?: (e: React.MouseEvent | React.KeyboardEvent) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  onRename?: (name: string | null) => void;
  onStar?: (starred: boolean) => void;
  forceHover?: boolean;
  /**
   * A main file with branches (help.figma.com "View and manage branches"): the branch icon at the tile's top left and
   * the number of branches under the name, a dropdown to switch to one of them.
   */
  branches?: { count: number; onMenu: (e: React.MouseEvent<HTMLElement>) => void };
  /** A branch's own tile (Recents, Starred): the branch icon at its top left */
  branch?: boolean;
  /** A short state at the thumbnail's bottom left (Home offline: "Available offline", docs/cloud.md §2) */
  badge?: string;
  /** Where it lives, at the thumbnail's top left (All projects: its team, or "Drafts") */
  place?: string;
  /** The file's kind, beside `place` (a Social file: "Social" — docs/social.md §18; a Design file: none) */
  kind?: string;
}

function CardRename({ value, onDone }: { value: string; onDone: (name: string | null) => void }) {
  useT();
  const committed = useRef<string | null>(null);
  return <TextInput label={t(STRINGS.rename)} value={value} autoFocus onCommit={(v) => (committed.current = v.trim() ? v : null)} onExit={(r) => onDone(r === "escape" ? null : committed.current)} />;
}

/**
 * A file's kind as Figma marks it in Home (cards, rows, the sidebar): a 16px brand square with the design glyph in white;
 * a Social file (`kind` "buzz", docs/social.md §18) the Social glyph.
 */
export function FileKindIcon({ size = 16, kind }: { size?: 16 | 20 | 24; kind?: string }) {
  return (
    <span data-ds="FileKindIcon" data-kind={kind === "buzz" ? "social" : undefined} className={styles.kindBadge} style={{ width: size, height: size }} aria-hidden>
      <Icon name={kind === "buzz" ? "24.social" : "16.design"} size={Math.round(size * 0.75)} />
    </span>
  );
}

/**
 * Home's file card (contract §4.27, as the owner designed it on 2026-10-19 —
 * docs/research/figma/live/owner-2026-10-19): 260×208 at the least, radius 9,
 * the thumbnail over a 60 high footer — the title (11/550) over when it was
 * edited (11, secondary; `formatEdited`), 16 in, no kind badge; the star box
 * at the thumbnail's top right; a 1px ring, 2px grey on hover, 2px blue when
 * selected. Enter opens, Space selects.
 */
export function FileCard({ id, title, subtitle, thumbnail, starred, selected, renaming, onOpen, onSelect, onContextMenu, onRename, onStar, forceHover, branches, branch, badge, place, kind }: FileCardProps) {
  useT();
  const hasBranches = !!branches && branches.count > 0;
  return (
    <div
      role="option"
      data-ds="FileCard"
      data-id={id}
      data-collection-item=""
      aria-selected={Boolean(selected)}
      aria-label={title}
      tabIndex={0}
      data-hover={forceHover || undefined}
      className={styles.card}
      onClick={onSelect}
      onDoubleClick={onOpen}
      onContextMenu={onContextMenu}
      onKeyDown={(e) => {
        if (renaming) return;
        if (e.key === "Enter") {
          e.preventDefault();
          onOpen?.();
        } else if (e.key === " ") {
          e.preventDefault();
          onSelect?.(e);
        }
      }}
    >
      <div className={styles.thumb}>
        {thumbnail && <img src={thumbnail} alt="" draggable={false} />}
        {badge && (
          <span className={styles.stateBadge} data-card-badge="">
            {badge}
          </span>
        )}
        {(hasBranches || branch || place || kind) && (
          <span className={styles.topLeft}>
            {(hasBranches || branch) && (
              <span className={styles.branchIcon} data-branch-icon="" aria-hidden>
                <Icon name="16.branch" />
              </span>
            )}
            {place && (
              <span className={styles.place} data-card-place="">
                {place}
              </span>
            )}
            {kind && (
              <span className={styles.place} data-card-kind="">
                {kind}
              </span>
            )}
          </span>
        )}
        {onStar && (
          <span className={styles.star} data-on={starred || undefined}>
            <IconButton icon={starred ? "24.star" : "24.star.outline"} label={starred ? t("Unstar") : t("Star")} tooltip={false} onClick={(e) => { e.stopPropagation(); onStar(!starred); }} />
          </span>
        )}
      </div>
      <div className={styles.footer}>
        <span className={styles.meta}>
          {renaming ? <CardRename value={title} onDone={(n) => onRename?.(n)} /> : <span className={styles.title}>{title}</span>}
          {hasBranches ? (
            <button
              type="button"
              className={styles.branches}
              data-branches-button=""
              aria-haspopup="menu"
              onClick={(e) => {
                e.stopPropagation();
                branches!.onMenu(e);
              }}
              onDoubleClick={(e) => e.stopPropagation()}
            >
              {branches!.count === 1 ? "1 branch" : `${branches!.count} branches`}
              <Icon name="16.chevron.down" />
            </button>
          ) : (
            <span className={styles.subtitle}>{subtitle}</span>
          )}
        </span>
      </div>
    </div>
  );
}

/** The list view's row (40 high, same data). */
export function FileRow({ id, title, subtitle, selected, onOpen, onSelect, onContextMenu }: Pick<FileCardProps, "id" | "title" | "subtitle" | "selected" | "onOpen" | "onSelect" | "onContextMenu">) {
  return (
    <div role="option" data-ds="FileRow" data-id={id} data-collection-item="" aria-selected={Boolean(selected)} tabIndex={0} className={styles.row} onClick={onSelect} onDoubleClick={onOpen} onContextMenu={onContextMenu} onKeyDown={(e) => e.key === "Enter" && onOpen?.()}>
      <FileKindIcon />
      <span className={styles.rowTitle}>{title}</span>
      <span className={styles.subtitle}>{subtitle}</span>
    </div>
  );
}
