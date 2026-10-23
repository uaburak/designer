import { useEffect, useRef, useState, type ReactNode } from "react";
import { ScrollArea } from "./ScrollArea";
import { visibleRange } from "../util/geometry";

export { visibleRange };

export interface VirtualListProps {
  count: number;
  /** Fixed (the layers' 24) */
  rowHeight: number;
  overscan?: number;
  renderRow: (index: number) => ReactNode;
  /** Brought into view when it changes */
  scrollToIndex?: number;
  /**
   * How `scrollToIndex` comes into view (only when it is out of view): "nearest" — at the edge it was past; "figma" —
   * Figma's Layers panel (`scrollNodeIntoView`): from above at the top (under `scrollTopPad`, a sticky row's room),
   * from below at mid-height
   */
  scrollAlign?: "nearest" | "figma";
  /** With "figma": the room a sticky row takes at the top when the row comes from above */
  scrollTopPad?: number;
  /**
   * Rows pinned at the top while the list scrolls under them (Figma's sticky headers): the block row `index` belongs
   * to — its header row `start` and the row past its end `end` (row indices) — or null. The header is drawn with CSS
   * `position: sticky` in a box spanning its block, so the browser keeps it at the top (and the next block's header
   * pushes it up) in the same frame as the scroll — never repositioned from a scroll event a frame late. While its
   * block's rows are scrolled under it the header carries `data-stuck` (Layers draws its line then).
   */
  stickyBlock?: (index: number) => { start: number; end: number } | null;
  className?: string;
  label?: string;
  /** "both": the rows may be wider than the list (`contentWidth`, or their own CSS sets it) and it scrolls sideways too */
  axis?: "y" | "both";
  /** With axis "both": how wide the rows are (px) — never narrower than the list; it scrolls sideways past that only */
  contentWidth?: number;
  /** Every scroll of the list (after its own bookkeeping) */
  onScroll?: (e: React.UIEvent<HTMLDivElement>) => void;
}

/** A long list drawing only the rows in view (contract §4.34), on a ScrollArea. */
export function VirtualList({ count, rowHeight, overscan = 8, renderRow, scrollToIndex, scrollAlign = "nearest", scrollTopPad = 0, stickyBlock, className, label, axis = "y", contentWidth, onScroll }: VirtualListProps) {
  const viewport = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState({ top: 0, height: 600 });
  useEffect(() => {
    const v = viewport.current;
    if (!v) return;
    const ro = new ResizeObserver(() => setView({ top: v.scrollTop, height: v.clientHeight }));
    ro.observe(v);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const v = viewport.current;
    if (!v || scrollToIndex === undefined || scrollToIndex < 0) return;
    const top = scrollToIndex * rowHeight;
    if (scrollAlign === "figma") {
      if (top < v.scrollTop + scrollTopPad) v.scrollTop = Math.max(0, top - scrollTopPad);
      else if (top + rowHeight > v.scrollTop + v.clientHeight) v.scrollTop = top - v.clientHeight / 2;
      return;
    }
    if (top < v.scrollTop) v.scrollTop = top;
    else if (top + rowHeight > v.scrollTop + v.clientHeight) v.scrollTop = top + rowHeight - v.clientHeight;
    // scrollTopPad / scrollAlign: read when the index changes, not a reason to scroll again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollToIndex, rowHeight]);
  const [first, last] = visibleRange(view.top, view.height, rowHeight, count, overscan);
  // The blocks with a pinned header among the rows drawn (their headers too, however far above the window they are).
  const blocks = new Map<number, number>();
  if (stickyBlock)
    for (let i = first; i < last; i++) {
      const b = stickyBlock(i);
      if (b && b.end > b.start + 1 && !blocks.has(b.start)) blocks.set(b.start, b.end);
    }
  const rows: ReactNode[] = [];
  for (let i = first; i < last; i++) {
    if (blocks.has(i)) continue;
    rows.push(
      <div key={i} style={{ position: "absolute", top: i * rowHeight, left: 0, right: 0, height: rowHeight }}>
        {renderRow(i)}
      </div>
    );
  }
  // A pinned header: its block's box (no pointer events of its own) over the block's rows, the header sticky at its
  // top on the list's background — where the compositor scrolls it, with no per-scroll render or write.
  for (const [start, end] of blocks)
    rows.push(
      <div key={`block:${start}`} data-sticky-block="" style={{ position: "absolute", top: start * rowHeight, left: 0, right: 0, height: (Math.min(end, count) - start) * rowHeight, zIndex: 1, pointerEvents: "none" }}>
        <div data-sticky-row="" data-stuck={view.top > start * rowHeight ? "" : undefined} style={{ position: "sticky", top: 0, height: rowHeight, background: "var(--figma-color-bg)", pointerEvents: "auto" }}>
          {renderRow(start)}
        </div>
      </div>
    );
  return (
    <ScrollArea
      className={className}
      axis={axis}
      style={{ width: "100%", height: "100%" }}
      viewportRef={(el) => {
        viewport.current = el;
      }}
      onScroll={(e) => {
        const top = e.currentTarget.scrollTop;
        const height = e.currentTarget.clientHeight;
        // A sideways scroll draws the same rows: no new state.
        setView((v) => (v.top === top && v.height === height ? v : { top, height }));
        onScroll?.(e);
      }}
      aria-label={label}
    >
      <div data-ds="VirtualList" role="presentation" style={{ position: "relative", height: count * rowHeight, ...(axis === "both" && contentWidth ? { width: contentWidth, minWidth: "100%" } : null) }}>{rows}</div>
    </ScrollArea>
  );
}
