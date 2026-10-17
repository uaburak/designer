import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cx } from "../util/cx";
import { timing } from "../tokens";
import type { Placement } from "../types";
import { Portal } from "./Portal";
import { place, type Align } from "./position";
import styles from "../components/Tooltip.module.css";

/**
 * One tooltip manager per document (contract §4.9), mounted by each entry's
 * root: a delegated pointerover / focusin listener reads the target's
 * `data-tooltip`, `data-tooltip-shortcut`, `data-tooltip-badge` (Figma's
 * "Motion  Beta" tag on the mode switch), `data-tooltip-placement` and
 * `data-tooltip-align`, and draws one dark bubble in the overlay root.
 * Figma's timing (docs/research/atlas/02-editor-chrome.md §6): it shows
 * after 1000ms (`data-tooltip-delay` overrides it, `-show-immediately`
 * skips it); while one is showing, the next target's shows at once; leaving
 * the target hides it 300ms later (`-hide-immediately` at once), a pending
 * one is dropped at once. Pointer down, keys, the wheel and blur hide it
 * at once; it never shows while a button is held or a menu is open.
 */
type Tip = { el: HTMLElement; label: string; shortcut?: string; badge?: string; side: Placement; align: Align };

export function TooltipManager() {
  const [tip, setTip] = useState<Tip | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const hideTimer = useRef<number | undefined>(undefined);
  /** The tooltip on screen (the state's, for the listeners) */
  const shown = useRef<Tip | null>(null);
  const current = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const read = (el: HTMLElement): Tip | null => {
      const label = el.dataset.tooltip;
      if (!label || "tooltipDisabled" in el.dataset || el.matches(":disabled")) return null;
      const side = (el.dataset.tooltipPlacement as Placement) || "bottom";
      return { el, label, shortcut: el.dataset.tooltipShortcut || undefined, badge: el.dataset.tooltipBadge || undefined, side, align: (el.dataset.tooltipAlign as Align) || "center" };
    };
    const put = (t: Tip | null) => {
      shown.current = t;
      setTip(t);
    };
    const hide = () => {
      window.clearTimeout(timer.current);
      window.clearTimeout(hideTimer.current);
      current.current = null;
      put(null);
    };
    // Leaving a target: a pending tooltip goes at once, a showing one after Figma's 300ms (a target reached meanwhile
    // shows its own at once).
    const leave = () => {
      window.clearTimeout(timer.current);
      const from = current.current;
      current.current = null;
      if (!shown.current) return;
      window.clearTimeout(hideTimer.current);
      if (from && "tooltipHideImmediately" in from.dataset) put(null);
      else hideTimer.current = window.setTimeout(() => put(null), timing.tooltipHide);
    };
    // An open menu (a MenuButton's, a context menu, the canvas status menu) never has a tooltip under it: checked when
    // the tooltip would show, not only when the pointer arrives — a menu opened during the delay (by a key, or by the
    // control's own press) wins.
    const menuOpen = () => Boolean(document.querySelector('[data-ds="Menu"]:not([data-static])'));
    const show = (el: HTMLElement) => {
      const t = read(el);
      if (!t || menuOpen()) return;
      window.clearTimeout(timer.current);
      current.current = el;
      const delay = "tooltipShowImmediately" in el.dataset ? 0 : Number(el.dataset.tooltipDelay) || timing.tooltip;
      if (shown.current || delay === 0) {
        window.clearTimeout(hideTimer.current);
        put(t);
      } else timer.current = window.setTimeout(() => current.current === el && !menuOpen() && put(t), delay);
    };
    const over = (e: PointerEvent) => {
      if (e.pointerType !== "mouse" || e.buttons) return;
      const el = (e.target as Element | null)?.closest?.<HTMLElement>("[data-tooltip]");
      if (el && el === current.current) return;
      if (menuOpen()) return hide();
      if (!el) return leave();
      if (el === shown.current?.el) {
        // Back on the target within the hide delay: it stays.
        window.clearTimeout(hideTimer.current);
        current.current = el;
        return;
      }
      show(el);
    };
    const out = (e: PointerEvent) => {
      const from = current.current;
      if (from && !from.contains(e.relatedTarget as Node | null)) leave();
    };
    const focusIn = (e: FocusEvent) => {
      const el = (e.target as Element | null)?.closest?.<HTMLElement>("[data-tooltip]");
      if (el && (e.target as Element).matches(":focus-visible")) show(el);
    };
    const key = (e: KeyboardEvent) => {
      if (current.current || shown.current) hide();
      void e;
    };
    document.addEventListener("pointerover", over, true);
    document.addEventListener("pointerout", out, true);
    document.addEventListener("pointerdown", hide, true);
    document.addEventListener("focusin", focusIn, true);
    document.addEventListener("focusout", hide, true);
    document.addEventListener("keydown", key, true);
    document.addEventListener("wheel", hide, { capture: true, passive: true });
    window.addEventListener("blur", hide);
    return () => {
      window.clearTimeout(timer.current);
      window.clearTimeout(hideTimer.current);
      document.removeEventListener("pointerover", over, true);
      document.removeEventListener("pointerout", out, true);
      document.removeEventListener("pointerdown", hide, true);
      document.removeEventListener("focusin", focusIn, true);
      document.removeEventListener("focusout", hide, true);
      document.removeEventListener("keydown", key, true);
      document.removeEventListener("wheel", hide, true);
      window.removeEventListener("blur", hide);
    };
  }, []);

  if (!tip) return null;
  return <FloatingTooltip tip={tip} />;
}

function FloatingTooltip({ tip }: { tip: Tip }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !document.contains(tip.el)) return;
    const r = tip.el.getBoundingClientRect();
    const p = place(r, { width: el.offsetWidth, height: el.offsetHeight }, { width: window.innerWidth, height: window.innerHeight }, tip.side, tip.align, 6);
    el.style.left = `${p.x}px`;
    el.style.top = `${p.y}px`;
    el.style.visibility = "visible";
  }, [tip]);
  return (
    <Portal theme="dark">
      <div ref={ref} role="tooltip" data-ds="Tooltip" className={styles.tooltip} style={{ left: 0, top: 0, visibility: "hidden" }}>
        <span className={styles.label}>{tip.label}</span>
        {tip.badge && <span className={styles.badge}>{tip.badge}</span>}
        {tip.shortcut && <span className={styles.shortcut}>{tip.shortcut}</span>}
      </div>
    </Portal>
  );
}

/** A tooltip drawn in place (the Gallery's forced state). */
export function TooltipBubble({ label, shortcut, className }: { label: string; shortcut?: string; className?: string }) {
  return (
    <div role="tooltip" data-ds="Tooltip" data-theme="dark" data-theme-forced="" className={cx(styles.tooltip, styles.static, className)}>
      <span className={styles.label}>{label}</span>
      {shortcut && <span className={styles.shortcut}>{shortcut}</span>}
    </div>
  );
}

/** The attributes that give an element a tooltip (`{...tooltipProps("Move", "V")}`); `badge`: a tag after the label ("Beta"). */
export function tooltipProps(label: string | undefined, shortcut?: string, placement?: Placement, align?: Align, badge?: string): Record<string, string | undefined> {
  if (!label) return {};
  return { "data-tooltip": label, "data-tooltip-shortcut": shortcut, "data-tooltip-badge": badge, "data-tooltip-placement": placement, "data-tooltip-align": align };
}
