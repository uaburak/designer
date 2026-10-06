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
 * `data-tooltip`, `data-tooltip-shortcut`, `data-tooltip-placement` and
 * `data-tooltip-align`, and draws one dark bubble in the overlay root after
 * 500ms — at once within 300ms of the last one hiding. Pointer leave or
 * down, keys, the wheel and blur hide it; it never shows while a button is
 * held or a menu is open.
 */
type Tip = { el: HTMLElement; label: string; shortcut?: string; side: Placement; align: Align };

export function TooltipManager() {
  const [tip, setTip] = useState<Tip | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const lastHidden = useRef(0);
  const current = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const read = (el: HTMLElement): Tip | null => {
      const label = el.dataset.tooltip;
      if (!label || "tooltipDisabled" in el.dataset || el.matches(":disabled")) return null;
      const side = (el.dataset.tooltipPlacement as Placement) || "bottom";
      return { el, label, shortcut: el.dataset.tooltipShortcut || undefined, side, align: (el.dataset.tooltipAlign as Align) || "center" };
    };
    const hide = () => {
      window.clearTimeout(timer.current);
      if (current.current) lastHidden.current = Date.now();
      current.current = null;
      setTip(null);
    };
    const show = (el: HTMLElement, delay: number) => {
      const t = read(el);
      if (!t) return;
      window.clearTimeout(timer.current);
      current.current = el;
      const warm = Date.now() - lastHidden.current < timing.tooltipWarm;
      if (warm || delay === 0) setTip(t);
      else timer.current = window.setTimeout(() => current.current === el && setTip(t), delay);
    };
    const menuOpen = () => Boolean(document.querySelector('[data-ds="Menu"]:not([data-static])'));
    const over = (e: PointerEvent) => {
      if (e.pointerType !== "mouse" || e.buttons) return;
      const el = (e.target as Element | null)?.closest?.<HTMLElement>("[data-tooltip]");
      if (el === current.current) return;
      if (!el || menuOpen()) return hide();
      hide();
      show(el, timing.tooltip);
    };
    const out = (e: PointerEvent) => {
      const from = current.current;
      if (from && !from.contains(e.relatedTarget as Node | null)) hide();
    };
    const focusIn = (e: FocusEvent) => {
      const el = (e.target as Element | null)?.closest?.<HTMLElement>("[data-tooltip]");
      if (el && (e.target as Element).matches(":focus-visible")) show(el, timing.tooltip);
    };
    const key = (e: KeyboardEvent) => {
      if (current.current) hide();
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
        {tip.shortcut && <span className={styles.shortcut}>{tip.shortcut}</span>}
      </div>
    </Portal>
  );
}

/** A tooltip drawn in place (the Gallery's forced state). */
export function TooltipBubble({ label, shortcut, className }: { label: string; shortcut?: string; className?: string }) {
  return (
    <div role="tooltip" data-ds="Tooltip" data-theme="dark" className={cx(styles.tooltip, styles.static, className)}>
      <span className={styles.label}>{label}</span>
      {shortcut && <span className={styles.shortcut}>{shortcut}</span>}
    </div>
  );
}

/** The attributes that give an element a tooltip (`{...tooltipProps("Move", "V")}`). */
export function tooltipProps(label: string | undefined, shortcut?: string, placement?: Placement, align?: Align): Record<string, string | undefined> {
  if (!label) return {};
  return { "data-tooltip": label, "data-tooltip-shortcut": shortcut, "data-tooltip-placement": placement, "data-tooltip-align": align };
}
