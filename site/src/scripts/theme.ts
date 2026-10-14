// The site's theme (docs/site.md §2.1): light on the first visit, the dock's toggle switches to dark and back, and
// the choice is kept in localStorage. It is `<html data-theme>`, which the app's tokens (ds/tokens.css) follow, so the
// scenes' chrome switches with the page; scenes with an engine canvas listen for THEME_EVENT.

export type SiteTheme = "light" | "dark";

export const THEME_KEY = "wecra-site-theme";
export const THEME_EVENT = "wecra-theme";

/** A stored value as a theme: anything but "dark" is light (the first visit included). */
export const parseTheme = (stored: string | null | undefined): SiteTheme => (stored === "dark" ? "dark" : "light");

export function siteTheme(): SiteTheme {
  return parseTheme(document.documentElement.getAttribute("data-theme"));
}

export function setSiteTheme(theme: SiteTheme): void {
  const root = document.documentElement;
  const apply = () => {
    root.setAttribute("data-theme", theme);
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#1e1e1e" : "#ffffff");
    window.dispatchEvent(new Event(THEME_EVENT));
  };
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* this visit only */
  }
  // A cross-fade where the browser has view transitions (and motion is welcome); otherwise at once.
  const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
  if (doc.startViewTransition && !matchMedia("(prefers-reduced-motion: reduce)").matches) doc.startViewTransition(apply);
  else apply();
}

export function onSiteTheme(listener: (theme: SiteTheme) => void): () => void {
  const handler = () => listener(siteTheme());
  window.addEventListener(THEME_EVENT, handler);
  return () => window.removeEventListener(THEME_EVENT, handler);
}

/** The dock's button: its pressed state follows the theme. */
export function initThemeToggle(): void {
  const button = document.querySelector<HTMLButtonElement>("[data-theme-toggle]");
  if (!button) return;
  const sync = () => {
    const dark = siteTheme() === "dark";
    button.setAttribute("aria-pressed", String(dark));
    button.title = dark ? "Light theme" : "Dark theme";
  };
  button.addEventListener("click", () => setSiteTheme(siteTheme() === "dark" ? "light" : "dark"));
  onSiteTheme(sync);
  sync();
}
