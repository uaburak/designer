import { useEffect, useId, useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactNode } from "react";
import { cx } from "../util/cx";
import { createTypeahead, typeahead } from "../util/typeahead";
import { place, placeBelow, placeOverTrigger } from "../overlay/position";
import { Portal } from "../overlay/Portal";
import { useDismiss } from "../overlay/useDismiss";
import { Icon, type IconName } from "../icons/Icon";
import { isMixed, type ControlSize, type Mixed } from "../types";
import { STRINGS } from "../strings";
import { FieldPrefix } from "./TextInput";
import { MenuIcon, scrollWithin } from "./Menu";
import field from "./Field.module.css";
import menu from "./Menu.module.css";
import styles from "./Select.module.css";

/**
 * An option; `image` is drawn in place of the label, in the field and in the list (live Stroke settings' "Width
 * profile": the profile as a 62 × 4 image named "Uniform"), the label staying its accessible name.
 */
export type SelectOption = { value: string; label: string; icon?: IconName; hint?: string; disabled?: boolean; image?: ReactNode };

export interface SelectProps extends Omit<HTMLAttributes<HTMLDivElement>, "onChange" | "prefix"> {
  label: string;
  value: Mixed<string>;
  options: (SelectOption | "-")[];
  onChange: (v: string) => void;
  /** filled: panel fields; outlined: instance properties; ghost: no fill until hover (Home's "Last viewed ⌄", sizing) */
  variant?: "filled" | "outlined" | "ghost";
  size?: ControlSize;
  prefix?: IconName | string;
  /** px, or "hug" (as wide as the value) */
  width?: number | "hug";
  disabled?: boolean;
  placeholder?: string;
  /** Gallery: draw the list open, in place */
  static?: boolean;
  /** A list without the check column (live: the effect type menu — its icons at 16, the current one highlighted) */
  noCheck?: boolean;
  /**
   * The list under the field (flush with its bottom, 8 left of it) rather than over it — above the field when there
   * is no room (live popovers/layout-guide-type-menu.txt: 110 × 88 at 968,792 under a field ending at 792; the export
   * format list)
   */
  below?: boolean;
  /**
   * The list's width as live Figma measured it (px): the browser that took the capture and ours differ by a pixel or
   * two in text width, so a list whose labels alone come out other than live's is held to it (Menu's `width`).
   */
  menuWidth?: number;
}

/**
 * Figma's dropdown (contract §4.7): the value and a chevron in a field;
 * open, the dark menu with the chosen option ticked and laid over the
 * trigger (macOS style), at least as wide as it. Enter / Space / ↓ open;
 * in the list ↑ ↓ Home End, typeahead, Enter picks, Esc closes (focus stays
 * on the trigger). Never a native <select>.
 */
export function Select({ label, value, options, onChange, variant = "filled", size = "default", prefix, width, disabled, placeholder = "", static: isStatic, noCheck, below, menuWidth, className, style, ...rest }: SelectProps) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const id = useId();
  const mixed = isMixed(value);
  const current = mixed ? undefined : options.find((o): o is SelectOption => o !== "-" && o.value === value);
  const close = (focus = true) => {
    setOpen(false);
    if (focus) trigger.current?.focus({ preventScroll: true });
  };
  const showList = open || isStatic;
  return (
    <div
      data-ds="Select"
      data-disabled={disabled || undefined}
      data-open={showList || undefined}
      className={cx(field.field, variant === "outlined" && field.outlined, variant === "ghost" && styles.ghostField, size === "large" && field.large, width === "hug" && styles.hug, className)}
      style={{ ...(typeof width === "number" ? { width, flex: "none" } : null), ...style }}
      {...rest}
    >
      <button
        ref={trigger}
        type="button"
        role="combobox"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={showList}
        aria-controls={showList ? id : undefined}
        disabled={disabled}
        className={cx(styles.trigger, prefix !== undefined && styles.withPrefix)}
        onClick={() => (open ? close() : setOpen(true))}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        {prefix !== undefined && <FieldPrefix prefix={prefix} />}
        {!mixed && current?.image ? (
          <span className={cx(styles.value, styles.imageValue)}>
            <span className={styles.image} role="img" aria-label={current.label}>
              {current.image}
            </span>
          </span>
        ) : (
          <span className={cx(styles.value, (mixed || !current) && styles.placeholder)}>{mixed ? STRINGS.mixed : current?.label ?? placeholder}</span>
        )}
        <Icon name="16.chevron.down" className={styles.chevron} />
      </button>
      {showList && <Listbox id={id} anchor={trigger} options={options} value={mixed ? null : value} isStatic={isStatic} noCheck={noCheck} below={below} width={menuWidth} onPick={(v) => { close(); if (v !== value) onChange(v); }} onClose={close} />}
    </div>
  );
}

function Listbox({ id, anchor, options, value, isStatic, noCheck, below, width, onPick, onClose }: { width?: number; id: string; anchor: React.RefObject<HTMLButtonElement | null>; options: (SelectOption | "-")[]; value: string | null; isStatic?: boolean; noCheck?: boolean; below?: boolean; onPick: (v: string) => void; onClose: (focus?: boolean) => void }) {
  const panel = useRef<HTMLDivElement>(null);
  const selected = options.findIndex((o) => o !== "-" && o.value === value);
  const usable = options.map((o, i) => (o !== "-" && !o.disabled ? i : -1)).filter((i) => i >= 0);
  const [active, setActive] = useState(selected >= 0 ? selected : usable[0] ?? -1);
  const typed = useRef(createTypeahead());
  const move = (dir: 1 | -1) => {
    const at = usable.indexOf(active);
    setActive(usable[at < 0 ? 0 : (at + dir + usable.length) % usable.length]);
  };
  useDismiss(panel, () => onClose(false), { enabled: !isStatic, ignore: anchor, blur: true, resize: true, escape: false });

  useLayoutEffect(() => {
    const el = panel.current;
    const a = anchor.current;
    if (!el || !a || isStatic) return;
    const r = a.parentElement?.getBoundingClientRect() ?? a.getBoundingClientRect();
    // Live capture: the list is as wide as its labels (+ 64), never narrower than the field's box.
    if (width !== undefined) el.style.width = `${width}px`;
    else el.style.minWidth = `${Math.round(r.width + 16)}px`;
    const item = selected >= 0 ? el.querySelector<HTMLElement>(`[data-index="${selected}"]`) : null;
    const box = { width: el.offsetWidth, height: el.offsetHeight };
    const view = { width: window.innerWidth, height: window.innerHeight };
    // Without the check column (live effect type menu, popovers/effect-type-menu.txt) the list is a dropdown at the
    // field's left, 12 under it — or, without the room, 12 above it (live: 207 high, flipped up over the popover).
    let p = noCheck ? place(r, box, view, "bottom", "start", 12) : below ? placeBelow(r, box, view) : placeOverTrigger(r, item ? item.offsetTop : null, item ? item.offsetHeight : 0, box, view);
    if (!noCheck && !below && item) {
      // Live (popovers/font-weight-menu.txt: 167 × 313 at 1208,575): a list too long for the room under its field keeps
      // the chosen option over the field and is cut 12 from the window's bottom (it scrolls), rather than moving up.
      const top = Math.round(r.top - item.offsetTop + (r.bottom - r.top - item.offsetHeight) / 2);
      const room = view.height - 12 - top;
      // With little room under it (a field at the window's bottom, e.g. the Agents composer) the list moves up whole instead.
      if (top >= 8 && box.height > room && room >= item.offsetTop + item.offsetHeight && room >= 200) {
        el.style.maxHeight = `${room}px`;
        p = { ...p, y: top };
      }
    }
    el.style.left = `${p.x}px`;
    el.style.top = `${p.y}px`;
    el.style.visibility = "visible";
    el.focus({ preventScroll: true });
  }, [anchor, selected, isStatic, noCheck, below, width]);
  useEffect(() => {
    const el = panel.current;
    const item = active >= 0 ? el?.querySelector<HTMLElement>(`[data-index="${active}"]`) : null;
    if (el && item) scrollWithin(el, item);
  }, [active]);

  const list = (
    <div
      ref={panel}
      id={id}
      role="listbox"
      tabIndex={-1}
      data-ds="Menu"
      data-theme="dark"
      data-theme-forced=""
      data-static={isStatic || undefined}
      aria-activedescendant={active >= 0 ? `${id}-${active}` : undefined}
      className={cx(menu.panel, isStatic && menu.static, noCheck && styles.compactList, noCheck && menu.inset)}
      style={isStatic ? { position: "absolute", top: "100%", left: 0, marginTop: 4 } : { left: 0, top: 0, visibility: "hidden" }}
      onKeyDown={(e) => {
        e.stopPropagation();
        const k = e.key;
        if (k === "ArrowDown" || k === "ArrowUp") move(k === "ArrowDown" ? 1 : -1);
        else if (k === "Home") setActive(usable[0] ?? -1);
        else if (k === "End") setActive(usable[usable.length - 1] ?? -1);
        else if (k === "Enter" || k === " ") {
          const o = options[active];
          if (o && o !== "-" && !o.disabled) onPick(o.value);
        } else if (k === "Escape") onClose();
        else if (k === "Tab") onClose(false);
        else if (k.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
          const q = typed.current.push(k);
          const found = typeahead(options.map((o) => (o === "-" || o.disabled ? null : o.label)), q.length > 1 ? active - 1 : active, q);
          if (found >= 0) setActive(found);
        } else return;
        e.preventDefault();
      }}
    >
      {options.map((o, i) =>
        o === "-" ? (
          <div key={`line-${i}`} role="separator" className={menu.separator} />
        ) : (
          <div
            key={o.value}
            id={`${id}-${i}`}
            role="option"
            aria-selected={o.value === value}
            aria-disabled={o.disabled || undefined}
            data-index={i}
            data-highlighted={(active === i && !o.disabled) || undefined}
            className={cx(menu.item, !noCheck && menu.listItem)}
            onPointerEnter={() => !o.disabled && setActive(i)}
            onClick={() => !o.disabled && onPick(o.value)}
          >
            {!noCheck && <span className={menu.check}>{o.value === value && <Icon name="16.check" />}</span>}
            {o.icon && <span className={menu.icon}><MenuIcon name={o.icon} /></span>}
            {o.image ? (
              <span className={cx(menu.label, styles.imageValue)}>
                <span className={styles.image} role="img" aria-label={o.label}>
                  {o.image}
                </span>
              </span>
            ) : (
              <span className={menu.label}>{o.label}</span>
            )}
            {o.hint && <span className={menu.hint}>{o.hint}</span>}
          </div>
        )
      )}
    </div>
  );
  if (isStatic) return list;
  return <Portal theme="dark">{list}</Portal>;
}
