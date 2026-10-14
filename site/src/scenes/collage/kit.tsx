// The collages' parts (docs/site.md §2, v3): a stage of a fixed design size that covers its tile (scaled down on
// narrow tiles, never up, cropped around a focus point), pieces of real app UI that settle in when the scene plays,
// the multiplayer cursors, and the engine's selection look. No window chrome, no shadows: a piece is a flat surface
// with a hairline.
//
// Motion is transform and opacity on the compositor: pieces settle in with CSS transitions (staggered by `d`), cursors
// glide along curved paths with the Web Animations API (usePointer + Cursor), a selection draws its outline in and
// resizes by transforming its edges, and numbers count with the shared ticker (Dims, runtime/ticker.ts).
import { forwardRef, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type HTMLAttributes, type ReactNode } from "react";
import { ARROW, ARROW_EDGE, CURSOR, SIZE } from "../runtime/cursorArt";
import { BEZIER, css, cubicBezier, durationFor, SPRING, springEasing, type Bezier } from "../runtime/easing";
import { useScene, type Run } from "../runtime/motion";
import { arcPoints, bendFor, type Point } from "../runtime/path";
import { prefersReduced } from "../runtime/reduced";
import { Tween } from "../runtime/ticker";
import { stageBox, type StageBox } from "./stage";
import styles from "./kit.module.css";

export { styles as kit, CURSOR };

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

/** How long after the scene starts its pieces have all settled (their `will-change` is dropped then). */
const SETTLE_MS = 2200;

/** The stage: fills its tile, scaled to cover it (at most 1×) and centred on `focus`. */
export function Collage({ size: [w, h], focus = [0.5, 0.5], safe = w * 0.45, script, children, className }: CollageProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<StageBox | null>(null);
  const { play, visible } = useScene(rootRef, script);
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    if (!play) return;
    const t = setTimeout(() => setSettled(true), SETTLE_MS);
    return () => clearTimeout(t);
  }, [play]);

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
        data-visible={visible || undefined}
        data-settled={settled || undefined}
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
  /** Delay after the scene starts, ms (pieces stagger by 40–80 ms). */
  d?: number;
  /** Where it comes from: a small rise (default), a small drop, from the left or right, a slight scale, or a fade. */
  from?: "up" | "down" | "left" | "right" | "scale" | "fade";
  /** Hidden until the script shows it (false: out). */
  show?: boolean;
  /** A flat panel surface (the app's panel colour, a hairline, the collage radius); it also scales in a touch. */
  surface?: boolean;
  /** Where a `scale` piece grows from (a popover from what opened it), CSS transform-origin. */
  origin?: string;
  /** z-order. */
  z?: number;
}

/** A piece of the collage, placed at x, y on the stage. */
export const Piece = forwardRef<HTMLDivElement, PieceProps>(function Piece({ x, y, w, h, d = 0, from = "up", show = true, surface, origin, z, className, style, children, ...rest }, ref) {
  return (
    <div
      ref={ref}
      className={`${styles.piece} ${surface ? styles.surface : ""} ${className ?? ""}`}
      data-from={from}
      data-out={show ? undefined : ""}
      style={{ left: x, top: y, width: w, height: h, zIndex: z, transformOrigin: origin, ["--d" as string]: `${d}ms`, ...style }}
      {...rest}
    >
      {children}
    </div>
  );
});

// ── Cursors ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** Where a cursor is headed and how it gets there (usePointer makes these; Cursor animates them). */
export interface PointerState {
  x: number;
  y: number;
  /** The button is down (the arrow shrinks a touch; what's under it is pressed). */
  press?: boolean;
  /** How long the move takes, ms (default: by distance). */
  ms?: number;
  /** How much the path bows (default: a gentle arc, by direction). */
  bend?: number;
  /** The move's time curve (default: the glide). */
  ease?: Bezier;
  /** The way there, evenly spaced points (default: a gentle arc); a drag along a drawn curve follows it exactly. */
  path?: [number, number][];
}

export interface MoveOptions {
  ms?: number;
  bend?: number;
  ease?: Bezier;
  /** Resolve when the move is under way rather than when it lands. */
  wait?: boolean;
}

export interface Pointer {
  state: PointerState;
  /** Glides to `p` along a curve (eased in and out) and resolves when it lands. */
  to(run: Run, p: Point, options?: MoveOptions): Promise<void>;
  /** Optionally glides to `p`; then a beat, the press, the release. The UI reacts after this resolves. */
  click(run: Run, p?: Point, options?: MoveOptions & { beat?: number }): Promise<void>;
  /** Presses, drags to `p` over `ms` (nearly straight, the same curve as what it drags), and releases. */
  drag(run: Run, p: Point, ms: number, options?: { ease?: Bezier; bend?: number; release?: boolean; path?: [number, number][]; /** Called as the move starts (what the drag changes starts with it). */ start?: () => void }): Promise<void>;
  /** Calm idle motion: drifts slowly between `spots`, pausing at each, until the scene is gone. */
  idle(run: Run, spots: Point[], options?: { pause?: number }): Promise<void>;
}

/** Points a few px around `p`: the hand at rest still moves a little. */
export const around = (p: Point, r = 14): Point[] => [
  [p[0] + r, p[1] + r * 0.4],
  [p[0] - r * 0.3, p[1] + r * 0.9],
  [p[0] + r * 0.2, p[1] - r * 0.5],
  [p[0], p[1]],
];

/** A scene's cursor: its state for `<Cursor {...me.state} />`, and the moves its script makes. */
export function usePointer(start: Point): Pointer {
  const [state, setState] = useState<PointerState>({ x: start[0], y: start[1] });
  const at = useRef<PointerState>(state);
  const api = useRef<Omit<Pointer, "state"> | null>(null);
  if (!api.current) {
    const set = (s: PointerState) => {
      at.current = s;
      setState(s);
    };
    const to: Pointer["to"] = async (run, p, o = {}) => {
      const cur = at.current;
      const ms = o.ms ?? durationFor(Math.hypot(p[0] - cur.x, p[1] - cur.y), 360, 1000);
      set({ x: p[0], y: p[1], press: cur.press, ms, bend: o.bend, ease: o.ease });
      if (o.wait !== false) await run.wait(ms);
    };
    api.current = {
      to,
      async click(run, p, o = {}) {
        if (p) await to(run, p, o);
        await run.wait(o.beat ?? 140);
        set({ ...at.current, press: true });
        await run.wait(110);
        set({ ...at.current, press: false });
        await run.wait(40);
      },
      async drag(run, p, ms, o = {}) {
        if (!at.current.press) {
          set({ ...at.current, press: true });
          await run.wait(120);
        }
        set({ x: p[0], y: p[1], press: true, ms, bend: o.bend ?? 0.03, ease: o.ease ?? BEZIER.standard, path: o.path });
        o.start?.();
        await run.wait(ms);
        if (o.release !== false) {
          set({ ...at.current, press: false });
          await run.wait(60);
        }
      },
      async idle(run, spots, o = {}) {
        for (let i = 0; !run.reduced && spots.length; i++) {
          await run.wait(o.pause ?? 2200 + (i % 3) * 500);
          const p = spots[i % spots.length];
          const cur = at.current;
          const ms = Math.max(1100, durationFor(Math.hypot(p[0] - cur.x, p[1] - cur.y), 360, 1000) * 1.6);
          await to(run, p, { ms, ease: BEZIER.standard, bend: bendFor([cur.x, cur.y], p, 0.2) });
        }
      },
    };
  }
  return { state, ...api.current };
}

/** What a cursor can hover and press in the app's UI (the ds draws `[data-hover]` / `[data-pressed]` like :hover). */
const PRESSABLE = 'button, [role="switch"], [role="combobox"], [data-ds="SidebarItem"], [data-ds="Select"], [data-pressable]';
const SNAP = springEasing(SPRING.snap);

/** The smallest pressable element under the cursor's tip (inside its stage). */
function targetAt(cursor: HTMLElement): HTMLElement | null {
  const stage = cursor.parentElement;
  if (!stage) return null;
  const tip = cursor.getBoundingClientRect();
  const x = tip.left + 1;
  const y = tip.top + 1;
  let best: HTMLElement | null = null;
  let area = Infinity;
  for (const el of stage.querySelectorAll<HTMLElement>(PRESSABLE)) {
    if (cursor.contains(el)) continue;
    const r = el.getBoundingClientRect();
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
    const a = r.width * r.height;
    if (a < area) {
      area = a;
      best = el;
    }
  }
  return best;
}

const at3d = (p: Point) => `translate3d(${p[0]}px, ${p[1]}px, 0)`;

function sample(pts: [number, number][], e: number): [number, number] {
  const f = Math.min(1, Math.max(0, e)) * (pts.length - 1);
  const i = Math.min(pts.length - 2, Math.floor(f));
  const k = f - i;
  return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * k, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * k];
}

export interface CursorProps extends PointerState {
  color?: string;
  name?: string;
  show?: boolean;
  /** Delay of its first appearance after the scene starts, ms. */
  d?: number;
  z?: number;
}

/**
 * A multiplayer cursor (the UI3 arrow in its colour, a name pill) gliding to x, y: along a gentle arc, eased in and
 * out, on the compositor. When it lands on something pressable that thing shows its hover; a press shrinks the arrow
 * and presses what's under it.
 */
export function Cursor({ x, y, press, ms, bend, ease, path, color = CURSOR.ink, name, show = true, d = 0, z = 20 }: CursorProps) {
  const ref = useRef<HTMLDivElement>(null);
  const motion = useRef<{ a: Animation; pts: [number, number][]; fn: (t: number) => number; ms: number } | null>(null);
  const at = useRef<[number, number] | null>(null);
  const hovered = useRef<HTMLElement | null>(null);
  const pressed = useRef<{ el: HTMLElement; a: Animation } | null>(null);

  const unhover = () => {
    hovered.current?.removeAttribute("data-hover");
    hovered.current = null;
  };

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const to: [number, number] = [x, y];
    let from = at.current;
    const m = motion.current;
    if (m) {
      // A new target mid-move: carry on from where the cursor is now
      const t = Number(m.a.currentTime ?? 0) / m.ms;
      if (t < 1) from = sample(m.pts, m.fn(t));
      m.a.cancel();
      motion.current = null;
    }
    at.current = to;
    el.style.transform = at3d(to);
    if (!from || (from[0] === x && from[1] === y) || prefersReduced() || typeof el.animate !== "function") return;
    const dist = Math.hypot(x - from[0], y - from[1]);
    const dur = ms ?? durationFor(dist, 360, 1000);
    const curve = ease ?? BEZIER.glide;
    const pts = path ?? arcPoints(from, to, bend ?? bendFor(from, to), Math.min(40, Math.max(4, Math.round(dist / 14))));
    if (!press) unhover();
    el.style.willChange = "transform";
    const a = el.animate(
      pts.map((p) => ({ transform: at3d(p) })),
      { duration: dur, easing: css(curve) },
    );
    motion.current = { a, pts, fn: cubicBezier(curve), ms: dur };
    a.finished.then(
      () => {
        if (motion.current?.a !== a) return;
        motion.current = null;
        el.style.willChange = "";
        const target = targetAt(el);
        if (target !== hovered.current) {
          unhover();
          if (target) {
            target.setAttribute("data-hover", "");
            hovered.current = target;
          }
        }
      },
      () => {},
    );
  }, [x, y]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (press) {
      const target = targetAt(el);
      if (!target || prefersReduced() || typeof target.animate !== "function") return;
      target.setAttribute("data-pressed", "");
      const a = target.animate([{ scale: "1" }, { scale: "0.96" }], { duration: 110, easing: css(BEZIER.out), fill: "forwards" });
      pressed.current = { el: target, a };
    } else if (pressed.current) {
      const { el: target, a } = pressed.current;
      pressed.current = null;
      target.removeAttribute("data-pressed");
      a.cancel();
      target.animate([{ scale: "0.96" }, { scale: "1" }], { duration: SNAP.duration, easing: SNAP.easing });
    }
  }, [press]);

  useEffect(() => () => unhover(), []);

  return (
    <div
      ref={ref}
      className={styles.cursor}
      data-out={show ? undefined : ""}
      data-press={press || undefined}
      style={{ transform: at3d([x, y]), zIndex: z, ["--d" as string]: `${d}ms`, ["--c" as string]: color }}
    >
      <span className={styles.cursorBody}>
        <i className={styles.ring} />
        <svg className={styles.arrow} width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden="true">
          <path d={ARROW_EDGE} fill="#fff" />
          <path d={ARROW} fill={color} />
        </svg>
        {name && <span className={styles.cursorName}>{name}</span>}
      </span>
    </div>
  );
}

// ── The engine's selection ───────────────────────────────────────────────────────────────────────────────────────

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The engine's selection: a 1px outline, four handles, the size under it. Its outline draws in around the box when it
 * appears (clockwise from the top left) and its handles pop; when the box changes, the edges move and stretch by
 * transform over `ms` on `ease` (so it can follow something resizing in step).
 */
export function Selection({
  box,
  size,
  tone = "brand",
  show = true,
  handles = true,
  draw = true,
  ms = 520,
  ease = BEZIER.standard,
  z = 10,
}: {
  box: Box;
  size?: ReactNode;
  tone?: "brand" | "component" | "dev";
  show?: boolean;
  handles?: boolean;
  /** Draw the outline in when it appears (false: it fades in whole). */
  draw?: boolean;
  /** How long a change of `box` takes, ms, and its curve. */
  ms?: number;
  ease?: Bezier;
  z?: number;
}) {
  // Known while rendering (not an effect later): the draw-in's delays must be in place when the outline starts to move
  const was = useRef(show);
  const shownAt = useRef(-Infinity);
  if (show && !was.current) shownAt.current = performance.now();
  was.current = show;
  const entering = draw && show && performance.now() - shownAt.current < 900;
  const [, rerender] = useState(0);
  useEffect(() => {
    if (!entering) return;
    const t = setTimeout(() => rerender((n) => n + 1), 900);
    return () => clearTimeout(t);
  }, [entering]);

  const style: CSSProperties & Record<string, string | number> = {
    transform: `translate(${box.x}px, ${box.y}px)`,
    zIndex: z,
    "--w": `${box.w}px`,
    "--h": `${box.h}px`,
    "--sx": box.w,
    "--sy": box.h,
    "--sel-ms": `${ms}ms`,
    "--sel-ease": css(ease),
  };
  return (
    <div className={styles.selection} data-tone={tone} data-out={show ? undefined : ""} data-draw={draw || undefined} data-entering={entering || undefined} style={style}>
      <i data-edge="t" />
      <i data-edge="r" />
      <i data-edge="b" />
      <i data-edge="l" />
      {handles && (
        <>
          <b data-h="tl" />
          <b data-h="tr" />
          <b data-h="bl" />
          <b data-h="br" />
        </>
      )}
      {size !== undefined && <span className={styles.size}>{size}</span>}
    </div>
  );
}

/** "W × H" with each number counting to its value (over `ms` on `ease`, in step with what it measures). */
export function Dims({ w, h, ms, ease }: { w: number | string; h: number | string; ms?: number; ease?: (t: number) => number }) {
  const n = (v: number | string) => (typeof v === "number" ? <Tween value={v} ms={ms} ease={ease} /> : v);
  return (
    <>
      {n(w)} × {n(h)}
    </>
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

/**
 * A picture filling in softly: a blurred copy fades in first, then the sharp one over it, settling from a touch
 * larger (opacity and transform only; the blur is static, on a small layer).
 */
export function Reveal({ on, children, className, style }: { on: boolean; children: ReactNode; className?: string; style?: CSSProperties }) {
  return (
    <div className={`${styles.reveal} ${className ?? ""}`} data-on={on || undefined} style={style}>
      <div className={styles.revealSoft}>{children}</div>
      <div className={styles.revealSharp}>{children}</div>
    </div>
  );
}

// ── Reflow and typing ────────────────────────────────────────────────────────────────────────────────────────────

/**
 * FLIP for reflow: after each change of `key`, every element under `ref` marked `data-flip` that moved in the layout
 * is drawn back where it was and slides (the `translate` property, on the gentle spring) to its new place. Layout
 * changes once, between frames; only transforms animate. A move that interrupts one in flight starts from where the
 * element is drawn.
 */
export function useFlip(ref: { current: HTMLElement | null }, key: unknown): void {
  const last = useRef(new Map<Element, [number, number]>());
  const flights = useRef(new Map<Element, Animation>());
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const spring = springEasing(SPRING.gentle);
    const next = new Map<Element, [number, number]>();
    for (const el of root.querySelectorAll<HTMLElement>("[data-flip]")) {
      if (!el.offsetParent) continue; // not laid out (display: none)
      const now: [number, number] = [el.offsetLeft, el.offsetTop];
      next.set(el, now);
      const was = last.current.get(el);
      if (!was || prefersReduced() || typeof el.animate !== "function") continue;
      let dx = was[0] - now[0];
      let dy = was[1] - now[1];
      const flying = flights.current.get(el);
      if (flying && flying.playState === "running") {
        const t = getComputedStyle(el).translate.split(" ").map(parseFloat);
        dx += t[0] || 0;
        dy += t[1] || 0;
        flying.cancel();
      }
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
      flights.current.set(el, el.animate([{ translate: `${dx}px ${dy}px` }, { translate: "0px 0px" }], { duration: spring.duration, easing: spring.easing }));
    }
    last.current = next;
  }, [key]);
}

/**
 * A blinking caret after the text in the first `input` inside `host` (a field the scene types into but can't focus:
 * the scene is inert). Steady while keys are coming (`typing`), blinking otherwise. `host` must be positioned.
 */
export function FieldCaret({ host, text, show, typing }: { host: { current: HTMLElement | null }; text: string; show: boolean; typing?: boolean }) {
  const [at, setAt] = useState<[number, number, number] | null>(null);
  useLayoutEffect(() => {
    const root = host.current;
    const input = root?.querySelector("input");
    if (!root || !input || !show) return setAt(null);
    const h = root.getBoundingClientRect();
    const scale = h.width / (root.offsetWidth || 1) || 1;
    const r = input.getBoundingClientRect();
    const cs = getComputedStyle(input);
    const ctx = document.createElement("canvas").getContext("2d");
    if (!ctx) return;
    ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const w = ctx.measureText(text).width + (parseFloat(cs.letterSpacing) || 0) * text.length;
    const height = Math.min(r.height / scale - 8, 16);
    setAt([(r.left - h.left) / scale + parseFloat(cs.paddingLeft) + w, (r.top - h.top) / scale + (r.height / scale - height) / 2, height]);
  }, [host, text, show]);
  if (!at) return null;
  return <span className={styles.caret} data-typing={typing || undefined} style={{ transform: `translate3d(${at[0]}px, ${at[1]}px, 0)`, height: at[2] }} />;
}
