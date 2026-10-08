import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cx } from "../util/cx";
import { inTriangle, isItem, nextItem, tidy, toNativeTemplate, type MenuEntry, type NativeMenuItem } from "../util/menu";
import { createTypeahead, typeahead } from "../util/typeahead";
import { placeMenu } from "../overlay/position";
import { Portal } from "../overlay/Portal";
import { useDismiss } from "../overlay/useDismiss";
import { Icon, iconBox, type IconName } from "../icons/Icon";
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
}

function MenuPanel({ entries, x, y, flipX, above, autoFocus, isStatic, highlighted, onPick, onBack, onClose, label, context, keepTop }: PanelProps) {
  const panel = useRef<HTMLDivElement>(null);
  const subId = useId();
  const list = tidy(entries);
  const [active, setActive] = useState(highlighted ?? -1);
  const [sub, setSub] = useState<{ index: number; x: number; y: number; flipX: number; focus: boolean } | null>(null);
  const typed = useRef(createTypeahead());
  const intent = useRef<number | undefined>(undefined);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const hasChecks = list.some((e) => isItem(e) && e.checked !== undefined);
  const hasIcons = list.some((e) => isItem(e) && e.icon);

  useLayoutEffect(() => {
    const el = panel.current;
    if (!el) return;
    if (!isStatic) {
      const { width, height } = el.getBoundingClientRect();
      const room = window.innerHeight - 8 - y;
      // Live Figma: a dropdown longer than the room below its trigger stays under it (and scrolls).
      const keep = keepTop && !above && height > room && room >= 160;
      if (keep) el.style.maxHeight = `${room}px`;
      const p = placeMenu(x, above ? Math.max(8, y - height) : y, { width, height: keep ? room : height }, { width: window.innerWidth, height: window.innerHeight }, flipX);
      el.style.left = `${p.x}px`;
      el.style.top = `${p.y}px`;
      el.style.visibility = "visible";
    }
    if (autoFocus) el.focus({ preventScroll: true });
  }, [x, y, flipX, above, autoFocus, isStatic, keepTop]);

  useEffect(() => () => window.clearTimeout(intent.current), []);
  useEffect(() => {
    const el = panel.current;
    const item = active >= 0 ? el?.querySelector<HTMLElement>(`[data-menu-index="${active}"]`) : null;
    if (el && item) scrollWithin(el, item);
  }, [active]);

  const openSub = (index: number, focus: boolean) => {
    const item = panel.current?.querySelector<HTMLElement>(`[data-menu-index="${index}"]`);
    if (!item) return;
    const r = item.getBoundingClientRect();
    setSub({ index, x: r.right + 4, y: r.top - 8, flipX: r.left - 4, focus });
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
        aria-label={label}
        tabIndex={-1}
        data-ds="Menu"
        data-theme="dark"
        data-theme-forced=""
        data-static={isStatic || undefined}
        className={cx(styles.panel, isStatic && styles.static, context && styles.context)}
        style={isStatic ? undefined : { left: x, top: y, visibility: "hidden" }}
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
        {list.map((entry, i) => {
          if (entry === "-") return <div key={`line-${i}`} role="separator" className={styles.separator} />;
          if (!isItem(entry)) return <div key={`header-${i}`} role="presentation" className={styles.header}>{entry.header}</div>;
          const lit = !entry.disabled && (active === i || sub?.index === i);
          return (
            <div
              key={entry.id}
              role={entry.checked === undefined ? "menuitem" : "menuitemcheckbox"}
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
              {hasIcons && <span className={styles.icon}>{entry.icon && <MenuIcon name={entry.icon} />}</span>}
              <span className={styles.label}>{entry.label}</span>
              {entry.hint && <span className={styles.hint}>{entry.hint}</span>}
              {entry.shortcut && <span className={styles.shortcut}>{entry.shortcut}</span>}
              {entry.items && <Icon name="16.chevron.right" className={styles.chevron} />}
            </div>
          );
        })}
      </div>
      {sub && subEntry && isItem(subEntry) && subEntry.items && (
        <SubPanel parent={subId}>
          <MenuPanel
            key={sub.index}
            entries={subEntry.items}
            x={sub.x}
            y={sub.y}
            flipX={sub.flipX}
            autoFocus={sub.focus}
            context={context}
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

/** A menu item's glyph in its 16px column: a 16 icon as is, a 24 one at its size with its box overlapping the column (its glyph is ~16). */
export function MenuIcon({ name }: { name: IconName }) {
  return iconBox(name) === 24 ? <Icon name={name} style={{ margin: -4 }} /> : <Icon name={name} />;
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
}

/** A menu at a point (contract §4.8): picking anything, a press outside, the wheel, Esc, blur or resize closes it. */
export function ContextMenu({ at, entries, onSelect, onClose, renderer = "dom", above, static: isStatic, highlighted, ignore, label, context, keepTop }: ContextMenuProps) {
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
      above={above}
      autoFocus={!isStatic}
      isStatic={isStatic}
      highlighted={highlighted}
      label={label}
      context={context}
      keepTop={keepTop}
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
}

/** A trigger opening a menu under (or above) it; ↓ / Enter / Space open it; focus returns on close. */
export function MenuButton({ entries, onSelect, children, label, placement = "bottom", className, disabled, tooltip, shortcut }: MenuButtonProps) {
  const button = useRef<HTMLButtonElement>(null);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const open = () => {
    const r = button.current?.getBoundingClientRect();
    if (r) setAt({ x: r.left, y: placement === "top" ? r.top - 8 : r.bottom + 4 });
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
      {at && <ContextMenu at={at} above={placement === "top"} keepTop entries={entries} onSelect={onSelect} onClose={close} ignore={button} />}
    </>
  );
}
