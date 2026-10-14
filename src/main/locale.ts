import { webContents } from "electron";
import { getLocale, parseLocale, registerDictionary, setLocale, type Locale } from "../shared/i18n";
import { TR } from "../shared/i18n/tr";
import { refreshAppMenu } from "./menu";
import { readSettings, writeSettings } from "./session";
import { storeLocaleChanged } from "./storeHost";
import { viewOf } from "./views";

/**
 * The UI's language (Settings › Account › Language), kept like the theme (src/main/theme.ts): main's, in settings.json;
 * every view hears `locale:changed` and a new view gets it before its first render (`--designer-locale`); the menu bar
 * is built again in it. Main's own words (the menu, dialogs, notifications) go through the same `t`.
 */

registerDictionary("tr", TR);

/** `--designer-locale=<locale>` for a new view's preload. */
export const localeArg = (): string => getLocale();

export function setLocalePreference(next: Locale): Locale {
  const l = parseLocale(next);
  if (l === getLocale()) return l;
  setLocale(l);
  const { locale: _old, ...rest } = readSettings();
  writeSettings(l === "en" ? rest : { ...rest, locale: l });
  for (const contents of webContents.getAllWebContents()) if (viewOf(contents) && !contents.isDestroyed()) contents.send("locale:changed", l);
  refreshAppMenu();
  storeLocaleChanged(l);
  return l;
}

/** At launch, before the menu and the first view: the kept language. */
export function initLocale(): void {
  setLocale(parseLocale(readSettings().locale));
}
