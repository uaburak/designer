/**
 * The device's own interface over a prototype played on it (Wecra's; present/DeviceChrome.tsx draws it): the system's
 * status bar (time, signal, Wi-Fi, battery), the home indicator, and — when chosen — a browser's bars (Safari, Chrome),
 * as the device shows them, with Apple's scroll edge effect under the bars that float over the page.
 *
 * - The viewer's settings, kept in this browser: Show status bar (on by default), Browser (None by default, Safari,
 *   Chrome). Both preview menus (the inline preview's options, the presentation's device menu) change them.
 * - Bars that float over the page (iOS's status bar and home indicator, Safari's iOS 26 tab bar, Android's status bar
 *   and gesture handle) are drawn over the prototype — the status bar's safe area kept clear at the start (the
 *   prototype starts under it and scrolls on up beneath it, `under`); opaque ones (Chrome's address bar and toolbar, a Mac's menu bar
 *   and browser toolbar, Safari's top on an iPad) take their height off the screen: the player lays the prototype out
 *   between them (presentSetOptions contentInsets).
 * - Sizes in the device's points, from Apple's and Google's published layouts where known (status bar 59 / 62 pt on
 *   Dynamic Island iPhones, 20 on a home-button iPhone, 24 on an iPad; Chrome's toolbar 56 dp on Android); the rest
 *   measured by eye.
 */
import { useSyncExternalStore } from "react";
import type { MenuEntry } from "@/ds";
import { t } from "@/i18n";

export type BrowserUi = "none" | "safari" | "chrome";
export interface DeviceUiSettings {
  statusBar: boolean;
  browser: BrowserUi;
}

const KEY = "wecra.preview.deviceUi";
const DEFAULTS: DeviceUiSettings = { statusBar: true, browser: "none" };
let current: DeviceUiSettings | null = null;
const listeners = new Set<() => void>();

export function readDeviceUi(): DeviceUiSettings {
  if (current) return current;
  try {
    const kept = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<DeviceUiSettings> | null;
    current = {
      statusBar: typeof kept?.statusBar === "boolean" ? kept.statusBar : DEFAULTS.statusBar,
      browser: kept?.browser === "safari" || kept?.browser === "chrome" ? kept.browser : DEFAULTS.browser,
    };
  } catch {
    current = { ...DEFAULTS };
  }
  return current;
}

export function writeDeviceUi(next: Partial<DeviceUiSettings>): void {
  current = { ...readDeviceUi(), ...next };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* kept for this page only */
  }
  for (const l of [...listeners]) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
export const useDeviceUi = (): DeviceUiSettings => useSyncExternalStore(subscribe, readDeviceUi, readDeviceUi);

/** The menus' rows (with a device): Show status bar, Browser ▸ None / Safari / Chrome. */
export function deviceUiEntries(kind: ChromeKind): MenuEntry[] {
  if (kind === "none") return [];
  const s = readDeviceUi();
  return [
    { id: "deviceui:status", label: t("Show status bar"), checked: s.statusBar },
    {
      id: "deviceui:browser",
      label: t("Browser"),
      items: [
        { id: "deviceui:browser:none", label: t("None"), checked: s.browser === "none" },
        { id: "deviceui:browser:safari", label: "Safari", checked: s.browser === "safari" },
        { id: "deviceui:browser:chrome", label: "Chrome", checked: s.browser === "chrome" },
      ],
    },
  ];
}

/** A menu row of deviceUiEntries chosen: true when it was one. */
export function applyDeviceUiOption(id: string): boolean {
  if (id === "deviceui:status") writeDeviceUi({ statusBar: !readDeviceUi().statusBar });
  else if (id.startsWith("deviceui:browser:")) writeDeviceUi({ browser: id.slice("deviceui:browser:".length) as BrowserUi });
  else return false;
  return true;
}

/**
 * The kind of interface a preset shows: an iPhone with the Dynamic Island, one with a home button, an iPad, an Android
 * phone, a Mac (`notch`: a MacBook's menu bar is taller), another computer (a browser, no system bar), or none (a watch).
 */
export type ChromeKind = "iphone" | "iphone-home" | "ipad" | "android" | "mac" | "desktop" | "none";

export function chromeKind(preset: string | undefined): ChromeKind {
  const id = (preset ?? "").replace(/^APPLE_/, "");
  if (!id) return "none";
  if (id.startsWith("IPHONE_SE")) return "iphone-home";
  if (id.startsWith("IPHONE")) return "iphone";
  if (id.startsWith("IPAD")) return "ipad";
  if (id.startsWith("ANDROID") || id.startsWith("GOOGLE") || id.startsWith("SAMSUNG")) return "android";
  if (id.startsWith("MACBOOK") || id.startsWith("IMAC")) return "mac";
  if (id.startsWith("DESKTOP") || id.startsWith("SURFACE")) return "desktop";
  return "none";
}

/** What is drawn and how tall (points) for a kind, the settings and the screen's orientation. */
export interface ChromeLayout {
  kind: ChromeKind;
  /** The browser drawn (Safari isn't on Android: Chrome there) */
  browser: BrowserUi;
  landscape: boolean;
  /** The system's bar (0: none): over the page, or part of `top` when a browser's bar is under it */
  status: number;
  /** A browser's own bar under the status bar (0: none) and the one at the bottom (Chrome on iOS) */
  toolbar: number;
  bottomBar: number;
  /** Safari's floating tab bar (iOS 26) over the page's bottom */
  floatingBar: boolean;
  /** The home indicator / gesture handle over the page's bottom */
  homeIndicator: boolean;
  /** The opaque bars' heights the prototype is laid out between */
  top: number;
  bottom: number;
  /**
   * `top` is the status bar's safe area: the prototype starts under it (a design without its own room there isn't
   * covered) but scrolls on up beneath it, as an app's page does
   */
  under: boolean;
}

export function chromeLayout(kind: ChromeKind, preset: string | undefined, s: DeviceUiSettings, landscape: boolean): ChromeLayout {
  const id = (preset ?? "").replace(/^APPLE_/, "");
  const browser = kind === "android" && s.browser === "safari" ? "chrome" : kind === "none" ? "none" : s.browser;
  const out: ChromeLayout = { kind, browser, landscape, status: 0, toolbar: 0, bottomBar: 0, floatingBar: false, homeIndicator: false, top: 0, bottom: 0, under: false };
  switch (kind) {
    case "iphone":
    case "iphone-home": {
      const island = kind === "iphone";
      // iOS hides the status bar in landscape on an iPhone.
      out.status = s.statusBar && !landscape ? (island ? (/PRO/.test(id) ? 62 : 59) : 20) : 0;
      out.homeIndicator = island && s.statusBar;
      // The page starts under the status bar and ends over the home indicator, and scrolls on beneath them (the scroll
      // edge effect over the status bar).
      out.top = out.status;
      out.bottom = out.homeIndicator ? (landscape ? 21 : 34) : 0;
      // Safari: its tab bar floats over the page's bottom — the page ends over it, scrolls beneath it.
      if (browser === "safari") {
        out.floatingBar = true;
        out.bottom = landscape ? 66 : 82;
      }
      out.under = out.top > 0 || out.bottom > 0;
      if (browser === "chrome") {
        out.toolbar = landscape ? 44 : 52;
        out.bottomBar = landscape ? 0 : island ? 50 + 34 : 44;
        out.homeIndicator = island;
        out.top = out.status + out.toolbar;
        out.under = false;
        out.bottom = out.bottomBar;
      }
      break;
    }
    case "ipad":
      out.status = s.statusBar ? 24 : 0;
      out.homeIndicator = s.statusBar;
      out.top = out.status;
      out.bottom = out.homeIndicator ? 20 : 0;
      out.under = out.top > 0 || out.bottom > 0;
      if (browser !== "none") {
        out.toolbar = browser === "safari" ? 50 : 56;
        out.top = out.status + out.toolbar;
        out.bottom = 0;
        out.under = false;
      }
      break;
    case "android":
      out.status = s.statusBar ? 36 : 0;
      out.homeIndicator = s.statusBar;
      out.top = out.status;
      out.bottom = out.homeIndicator ? 24 : 0;
      out.under = out.top > 0 || out.bottom > 0;
      if (browser !== "none") {
        // Chrome's toolbar (Safari isn't on Android: shown as Chrome).
        out.toolbar = 56;
        out.top = out.status + out.toolbar;
        out.bottom = 0;
        out.under = false;
      }
      break;
    case "mac":
    case "desktop":
      out.status = kind === "mac" && s.statusBar ? (id.startsWith("MACBOOK") ? 37 : 24) : 0;
      if (browser !== "none") out.toolbar = browser === "safari" ? 52 : 80;
      out.top = out.status + out.toolbar;
      break;
    case "none":
      break;
  }
  return out;
}

/** Light or dark content under the bars ("#rrggbb", null: unknown — light): the bars' ink follows it, as iOS's. */
export function isDark(color: string | null | undefined): boolean {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color ?? "");
  if (!m) return false;
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => parseInt(h!, 16) / 255) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.5;
}
