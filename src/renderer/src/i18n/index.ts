import { useSyncExternalStore } from "react";
import { getLocale, hasDictionary, intlLocale, LOCALES, onLocaleChange, parseLocale, registerDictionary, setLocale, t, tp, tx, type Locale } from "@shared/i18n";

/**
 * The UI's language in a view (src/shared/i18n): `t("Share")` / `tp(n, "{n} file", "{n} files")` anywhere, and
 * `const t = useT()` in a component so it renders again when the language changes. English strings stay in code
 * (they are the keys); module-level lists keep English and are translated where they render (`t(item.label)`).
 *
 * The desktop app's language is main's (settings.json): the preload hands the one the view was made with
 * (`window.designer.locale`), `setLocalePreference` asks main (`locale:set`), and main tells every view
 * (`locale:changed`). Without a preload (a browser, tests) it is localStorage "designer-locale".
 * Turkish's dictionary is loaded only when Turkish is on.
 */
export { t, tp, tx, getLocale, intlLocale, LOCALES, type Locale };

export const LOCALE_STORAGE_KEY = "designer-locale";

type DesignerLocale = { locale?: Locale; setLocale?: (l: Locale) => Promise<Locale>; onLocaleChanged?: (cb: (l: Locale) => void) => () => void };
const designer = (): DesignerLocale | undefined => (typeof window === "undefined" ? undefined : (window as unknown as { designer?: DesignerLocale }).designer);

async function load(l: Locale): Promise<void> {
  if (!hasDictionary(l)) registerDictionary(l, (await import("@shared/i18n/tr")).TR);
}

/** The language switched on, its dictionary loaded first (and <html lang> set). */
export async function applyLocale(next: Locale): Promise<void> {
  const l = parseLocale(next);
  await load(l);
  setLocale(l);
  if (typeof document !== "undefined") document.documentElement.lang = l;
}

function storedLocale(): Locale {
  try {
    return parseLocale(localStorage.getItem(LOCALE_STORAGE_KEY));
  } catch {
    return "en";
  }
}

let installed = false;

/** Once per page, before the first render: the view's language, and main's (or another tab's) changes followed. */
export async function initLocale(): Promise<void> {
  if (installed) return;
  installed = true;
  const d = designer();
  if (d?.onLocaleChanged) d.onLocaleChanged((l) => void applyLocale(l));
  else if (typeof window !== "undefined") window.addEventListener("storage", (e) => (e.key === LOCALE_STORAGE_KEY || e.key === null) && void applyLocale(storedLocale()));
  const boot = d?.locale !== undefined ? parseLocale(d.locale) : storedLocale();
  if (boot !== "en") await applyLocale(boot).catch(() => {});
}

/** Settings › Account › Language: main is told (every view and the menu bar follow); this page switches at once. */
export async function setLocalePreference(next: Locale): Promise<void> {
  const l = parseLocale(next);
  try {
    if (l === "en") localStorage.removeItem(LOCALE_STORAGE_KEY);
    else localStorage.setItem(LOCALE_STORAGE_KEY, l);
  } catch {
    /* this page only */
  }
  await applyLocale(l);
  await designer()?.setLocale?.(l);
}

const subscribe = (cb: () => void) => onLocaleChange(cb);

/** The current language (re-renders on a change). */
export function useLocale(): Locale {
  return useSyncExternalStore(subscribe, getLocale, getLocale);
}

/** `t`, with the component rendering again when the language changes. */
export function useT(): typeof t {
  useLocale();
  return t;
}
