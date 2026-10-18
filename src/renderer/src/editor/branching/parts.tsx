/**
 * Pieces the branching windows share: the full-window frame (Compare changes' shape), the badge, the change list
 * grouped by page and top-level layer, and Resolve conflicts (main left, branch right, a pick per chunk, Resolve all
 * › Pick main file / Pick branch, Next) — R21.
 */
import { useState, type ReactNode } from "react";
import { Badge, Button, Dialog, FocusTrap, IconButton, MenuButton, Portal, RadioGroup, ScrollArea, Icon } from "@/ds";
import { t, useT } from "@/i18n";
import type { MergePreview } from "../../../../shared/merge/branches";
import type { DiffChunk, Resolutions, Side } from "../../../../shared/merge/types";
import { ChunkCompare, type SideDocs } from "./ChunkCompare";
import { badgeTone, changeTag, conflictChunks, detailLines, groupChunks, pickAll, pickOf, withPick, allPicked, type BadgeKind } from "./model";
import styles from "./Branching.module.css";

export function BranchBadge({ kind }: { kind: BadgeKind | null }) {
  useT();
  if (!kind) return null;
  return (
    <Badge tone={badgeTone(kind)} data-branch-badge={kind}>
      {t(kind)}
    </Badge>
  );
}

/** The scrim and window of a full-size branching modal, with its header (back, title, extra, ×). */
export function BranchWindow({ label, title, onClose, onBack, extra, children, footer }: { label: string; title: ReactNode; onClose: () => void; onBack?: () => void; extra?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  useT();
  return (
    <Portal>
      <div className={styles.scrim} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        <FocusTrap className={styles.trap}>
          <div
            role="dialog"
            aria-modal="true"
            aria-label={t(label)}
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
              {onBack && <IconButton icon="24.arrow.left" label={t("Back")} onClick={onBack} />}
              <span className={styles.title}>{title}</span>
              {extra}
              <span className={styles.grow} />
              <IconButton icon="24.close.small" label={t("Close")} onClick={onClose} />
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
  useT();
  const groups = groupChunks(chunks);
  if (!groups.length) return <div className={styles.hint}>{t("No changes")}</div>;
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
                {t(changeTag(c))}
              </span>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

/** Figma's change details (`branching_chunk.change_details`): each changed layer of a chunk and what changed on it. */
export function ChangeDetails({ chunk }: { chunk: DiffChunk }) {
  useT();
  const details = (chunk.details ?? []).filter((d) => d.phase !== "updated" || d.fields.length);
  if (!details.length) return null;
  return (
    <section className={styles.details} data-change-details={chunk.index}>
      <div className={styles.sectionTitle}>{t("Change details")}</div>
      {details.map((d) => (
        <div key={d.guid} className={styles.detail} data-detail={d.guid}>
          <span className={styles.rowName}>{d.name || d.type}</span>
          <span className={styles.hint}>{detailLines(d).join(" · ")}</span>
        </div>
      ))}
    </section>
  );
}

/**
 * Resolve conflicts: the conflicting chunks in the left sidebar with their pick's badge (main / branch); the selected
 * one with main on the left and the branch on the right, and its two picks; Resolve all; Next once all are picked.
 */
export function Conflicts({ preview, picks, onPicks, docs, selected, onSelect, onNext }: { preview: MergePreview; picks: Resolutions; onPicks: (p: Resolutions) => void; docs: SideDocs; selected: number | null; onSelect: (i: number) => void; onNext: () => void }) {
  useT();
  const list = conflictChunks(preview);
  const chunk = list.find((c) => c.index === selected) ?? list[0] ?? null;
  const pick = (side: Side) => chunk && onPicks(withPick(picks, chunk, side));
  return (
    <div className={styles.body} data-conflicts="">
      <nav className={styles.sidebar}>
        <div className={styles.sidebarHead}>
          <span className={styles.sectionTitle}>{t("Conflicts")}</span>
          <span className={styles.grow} />
          <MenuButton
            label={t("Resolve all")}
            entries={[
              { id: "main", label: t("Pick main file") },
              { id: "branch", label: t("Pick branch") },
            ]}
            onSelect={(id) => onPicks(pickAll(id as Side))}
            className={styles.menuTrigger}
          >
            <span>{t("Resolve all")}</span>
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
                  <span className={styles.hint}>{c.canvasIsInternal ? t("Assets") : c.canvasName}</span>
                </span>
                {p && (
                  <Badge tone={p === "main" ? "default" : "brand"} data-pick={p}>
                    {p === "main" ? t("main") : t("branch")}
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
                { side: "main", caption: t("Main file") },
                { side: "branch", caption: t("Branch") },
              ]}
            />
            <div className={styles.picks}>
              <Button variant={pickOf(picks, chunk) === "main" ? "primary" : "secondary"} onClick={() => pick("main")} data-keep="main">
                {t("Keep main")}
              </Button>
              <Button variant={pickOf(picks, chunk) === "branch" ? "primary" : "secondary"} onClick={() => pick("branch")} data-keep="branch">
                {t("Keep branch")}
              </Button>
              <span className={styles.grow} />
              <Button variant="primary" disabled={!allPicked(picks, preview)} onClick={onNext}>
                {t("Next")}
              </Button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

/**
 * Force merge (Figma's `branching_force`, atlas 16 §4.8 — its English isn't read): every conflict kept from one side
 * at once, Main by default, without picking them one by one; to main ("Merge") or from main ("Apply changes").
 */
export function ForceDialog({ direction, onClose, onConfirm }: { direction: "merge" | "update"; onClose(): void; onConfirm(side: Side): Promise<void> }) {
  useT();
  const [side, setSide] = useState<Side>("main");
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      title={direction === "merge" ? t("Force merge") : t("Force update from main")}
      open
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t("Cancel")}
          </Button>
          <Button
            variant="destructive"
            loading={busy}
            data-force={direction}
            onClick={async () => {
              setBusy(true);
              await onConfirm(side);
              setBusy(false);
            }}
          >
            {direction === "merge" ? t("Merge") : t("Apply changes")}
          </Button>
        </>
      }
    >
      <div className={styles.force}>
        <p className={styles.description}>
          {direction === "merge" ? t("Merge the branch into the main file without reviewing its conflicts one by one.") : t("Bring the main file’s changes into the branch without reviewing its conflicts one by one.")}
        </p>
        <RadioGroup
          label={t("On conflicts, keep")}
          value={side}
          options={[
            { value: "main", label: t("Main file") },
            { value: "branch", label: t("Branch") },
          ]}
          onChange={(v) => setSide(v as Side)}
        />
      </div>
    </Dialog>
  );
}

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** A store refusal's code (StoreError.code), when it is one. */
export const codeOf = (e: unknown): string | null => (e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : e instanceof Error ? e.message : null);
