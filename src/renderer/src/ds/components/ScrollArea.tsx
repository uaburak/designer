import { capture } from "../util/pointer";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactNode } from "react";
import { cx } from "../util/cx";
import { thumbGeometry } from "../util/geometry";
import styles from "./ScrollArea.module.css";

export interface ScrollAreaProps extends Omit<HTMLAttributes<HTMLDivElement>, "onScroll"> {
  axis?: "y" | "x" | "both";
  children: ReactNode;
  onScroll?: (e: React.UIEvent<HTMLDivElement>) => void;
  /** The scrolling element (a callback) */
  viewportRef?: (el: HTMLDivElement | null) => void;
  /** Gallery: thumbs always drawn */
  forceVisible?: boolean;
}

export { thumbGeometry };

/**
 * Native scrolling with Figma's overlay thumbs (contract §4.33): an 8px hit
 * area, a 4px thumb (6 while hovered or dragged); shown while the pointer
 * is over the area and for a second after scrolling. Dragging the thumb
 * scrolls; clicking the track pages.
 */
export function ScrollArea({ axis = "y", children, onScroll, viewportRef, forceVisible, className, ...rest }: ScrollAreaProps) {
  const viewport = useRef<HTMLDivElement | null>(null);
  const [geo, setGeo] = useState<{ y: { size: number; offset: number } | null; x: { size: number; offset: number } | null }>({ y: null, x: null });
  const [visible, setVisible] = useState(false);
  const [dragging, setDragging] = useState<"x" | "y" | null>(null);
  const hideTimer = useRef<number | undefined>(undefined);

  const measure = useCallback(() => {
    const v = viewport.current;
    if (!v) return;
    setGeo({
      y: axis !== "x" ? thumbGeometry(v.clientHeight, v.scrollHeight, v.scrollTop, v.clientHeight - 4) : null,
      x: axis !== "y" ? thumbGeometry(v.clientWidth, v.scrollWidth, v.scrollLeft, v.clientWidth - 4) : null,
    });
  }, [axis]);

  useLayoutEffect(() => {
    const v = viewport.current;
    if (!v) return;
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(v);
    if (v.firstElementChild) ro.observe(v.firstElementChild);
    return () => ro.disconnect();
  }, [measure]);
  useEffect(() => () => window.clearTimeout(hideTimer.current), []);

  const flash = () => {
    setVisible(true);
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setVisible(false), 1000);
  };

  const dragThumb = (dir: "x" | "y", e: React.PointerEvent<HTMLDivElement>) => {
    const v = viewport.current;
    if (!v || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    capture(e.currentTarget, e.pointerId);
    const start = dir === "y" ? e.clientY : e.clientX;
    const startScroll = dir === "y" ? v.scrollTop : v.scrollLeft;
    const content = dir === "y" ? v.scrollHeight - v.clientHeight : v.scrollWidth - v.clientWidth;
    const g = geo[dir];
    const track = (dir === "y" ? v.clientHeight : v.clientWidth) - 4 - (g?.size ?? 0);
    setDragging(dir);
    const el = e.currentTarget;
    const move = (ev: PointerEvent) => {
      const d = (dir === "y" ? ev.clientY : ev.clientX) - start;
      const next = startScroll + (track > 0 ? (d / track) * content : 0);
      if (dir === "y") v.scrollTop = next;
      else v.scrollLeft = next;
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      setDragging(null);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };

  const page = (dir: "x" | "y", e: React.PointerEvent<HTMLDivElement>) => {
    const v = viewport.current;
    if (!v || e.target !== e.currentTarget) return;
    const r = e.currentTarget.getBoundingClientRect();
    const g = geo[dir];
    if (!g) return;
    const at = dir === "y" ? e.clientY - r.top : e.clientX - r.left;
    const sign = at < g.offset ? -1 : 1;
    if (dir === "y") v.scrollBy({ top: sign * v.clientHeight * 0.9 });
    else v.scrollBy({ left: sign * v.clientWidth * 0.9 });
  };

  const show = forceVisible || visible || dragging !== null;
  return (
    <div data-ds="ScrollArea" className={cx(styles.root, className)} onPointerEnter={() => setVisible(true)} onPointerLeave={() => !dragging && setVisible(false)} {...rest}>
      <div
        ref={(el) => {
          viewport.current = el;
          viewportRef?.(el);
        }}
        className={cx(styles.viewport, axis === "y" && styles.y, axis === "x" && styles.x)}
        onScroll={(e) => {
          measure();
          flash();
          onScroll?.(e);
        }}
      >
        {children}
      </div>
      {geo.y && (
        <div className={cx(styles.track, styles.trackY)} data-visible={show || undefined} onPointerDown={(e) => page("y", e)}>
          <div className={styles.thumb} data-dragging={dragging === "y" || undefined} style={{ top: geo.y.offset, height: geo.y.size }} onPointerDown={(e) => dragThumb("y", e)} />
        </div>
      )}
      {geo.x && (
        <div className={cx(styles.track, styles.trackX)} data-visible={show || undefined} onPointerDown={(e) => page("x", e)}>
          <div className={styles.thumb} data-dragging={dragging === "x" || undefined} style={{ left: geo.x.offset, width: geo.x.size }} onPointerDown={(e) => dragThumb("x", e)} />
        </div>
      )}
    </div>
  );
}
