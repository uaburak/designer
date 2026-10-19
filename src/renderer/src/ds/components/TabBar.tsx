import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { cx } from "../util/cx";
import { Icon } from "../icons/Icon";
import { STRINGS } from "../strings";
import { t, useT } from "@/i18n";
import { dropIndex } from "../util/geometry";
import { Button } from "./Button";
import { Spinner } from "./Spinner";
import styles from "./TabBar.module.css";

/** `splitWith`: a split tab's other half (atlas 01 §2.3), the tab right after or before it */
export type TabBarTab = { id: string; title: string; dirty?: boolean; kind?: "design" | "prototype" | "new-tab"; pinned?: boolean; groupId?: string; splitWith?: string };

/** Figma's tab group colours (atlas 01 §2.3) */
export type TabBarGroupColor = "blue" | "red" | "yellow" | "green" | "purple" | "pink" | "persimmon" | "grey";
/** A tab group as the bar shows it: its name already "Group {number}" when it has none */
export type TabBarGroup = { id: string; name: string; color: TabBarGroupColor };

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
  /** The tab groups its tabs name (atlas 01 §2.3) */
  groups?: TabBarGroup[];
  /** A group's header pressed with the right button: the shell's native group menu */
  onGroupMenu?: (groupId: string, at: { x: number; y: number }) => void;
  /** The group whose name is a field (Edit group name) */
  editingGroup?: string | null;
  /** The field left: the name typed, or null when Esc cancelled it */
  onRenameGroup?: (groupId: string, name: string | null) => void;
  /** The tabs menu at the right end ("Open and recently closed tabs"); the shell shows it native */
  onTabsMenu?: (at: { x: number; y: number }) => void;
  /**
   * The pointer on a file's tab (or the keyboard's focus, `keyboard`), from `x` in the bar, or on none (null): the
   * shell's preview card under it (atlas 01 §2.2). A press hides it until the pointer is on another tab.
   */
  onHover?: (id: string | null, at: { x: number; keyboard?: boolean }) => void;
}

export { dropIndex };

/**
 * Figma's desktop tab bar (contract §4.23): 38px incl. its 1px line; 80px
 * for the traffic lights; Home (40); each file — glyph, name, × or the
 * unsaved dot — with full-height lines after every tab. Drag sideways to
 * reorder (4px threshold; the others make room), middle click closes, the
 * free space moves the window. Titles use the native `title` attribute: no
 * DOM tooltip can leave a 38px view. Pinned tabs come first; a group's tabs
 * follow its coloured name as 24px pills (atlas 01 §2.3); "+" opens the
 * new-tab page; the tabs menu sits at the right end (§2.5). A split tab's two
 * halves stand together in one group ("Split tab group: {tab1}, {tab2}"),
 * no line between them, both lit while either is in front.
 */
export function TabBar({ tabs, active, onActivate, onClose, onMove, onContextMenu, onNew, trailing, notice, fullScreen, windows, onMainMenu, hoverId, groups = [], onGroupMenu, editingGroup, onRenameGroup, onTabsMenu, onHover }: TabBarProps) {
  useT();
  const strip = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ id: string; dx: number; from: number; to: number; width: number } | null>(null);
  /** The tab the preview card was asked for last (or pressed: none until another) */
  const hovered = useRef<string | null>(null);
  const hover = (el: HTMLElement | null, keyboard = false) => {
    const id = el?.dataset.tabId ?? null;
    if (!onHover || (id === hovered.current && !keyboard)) return;
    hovered.current = id;
    onHover(id, { x: el ? el.getBoundingClientRect().left : 0, keyboard });
  };
  const tabUnder = (target: EventTarget) => (target instanceof Element ? target.closest<HTMLElement>("[data-tab-id]") : null);

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
        onPointerMove={(e) => !drag && e.buttons === 0 && hover(tabUnder(e.target))}
        onPointerLeave={() => hover(null)}
        onPointerDownCapture={(e) => {
          if (!onHover || hovered.current === null) return;
          onHover(null, { x: 0 });
          // Pressed: no card again until the pointer is on another tab.
          hovered.current = tabUnder(e.target)?.dataset.tabId ?? null;
        }}
        onFocus={(e) => e.target.matches(":focus-visible") && hover(tabUnder(e.target), true)}
        onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && hover(null)}
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
          onContextMenu={(e) => {
            e.preventDefault();
            onContextMenu?.("home", { x: e.clientX, y: e.clientY });
          }}
          onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onActivate("home")}
        >
          <span className={styles.glyph}><Icon name="24.home" /></span>
        </div>
        {tabs.map((tab, i) => {
          const group = tab.groupId && tabs[i - 1]?.groupId !== tab.groupId ? groups.find((g) => g.id === tab.groupId) : undefined;
          // A split tab: drawn with its other half (the first of the two draws both).
          const second = tab.splitWith && tabs[i + 1]?.id === tab.splitWith ? tabs[i + 1] : undefined;
          if (tab.splitWith && tabs[i - 1]?.id === tab.splitWith) return null;
          const one = (t: TabBarTab, at: number, split?: "start" | "end") => (
            <Tab
              key={t.id}
              tab={t}
              active={t.id === active}
              split={split}
              splitFront={split && (t.splitWith === active || t.id === active)}
              hover={hoverId === t.id}
              dragging={drag?.id === t.id}
              shift={drag ? (drag.id === t.id ? drag.dx : shift(at)) : 0}
              groupColor={t.groupId ? groups.find((g) => g.id === t.groupId)?.color : undefined}
              onPointerDown={press(t.id, at)}
              onActivate={() => onActivate(t.id)}
              onClose={() => onClose(t.id)}
              onContextMenu={onContextMenu && ((at) => onContextMenu(t.id, at))}
            />
          );
          return (
            <Fragment key={tab.id}>
              {group && <GroupLabel group={group} editing={editingGroup === group.id} onMenu={onGroupMenu && ((at) => onGroupMenu(group.id, at))} onRename={onRenameGroup && ((name) => onRenameGroup(group.id, name))} />}
              {second ? (
                <div role="group" aria-label={t("Split tab group: {tab1}, {tab2}", { tab1: tab.title, tab2: second.title })} className={styles.split}>
                  {one(tab, i, "start")}
                  {one(second, i + 1, "end")}
                </div>
              ) : (
                one(tab, i)
              )}
            </Fragment>
          );
        })}
      </div>
      {onNew && (
        <button type="button" aria-label={t(STRINGS.newFile)} title={t(STRINGS.newFile)} className={styles.add} onClick={onNew}>
          <Icon name="24.plus" />
        </button>
      )}
      <div className={styles.spacer} />
      {notice && <div className={styles.notice}>{notice}</div>}
      {trailing && <div className={styles.trailing}>{trailing}</div>}
      {onTabsMenu && (
        <button
          type="button"
          aria-label={t(STRINGS.tabsMenu)}
          title={t(STRINGS.tabsMenu)}
          className={styles.tabsMenu}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            onTabsMenu({ x: r.left, y: r.bottom });
          }}
        >
          <Icon name="24.chevron.down" />
        </button>
      )}
    </div>
  );
}

/** A tab group's coloured name before its tabs; its menu on a right click, a field while it is renamed. */
function GroupLabel({ group, editing, onMenu, onRename }: { group: TabBarGroup; editing: boolean; onMenu?: (at: { x: number; y: number }) => void; onRename?: (name: string | null) => void }) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);
  return (
    <div
      data-ds="TabGroup"
      data-group-id={group.id}
      data-color={group.color}
      className={styles.group}
      title={group.name}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu?.({ x: e.clientX, y: e.clientY });
      }}
    >
      {editing ? (
        <input
          ref={input}
          className={styles.groupInput}
          aria-label={t("Group name")}
          defaultValue={group.name}
          onBlur={(e) => onRename?.(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            else if (e.key === "Escape") {
              e.preventDefault();
              onRename?.(null);
            }
          }}
        />
      ) : (
        <span className={styles.groupName}>{group.name}</span>
      )}
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
  /** In a group: a pill with the group's colour */
  groupColor?: TabBarGroupColor;
  /** Half of a split tab: the left or right one */
  split?: "start" | "end";
  /** Half of a split tab in front (either half): lit with it */
  splitFront?: boolean;
}

/** One file's tab (contract §4.23): glyph, title, then × — or the unsaved dot, swapped for × on hover. Middle click closes. */
export function Tab({ tab, active, onActivate, onClose, onContextMenu, onPointerDown, shift = 0, dragging, hover, groupColor, split, splitFront }: TabProps) {
  useT();
  return (
    <div
      data-ds="Tab"
      data-tab-id={tab.id}
      role="tab"
      aria-selected={active}
      aria-label={tab.pinned ? t("Pinned tab: {tabTitle}", { tabTitle: tab.title }) : undefined}
      tabIndex={active ? 0 : -1}
      title={tab.title}
      data-dirty={tab.dirty || undefined}
      data-dragging={dragging || undefined}
      data-hover={hover || undefined}
      data-pinned={tab.pinned || undefined}
      data-grouped={groupColor}
      data-split={split}
      data-split-front={splitFront || undefined}
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
      <span className={styles.glyph}><Icon name={tab.kind === "prototype" ? "16.play" : tab.kind === "new-tab" ? "16.page" : "16.design"} /></span>
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
