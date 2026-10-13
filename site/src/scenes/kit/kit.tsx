// The scenes' shared parts: the window, a canvas drawn by the page, the engine's selection look, a panel column.
// The canvases here are DOM (docs/site.md §2.4: one live engine per page — the hero's, or Draw's on /features —
// and the rest drawn with the same components over the app's canvas colour); what sits on them follows the
// engine's look (1px brand selection, white handles, the size pill).
import { forwardRef, type CSSProperties, type HTMLAttributes, type ReactNode } from "react";
import styles from "./kit.module.css";

export { styles as kit };

export const SceneWindow = forwardRef<HTMLDivElement, { title?: string; children: ReactNode; className?: string; style?: CSSProperties } & HTMLAttributes<HTMLDivElement>>(
  function SceneWindow({ title, children, className, ...rest }, ref) {
    return (
      <div ref={ref} className={`${styles.window} ${className ?? ""}`} {...rest}>
        {title !== undefined && <div className={styles.titlebar}>{title}</div>}
        {children}
      </div>
    );
  },
);

/** The window's body: canvas and panels side by side (`stack`: the panel goes under the canvas on a phone). */
export function SceneBody({ children, stack = true, style }: { children: ReactNode; stack?: boolean; style?: CSSProperties }) {
  return (
    <div className={styles.body} data-stack={stack || undefined} style={style}>
      {children}
    </div>
  );
}

export const SceneCanvas = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function SceneCanvas({ className, ...rest }, ref) {
  return <div ref={ref} className={`${styles.canvas} ${className ?? ""}`} {...rest} />;
});

export function Panel({ children, side = "right", title, style }: { children: ReactNode; side?: "left" | "right"; title?: ReactNode; style?: CSSProperties }) {
  return (
    <aside className={styles.panel} data-side={side} data-panel={side} style={style}>
      {title !== undefined && <div className={styles.panelTitle}>{title}</div>}
      {children}
    </aside>
  );
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The engine's selection: a box with four handles and its size under it. */
export function Selection({ box, label, tone, instant, handles = true }: { box: Box | null; label?: string; tone?: "component" | "dev"; instant?: boolean; handles?: boolean }) {
  if (!box) return null;
  return (
    <div className={styles.selection} data-tone={tone} data-instant={instant || undefined} style={{ left: box.x, top: box.y, width: box.w, height: box.h }}>
      {handles && (
        <>
          <span className={styles.handle} />
          <span className={styles.handle} />
          <span className={styles.handle} />
          <span className={styles.handle} />
        </>
      )}
      {label && <span className={styles.sizePill}>{label}</span>}
    </div>
  );
}

export function FrameLabel({ x, y, children, selected }: { x: number; y: number; children: ReactNode; selected?: boolean }) {
  return (
    <span className={styles.frameLabel} data-selected={selected || undefined} style={{ left: x, top: y }}>
      {children}
    </span>
  );
}

/** An element's box in another's (for a selection drawn over DOM content). */
export function boxIn(el: Element | null | undefined, container: Element | null | undefined): Box | null {
  if (!el || !container) return null;
  const a = el.getBoundingClientRect();
  const c = container.getBoundingClientRect();
  return { x: a.left - c.left, y: a.top - c.top, w: a.width, h: a.height };
}
