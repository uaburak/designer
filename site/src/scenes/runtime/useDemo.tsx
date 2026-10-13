// A scene's animation: DemoController wired to the page (on screen, reduced motion) and a pointer that shows where
// the app is being used. Steps change the scene through its own state; the pointer only shows it. Watch-only: the
// scene's container is inert (mount.tsx), the visitor's input never reaches it.
import { useEffect, useMemo, useRef, useSyncExternalStore, type RefObject } from "react";
import { DemoController, type DemoRun, type DemoState } from "./demoController";
import styles from "./runtime.module.css";

interface CursorState {
  x: number;
  y: number;
  shown: boolean;
  pressed: boolean;
  /** Travel time of the last move (ms) */
  ms: number;
}

export class CursorStore {
  private state: CursorState = { x: 0, y: 0, shown: false, pressed: false, ms: 0 };
  private readonly listeners = new Set<() => void>();
  get = () => this.state;
  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  set(patch: Partial<CursorState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }
}

type Target = Element | null | undefined | { x: number; y: number };

export interface SceneRun extends DemoRun {
  /** Moves the pointer to an element's centre (or a point in the scene's box) and waits until it is there. */
  move(target: Target, opts?: { ms?: number; dx?: number; dy?: number }): Promise<void>;
  /** Moves there and presses (the press is drawn; the step itself is the caller's). */
  click(target: Target, opts?: { ms?: number; dx?: number; dy?: number }): Promise<void>;
  /** Press and hold, for a drag the caller animates. */
  press(on: boolean): void;
  hide(): void;
  /** A point in the scene's box for an element (its centre plus an offset). */
  at(el: Element | null | undefined, dx?: number, dy?: number): { x: number; y: number };
  /** An element of the scene by selector. */
  $(selector: string): HTMLElement | null;
  /** The scene's root (the pointer's coordinates are in its box). */
  readonly root: HTMLElement;
}

export interface UseDemoOptions {
  loopGapMs?: number;
  startDelayMs?: number;
  /** Called as the demo starts each time (before the script): put the scene back to its first state */
  onStart?: () => void;
}

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export function useDemo(rootRef: RefObject<HTMLElement | null>, script: (run: SceneRun) => Promise<void>, options: UseDemoOptions = {}) {
  const cursor = useMemo(() => new CursorStore(), []);
  const scriptRef = useRef(script);
  scriptRef.current = script;
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const stateRef = useRef<DemoState>("off");

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const at = (el: Element | null | undefined, dx = 0, dy = 0) => {
      const box = root.getBoundingClientRect();
      if (!el) return { x: box.width / 2, y: box.height / 2 };
      const r = el.getBoundingClientRect();
      return { x: r.left - box.left + r.width / 2 + dx, y: r.top - box.top + r.height / 2 + dy };
    };
    const point = (t: Target, dx = 0, dy = 0) => (t && "getBoundingClientRect" in t ? at(t, dx, dy) : t ? { x: t.x + dx, y: t.y + dy } : at(null));

    const demo = new DemoController(
      async (run) => {
        optionsRef.current.onStart?.();
        const scene: SceneRun = {
          ...run,
          signal: run.signal,
          wait: run.wait,
          at,
          root,
          $: (s) => root.querySelector<HTMLElement>(s),
          async move(t, o = {}) {
            const p = point(t, o.dx, o.dy);
            const s = cursor.get();
            const ms = o.ms ?? (s.shown ? Math.min(900, 280 + Math.hypot(p.x - s.x, p.y - s.y) * 0.9) : 0);
            if (!s.shown) cursor.set({ x: p.x, y: p.y, ms: 0, shown: true });
            else cursor.set({ x: p.x, y: p.y, ms });
            await run.wait(ms + 40);
          },
          async click(t, o = {}) {
            await scene.move(t, o);
            cursor.set({ pressed: true });
            await run.wait(140);
            cursor.set({ pressed: false });
          },
          press(on) {
            cursor.set({ pressed: on });
          },
          hide() {
            cursor.set({ shown: false, pressed: false });
          },
        };
        try {
          await scriptRef.current(scene);
        } finally {
          if (run.signal.aborted) cursor.set({ shown: false, pressed: false });
        }
      },
      {
        loopGapMs: options.loopGapMs,
        startDelayMs: options.startDelayMs,
        onState: (s) => {
          stateRef.current = s;
          root.toggleAttribute("data-demo-playing", s === "playing");
          if (s !== "playing") cursor.set({ shown: false, pressed: false });
        },
      },
    );

    const io = new IntersectionObserver(([entry]) => demo.setVisible(entry.isIntersecting && !document.hidden), { threshold: 0.45 });
    io.observe(root);
    const onVisibility = () => {
      if (document.hidden) demo.setVisible(false);
      else {
        const r = root.getBoundingClientRect();
        demo.setVisible(r.bottom > innerHeight * 0.3 && r.top < innerHeight * 0.7);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    const onMotion = () => demo.setEnabled(!reducedMotion());
    onMotion();
    motion.addEventListener("change", onMotion);

    return () => {
      io.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      motion.removeEventListener("change", onMotion);
      demo.dispose();
    };
  }, [rootRef, cursor, options.loopGapMs, options.startDelayMs]);

  return { cursor, playing: () => stateRef.current === "playing" };
}

/** The demo's pointer: Figma's arrow, gliding between the steps (transform only). */
export function DemoCursor({ cursor }: { cursor: CursorStore }) {
  const s = useSyncExternalStore(cursor.subscribe, cursor.get);
  return (
    <div
      className={styles.cursor}
      data-shown={s.shown || undefined}
      data-pressed={s.pressed || undefined}
      aria-hidden="true"
      style={{ transform: `translate3d(${s.x}px, ${s.y}px, 0)`, transitionDuration: `${s.ms}ms, 200ms` }}
    >
      <svg width="22" height="24" viewBox="0 0 22 24" fill="none">
        <path d="M2.5 2.2 18.4 11.3l-7 1.9-3.7 6.6L2.5 2.2Z" fill="#000" stroke="#fff" strokeWidth="1.5" strokeLinejoin="round" />
      </svg>
    </div>
  );
}
