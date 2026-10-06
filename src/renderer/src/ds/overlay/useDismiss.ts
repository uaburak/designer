import { useEffect, useRef, type RefObject } from "react";

/**
 * Closes an overlay on a press outside it (and outside `ignore`, e.g. its
 * trigger; presses inside any other DS overlay count as inside), and
 * optionally on the wheel, Esc, the window's blur and resize.
 */
export function useDismiss(
  inside: RefObject<HTMLElement | null>,
  onClose: () => void,
  { enabled = true, ignore, wheel = false, escape = true, blur = false, resize = false }: { enabled?: boolean; ignore?: RefObject<HTMLElement | null> | Element | null; wheel?: boolean; escape?: boolean; blur?: boolean; resize?: boolean } = {}
) {
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });
  useEffect(() => {
    if (!enabled) return;
    const outside = (e: Event) => {
      const t = e.target as Element | null;
      const skip = ignore instanceof Element ? ignore : ignore?.current;
      if (!t || inside.current?.contains(t) || skip?.contains(t)) return;
      // Another overlay of the same chain (a submenu, a picker's Select list) is inside.
      if (t.closest?.("#ds-overlays") && inside.current?.closest("#ds-overlays") && e.type !== "wheel") return;
      close.current();
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Focus in another overlay (a Select list or menu opened from this one): that one closes first.
      const t = e.target as Element | null;
      if (t && !inside.current?.contains(t) && t.closest?.("#ds-overlays")) return;
      e.stopPropagation();
      close.current();
    };
    const shut = () => close.current();
    document.addEventListener("pointerdown", outside, true);
    if (wheel) document.addEventListener("wheel", outside, { capture: true, passive: true });
    if (escape) document.addEventListener("keydown", esc, true);
    if (blur) window.addEventListener("blur", shut);
    if (resize) window.addEventListener("resize", shut);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("wheel", outside, true);
      document.removeEventListener("keydown", esc, true);
      window.removeEventListener("blur", shut);
      window.removeEventListener("resize", shut);
    };
  }, [enabled, inside, ignore, wheel, escape, blur, resize]);
}
