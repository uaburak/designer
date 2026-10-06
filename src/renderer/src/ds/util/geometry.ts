/** Pure geometry behind TabBar, ScrollArea and VirtualList (tested in node). */

/** Where a dragged tab lands: before the first other tab whose middle is past the dragged tab's middle. */
export function dropIndex(middles: number[], draggedMiddle: number): number {
  const i = middles.findIndex((m) => draggedMiddle < m);
  return i < 0 ? middles.length : i;
}

/** A scrollbar thumb's size and offset along its track; null when nothing scrolls. */
export function thumbGeometry(viewport: number, content: number, scroll: number, track: number, minThumb = 20): { size: number; offset: number } | null {
  if (content <= viewport + 1) return null;
  const size = Math.max(minThumb, (viewport / content) * track);
  const offset = (Math.max(0, Math.min(scroll, content - viewport)) / (content - viewport)) * (track - size);
  return { size, offset };
}

/** The rows a fixed-pitch list draws for a scroll position: [first, last) with `overscan` either side. */
export function visibleRange(scrollTop: number, height: number, rowHeight: number, count: number, overscan = 8): [number, number] {
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const last = Math.min(count, Math.ceil((scrollTop + height) / rowHeight) + overscan);
  return [first, last];
}

/** Initials for an avatar: one letter, or two (first and last word; a single word's first two letters). */
export function initials(name: string, max: 1 | 2 = 2): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const two = (parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : parts[0]?.[1] ?? "");
  return two.slice(0, max).toLocaleUpperCase();
}
