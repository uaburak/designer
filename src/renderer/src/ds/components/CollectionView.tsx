import { useRef, useState, type HTMLAttributes, type ReactNode } from "react";
import { cx } from "../util/cx";
import { capture, release } from "../util/pointer";
import { isToggleModifier, idsInRect } from "../util/selection";
import styles from "./CollectionView.module.css";

type Box = { left: number; top: number; right: number; bottom: number };

/**
 * Where an arrow key goes in a laid-out collection: ← → step through the
 * order (grids only); ↑ ↓ go to the nearest item in the row above or below
 * (by centre x); Home / End to the ends. Null: not a move (or no item there).
 */
export function collectionTarget(key: string, items: readonly { id: string; rect: Box }[], from: number, layout: "grid" | "list"): number | null {
  if (!items.length) return null;
  if (key === "Home") return 0;
  if (key === "End") return items.length - 1;
  if (from < 0) return key === "ArrowUp" || key === "ArrowLeft" ? items.length - 1 : key.startsWith("Arrow") ? 0 : null;
  if (key === "ArrowLeft" || key === "ArrowRight") {
    if (layout === "list") return null;
    const next = from + (key === "ArrowRight" ? 1 : -1);
    return next < 0 || next >= items.length ? from : next;
  }
  if (key !== "ArrowUp" && key !== "ArrowDown") return null;
  const cur = items[from].rect;
  const down = key === "ArrowDown";
  const rowEdge = down ? cur.bottom - 1 : cur.top + 1;
  const others = items.map((it, i) => ({ i, r: it.rect })).filter(({ r }) => (down ? r.top >= rowEdge : r.bottom <= rowEdge));
  if (!others.length) return from;
  // the nearest row, then the closest centre in it
  const rowTop = down ? Math.min(...others.map((o) => o.r.top)) : Math.max(...others.map((o) => o.r.top));
  const row = others.filter((o) => Math.abs(o.r.top - rowTop) < 1);
  const cx0 = (cur.left + cur.right) / 2;
  row.sort((a, b) => Math.abs((a.r.left + a.r.right) / 2 - cx0) - Math.abs((b.r.left + b.r.right) / 2 - cx0));
  return row[0].i;
}

export interface CollectionViewProps extends Omit<HTMLAttributes<HTMLDivElement>, "role"> {
  /** grid: cards on a 268 / 36 grid; list: rows under an optional header */
  layout?: "grid" | "list";
  /** aria-label ("Files") */
  label: string;
  /** Above the items in list layout (a ListHeader); sticky */
  header?: ReactNode;
  /** The keyboard moved focus to an item; select it (`extend`: ⇧ was held — extend from the anchor) */
  onNavigate?: (id: string, extend: boolean) => void;
  /** ⌘A */
  onSelectAll?: () => void;
  /** Esc, or a click on empty space */
  onClearSelection?: () => void;
  /** ⌫ or Delete on the collection (Home: move to trash) */
  onDelete?: () => void;
  /**
   * Drag on empty space: the ids under the rectangle, on every move and once
   * with `final` on release. `additive` (⇧ or ⌘ held at the press): add them
   * to the selection the drag started with.
   */
  onMarquee?: (ids: string[], info: { additive: boolean; final: boolean }) => void;
  /** Default: listbox for grids, grid for lists (pair with FileCard / ListRow) */
  role?: string;
  children: ReactNode;
}

/**
 * A selectable collection of files or folders (Home's grid and list views).
 * Items are its descendants with `data-collection-item` and `data-id`
 * (FileCard, FolderCard, FileRow and ListRow carry both). It moves focus
 * with the arrows by layout, reports ⌘A / Esc / ⌫, clears on an empty click
 * and draws a marquee for drag-select; what is selected stays the parent's
 * (see `useSelection`).
 */
export function CollectionView({ layout = "grid", label, header, onNavigate, onSelectAll, onClearSelection, onDelete, onMarquee, role, children, className, onKeyDown, onPointerDown, ...rest }: CollectionViewProps) {
  const root = useRef<HTMLDivElement>(null);
  const [marquee, setMarquee] = useState<Box | null>(null);

  const items = () => {
    const el = root.current;
    if (!el) return [];
    return [...el.querySelectorAll<HTMLElement>("[data-collection-item][data-id]")].map((node) => ({ id: node.dataset.id!, node, rect: node.getBoundingClientRect() as Box }));
  };

  const keyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(e);
    if (e.defaultPrevented) return;
    const t = e.target as HTMLElement;
    // A field inside an item (rename) keeps its keys
    if (t.closest("input, textarea, [contenteditable='true']")) return;
    const mod = isToggleModifier(e);
    if (mod && e.key.toLowerCase() === "a" && onSelectAll) {
      e.preventDefault();
      onSelectAll();
      return;
    }
    if (e.key === "Escape" && onClearSelection) {
      e.preventDefault();
      onClearSelection();
      return;
    }
    if ((e.key === "Backspace" || e.key === "Delete") && onDelete && !mod) {
      e.preventDefault();
      onDelete();
      return;
    }
    if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key) || e.altKey || mod) return;
    const list = items();
    const from = list.findIndex((it) => it.node === t.closest("[data-collection-item]"));
    const to = collectionTarget(e.key, list, from, layout);
    if (to === null) return;
    e.preventDefault();
    list[to].node.focus({ preventScroll: false });
    list[to].node.scrollIntoView?.({ block: "nearest" });
    onNavigate?.(list[to].id, e.shiftKey);
  };

  const pointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    onPointerDown?.(e);
    if (e.defaultPrevented || e.button !== 0) return;
    const t = e.target as HTMLElement;
    if (t.closest("[data-collection-item], [role='row']:not([data-collection-item]), button, input, [role='columnheader']")) return;
    const el = e.currentTarget;
    const additive = e.shiftKey || isToggleModifier(e);
    const start = el.getBoundingClientRect();
    // Content coordinates (the root's own scroll included), so the marquee survives scrolling
    const sx = e.clientX - start.left + el.scrollLeft;
    const sy = e.clientY - start.top + el.scrollTop;
    let moved = false;
    capture(el, e.pointerId);
    const boxAt = (ev: PointerEvent) => {
      const r = el.getBoundingClientRect();
      const origin = { left: r.left - el.scrollLeft, top: r.top - el.scrollTop };
      const x = ev.clientX - origin.left;
      const y = ev.clientY - origin.top;
      return { local: { left: Math.min(sx, x), top: Math.min(sy, y), right: Math.max(sx, x), bottom: Math.max(sy, y) }, origin };
    };
    const hits = (local: Box, origin: { left: number; top: number }) => idsInRect(items().map((it) => ({ id: it.id, rect: { left: it.rect.left - origin.left, top: it.rect.top - origin.top, right: it.rect.right - origin.left, bottom: it.rect.bottom - origin.top } })), local);
    const move = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 3) return;
      moved = true;
      const { local, origin } = boxAt(ev);
      setMarquee(local);
      onMarquee?.(hits(local, origin), { additive, final: false });
    };
    const up = (ev: PointerEvent) => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      release(el, e.pointerId);
      setMarquee(null);
      if (moved) {
        const { local, origin } = boxAt(ev);
        onMarquee?.(hits(local, origin), { additive, final: true });
      } else if (!additive) onClearSelection?.();
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  return (
    <div
      ref={root}
      data-ds="CollectionView"
      data-layout={layout}
      role={role ?? (layout === "grid" ? "listbox" : "grid")}
      aria-label={label}
      aria-multiselectable
      className={cx(styles.root, layout === "grid" ? styles.grid : styles.list, className)}
      onKeyDown={keyDown}
      onPointerDown={pointerDown}
      {...rest}
    >
      {layout === "list" && header}
      {children}
      {marquee && <div data-ds="Marquee" aria-hidden className={styles.marquee} style={{ left: marquee.left, top: marquee.top, width: marquee.right - marquee.left, height: marquee.bottom - marquee.top }} />}
    </div>
  );
}
