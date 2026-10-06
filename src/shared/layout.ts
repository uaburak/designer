/**
 * The window's fixed measures (docs/desktop.md §2), read by main (where the
 * views go) and the tab bar's page (how it draws).
 */

/** The tab bar's view, its 1px bottom line included (measured in Figma desktop, docs/research/visual-diff.md) */
export const TABBAR_HEIGHT = 38;
/** The tab bar's left inset for the traffic lights; 0 in full screen */
export const TRAFFIC_LIGHT_ROOM = 80;
/** The traffic lights' place: centred in the 38px bar */
export const TRAFFIC_LIGHT_POSITION = { x: 14, y: 12 } as const;
export const DEFAULT_WINDOW_SIZE = { width: 1440, height: 900 } as const;
export const MIN_WINDOW_SIZE = { width: 800, height: 520 } as const;

/** Each view's background until its page paints, so a switch never flashes white in the dark. */
export const VIEW_BACKGROUND = {
  tabbar: { dark: "#3b3b3b", light: "#e6e6e6" },
  home: { dark: "#2c2c2c", light: "#ffffff" },
  editor: { dark: "#2c2c2c", light: "#ffffff" },
} as const;
