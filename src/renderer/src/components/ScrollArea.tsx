import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A scroll container with the site's own scrollbars: the native ones are
 * hidden; thin rounded thumbs show while the pointer is over it (or a thumb is
 * dragged) and are gone the moment it leaves — no fade. Without hover (touch),
 * they show while scrolling, for a moment. A thumb can be dragged to scroll.
 *
 * `className` styles the outer box (give it a size); `viewportClassName` the
 * scrolling element inside it (padding, layout of the children).
 */

const THUMB_SIZE = 5;     // px thickness
const MIN_THUMB = 40;     // px
const HIDE_DELAY = 1200;  // ms the thumbs stay after a scroll without hover (touch)

type Thumb = { size: number; offset: number };

export function ScrollArea({ className, viewportClassName, inset = 24, edge = 4, children }: {
  className?: string;
  viewportClassName?: string;
  /** Room the thumbs keep from the start and end of their track (px) */
  inset?: number;
  /** Distance of the thumbs from the edge they run along (px) */
  edge?: number;
  children: ReactNode;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const [vertical, setVertical] = useState<Thumb | null>(null);
  const [horizontal, setHorizontal] = useState<Thumb | null>(null);
  const [hovered, setHovered] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [flashed, setFlashed] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const visible = hovered || dragging || flashed;

  /** No hover to show them (touch): a scroll shows the thumbs for a moment. */
  const flash = useCallback(() => {
    if (!window.matchMedia("(hover: none)").matches) return;
    setFlashed(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setFlashed(false), HIDE_DELAY);
  }, []);

  /** Thumb sizes and positions from the viewport's scroll state. */
  const measure = useCallback(() => {
    const el = viewport.current;
    if (!el) return;
    const thumb = (content: number, view: number, position: number): Thumb | null => {
      const track = view - inset * 2;
      if (content <= view + 1 || track <= 0) return null;
      const size = Math.max(MIN_THUMB, (view / content) * track);
      const max = content - view;
      return { size, offset: inset + (max > 0 ? position / max : 0) * (track - size) };
    };
    setVertical(thumb(el.scrollHeight, el.clientHeight, el.scrollTop));
    setHorizontal(thumb(el.scrollWidth, el.clientWidth, el.scrollLeft));
  }, [inset]);

  // Measure whenever the viewport or one of its children changes size (children come and go too).
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const resize = new ResizeObserver(measure);
    const observeAll = () => {
      resize.disconnect();
      resize.observe(el);
      Array.from(el.children).forEach((child) => resize.observe(child));
    };
    observeAll();
    const children = new MutationObserver(observeAll);
    children.observe(el, { childList: true });
    return () => {
      resize.disconnect();
      children.disconnect();
    };
  }, [measure]);

  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const onScroll = () => {
      measure();
      flash();
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [measure, flash]);

  useEffect(() => () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
  }, []);

  /** Dragging a thumb scrolls the viewport by the same share of its range. */
  const startDrag = (axis: "vertical" | "horizontal", e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const el = viewport.current;
    const thumb = axis === "vertical" ? vertical : horizontal;
    if (!el || !thumb) return;
    setDragging(true);
    const v = axis === "vertical";
    const start = v ? e.clientY : e.clientX;
    const startScroll = v ? el.scrollTop : el.scrollLeft;
    const thumbRange = (v ? el.clientHeight : el.clientWidth) - inset * 2 - thumb.size;
    const scrollRange = v ? el.scrollHeight - el.clientHeight : el.scrollWidth - el.clientWidth;

    const onMove = (ev: MouseEvent) => {
      if (thumbRange <= 0) return;
      const next = startScroll + (((v ? ev.clientY : ev.clientX) - start) / thumbRange) * scrollRange;
      if (v) el.scrollTop = next;
      else el.scrollLeft = next;
    };
    // Let go outside the area: the thumbs go then (the pointer left it while dragging).
    const onUp = () => {
      setDragging(false);
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  const thumbStyle = { backgroundColor: "var(--border-hover)", opacity: visible ? 0.7 : 0 };

  return (
    <div className={cn("relative", className)} onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)}>
      <div
        ref={viewport}
        className={cn("overflow-auto hide-native-scrollbar", viewportClassName)}
      >
        {children}
      </div>

      {vertical && (
        <div className="pointer-events-none absolute top-0 right-0 z-10 w-4 h-full">
          <div
            onMouseDown={(e) => startDrag("vertical", e)}
            className="pointer-events-auto absolute rounded-full cursor-pointer"
            style={{ right: edge, top: vertical.offset, width: THUMB_SIZE, height: vertical.size, ...thumbStyle }}
          />
        </div>
      )}

      {horizontal && (
        <div className="pointer-events-none absolute bottom-0 left-0 z-10 h-4 w-full">
          <div
            onMouseDown={(e) => startDrag("horizontal", e)}
            className="pointer-events-auto absolute rounded-full cursor-pointer"
            style={{ bottom: edge, left: horizontal.offset, height: THUMB_SIZE, width: horizontal.size, ...thumbStyle }}
          />
        </div>
      )}
    </div>
  );
}
