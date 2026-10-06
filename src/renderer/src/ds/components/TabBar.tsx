import { useRef, useState, type ReactNode } from "react";
import { cx } from "../util/cx";
import { Icon } from "../icons/Icon";
import { STRINGS } from "../strings";
import { dropIndex } from "../util/geometry";
import styles from "./TabBar.module.css";

export type TabBarTab = { id: string; title: string; dirty?: boolean; kind?: "design" };

export interface TabBarProps {
  tabs: TabBarTab[];
  /** "home" or a tab's id */
  active: string;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  /** toIndex among the file tabs */
  onMove?: (id: string, toIndex: number) => void;
  /** The shell shows a native menu there */
  onContextMenu?: (id: string, at: { x: number; y: number }) => void;
  onNew?: () => void;
  /** The 40px slot at the right edge (the shell's icon button) */
  trailing?: ReactNode;
  /** No traffic lights: 8px instead of 80 */
  fullScreen?: boolean;
  /** Gallery: a forced hover on this tab */
  hoverId?: string;
}

export { dropIndex };

/**
 * Figma's desktop tab bar (contract §4.23): 38px incl. its 1px line; 80px
 * for the traffic lights; Home (40); each file — glyph, name, × or the
 * unsaved dot — with full-height lines after every tab. Drag sideways to
 * reorder (4px threshold; the others make room), middle click closes, the
 * free space moves the window. Titles use the native `title` attribute: no
 * DOM tooltip can leave a 38px view.
 */
export function TabBar({ tabs, active, onActivate, onClose, onMove, onContextMenu, onNew, trailing, fullScreen, hoverId }: TabBarProps) {
  const strip = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ id: string; dx: number; from: number; to: number; width: number } | null>(null);

  const press = (id: string, index: number) => (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || (e.target as Element).closest("button")) return;
    onActivate(id);
    const startX = e.clientX;
    const el = e.currentTarget;
    const own = el.getBoundingClientRect();
    const others = [...(strip.current?.querySelectorAll<HTMLElement>("[data-tab-id]") ?? [])].filter((t) => t.dataset.tabId !== id).map((t) => {
      const r = t.getBoundingClientRect();
      return r.left + r.width / 2;
    });
    let moved = false;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      if (!moved && Math.abs(dx) < 4) return;
      moved = true;
      setDrag({ id, dx, from: index, to: dropIndex(others, own.left + own.width / 2 + dx), width: own.width });
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDrag(null);
      if (moved) onMove?.(id, dropIndex(others, own.left + own.width / 2 + ev.clientX - startX));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // While dragging, the tabs between the old and the new place shift by the dragged tab's width.
  const shift = (i: number) => {
    if (!drag || i === drag.from) return 0;
    if (drag.to > drag.from && i > drag.from && i <= drag.to) return -drag.width;
    if (drag.to < drag.from && i >= drag.to && i < drag.from) return drag.width;
    return 0;
  };

  return (
    <div data-ds="TabBar" className={cx(styles.bar, fullScreen && styles.fullScreen)}>
      <div
        ref={strip}
        role="tablist"
        aria-label="Tabs"
        className={styles.strip}
        onKeyDown={(e) => {
          // ← → move between Home and the tabs, bringing each forward
          if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
          const all = [...(strip.current?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])];
          const at = all.indexOf(document.activeElement as HTMLElement);
          if (at < 0) return;
          e.preventDefault();
          const next = all[(at + (e.key === "ArrowRight" ? 1 : -1) + all.length) % all.length];
          next.focus();
          onActivate(next.dataset.tabId ?? "home");
        }}
      >
        <div
          role="tab"
          aria-selected={active === "home"}
          aria-label={STRINGS.home}
          title={STRINGS.home}
          tabIndex={active === "home" ? 0 : -1}
          data-hover={hoverId === "home" || undefined}
          className={cx(styles.tab, styles.home)}
          onClick={() => onActivate("home")}
          onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onActivate("home")}
        >
          <span className={styles.glyph}><Icon name="24.home" /></span>
        </div>
        {tabs.map((t, i) => (
          <Tab
            key={t.id}
            tab={t}
            active={t.id === active}
            hover={hoverId === t.id}
            dragging={drag?.id === t.id}
            shift={drag ? (drag.id === t.id ? drag.dx : shift(i)) : 0}
            onPointerDown={press(t.id, i)}
            onActivate={() => onActivate(t.id)}
            onClose={() => onClose(t.id)}
            onContextMenu={onContextMenu && ((at) => onContextMenu(t.id, at))}
          />
        ))}
      </div>
      {onNew && (
        <button type="button" aria-label={STRINGS.newDesignFile} title={STRINGS.newDesignFile} className={styles.add} onClick={onNew}>
          <Icon name="24.plus" />
        </button>
      )}
      <div className={styles.spacer} />
      {trailing && <div className={styles.trailing}>{trailing}</div>}
    </div>
  );
}

export interface TabProps {
  tab: TabBarTab;
  active: boolean;
  onActivate: () => void;
  onClose: () => void;
  onContextMenu?: (at: { x: number; y: number }) => void;
  onPointerDown?: (e: React.PointerEvent<HTMLDivElement>) => void;
  /** px it is moved sideways (dragged, or making room for the dragged one) */
  shift?: number;
  dragging?: boolean;
  /** Gallery: forced hover */
  hover?: boolean;
}

/** One file's tab (contract §4.23): glyph, title, then × — or the unsaved dot, swapped for × on hover. Middle click closes. */
export function Tab({ tab, active, onActivate, onClose, onContextMenu, onPointerDown, shift = 0, dragging, hover }: TabProps) {
  return (
    <div
      data-ds="Tab"
      data-tab-id={tab.id}
      role="tab"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      title={tab.title}
      data-dirty={tab.dirty || undefined}
      data-dragging={dragging || undefined}
      data-hover={hover || undefined}
      className={styles.tab}
      style={shift ? { transform: `translateX(${shift}px)` } : undefined}
      onPointerDown={onPointerDown}
      onAuxClick={(e) => e.button === 1 && onClose()}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu?.({ x: e.clientX, y: e.clientY });
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onActivate();
      }}
    >
      <span className={styles.glyph}><Icon name="16.design" /></span>
      <span className={styles.title}>{tab.title}</span>
      <span className={styles.slot}>
        {tab.dirty && <span className={styles.dot} aria-label={STRINGS.unsaved} />}
        <button type="button" tabIndex={-1} aria-label={`${STRINGS.close} ${tab.title}`} className={styles.close} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onClose(); }}>
          <Icon name="24.close.small" />
        </button>
      </span>
    </div>
  );
}
