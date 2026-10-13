// The AI page's shared parts: a design world fitted into its canvas (the scenes' frames are drawn at their own size
// and scaled, as the engine's camera would), cancellable timed jobs for the scenes' fake runs, the AI badge and the
// run pill. What the app draws comes from its own CSS modules (the Actions panel's badge, the image tools' sweep);
// the rest is the site's, from the tokens.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { Button } from "@/ds/components/Button";
import { Spinner } from "@/ds/components/Spinner";
import aiPanel from "@/editor/ai/AiPanel.module.css";
import styles from "./shared.module.css";

export { styles as shared };

/** The scale that fits a `w` × `h` world in the element (with `pad` around it), at most `max`. */
export function useFit(ref: RefObject<HTMLElement | null>, w: number, h: number, { pad = 24, max = 1, min = 0.2 }: { pad?: number; max?: number; min?: number } = {}): number {
  const [scale, setScale] = useState(1);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const cw = el.clientWidth - pad * 2;
      const ch = el.clientHeight - pad * 2;
      if (cw <= 0 || ch <= 0) return;
      setScale(Math.max(min, Math.min(max, cw / w, ch / h)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, w, h, pad, max, min]);
  return scale;
}

/** A world of `w` × `h` design units, centred and scaled in its (relative) parent. */
export function World({ w, h, scale, children, className, style }: { w: number; h: number; scale: number; children: ReactNode; className?: string; style?: CSSProperties }) {
  return (
    <div className={`${styles.world} ${className ?? ""}`} style={{ width: w, height: h, transform: `translate(-50%, -50%) scale(${scale})`, ...style }}>
      {children}
    </div>
  );
}

class Cancelled extends Error {
  constructor() {
    super("cancelled");
    this.name = "Cancelled";
  }
}

export type Wait = (ms: number) => Promise<void>;

/**
 * Timed jobs (a fake run's steps): starting one cancels the one before, and leaving the page cancels all. A job's
 * `wait` rejects quietly once it is cancelled, so its later steps never land.
 */
export function useJobs() {
  const gen = useRef(0);
  useEffect(() => {
    const g = gen;
    return () => {
      g.current++;
    };
  }, []);
  return useMemo(
    () => ({
      start(fn: (wait: Wait) => Promise<void>, { parallel = false }: { parallel?: boolean } = {}): Promise<void> {
        const my = parallel ? gen.current : ++gen.current;
        const live = () => gen.current === my;
        const wait: Wait = (ms) => new Promise<void>((res, rej) => setTimeout(() => (live() ? res() : rej(new Cancelled())), ms));
        return fn(wait).catch((e: unknown) => {
          if (!(e instanceof Cancelled)) throw e;
        });
      },
      cancel() {
        gen.current++;
      },
    }),
    [],
  );
}

/** Figma's "AI" badge on an Actions row (the app's own class; a label here, not the help link). */
export function AiBadge() {
  return <span className={aiPanel.badge}>AI</span>;
}

/** Where a tool runs: on this computer, in the engine, or through the image route. */
export function WhereTag({ where }: { where: "local" | "engine" | "route" | "text" }) {
  const label = where === "local" ? "On your computer" : where === "engine" ? "In the engine" : where === "route" ? "Image route" : "Text route";
  return (
    <span className={styles.where} data-where={where}>
      {label}
    </span>
  );
}

/**
 * The bottom pill over the canvas (the app's AiHost pill): a run's label with Stop while it runs, then what it did
 * with Undo — each run is one undo step.
 */
export function RunPill({ running, label, done, onStop, onUndo, children }: { running?: boolean; label?: string; done?: string | null; onStop?: () => void; onUndo?: () => void; children?: ReactNode }) {
  if (!running && !done && !children) return null;
  return (
    <div className={styles.pill} role="status" data-run-pill={running ? "running" : "done"}>
      {running ? (
        <>
          <Spinner size={16} label={label ?? "Working…"} />
          <span className={styles.pillText}>{label}</span>
          {onStop && (
            <Button variant="secondary" onClick={onStop}>
              Stop
            </Button>
          )}
        </>
      ) : children ? (
        children
      ) : (
        <>
          <span className={styles.pillText}>{done}</span>
          {onUndo && (
            <Button variant="secondary" shortcut="⌘Z" onClick={onUndo} data-undo="">
              Undo
            </Button>
          )}
        </>
      )}
    </div>
  );
}

/** ⌘Z / Ctrl+Z inside the scene (only while the pointer or focus is in it). */
export function useUndoKey(root: RefObject<HTMLElement | null>, undo: () => void) {
  const fn = useRef(undo);
  fn.current = undo;
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "z") {
        const t = e.target as HTMLElement | null;
        if (t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT")) return;
        e.preventDefault();
        fn.current();
      }
    };
    el.addEventListener("keydown", onKey);
    return () => el.removeEventListener("keydown", onKey);
  }, [root]);
}

export const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
