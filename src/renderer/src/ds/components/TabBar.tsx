import { useRef, useState, type ReactNode } from "react";
import { cx } from "../util/cx";
import { Icon } from "../icons/Icon";
import { STRINGS } from "../strings";
import { t, useT } from "@/i18n";
import { dropIndex } from "../util/geometry";
import { Button } from "./Button";
import { Spinner } from "./Spinner";
import styles from "./TabBar.module.css";

export type TabBarTab = { id: string; title: string; dirty?: boolean; kind?: "design" | "prototype" };

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
  /** At the right, before `trailing`: the app's update notice (`TabBarUpdate`) */
  notice?: ReactNode;
  /** No traffic lights: 8px instead of 80 */
  fullScreen?: boolean;
  /** Windows: Figma's main menu button at the left (no menu bar) and room for the caption buttons at the right */
  windows?: boolean;
  /** Windows: the main menu button, pressed — the shell pops the app's menu under it */
  onMainMenu?: (at: { x: number; y: number }) => void;
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
export function TabBar({ tabs, active, onActivate, onClose, onMove, onContextMenu, onNew, trailing, notice, fullScreen, windows, onMainMenu, hoverId }: TabBarProps) {
  useT();
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
    <div data-ds="TabBar" className={cx(styles.bar, fullScreen && styles.fullScreen, windows && styles.windows)}>
      {windows && (
        <button
          type="button"
          aria-label={t(STRINGS.mainMenu)}
          title={t(STRINGS.mainMenu)}
          className={styles.mainMenu}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            onMainMenu?.({ x: r.left, y: r.bottom });
          }}
        >
          <Icon name="24.figma" />
        </button>
      )}
      <div
        ref={strip}
        role="tablist"
        aria-label={t("Tabs")}
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
          aria-label={t(STRINGS.home)}
          title={t(STRINGS.home)}
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
        <button type="button" aria-label={t(STRINGS.newDesignFile)} title={t(STRINGS.newDesignFile)} className={styles.add} onClick={onNew}>
          <Icon name="24.plus" />
        </button>
      )}
      <div className={styles.spacer} />
      {notice && <div className={styles.notice}>{notice}</div>}
      {trailing && <div className={styles.trailing}>{trailing}</div>}
    </div>
  );
}

export type TabBarUpdateState = { kind: "checking" } | { kind: "downloading"; percent: number } | { kind: "ready"; version: string };

/**
 * The app's update in the tab bar (docs/desktop.md §12.6): Figma shows "Restart to update" there once an update has
 * downloaded — never forced, quitting installs it too. While "Check for Updates…" runs, its progress in the same place.
 */
export function TabBarUpdate({ state, onRestart }: { state: TabBarUpdateState; onRestart: () => void }) {
  useT();
  if (state.kind === "ready") {
    return (
      <Button variant="primary" className={styles.update} title={t("Version {version} is ready to install", { version: state.version })} onClick={onRestart}>
        {t(STRINGS.restartToUpdate)}
      </Button>
    );
  }
  return (
    <span data-ds="TabBarUpdate" role="status" className={styles.updateStatus}>
      <Spinner size={16} />
      {state.kind === "checking" ? t(STRINGS.checkingForUpdates) : `${t(STRINGS.downloadingUpdate)} ${state.percent}%`}
    </span>
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
  useT();
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
      <span className={styles.glyph}><Icon name={tab.kind === "prototype" ? "16.play" : "16.design"} /></span>
      <span className={styles.title}>{tab.title}</span>
      <span className={styles.slot}>
        {tab.dirty && <span className={styles.dot} aria-label={t(STRINGS.unsaved)} />}
        <button type="button" tabIndex={-1} aria-label={t("Close {title}", { title: tab.title })} className={styles.close} onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onClose(); }}>
          <Icon name="24.close.small" />
        </button>
      </span>
    </div>
  );
}
