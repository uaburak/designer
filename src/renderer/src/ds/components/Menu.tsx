import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cx } from "../util/cx";
import { inTriangle, isItem, nextItem, shortcutKeys, tidy, toNativeTemplate, type MenuEntry, type NativeMenuItem } from "../util/menu";
import { createTypeahead, typeahead } from "../util/typeahead";
import { placeMenu } from "../overlay/position";
import { Portal } from "../overlay/Portal";
import { useDismiss } from "../overlay/useDismiss";
import { Icon, type IconName } from "../icons/Icon";
import { tooltipProps } from "../overlay/TooltipManager";
import { timing } from "../tokens";
import styles from "./Menu.module.css";

export type { MenuEntry, MenuItem, MenuHeader, NativeMenuItem } from "../util/menu";
export { toNativeTemplate, tidy } from "../util/menu";

/**
 * Figma's menu (contract §4.8; ported from components/admin/ContextMenu.tsx):
 * dark in both themes, 13px corners, 24px items at 12px, groups parted by
 * full-bleed lines, keys at the right, check and icon columns only when some
 * item uses them, submenus beside their item (flipped at the view's edge).
 * Keys: ↑ ↓ (wrapping) Home End, typeahead, → / Enter open a submenu, ← /
 * Esc go back, Esc at the root closes, Enter / Space pick. A submenu opens
 * after a short hover; a pointer heading for the open one (the triangle
 * "safe area") does not switch it.
 */
interface PanelProps {
  entries: MenuEntry[];
  x: number;
  y: number;
  /** A submenu's flip point: its right edge here when there is no room on the right */
  flipX?: number;
  /** `y` is the bottom (a menu opening upwards from the bottom toolbar) */
  above?: boolean;
  autoFocus: boolean;
  isStatic?: boolean;
  /** Gallery: the item drawn highlighted */
  highlighted?: number;
  onPick: (id: string) => void;
  onBack?: () => void;
  onClose: () => void;
  label?: string;
  /** A context menu (canvas, layers, pages): live Figma's 11px / 400 items, at least 200 wide */
  context?: boolean;
  /** A dropdown under its trigger (MenuButton): a long one stays there and scrolls (live Figma) rather than moving up */
  keepTop?: boolean;
  /**
   * A dropdown over its field (live: the font size, gap and W / H lists): the checked item at the field's top + `dy`,
   * the list at the field's left (or right) edge, at least as wide as the field + 8
   */
  over?: MenuOver;
  /**
   * A tool menu over the bottom toolbar (live: Move tools, Shape tools…): no padding above or below its rows, the
   * current tool lit when it opens
   */
  dropdown?: boolean;
  /** The least width (live Figma's measured width where the rows alone don't make it) */
  minWidth?: number;
  /**
   * The width live Figma measured (px). Text metrics differ by a fraction of a pixel between the browser that took the
   * capture and ours, so a menu whose rows alone come out 1 wider is held to live's: its label may run into the gap
   * before the keys by that fraction (`.fixed`), the keys' edge stays 16 from the menu's.
   */
  width?: number;
  /** A submenu (beside its item): live Figma's margins to the window (6 above, 8 below), scrolling when taller */
  submenu?: boolean;
  /** A submenu's margin to the window's bottom where live measured another than 8 (Preferences: 5) */
  edgeBottom?: number;
  /**
   * A menu under its trigger (MenuButton; live popovers/boolean-operations-menu, instance-more-actions-menu…): no
   * padding above or below its rows, groups 15 apart, the first row lit when it opens
   */
  flush?: boolean;
  /** The caller's look for this menu (its width, its headers, its icon column): a class on the panel */
  className?: string;
  /**
   * A dropdown that flips: when it would end less than 16 from the window's bottom it opens upwards with its bottom
   * here (live popovers/stroke-individual-strokes-menu.txt: 12 above its trigger)
   */
  flipY?: number;
  /**
   * A menu longer than the window runs past its bottom, uncut (live popovers/frame-presets-menu.txt: 222 × 1887 at
   * 1208,125 in a 900-high window); the wheel and the arrow keys move it up and down to bring its rows in
   */
  extend?: boolean;
}

export type MenuOver = { rect: DOMRect; align?: "left" | "right"; dy?: number };

/** Live (menus/main-view.txt: 105 + 787 in a 900-high window): 8 below; main-preferences.txt measured 5 (`edgeBottom`). */
const SUBMENU_EDGES = { top: 6, bottom: 8 };

function MenuPanel({ entries, x, y, flipX, above, autoFocus, isStatic, highlighted, onPick, onBack, onClose, label, context, keepTop, over, dropdown, minWidth, width: fixedWidth, submenu, edgeBottom, flush, className, flipY, extend: extendProp }: PanelProps) {
  const panel = useRef<HTMLDivElement>(null);
  // Live (menus/main-object.txt): a submenu taller than the window isn't clamped to it — 185 × 1050 at 210, 6 in a 900 high
  // window; it is an extended menu then (the rows past the window's bottom move up on the wheel or on the bar).
  const [tall, setTall] = useState(false);
  const extend = extendProp || tall;
  const edges = edgeBottom === undefined ? SUBMENU_EDGES : { top: SUBMENU_EDGES.top, bottom: edgeBottom };
  const subId = useId();
  const list = tidy(entries);
  // Live: a tool menu and a list over its field (gap, W / H) open with the current value lit, a menu under its trigger
  // with its checked row lit, else its first (popovers/boolean-operations-menu, blend-mode-menu,
  // stroke-individual-strokes-menu, frame-presets-menu, width-sizing-menu, gap-menu).
  const checkedRow = list.findIndex((e) => isItem(e) && e.checked && !e.disabled);
  const [active, setActive] = useState(highlighted ?? (dropdown || over ? checkedRow : flush ? (checkedRow >= 0 ? checkedRow : nextItem(list, -1, 1)) : -1));
  // Live (toolbar/*-tools-menu.txt, popovers/stroke-individual-strokes-menu.txt): a menu of radio items is named by a
  // hidden label ("Move tools", "Individual strokes").
  const named = !!label && (dropdown || (flush && list.some((e) => isItem(e) && e.radio)));
  const [sub, setSub] = useState<{ index: number; x: number; y: number; flipX: number; focus: boolean } | null>(null);
  const typed = useRef(createTypeahead());
  const intent = useRef<number | undefined>(undefined);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const hasChecks = list.some((e) => isItem(e) && e.checked !== undefined);
  // A glyph column when an item has a glyph; an `inlineIcon` glyph sits before its own label instead (live main menu:
  // "Actions…" at 40, the other rows at 16).
  const hasIcons = list.some((e) => isItem(e) && e.icon && !e.inlineIcon);

  // An extended menu moves instead of scrolling: never above where it opened, never ending above the window's bottom.
  const more = useRef<HTMLDivElement>(null);
  const moreTimer = useRef<number | undefined>(undefined);
  const placeMore = (el: HTMLElement) => {
    const bar = more.current;
    if (!bar) return;
    bar.style.top = "0px";
    const natural = el.offsetTop + bar.offsetTop;
    const want = window.innerHeight - 12 - bar.offsetHeight;
    // Shown while rows run past it; at the end of the list it stays in place, hidden.
    const shown = natural > want + 12;
    bar.style.top = shown ? `${want - natural}px` : "0px";
    bar.style.visibility = shown ? "visible" : "hidden";
  };
  // (where an extended menu rests: where it opened; a tall submenu 6 from the window's top)
  const home = tall ? SUBMENU_EDGES.top : y;
  const shift = (el: HTMLElement, by: number) => {
    const lowest = Math.min(home, window.innerHeight - 8 - el.offsetHeight);
    el.style.top = `${Math.round(Math.min(home, Math.max(lowest, el.offsetTop - by)))}px`;
    placeMore(el);
  };
  useLayoutEffect(() => {
    const el = panel.current;
    if (!el) return;
    if (!isStatic && over) {
      const { rect, align = "left", dy = 0 } = over;
      // Live: a list over its field's left edge is the field + 8 wide (font size); one at its right edge at least 156 (gap).
      el.style.minWidth = `${align === "left" ? Math.round(rect.width + 8) : 156}px`;
      const item = el.querySelector<HTMLElement>('[aria-checked="true"]');
      const { width, height } = el.getBoundingClientRect();
      const top = item ? rect.top - item.offsetTop + dy : rect.bottom + 4;
      const left = align === "right" ? rect.right - width : rect.left;
      el.style.left = `${Math.round(Math.max(8, Math.min(left, window.innerWidth - 8 - width)))}px`;
      el.style.top = `${Math.round(Math.max(8, Math.min(top, window.innerHeight - 8 - height)))}px`;
      el.style.visibility = "visible";
      if (item) scrollWithin(el, item);
    } else if (!isStatic && extend) {
      el.style.maxHeight = "none";
      el.style.overflowY = "visible";
      const { width } = el.getBoundingClientRect();
      el.style.left = `${placeMenu(x, y, { width, height: 0 }, { width: window.innerWidth, height: window.innerHeight }, flipX).x}px`;
      el.style.top = `${home}px`;
      el.style.visibility = "visible";
      placeMore(el);
    } else if (!isStatic) {
      if (submenu) {
        // Natural height first: past the window it is a tall submenu (above), else the clamp below applies as before.
        el.style.maxHeight = "none";
        const natural = el.getBoundingClientRect().height;
        el.style.maxHeight = "";
        if (natural > window.innerHeight - edges.top - edges.bottom) {
          setTall(true);
          return;
        }
      }
      const { width, height } = el.getBoundingClientRect();
      const room = window.innerHeight - 8 - y;
      const flip = flipY !== undefined && !above && y + height > window.innerHeight - 16 && flipY - height >= 8;
      // Live Figma: a dropdown longer than the room below its trigger stays under it (and scrolls).
      const keep = keepTop && !above && !flip && height > room && room >= 160;
      if (keep) el.style.maxHeight = `${room}px`;
      // A submenu keeps live Figma's margins: 6 above, 5 below (menus/main-object, main-preferences).
      const p = placeMenu(x, flip ? flipY - height : above ? Math.max(8, y - height) : y, { width, height: keep ? room : height }, { width: window.innerWidth, height: window.innerHeight }, flipX, submenu ? edges : undefined);
      el.style.left = `${p.x}px`;
      el.style.top = `${p.y}px`;
      el.style.visibility = "visible";
    }
    if (autoFocus) el.focus({ preventScroll: true });
  }, [x, y, flipX, flipY, above, autoFocus, isStatic, keepTop, over, submenu, extend, home, edges.bottom]);

  // Resting on the bar moves the rows up a row at a time (unverified: live's capture shows the bar at rest).
  const moreScroll = (el: HTMLElement) => {
    window.clearInterval(moreTimer.current);
    moreTimer.current = window.setInterval(() => shift(el, 24), 80);
  };
  useEffect(() => () => window.clearInterval(moreTimer.current), []);
  useEffect(() => {
    const el = panel.current;
    if (!el || !extend || isStatic) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      shift(el, e.deltaY);
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `shift` reads the current layout
  }, [extend, isStatic, y]);
  useEffect(() => () => window.clearTimeout(intent.current), []);
  useEffect(() => {
    const el = panel.current;
    const item = active >= 0 ? el?.querySelector<HTMLElement>(`[data-menu-index="${active}"]`) : null;
    if (!el || !item) return;
    if (!extend) return scrollWithin(el, item);
    const r = item.getBoundingClientRect();
    if (r.bottom > window.innerHeight - 8) shift(el, r.bottom - (window.innerHeight - 8));
    else if (r.top < 8) shift(el, r.top - 8);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `shift` reads the current layout
  }, [active, extend]);

  const openSub = (index: number, focus: boolean) => {
    const item = panel.current?.querySelector<HTMLElement>(`[data-menu-index="${index}"]`);
    if (!item || !panel.current) return;
    // Live (menus/main-*.txt): 4 past the menu's own edge, its first row level with the item.
    const r = item.getBoundingClientRect();
    const p = panel.current.getBoundingClientRect();
    setSub({ index, x: p.right + 4, y: r.top - 8, flipX: p.left - 4, focus });
  };
  const pick = (index: number) => {
    const entry = list[index];
    if (!entry || !isItem(entry) || entry.disabled) return;
    if (entry.items) return openSub(index, true);
    onPick(entry.id);
  };
  // Is the pointer heading for the open submenu? (inside the triangle from where it was to the submenu's near edge)
  const headingForSub = (p: { x: number; y: number }) => {
    const from = pointer.current;
    const el = document.querySelector<HTMLElement>(`[data-menu-parent="${CSS.escape(subId)}"]`);
    if (!from || !el) return false;
    const r = el.getBoundingClientRect();
    const nearX = r.left > from.x ? r.left : r.right;
    return inTriangle(p, from, { x: nearX, y: r.top }, { x: nearX, y: r.bottom });
  };
  const enter = (i: number, e: React.PointerEvent) => {
    const entry = list[i];
    if (!isItem(entry)) return;
    window.clearTimeout(intent.current);
    const p = { x: e.clientX, y: e.clientY };
    const go = () => {
      setActive(i);
      if (entry.items && !entry.disabled) openSub(i, false);
      else setSub(null);
    };
    if (sub && sub.index !== i && headingForSub(p)) {
      intent.current = window.setTimeout(go, 300);
      return;
    }
    setActive(i);
    if (entry.items && !entry.disabled) {
      if (sub) go();
      else intent.current = window.setTimeout(go, timing.submenu);
    } else setSub(null);
  };

  const subEntry = sub ? list[sub.index] : undefined;
  return (
    <>
      <div
        ref={panel}
        role="menu"
        aria-label={named ? undefined : label}
        aria-labelledby={named ? `${subId}-label` : undefined}
        tabIndex={-1}
        data-ds="Menu"
        data-theme="dark"
        data-theme-forced=""
        data-static={isStatic || undefined}
        className={cx(styles.panel, isStatic && styles.static, context && styles.context, over && styles.overList, over && styles.inset, dropdown && styles.dropdown, flush && !over && styles.flush, hasIcons && styles.withIcons, submenu && styles.sub, fixedWidth !== undefined && styles.fixed, className)}
        style={isStatic ? { ...(minWidth ? { minWidth } : {}), ...(fixedWidth !== undefined ? { width: fixedWidth } : {}) } : { left: x, top: y, visibility: "hidden", ...(minWidth ? { minWidth } : {}), ...(fixedWidth !== undefined ? { width: fixedWidth } : {}) }}
        onPointerMove={(e) => {
          pointer.current = { x: e.clientX, y: e.clientY };
        }}
        onContextMenu={(e) => e.preventDefault()}
        onKeyDown={(e) => {
          e.stopPropagation();
          const k = e.key;
          if (k === "ArrowDown" || k === "ArrowUp") setActive(nextItem(list, active, k === "ArrowDown" ? 1 : -1));
          else if (k === "Home") setActive(nextItem(list, -1, 1));
          else if (k === "End") setActive(nextItem(list, -1, -1));
          else if (k === "Enter" || k === " ") pick(active);
          else if (k === "ArrowRight") {
            const entry = list[active];
            if (entry && isItem(entry) && entry.items && !entry.disabled) openSub(active, true);
          } else if ((k === "ArrowLeft" || k === "Escape") && onBack) onBack();
          else if (k === "Escape" || k === "Tab") onClose();
          else if (k.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
            const q = typed.current.push(k);
            const labels = list.map((en) => (isItem(en) && !en.disabled ? en.label : null));
            const found = typeahead(labels, q.length > 1 ? active - 1 : active, q);
            if (found >= 0) setActive(found);
          } else return;
          e.preventDefault();
        }}
      >
        {/* Live (toolbar/*-tools-menu.txt): a tool menu is named by a hidden "Move tools" / "Shape tools"… */}
        {named && (
          <span id={`${subId}-label`} className={styles.hiddenLabel}>
            {label}
          </span>
        )}
        {list.map((entry, i) => {
          if (entry === "-") return <div key={`line-${i}`} role="separator" className={styles.separator} />;
          if (!isItem(entry)) return <div key={`header-${i}`} role="presentation" className={styles.header}>{entry.header}</div>;
          const lit = !entry.disabled && (active === i || sub?.index === i);
          return (
            <div
              key={entry.id}
              role={entry.checked === undefined ? "menuitem" : entry.radio ? "menuitemradio" : "menuitemcheckbox"}
              data-menu-index={i}
              data-highlighted={lit || undefined}
              aria-haspopup={entry.items ? "menu" : undefined}
              aria-expanded={entry.items ? sub?.index === i : undefined}
              aria-checked={entry.checked}
              aria-disabled={entry.disabled || undefined}
              className={styles.item}
              onPointerEnter={(e) => enter(i, e)}
              onClick={() => pick(i)}
            >
              {hasChecks && <span className={styles.check}>{entry.checked && <Icon name="16.check" />}</span>}
              {hasIcons && <span className={styles.icon}>{entry.icon && !entry.inlineIcon && <MenuIcon name={entry.icon} />}</span>}
              {entry.inlineIcon && entry.icon && <span className={cx(styles.icon, styles.inlineIcon)}><MenuIcon name={entry.icon} /></span>}
              <span className={styles.label}>{entry.label}</span>
              {entry.trailingIcon && <span className={styles.icon}><MenuIcon name={entry.trailingIcon} /></span>}
              {entry.hint && <span className={styles.hint}>{hintParts(entry.hint)}</span>}
              {entry.badge && (
                <span className={styles.badge} aria-label={`${entry.badge}, Learn more`}>
                  {entry.badge}
                </span>
              )}
              {entry.shortcut &&
                (context ? (
                  // Live context menus: one 12px glyph per key, the chord 8 after the label.
                  <span className={cx(styles.shortcut, styles.keys)}>
                    {shortcutKeys(entry.shortcut).map((k, j) => (
                      <span key={j} data-key={k}>
                        {k}
                      </span>
                    ))}
                  </span>
                ) : (
                  <span className={styles.shortcut}>{entry.shortcut}</span>
                ))}
              {entry.items && <Icon name="16.chevron.right" className={styles.chevron} />}
            </div>
          );
        })}
        {/* An extended menu's bar at the window's bottom while rows run past it (live: 24 high, 12 above the bottom) */}
        {extendProp && !isStatic && (
          <div ref={more} className={styles.more} aria-hidden="true" onPointerEnter={() => panel.current && moreScroll(panel.current)} onPointerLeave={() => window.clearInterval(moreTimer.current)}>
            <Icon name="16.chevron.down" />
          </div>
        )}
      </div>
      {sub && subEntry && isItem(subEntry) && subEntry.items && (
        <SubPanel parent={subId}>
          <MenuPanel
            key={sub.index}
            entries={subEntry.items}
            x={sub.x}
            y={sub.y}
            flipX={sub.flipX}
            submenu
            autoFocus={sub.focus}
            context={context}
            minWidth={subEntry.minWidth}
            width={subEntry.width}
            edgeBottom={subEntry.edgeBottom}
            onPick={onPick}
            onClose={onClose}
            onBack={() => {
              setSub(null);
              panel.current?.focus({ preventScroll: true });
            }}
          />
        </SubPanel>
      )}
    </>
  );
}

/** A hint as Figma draws a size: "402×874" as three runs ("402", "×", "874"; live popovers/frame-presets-menu.txt). */
function hintParts(hint: string): ReactNode {
  const parts = hint.split(/(×)/);
  return parts.length === 3 ? parts.map((p, i) => <span key={i}>{p}</span>) : hint;
}

/** A menu item's glyph in its 24px column (a 16 icon centred in it). */
export function MenuIcon({ name }: { name: IconName }) {
  return <Icon name={name} />;
}

/** Scrolls a long menu so `item` is in view — the menu only, never the page behind it. */
export function scrollWithin(panel: HTMLElement, item: HTMLElement) {
  const top = item.offsetTop;
  const bottom = top + item.offsetHeight;
  if (top < panel.scrollTop) panel.scrollTop = top - 8;
  else if (bottom > panel.scrollTop + panel.clientHeight) panel.scrollTop = bottom - panel.clientHeight + 8;
}

/** Marks a submenu with its parent's id (the safe-area lookup). */
function SubPanel({ parent, children }: { parent: string; children: ReactNode }) {
  return <div data-menu-parent={parent} style={{ display: "contents" }}>{children}</div>;
}

type DesignerMenuBridge = { designer?: { menu?: { popup?: (template: NativeMenuItem[], at: { x: number; y: number }) => Promise<string | null> } } };

export interface ContextMenuProps {
  /** Where it opens, in the view's px */
  at: { x: number; y: number };
  entries: MenuEntry[];
  onSelect: (id: string) => void;
  onClose: () => void;
  /** "native": the OS menu through the preload (`menu:popup`); falls back to the DOM one */
  renderer?: "dom" | "native";
  /** Open upwards: `at.y` is its bottom */
  above?: boolean;
  /** Drawn in place, not in the overlay root (the Gallery) */
  static?: boolean;
  /** Gallery: the highlighted item's index */
  highlighted?: number;
  /** Presses here do not close it (the button that toggles it) */
  ignore?: React.RefObject<HTMLElement | null>;
  label?: string;
  /** A context menu (canvas, layers, pages): live Figma's 11px / 400 items, at least 200 wide */
  context?: boolean;
  /** A dropdown under its trigger: stays there when long (see MenuPanel) */
  keepTop?: boolean;
  /** A dropdown over its field (see MenuPanel) */
  over?: MenuOver;
  /** A tool menu over the bottom toolbar (see MenuPanel) */
  dropdown?: boolean;
  /** The least width (see MenuPanel) */
  minWidth?: number;
  /** The width live measured (see MenuPanel) */
  width?: number;
  /** Its right edge here when it doesn't fit right of `at.x` (a dropdown right-aligned with its trigger) */
  flipX?: number;
  /** A menu under its trigger (see MenuPanel) */
  flush?: boolean;
  /** The caller's look for this menu (see MenuPanel) */
  className?: string;
  /** Flips upwards with its bottom here when it doesn't fit under (see MenuPanel) */
  flipY?: number;
  /** Runs past the window's bottom, moved by the wheel (see MenuPanel) */
  extend?: boolean;
}

/** A menu at a point (contract §4.8): picking anything, a press outside, the wheel, Esc, blur or resize closes it. */
export function ContextMenu({ at, entries, onSelect, onClose, renderer = "dom", above, static: isStatic, highlighted, ignore, label, context, keepTop, over, dropdown, minWidth, width, flipX, flush, className, flipY, extend }: ContextMenuProps) {
  const root = useRef<HTMLDivElement>(null);
  const popup = renderer === "native" ? (window as unknown as DesignerMenuBridge).designer?.menu?.popup : undefined;
  useDismiss(root, onClose, { enabled: !isStatic && !popup, ignore, wheel: true, blur: true, resize: true, escape: false });
  useEffect(() => {
    if (!popup) return;
    let live = true;
    void popup(toNativeTemplate(entries), at).then((id) => {
      if (!live) return;
      if (id) onSelect(id);
      onClose();
    });
    return () => {
      live = false;
    };
    // The native menu opens once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (popup) return null;
  const panel = (
    <MenuPanel
      entries={entries}
      x={at.x}
      y={at.y}
      flipX={flipX}
      flipY={flipY}
      extend={extend}
      className={className}
      above={above}
      autoFocus={!isStatic}
      isStatic={isStatic}
      highlighted={highlighted}
      label={label}
      context={context}
      keepTop={keepTop}
      over={over}
      dropdown={dropdown}
      flush={flush}
      minWidth={minWidth}
      width={width}
      onPick={(id) => {
        onSelect(id);
        onClose();
      }}
      onClose={onClose}
    />
  );
  if (isStatic) return panel;
  return (
    <Portal theme="dark">
      <div ref={root} style={{ display: "contents" }}>{panel}</div>
    </Portal>
  );
}

export interface MenuButtonProps {
  entries: MenuEntry[];
  onSelect: (id: string) => void;
  /** The trigger's content */
  children: ReactNode;
  /** aria-label */
  label: string;
  placement?: "bottom" | "top";
  /** The trigger's look, replacing the default ghost one (it gets `data-open` while open) */
  className?: string;
  disabled?: boolean;
  /** A tooltip on hover (Figma's panel buttons: the label, or this text) */
  tooltip?: boolean | string;
  /** Shown next to the tooltip */
  shortcut?: string;
  /** Open over this field (the closest ancestor matching it): the checked item over it (live: the font size list) */
  overField?: string;
  /** With `overField`: which of its edges the list lines up with, and the checked item's offset from its top */
  overAlign?: "left" | "right";
  overOffset?: number;
  /** `end`: a menu that doesn't fit right of the trigger lines up with its right edge (live: the panel header's menus) */
  align?: "start" | "end";
  /** The menu's distance under the trigger (default 4; the Design panel's menus 12 — `PANEL_MENU_GAP`) */
  gap?: number;
  /** Opens upwards, `gap` above the trigger, when it doesn't fit under it (16 from the window's bottom) */
  flip?: boolean;
  /** Longer than the window: runs past its bottom, moved by the wheel (see MenuPanel) */
  extend?: boolean;
  /**
   * A list named by the trigger's label (a hidden first line, live stroke-individual-strokes-menu.txt "Individual
   * strokes" at −1,1) with its checked row lit on open
   */
  named?: boolean;
  /**
   * A menu flush under its trigger (S8; live popovers/boolean-operations-menu, instance-more-actions-menu,
   * component-create-property-menu, blend-mode-menu, frame-presets-menu): no padding above or below its rows, its
   * checked row — else its first — lit when it opens
   */
  flush?: boolean;
  /** The menu's own look (see MenuPanel's `className`) */
  menuClassName?: string;
  /** The width live measured (see MenuPanel's `width`) */
  menuWidth?: number;
  /** With `align="end"`: px the menu's right edge lies past the trigger's (live: blend mode, Create property 1) */
  alignOffset?: number;
}

/** A trigger opening a menu under (or above) it; ↓ / Enter / Space open it; focus returns on close. */
export function MenuButton({ entries, onSelect, children, label, placement = "bottom", className, disabled, tooltip, shortcut, overField, overAlign, overOffset, align = "start", gap = 4, flip, extend, named, flush, menuClassName, menuWidth, alignOffset = 0 }: MenuButtonProps) {
  const button = useRef<HTMLButtonElement>(null);
  const [at, setAt] = useState<{ x: number; y: number; over?: MenuOver; flipX?: number; flipY?: number } | null>(null);
  const open = () => {
    const r = button.current?.getBoundingClientRect();
    const field = overField ? button.current?.closest(overField)?.getBoundingClientRect() : undefined;
    if (r) setAt({ x: r.left, y: placement === "top" ? r.top - 8 : r.bottom + gap, over: field ? { rect: field, align: overAlign, dy: overOffset } : undefined, flipX: align === "end" ? r.right + alignOffset : undefined, flipY: flip && placement !== "top" ? r.top - gap : undefined });
  };
  const close = () => {
    setAt(null);
    button.current?.focus({ preventScroll: true });
  };
  return (
    <>
      <button
        ref={button}
        type="button"
        data-ds="MenuButton"
        aria-haspopup="menu"
        aria-expanded={Boolean(at)}
        aria-label={label}
        data-open={at ? "" : undefined}
        disabled={disabled}
        className={className ?? styles.trigger}
        {...(tooltip && !at ? tooltipProps(typeof tooltip === "string" ? tooltip : label, shortcut) : {})}
        onClick={() => (at ? setAt(null) : open())}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && placement === "bottom") {
            e.preventDefault();
            open();
          }
        }}
      >
        {children}
      </button>
      {at && <ContextMenu at={at} above={placement === "top"} keepTop flush={flush} over={at.over} flipX={at.flipX} flipY={at.flipY} extend={extend} dropdown={named} label={named || flush ? label : undefined} className={menuClassName} width={menuWidth} entries={entries} onSelect={onSelect} onClose={close} ignore={button} />}
    </>
  );
}
