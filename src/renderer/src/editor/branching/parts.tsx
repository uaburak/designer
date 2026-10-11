/**
 * Pieces the branching windows share: the full-window frame (Compare changes' shape), the badge, the change list
 * grouped by page and top-level layer, and Resolve conflicts (main left, branch right, a pick per chunk, Resolve all
 * › Pick main file / Pick branch, Next) — R21.
 */
import type { ReactNode } from "react";
import { Badge, Button, FocusTrap, IconButton, MenuButton, Portal, ScrollArea, Icon } from "@/ds";
import type { MergePreview } from "../../../../shared/merge/branches";
import type { DiffChunk, Resolutions, Side } from "../../../../shared/merge/types";
import { ChunkCompare, type SideDocs } from "./ChunkCompare";
import { badgeTone, changeTag, conflictChunks, groupChunks, pickAll, pickOf, withPick, allPicked, type BadgeKind } from "./model";
import styles from "./Branching.module.css";

export function BranchBadge({ kind }: { kind: BadgeKind | null }) {
  if (!kind) return null;
  return (
    <Badge tone={badgeTone(kind)} data-branch-badge={kind}>
      {kind}
    </Badge>
  );
}

/** The scrim and window of a full-size branching modal, with its header (back, title, extra, ×). */
export function BranchWindow({ label, title, onClose, onBack, extra, children, footer }: { label: string; title: ReactNode; onClose: () => void; onBack?: () => void; extra?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <Portal>
      <div className={styles.scrim} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        <FocusTrap className={styles.trap}>
          <div
            role="dialog"
            aria-modal="true"
            aria-label={label}
            className={styles.window}
            data-branch-window={label}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                onClose();
              }
            }}
          >
            <header className={styles.header}>
              {onBack && <IconButton icon="24.arrow.left" label="Back" onClick={onBack} />}
              <span className={styles.title}>{title}</span>
              {extra}
              <span className={styles.grow} />
              <IconButton icon="24.close.small" label="Close" onClick={onClose} />
            </header>
            {children}
            {footer && <footer className={styles.footer}>{footer}</footer>}
          </div>
        </FocusTrap>
      </div>
    </Portal>
  );
}

/** The changes, by page then top-level layer, each tagged Added / Edited / Removed; conflicting ones flagged. */
export function ChangeList({ chunks, selected, onSelect }: { chunks: readonly DiffChunk[]; selected: number | null; onSelect: (index: number) => void }) {
  const groups = groupChunks(chunks);
  if (!groups.length) return <div className={styles.hint}>No changes</div>;
  return (
    <div className={styles.changes} data-change-list="">
      {groups.map((g) => (
        <div key={g.id} className={styles.group} data-page={g.name}>
          <div className={styles.groupName}>{g.name}</div>
          {g.chunks.map((c) => (
            <button key={c.index} type="button" className={styles.row} aria-current={c.index === selected || undefined} data-chunk={c.index} onClick={() => onSelect(c.index)}>
              <span className={styles.grow}>{c.displayName || c.displayType}</span>
              {c.conflicts.length > 0 && <Icon name="24.warning" />}
              <span className={styles.tag} data-tag={changeTag(c)}>
                {changeTag(c)}
              </span>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * Resolve conflicts: the conflicting chunks in the left sidebar with their pick's badge (main / branch); the selected
 * one with main on the left and the branch on the right, and its two picks; Resolve all; Next once all are picked.
 */
export function Conflicts({ preview, picks, onPicks, docs, selected, onSelect, onNext }: { preview: MergePreview; picks: Resolutions; onPicks: (p: Resolutions) => void; docs: SideDocs; selected: number | null; onSelect: (i: number) => void; onNext: () => void }) {
  const list = conflictChunks(preview);
  const chunk = list.find((c) => c.index === selected) ?? list[0] ?? null;
  const pick = (side: Side) => chunk && onPicks(withPick(picks, chunk, side));
  return (
    <div className={styles.body} data-conflicts="">
      <nav className={styles.sidebar}>
        <div className={styles.sidebarHead}>
          <span className={styles.sectionTitle}>Conflicts</span>
          <span className={styles.grow} />
          <MenuButton
            label="Resolve all"
            entries={[
              { id: "main", label: "Pick main file" },
              { id: "branch", label: "Pick branch" },
            ]}
            onSelect={(id) => onPicks(pickAll(id as Side))}
            className={styles.menuTrigger}
          >
            <span>Resolve all</span>
            <Icon name="16.chevron.down" />
          </MenuButton>
        </div>
        <ScrollArea className={styles.scroll}>
          {list.map((c) => {
            const p = pickOf(picks, c);
            return (
              <button key={c.index} type="button" className={styles.row} aria-current={c.index === chunk?.index || undefined} data-conflict-chunk={c.index} onClick={() => onSelect(c.index)}>
                <span className={styles.grow}>
                  <span className={styles.rowName}>{c.displayName || c.displayType}</span>
                  <span className={styles.hint}>{c.canvasIsInternal ? "Assets" : c.canvasName}</span>
                </span>
                {p && (
                  <Badge tone={p === "main" ? "default" : "brand"} data-pick={p}>
                    {p}
                  </Badge>
                )}
              </button>
            );
          })}
        </ScrollArea>
      </nav>
      <section className={styles.main}>
        {chunk && (
          <>
            <ChunkCompare
              docs={docs}
              previewId={preview.previewId}
              chunk={chunk}
              modes={false}
              sides={[
                { side: "main", caption: "Main file" },
                { side: "branch", caption: "Branch" },
              ]}
            />
            <div className={styles.picks}>
              <Button variant={pickOf(picks, chunk) === "main" ? "primary" : "secondary"} onClick={() => pick("main")} data-keep="main">
                Keep main
              </Button>
              <Button variant={pickOf(picks, chunk) === "branch" ? "primary" : "secondary"} onClick={() => pick("branch")} data-keep="branch">
                Keep branch
              </Button>
              <span className={styles.grow} />
              <Button variant="primary" disabled={!allPicked(picks, preview)} onClick={onNext}>
                Next
              </Button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** A store refusal's code (StoreError.code), when it is one. */
export const codeOf = (e: unknown): string | null => (e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : e instanceof Error ? e.message : null);
