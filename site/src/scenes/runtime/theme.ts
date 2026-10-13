import { useSyncExternalStore } from "react";
import { onSiteTheme, siteTheme, type SiteTheme } from "../../scripts/theme";

const subscribe = (listener: () => void) => onSiteTheme(listener);

/** The page's theme, for scenes that draw something the tokens don't reach (the engine's canvas). */
export function useSiteTheme(): SiteTheme {
  return useSyncExternalStore(subscribe, siteTheme, () => "light");
}
