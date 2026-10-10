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
export function VirtualList({ count, rowHeight, overscan = 8, renderRow, scrollToIndex, className, label, axis = "y", contentWidth, onScroll }: VirtualListProps) {
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
    if (top < v.scrollTop) v.scrollTop = top;
    else if (top + rowHeight > v.scrollTop + v.clientHeight) v.scrollTop = top + rowHeight - v.clientHeight;
  }, [scrollToIndex, rowHeight]);
  const [first, last] = visibleRange(view.top, view.height, rowHeight, count, overscan);
  const rows: ReactNode[] = [];
  for (let i = first; i < last; i++) {
    rows.push(
      <div key={i} style={{ position: "absolute", top: i * rowHeight, left: 0, right: 0, height: rowHeight }}>
        {renderRow(i)}
      </div>
    );
  }
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
