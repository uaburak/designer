/**
 * The Brush styles menu and brush picker (docs/draw.md §5.6; round 7c owns it, 7d's Stroke settings use it): a list of
 * rows, each the brush drawn along the engine's S-curve (`brushPreview`) and its name, in the sections Stretch, Scatter
 * and Custom (this file's BRUSH nodes that aren't built-ins; shown when there are any) [section names unverified]. The
 * current brush is ticked. ↑ ↓ move, Enter or a click picks, Esc closes.
 */
import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Icon, Popover, type PopoverPlacement } from "@/ds";
import type { BrushEntry, BrushType, BuiltinBrushName, GuidString } from "@shared/draw/types";
import { useEditor } from "../controller";
import { brushPreviewUrl, brushSections, type BrushSections } from "./drawTools";
import styles from "./Draw.module.css";

/** A row's preview box (CSS px) [ours: the row is 240 × 32]. */
export const BRUSH_PREVIEW = { width: 96, height: 24 } as const;

const SECTIONS: { id: keyof BrushSections; label: string }[] = [
  { id: "stretch", label: "Stretch" },
  { id: "scatter", label: "Scatter" },
  { id: "custom", label: "Custom" },
];

export interface BrushMenuProps {
  /** What it opens from (the Brush styles button; Stroke's Brush row) */
  anchor: HTMLElement | DOMRect | null;
  /** Default `top` (over the secondary toolbar); Stroke passes `left-of-panel` */
  placement?: PopoverPlacement;
  /** The brush ticked: a file's BRUSH node, or a built-in not installed yet */
  current: { guid: GuidString | null; builtin: BuiltinBrushName | null } | null;
  /** Only this kind of brush (none: every section) */
  type?: BrushType;
  onPick: (entry: BrushEntry) => void;
  onClose: () => void;
}

const same = (a: BrushEntry, b: BrushMenuProps["current"]) => !!b && ((!!a.guid && a.guid === b.guid) || (!!a.builtin && a.builtin === b.builtin));

/** One brush: its preview (a mask over the icon colour, so it follows the theme) and its name. */
export function BrushPreview({ entry, className }: { entry: BrushEntry; className?: string }) {
  const ed = useEditor();
  const url = brushPreviewUrl(ed, entry, BRUSH_PREVIEW.width, BRUSH_PREVIEW.height);
  return <span aria-hidden className={className ?? styles.preview} data-brush-preview={url ? "" : "none"} style={url ? { maskImage: `url(${url})`, WebkitMaskImage: `url(${url})` } : undefined} />;
}

export function BrushMenu({ anchor, placement = "top", current, type, onPick, onClose }: BrushMenuProps) {
  const ed = useEditor();
  const sections = useMemo(() => brushSections(ed), [ed]);
  const shown = SECTIONS.filter((s) => (!type || (s.id === "stretch" ? type === "STRETCH" : s.id === "scatter" ? type === "SCATTER" : true)) && sections[s.id].length > 0).map((s) => ({
    ...s,
    entries: sections[s.id].filter((e) => !type || e.type === type),
  }));
  const flat = shown.flatMap((s) => s.entries);
  const [active, setActive] = useState(() => Math.max(0, flat.findIndex((e) => same(e, current))));
  const rows = useRef<(HTMLDivElement | null)[]>([]);
  const move = (to: number) => {
    const i = Math.max(0, Math.min(flat.length - 1, to));
    setActive(i);
    rows.current[i]?.focus();
    rows.current[i]?.scrollIntoView?.({ block: "nearest" });
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") move(active + 1);
    else if (e.key === "ArrowUp") move(active - 1);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(flat.length - 1);
    else if ((e.key === "Enter" || e.key === " ") && flat[active]) onPick(flat[active]);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  let index = -1;
  return (
    <Popover anchor={anchor} placement={placement} label="Brush styles" onClose={onClose}>
      <div role="listbox" aria-label="Brush styles" className={styles.brushList} data-brush-menu="" onKeyDown={onKey}>
        {shown.map((s) => (
          <div key={s.id} role="group" aria-label={s.label} data-brush-section={s.id}>
            <div role="presentation" className={styles.brushHeader}>
              {s.label}
            </div>
            {s.entries.map((entry) => {
              const i = ++index;
              const ticked = same(entry, current);
              return (
                <div
                  key={entry.guid ?? entry.builtin ?? entry.name}
                  ref={(el) => {
                    rows.current[i] = el;
                  }}
                  role="option"
                  aria-selected={ticked}
                  aria-label={entry.name}
                  tabIndex={i === active ? 0 : -1}
                  data-highlighted={i === active || undefined}
                  className={styles.brushRow}
                  onPointerEnter={() => setActive(i)}
                  onClick={() => onPick(entry)}
                >
                  <span className={styles.brushCheck}>{ticked && <Icon name="16.check" />}</span>
                  <BrushPreview entry={entry} />
                  <span className={styles.brushName}>{entry.name}</span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </Popover>
  );
}
