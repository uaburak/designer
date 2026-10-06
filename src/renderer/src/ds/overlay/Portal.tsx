import type { ReactNode } from "react";
import { createPortal } from "react-dom";

const ROOT_ID = "ds-overlays";

/** The one overlay root of this document (`<div id="ds-overlays">` at the end of <body>), created on first use. */
export function overlayRoot(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  let el = document.getElementById(ROOT_ID);
  if (!el) {
    el = document.createElement("div");
    el.id = ROOT_ID;
    document.body.appendChild(el);
  }
  return el;
}

/** The theme an element is drawn in: its nearest `data-theme` (a subtree can force one). */
export function themeOf(el: Element | null | undefined): "light" | "dark" | undefined {
  const t = el?.closest("[data-theme]")?.getAttribute("data-theme");
  return t === "light" || t === "dark" ? t : undefined;
}

/**
 * The theme a new overlay inherits from what had focus when it opened. Menus,
 * tooltips and toasts force dark on their wrapper (`data-theme-forced`); those
 * are skipped, so a dialog opened from a context menu item takes the theme
 * around the menu — the app's — not the menu's dark. Without focus: the
 * document root's.
 */
export function inheritedTheme(active: Element | null | undefined): "light" | "dark" | undefined {
  const t = active?.closest("[data-theme]:not([data-theme-forced])")?.getAttribute("data-theme");
  if (t === "light" || t === "dark") return t;
  return themeOf(typeof document === "undefined" ? null : document.documentElement);
}

/**
 * Drawn in the overlay root (never clipped by a panel's overflow), in the
 * same commit as its owner — so the owner's layout effects can measure and
 * place what it portals. `theme`: "dark" for menus, tooltips and toasts
 * (dark in both themes); otherwise the theme of `anchor` (a popover opened
 * from a dark subtree stays dark), else of the focused element (the
 * trigger), else the document's.
 */
export function Portal({ children, theme, anchor }: { children: ReactNode; theme?: "light" | "dark"; anchor?: Element | null }) {
  const root = overlayRoot();
  if (!root) return null;
  // Without an anchor: the theme of what had focus when it opened (its trigger) — the document's in the app, a forced subtree's in the Gallery.
  const inherited = anchor !== undefined ? themeOf(anchor) ?? inheritedTheme(null) : inheritedTheme(document.activeElement);
  return createPortal(<div data-theme={theme ?? inherited} data-theme-forced={theme ? "" : undefined} style={{ display: "contents" }}>{children}</div>, root);
}
