// The collages' parts (docs/site.md §2, v3): a stage of a fixed design size that covers its tile (scaled down on
// narrow tiles, never up, cropped around a focus point), pieces of real app UI that settle in when the scene plays,
// the multiplayer cursors, and the engine's selection look. No window chrome, no shadows: a piece is a flat surface
// with a hairline.
import { forwardRef, useEffect, useRef, useState, type CSSProperties, type HTMLAttributes, type ReactNode } from "react";
import { useScene, type Run } from "../runtime/motion";
import { stageBox, type StageBox } from "./stage";
import styles from "./kit.module.css";

export { styles as kit };

export interface CollageProps {
  /** The stage's design size, px. */
  size: readonly [number, number];
  /** What stays in view when a narrow tile crops the stage (0…1 of its width and height). */
  focus?: readonly [number, number];
  /**
   * How much of the stage's width must show on a narrow tile (a phone), px: the stage is scaled down until it fits,
   * even below covering the tile (the tile's colour then shows above and below). Default: the whole width on wide
   * tiles, 45% of it at the narrowest.
   */
  safe?: number;
  script: (run: Run) => Promise<void>;
  children: ReactNode;
  className?: string;
}

/** The stage: fills its tile, scaled to cover it (at most 1×) and centred on `focus`. */
export function Collage({ size: [w, h], focus = [0.5, 0.5], safe = w * 0.45, script, children, className }: CollageProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<StageBox | null>(null);
  const play = useScene(rootRef, script);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const place = () => {
      const W = el.clientWidth;
      const H = el.clientHeight;
      if (W && H) setBox(stageBox(W, H, w, h, focus, safe));
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(el);
    return () => ro.disconnect();
  }, [w, h, safe, focus[0], focus[1]]);

  return (
    <div ref={rootRef} className={styles.root}>
      <div
        className={`${styles.stage} ${className ?? ""}`}
        data-play={play || undefined}
        style={{ width: w, height: h, transform: box ? `translate(${box.x}px, ${box.y}px) scale(${box.s})` : undefined, visibility: box ? undefined : "hidden" }}
      >
        {children}
      </div>
    </div>
  );
}

export interface PieceProps extends HTMLAttributes<HTMLDivElement> {
  x: number;
  y: number;
  w?: number;
  h?: number;
  /** Delay after the scene starts, ms. */
  d?: number;
  /** Where it comes from: a small slide up (default), from the left or right, or a slight scale. */
  from?: "up" | "down" | "left" | "right" | "scale" | "fade";
  /** Hidden until the script shows it (false: out). */
  show?: boolean;
  /** A flat panel surface (the app's panel colour, a hairline, the collage radius). */
  surface?: boolean;
  /** z-order. */
  z?: number;
}

/** A piece of the collage, placed at x, y on the stage. */
export const Piece = forwardRef<HTMLDivElement, PieceProps>(function Piece({ x, y, w, h, d = 0, from = "up", show = true, surface, z, className, style, children, ...rest }, ref) {
  return (
    <div
      ref={ref}
      className={`${styles.piece} ${surface ? styles.surface : ""} ${className ?? ""}`}
      data-from={from}
      data-out={show ? undefined : ""}
      style={{ left: x, top: y, width: w, height: h, zIndex: z, ["--d" as string]: `${d}ms`, ...style }}
      {...rest}
    >
      {children}
    </div>
  );
});

export const CURSOR = {
  blue: "#0D99FF",
  purple: "#9747FF",
  green: "#14AE5C",
  orange: "#FFA629",
  pink: "#FF24BD",
  red: "#F24822",
  /** The visitor's own pointer */
  ink: "#1E1E1E",
} as const;

/** A multiplayer cursor with its name (or the visitor's own, without one), gliding to x, y. */
export function Cursor({ x, y, color = CURSOR.blue, name, show = true, d = 0, z = 20, press, instant }: { x: number; y: number; color?: string; name?: string; show?: boolean; d?: number; z?: number; press?: boolean; instant?: boolean }) {
  return (
    <div className={styles.cursor} data-out={show ? undefined : ""} data-press={press || undefined} data-instant={instant || undefined} style={{ transform: `translate(${x}px, ${y}px)`, zIndex: z, ["--d" as string]: `${d}ms`, ["--c" as string]: color }}>
      <svg width="18" height="20" viewBox="0 0 18 20" aria-hidden="true">
        <path d="M1.5 1.5v15.2l4.2-4 2.7 6.1 2.8-1.2-2.6-6h5.9L1.5 1.5Z" fill={color} stroke="#fff" strokeWidth="1.5" strokeLinejoin="round" />
      </svg>
      {name && <span className={styles.cursorName}>{name}</span>}
    </div>
  );
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The engine's selection: a 1px outline, four handles, the size under it. */
export function Selection({ box, size, tone = "brand", show = true, handles = true, z = 10 }: { box: Box; size?: string; tone?: "brand" | "component" | "dev"; show?: boolean; handles?: boolean; z?: number }) {
  return (
    <div className={styles.selection} data-tone={tone} data-out={show ? undefined : ""} style={{ left: box.x, top: box.y, width: box.w, height: box.h, zIndex: z }}>
      {handles && (
        <>
          <i />
          <i />
          <i />
          <i />
        </>
      )}
      {size && <span className={styles.size}>{size}</span>}
    </div>
  );
}

/** A frame's name over its top-left corner, as the canvas shows it. */
export function FrameName({ x, y, children, selected, show = true, tone }: { x: number; y: number; children: ReactNode; selected?: boolean; show?: boolean; tone?: "component" }) {
  return (
    <span className={styles.frameName} data-selected={selected || undefined} data-tone={tone} data-out={show ? undefined : ""} style={{ left: x, top: y - 18 }}>
      {children}
    </span>
  );
}

/** A plain box on the canvas (a design's layer): flat colour, optional radius. */
export function Shape({ x, y, w, h, fill, r = 0, style, children, className }: { x: number; y: number; w: number; h: number; fill?: string; r?: number; style?: CSSProperties; children?: ReactNode; className?: string }) {
  return (
    <div className={className} style={{ position: "absolute", left: x, top: y, width: w, height: h, background: fill, borderRadius: r, ...style }}>
      {children}
    </div>
  );
}
