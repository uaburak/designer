import { useEffect, useRef, type ReactNode, type RefObject } from "react";

const FOCUSABLE = 'button:not([disabled]),[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((n) => n.getClientRects().length > 0);
}

/**
 * Focus moves in on mount — `initialFocus`, else `[data-autofocus]`, else
 * the first field, else the container — and goes back where it was on
 * unmount. With `trap`, Tab and ⇧Tab cycle inside.
 */
export function useFocusScope(container: RefObject<HTMLElement | null>, { trap = false, initialFocus, enabled = true }: { trap?: boolean; initialFocus?: RefObject<HTMLElement | null>; enabled?: boolean } = {}) {
  useEffect(() => {
    if (!enabled) return;
    const root = container.current;
    if (!root) return;
    const before = document.activeElement as HTMLElement | null;
    const first = initialFocus?.current ?? root.querySelector<HTMLElement>("[data-autofocus]") ?? root.querySelector<HTMLElement>("input:not([disabled]),textarea:not([disabled])");
    (first ?? root).focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (!trap || e.key !== "Tab") return;
      const items = focusables(root);
      if (!items.length) {
        e.preventDefault();
        return;
      }
      const a = items[0];
      const z = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === a || document.activeElement === root)) {
        e.preventDefault();
        z.focus();
      } else if (!e.shiftKey && document.activeElement === z) {
        e.preventDefault();
        a.focus();
      }
    };
    root.addEventListener("keydown", onKey);
    return () => {
      root.removeEventListener("keydown", onKey);
      if (before && document.contains(before)) before.focus({ preventScroll: true });
    };
  }, [container, trap, initialFocus, enabled]);
}

/** A focus trap around its children (a div with display: contents is not focusable, so this one is a block). */
export function FocusTrap({ children, className }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusScope(ref, { trap: true });
  return <div ref={ref} tabIndex={-1} className={className}>{children}</div>;
}
