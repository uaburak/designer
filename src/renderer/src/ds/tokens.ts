/**
 * DesignerV2's chrome design system — the ONE source of every colour, size,
 * type style, shadow, layer and timing of the app's own UI (tab bar, Home,
 * panels, menus, dialogs, toolbar). Not the user's design variables.
 * Contract: docs/design-system.md §1–2. Usage: docs/design-system-usage.md.
 *
 * Pure data and pure functions: no imports, no DOM, no React, no Node APIs,
 * only erasable TypeScript — the renderer, Electron main, the generator and
 * the tests all import it. tokens.css is generated from it (tokensCss.ts).
 *
 * Sources (tags as in the contract):
 * - D: developers.figma.com/docs/plugins/css-variables/. Light values are in
 *   the page HTML (docs/research/figma/figma-color-tokens-light.txt, all 174
 *   match); dark values are in the page's JS chunk
 *   assets/js/0336f8dc.2c2d3b7a.js (`{design_light, design_dark}` per
 *   token), fetched 2026-10-06 — every dark value below is that chunk's,
 *   except the † ones.
 * - M: the owner's measured Figma screenshots (docs/research/visual-diff.md),
 *   dark only. M beats D: the bg-selected family moves to #394360 (†, §1.2).
 * - K: the owner's kit-derived code; F: figui3; G: our guess (verify in the
 *   Gallery, change here only).
 */

export type ThemeName = "light" | "dark";
export type ThemePreference = "system" | "light" | "dark";
/** A themed value: [light, dark]. */
export type Pair = readonly [light: string, dark: string];

/** Figma's theme colours, `--figma-color-<name>` (174, D unless †). */
export const figmaColor = {
  "bg": ["#ffffff", "#2c2c2c"],
  "bg-brand": ["#0d99ff", "#0c8ce9"],
  "bg-brand-hover": ["#007be5", "#0a6dc2"],
  "bg-brand-pressed": ["#007be5", "#0a6dc2"],
  "bg-brand-secondary": ["#0768cf", "#105cad"],
  "bg-brand-tertiary": ["#e5f4ff", "#394360"],
  "bg-component": ["#9747ff", "#8a38f5"],
  "bg-component-hover": ["#8638e5", "#7a2ed6"],
  "bg-component-pressed": ["#8638e5", "#7a2ed6"],
  "bg-component-secondary": ["#7c2bda", "#652ca8"],
  "bg-component-tertiary": ["#f1e5ff", "#473956"],
  "bg-danger": ["#f24822", "#e03e1a"],
  "bg-danger-hover": ["#dc3412", "#c4381c"],
  "bg-danger-pressed": ["#dc3412", "#c4381c"],
  "bg-danger-secondary": ["#bd2915", "#963323"],
  "bg-danger-tertiary": ["#ffe2e0", "#7c2622"],
  "bg-disabled": ["#d9d9d9", "#757575"],
  "bg-disabled-secondary": ["#b3b3b3", "#b3b3b3"],
  "bg-hover": ["#f5f5f5", "#383838"],
  "bg-inverse": ["#2c2c2c", "#ffffff"],
  "bg-onselected": ["#bde3ff", "#4a5878"], // † dark moved from D (1.2)
  "bg-onselected-hover": ["#bde3ff", "#4a5878"], // † dark moved from D (1.2)
  "bg-onselected-pressed": ["#bde3ff", "#4a5878"], // † dark moved from D (1.2)
  "bg-pressed": ["#f5f5f5", "#383838"],
  "bg-secondary": ["#f5f5f5", "#383838"],
  "bg-selected": ["#e5f4ff", "#394360"], // † dark moved from D (1.2)
  "bg-selected-hover": ["#bde3ff", "#4a5878"], // † dark moved from D (1.2)
  "bg-selected-pressed": ["#bde3ff", "#4a5878"], // † dark moved from D (1.2)
  "bg-selected-secondary": ["#f2f9ff", "#32394d"], // † dark moved from D (1.2)
  "bg-selected-strong": ["#0d99ff", "#0c8ce9"],
  "bg-selected-tertiary": ["#f2f9ff", "#32394d"], // † dark moved from D (1.2)
  "bg-success": ["#14ae5c", "#198f51"],
  "bg-success-hover": ["#009951", "#078348"],
  "bg-success-pressed": ["#009951", "#078348"],
  "bg-success-secondary": ["#008043", "#0a5c35"],
  "bg-success-tertiary": ["#cff7d3", "#0a4c2d"],
  "bg-tertiary": ["#e6e6e6", "#444444"],
  "bg-warning": ["#ffcd29", "#f3c11b"],
  "bg-warning-hover": ["#ffc21a", "#f2b50d"],
  "bg-warning-pressed": ["#ffc21a", "#f2b50d"],
  "bg-warning-secondary": ["#fab815", "#e4a711"],
  "bg-warning-tertiary": ["#fff1c2", "#c58011"],
  "bg-slot": ["rgba(255, 36, 189, 0.25)", "rgba(243, 22, 176, 0.25)"],
  "border": ["#e6e6e6", "#444444"],
  "border-brand": ["#bde3ff", "#105cad"],
  "border-brand-strong": ["#007be5", "#7cc4f8"],
  "border-component": ["#e4ccff", "#652ca8"],
  "border-component-hover": ["#9747ff", "#8a38f5"],
  "border-component-strong": ["#8638e5", "#d6b6fb"],
  "border-danger": ["#ffc7c2", "#963323"],
  "border-danger-strong": ["#dc3412", "#fca397"],
  "border-disabled": ["#e6e6e6", "#444444"],
  "border-disabled-strong": ["#0000004d", "#ffffff66"],
  "border-onbrand": ["#007be5", "#0a6dc2"],
  "border-onbrand-strong": ["#ffffff", "#ffffff"],
  "border-oncomponent": ["#8638e5", "#7a2ed6"],
  "border-oncomponent-strong": ["#ffffff", "#ffffff"],
  "border-ondanger": ["#dc3412", "#c4381c"],
  "border-ondanger-strong": ["#ffffff", "#ffffff"],
  "border-onselected": ["#bde3ff", "#667799"],
  "border-onselected-strong": ["#000000e5", "#ffffffe5"],
  "border-onsuccess": ["#009951", "#078348"],
  "border-onsuccess-strong": ["#ffffff", "#ffffff"],
  "border-onwarning": ["#fab815", "#e4a711"],
  "border-onwarning-strong": ["#000000e5", "#000000e5"],
  "border-selected": ["#0d99ff", "#0c8ce9"],
  "border-selected-strong": ["#007be5", "#7cc4f8"],
  "border-strong": ["#2c2c2c", "#ffffffe5"],
  "border-success": ["#aff4c6", "#0a5c35"],
  "border-success-strong": ["#009951", "#79d297"],
  "border-warning": ["#ffe8a3", "#925711"],
  "border-warning-strong": ["#b86200", "#f7d15f"],
  "border-slot": ["#ff24bd", "#f316b0"],
  "icon": ["#000000e5", "#ffffff"],
  "icon-brand": ["#007be5", "#7cc4f8"],
  "icon-brand-pressed": ["#0768cf", "#0c8ce9"],
  "icon-brand-secondary": ["#80caff", "#536383"],
  "icon-brand-tertiary": ["#bde3ff", "#394360"],
  "icon-component": ["#8638e5", "#d1a8ff"],
  "icon-component-pressed": ["#7c2bda", "#d6b6fb"],
  "icon-component-secondary": ["#c5b2dc", "#6b5884"],
  "icon-component-tertiary": ["#c5b2dc", "#6b5884"],
  "icon-danger": ["#f24822", "#e03e1a"],
  "icon-danger-hover": ["#bd2915", "#fbbcb6"],
  "icon-danger-pressed": ["#bd2915", "#fbbcb6"],
  "icon-danger-secondary": ["#f24822", "#e03e1a"],
  "icon-danger-secondary-hover": ["#f24822", "#e03e1a"],
  "icon-danger-tertiary": ["#f24822", "#e03e1a"],
  "icon-disabled": ["#0000004d", "#ffffff66"],
  "icon-hover": ["#000000e5", "#ffffff"],
  "icon-onbrand": ["#ffffff", "#ffffff"],
  "icon-onbrand-secondary": ["#ffffffcc", "#ffffffcc"],
  "icon-onbrand-tertiary": ["#ffffff66", "#ffffff66"],
  "icon-oncomponent": ["#ffffff", "#ffffff"],
  "icon-oncomponent-secondary": ["#ffffffcc", "#ffffffcc"],
  "icon-oncomponent-tertiary": ["#ffffff66", "#ffffff66"],
  "icon-ondanger": ["#ffffff", "#ffffff"],
  "icon-ondanger-secondary": ["#ffffffcc", "#ffffffcc"],
  "icon-ondanger-tertiary": ["#ffffff66", "#ffffff66"],
  "icon-ondisabled": ["#ffffff", "#2c2c2c"],
  "icon-oninverse": ["#ffffffe5", "#000000e5"],
  "icon-onselected": ["#000000e5", "#ffffff"],
  "icon-onselected-secondary": ["#00000080", "#ffffffb2"],
  "icon-onselected-strong": ["#ffffff", "#ffffff"],
  "icon-onselected-tertiary": ["#0000004d", "#ffffff66"],
  "icon-onsuccess": ["#ffffff", "#ffffff"],
  "icon-onsuccess-secondary": ["#ffffffcc", "#ffffffcc"],
  "icon-onsuccess-tertiary": ["#ffffff66", "#ffffff66"],
  "icon-onwarning": ["#000000e5", "#000000e5"],
  "icon-onwarning-secondary": ["#ffffffcc", "#00000080"],
  "icon-onwarning-tertiary": ["#ffffff66", "#0000004d"],
  "icon-pressed": ["#007be5", "#0a6dc2"],
  "icon-secondary": ["#00000080", "#ffffffb2"],
  "icon-secondary-hover": ["#000000e5", "#ffffff"],
  "icon-selected": ["#007be5", "#7cc4f8"],
  "icon-selected-secondary": ["#007be5", "#7cc4f8"],
  "icon-selected-tertiary": ["#007be5", "#7cc4f8"],
  "icon-success": ["#14ae5c", "#198f51"],
  "icon-success-pressed": ["#008043", "#a1e8b9"],
  "icon-success-secondary": ["#14ae5c", "#198f51"],
  "icon-success-tertiary": ["#14ae5c", "#198f51"],
  "icon-tertiary": ["#0000004d", "#ffffff66"],
  "icon-tertiary-hover": ["#000000e5", "#ffffff"],
  "icon-warning": ["#ffcd29", "#f3c11b"],
  "icon-warning-pressed": ["#b86200", "#f7d15f"],
  "icon-warning-secondary": ["#ffcd29", "#f3c11b"],
  "icon-warning-tertiary": ["#ffcd29", "#f3c11b"],
  "text": ["#000000e5", "#ffffff"],
  "text-brand": ["#007be5", "#7cc4f8"],
  "text-brand-secondary": ["#007be5", "#7cc4f8"],
  "text-brand-tertiary": ["#007be5", "#7cc4f8"],
  "text-component": ["#8638e5", "#d1a8ff"],
  "text-component-pressed": ["#7c2bda", "#d6b6fb"],
  "text-component-secondary": ["#c5b2dc", "#6b5884"],
  "text-component-tertiary": ["#c5b2dc", "#6b5884"],
  "text-danger": ["#dc3412", "#fca397"],
  "text-danger-secondary": ["#dc3412", "#fca397"],
  "text-danger-tertiary": ["#dc3412", "#fca397"],
  "text-disabled": ["#0000004d", "#ffffff66"],
  "text-hover": ["#000000e5", "#ffffff"],
  "text-onbrand": ["#ffffff", "#ffffff"],
  "text-onbrand-secondary": ["#ffffffcc", "#ffffffcc"],
  "text-onbrand-tertiary": ["#ffffff66", "#ffffff66"],
  "text-oncomponent": ["#ffffff", "#ffffff"],
  "text-oncomponent-secondary": ["#ffffffcc", "#ffffffcc"],
  "text-oncomponent-tertiary": ["#ffffff66", "#ffffff66"],
  "text-ondanger": ["#ffffff", "#ffffff"],
  "text-ondanger-secondary": ["#ffffffcc", "#ffffffcc"],
  "text-ondanger-tertiary": ["#ffffff66", "#ffffff66"],
  "text-ondisabled": ["#ffffff", "#2c2c2c"],
  "text-oninverse": ["#ffffffe5", "#000000e5"],
  "text-onselected": ["#000000e5", "#ffffffe5"],
  "text-onselected-secondary": ["#00000080", "#ffffffb2"],
  "text-onselected-strong": ["#ffffff", "#ffffff"],
  "text-onselected-tertiary": ["#0000004d", "#ffffff66"],
  "text-onsuccess": ["#ffffff", "#ffffff"],
  "text-onsuccess-secondary": ["#ffffffcc", "#ffffffcc"],
  "text-onsuccess-tertiary": ["#ffffff66", "#ffffff66"],
  "text-onwarning": ["#000000e5", "#000000e5"],
  "text-onwarning-secondary": ["#00000080", "#00000080"],
  "text-onwarning-tertiary": ["#0000004d", "#0000004d"],
  "text-secondary": ["#00000080", "#ffffffb2"],
  "text-secondary-hover": ["#000000e5", "#ffffff"],
  "text-selected": ["#007be5", "#7cc4f8"],
  "text-selected-secondary": ["#007be5", "#7cc4f8"],
  "text-selected-tertiary": ["#007be5", "#7cc4f8"],
  "text-success": ["#009951", "#79d297"],
  "text-success-secondary": ["#009951", "#79d297"],
  "text-success-tertiary": ["#009951", "#79d297"],
  "text-tertiary": ["#0000004d", "#ffffff66"],
  "text-tertiary-hover": ["#000000e5", "#ffffff"],
  "text-warning": ["#b86200", "#f7d15f"],
  "text-warning-secondary": ["#b86200", "#f7d15f"],
  "text-warning-tertiary": ["#b86200", "#f7d15f"],} as const satisfies Record<string, Pair>;

export type FigmaColorName = keyof typeof figmaColor;

/** App colours Figma does not publish, `--ds-color-<name>` (§1.3). Components use a figmaColor whenever one fits. */
export const appColor = {
  "tabbar-bg": ["#e6e6e6", "#3b3b3b"], // G / M
  "tabbar-line": ["#d9d9d9", "#4a4a4a"], // G / M — the bar's 1px bottom line, inside its 38px
  "tabbar-separator": ["#cfcfcf", "#4f4f4f"], // K / M — full-height lines between tabs, both sides of the active one too
  "tabbar-hover": ["#dcdcdc", "#444444"], // K / G
  "tabbar-text": ["#00000080", "#ffffffb2"], // K
  "rail-separator": ["#e6e6e6", "#404040"], // G / M
  "menu-bg": ["#1e1e1e", "#1e1e1e"], // K / F — menus, tooltips, toasts: dark in both themes
  "menu-text": ["#ffffff", "#ffffff"], // K
  "menu-text-secondary": ["#ffffffb2", "#ffffffb2"], // live capture (menus/*.txt: shortcuts .7)
  "menu-text-disabled": ["#ffffff66", "#ffffff66"], // live capture (.4)
  "menu-highlight": ["#0c8ce9", "#0c8ce9"], // live capture (menus/*.txt, popovers/*-menu.txt)
  "menu-text-on-highlight-secondary": ["#ffffffcc", "#ffffffcc"], // K
  "menu-separator": ["#383838", "#383838"], // F
  /** Live capture (popovers/fill-picker-image / -pattern / -video): an empty preview, the shade over a preview */
  "picker-preview-empty": ["#bababa99", "#bababa99"],
  "picker-preview-shade": ["#00000080", "#00000080"],
  "picker-stop-shadow": ["#00000026", "#00000026"],
  "scrim": ["#00000066", "#00000066"], // K
  "border-translucent": ["#0000001a", "#ffffff1a"], // K / F
  "border-translucent-strong": ["#00000033", "#ffffff33"], // F
  "bg-transparent-hover": ["#0000000d", "#ffffff0d"], // F
  "bg-transparent-pressed": ["#0000001a", "#ffffff1a"], // F
  "switch-hover": ["#f4f4f4", "#585858"], // K
  "switch-knob": ["#ffffff", "#ffffff"], // K — the knob is white in both themes
  "picker-thumb": ["#ffffff", "#ffffff"], // K — colour picker thumbs and gradient stops: white rings in both themes
  "picker-thumb-ring": ["#0000004d", "#0000004d"], // K — their 1px dark outline
  "scrollbar-thumb": ["#00000033", "#ffffff33"], // K
  "scrollbar-thumb-hover": ["#00000059", "#ffffff59"], // K
  "text-selection": ["#0d99ff66", "#0d99ff66"], // F
  "card-border-hover": ["#cccccc", "#5c5c5c"], // K
  "file-design": ["#0c8ce9", "#0c8ce9"], // K
  "canvas-default": ["#f5f5f5", "#1e1e1e"], // K
  "marquee-fill": ["#0d99ff1a", "#0c8ce926"], // G — drag-select rectangle in Home's grid and list (its border is border-selected)
  // Folder colours (Home): the store's FolderColor ids ("none" is the plain icon-secondary glyph, no token). G — Figma's palette where it has one
  "folder-red": ["#f24822", "#e03e1a"], // = bg-danger
  "folder-orange": ["#ffa629", "#f0941d"],
  "folder-yellow": ["#ffcd29", "#f3c11b"], // = bg-warning
  "folder-green": ["#14ae5c", "#198f51"], // = bg-success
  "folder-teal": ["#0fa8a8", "#119a9a"],
  "folder-blue": ["#0d99ff", "#0c8ce9"], // = bg-brand
  "folder-purple": ["#9747ff", "#8a38f5"], // = bg-component
  "folder-pink": ["#ff24bd", "#e81fae"],
  "folder-gray": ["#b3b3b3", "#8c8c8c"],
} as const satisfies Record<string, Pair>;

export type AppColorName = keyof typeof appColor;

/** Alpha behind chits and swatches (`--ds-checkerboard`, a `background` value; G). */
export const checkerboard = "repeating-conic-gradient(#e6e6e6 0% 25%, #ffffff 0% 50%) 0 0 / 8px 8px";

/** The 4px grid, `--ds-space-<key>` (px, §1.5). */
export const space = { "0": 0, half: 2, "1": 4, "1-5": 6, "2": 8, "3": 12, "4": 16, "5": 20, "6": 24, "8": 32, "10": 40, "12": 48, "16": 64 } as const;

/** Sizes and panel metrics, `--ds-size-<key>` (px, §1.6; M unless noted). */
export const size = {
  control: 24,
  "control-large": 32,
  row: 32,
  "layer-row": 32, // live: the Layers pitch (the highlight 24, inset 4)
  "section-header": 40,
  field: 88,
  "panel-pad-left": 16,
  "panel-pad-right": 8,
  "row-inset": 8,
  "layer-indent": 24, // live: a level moves the glyph 24
  panel: 240,
  "panel-min": 240,
  "panel-max": 480, // G
  "panel-header": 64,
  "right-header": 80,
  rail: 56, // live: the navigation bar (a 1px line after it)
  "rail-item": 56, // live: a tab button, 56 × 56 (tile + label)
  "rail-tile": 32,
  tabbar: 38,
  "tab-home": 40,
  "tab-min": 72, // G
  "tab-max": 240, // G
  "traffic-room": 80,
  "traffic-room-fullscreen": 8,
  toolbar: 48,
  "toolbar-bottom": 12,
  tool: 32,
  ruler: 20,
  popover: 240, // K
  "menu-item": 24, // K
  "menu-min": 0, // live capture: menus are as wide as their items (context menus 200: ContextMenu minWidth)
  "menu-max": 320, // K
  "menu-pad": 8, // K
  "dialog-small": 320, // G
  "dialog-medium": 480, // G
  "dialog-large": 640, // G
  "rename-preview": 128, // live: Rename layers' Preview column (fields 160 in)
  "rename-list": 240, // Rename layers' Preview list before it scrolls
  "field-narrow": 40, // live: Rename layers' "Start ascending from" field
  "home-topbar": 48,
  "home-sidebar": 240, // G
  "home-nav": 28,
  "home-nav-pitch": 32,
  "card-width": 268,
  "card-height": 213,
  "card-thumb": 151,
  "card-gap": 36,
  "list-row": 40, // the Home list view's row (§4.27)
  "list-header": 32, // G — the list view's column header
  "breadcrumb-max": 160, // G — an ancestor crumb's width before it ellipsizes
  checkbox: 16,
  "switch-width": 28, // K
  "switch-height": 16, // K
  chit: 14, // K
  "swatch-round": 16,
  "styles-row": 30,
  "icon-16": 16,
  "icon-24": 24,
} as const;

/** Corner radii, `--ds-radius-<key>` (px, §1.7). */
export const radius = { none: 0, small: 2, medium: 5, "medium-large": 9, large: 13, full: 9999 } as const;

export const fontFamily = {
  sans: '"Inter Variable", Inter, system-ui, -apple-system, sans-serif',
  mono: 'ui-monospace, "SF Mono", Menlo, monospace',
} as const;

export type TextStyle = { size: number; line: number; weight: number; tracking: string; mono?: boolean };

/** Type styles (§1.8): `--ds-font-<style>` (a `font` shorthand) and `--ds-tracking-<style>`. 450 / 550; 400 for mono, for the live capture's layer and page names and field prefixes; 500 for the panel labels, as Figma draws them. */
export const text = {
  "body-small": { size: 9, line: 14, weight: 450, tracking: "0.045px" },
  /** The Design panel's field labels ("Position", "Corner radius"): 9px/500 at 70% — Figma's live panel (docs/research/figma/live). */
  "panel-label": { size: 9, line: 11, weight: 500, tracking: "0.045px" },
  "body-medium": { size: 11, line: 16, weight: 450, tracking: "0.055px" },
  "body-medium-strong": { size: 11, line: 16, weight: 550, tracking: "0.055px" },
  /** Live capture: layer and page names, Find's results and counts, a field's prefix letter (X, Y, W, H) are 11px / 400 */
  "body-medium-regular": { size: 11, line: 16, weight: 400, tracking: "0.055px" },
  "body-ruler": { size: 10, line: 12, weight: 450, tracking: "0.05px" },
  /** Live capture: every menu and dropdown list is 11px / 450 (menus/*.txt, popovers/*-menu.txt) */
  menu: { size: 11, line: 16, weight: 450, tracking: "0.055px" },
  "body-large": { size: 13, line: 22, weight: 450, tracking: "-0.0325px" },
  "body-large-strong": { size: 13, line: 22, weight: 550, tracking: "-0.0325px" },
  "heading-medium": { size: 15, line: 25, weight: 550, tracking: "-0.13px" },
  "heading-large": { size: 24, line: 32, weight: 550, tracking: "-0.47px" },
  code: { size: 11, line: 16, weight: 400, tracking: "0px", mono: true },
} as const satisfies Record<string, TextStyle>;

export type TextStyleName = keyof typeof text;

/** Elevation, `--ds-elevation-<key>` (§1.9, F), [light, dark]. */
export const elevation = {
  "100": ["0 0 0.5px #0000004d, 0 1px 3px #00000026", "0 0 0.5px #00000080, inset 0 0.75px 0 #ffffff1a, 0 1px 3px #00000066"],
  "200": ["0 0 0.5px #0000002e, 0 3px 8px #0000001a, 0 1px 3px #0000001a", "0 3px 8px #00000059, 0 1px 3px #00000080, inset 0 0.5px 0 #ffffff14, inset 0 0 0.5px #ffffff4d"],
  "400-menu-panel": ["0 0 0.5px #0000001f, 0 10px 16px #0000001f, 0 2px 5px #00000026", "0 10px 16px #00000059, 0 2px 5px #00000059, inset 0 0.5px 0 #ffffff14, inset 0 0.75px 0 #ffffff1a"],
  "500-modal-window": ["0 0 0.5px #00000014, 0 10px 24px #0000002e, 0 2px 5px #00000026", "0 10px 24px #00000073, 0 3px 5px #00000059, inset 0 0.75px 0 #ffffff1a"],
  menu: ["0 0 0.5px #0000004d, 0 5px 17px #00000040, 0 2px 7px #00000026", "0 0 0.5px #0000004d, 0 5px 17px #00000040, 0 2px 7px #00000026"],
} as const satisfies Record<string, Pair>;

/** Focus (§1.10): fields turn their border blue; everything else gets a 1px outline 1px out. */
export const focus = { color: "var(--figma-color-border-selected)", width: 1, offset: 1 } as const;

/** Stacking within one document, `--ds-z-<key>` (§1.11). */
export const z = { base: 0, panel: 10, floating: 20, resize: 30, scrim: 100, dialog: 110, popover: 200, menu: 300, toast: 400, tooltip: 500, drag: 600 } as const;

/** Motion (§1.12): the chrome is instant; only these opt in. `--ds-<key>`. */
export const motion = {
  "duration-instant": "0ms",
  "duration-fast": "80ms",
  "duration-medium": "150ms",
  "ease-out": "cubic-bezier(0, 0, 0.2, 1)",
  "delay-tooltip": "500ms",
  "delay-tooltip-warm": "300ms",
  "delay-submenu": "100ms",
  "toast-duration": "4000ms",
  "toast-duration-action": "8000ms",
} as const;

/** The same timings as numbers (ms) for code. */
export const timing = { tooltip: 500, tooltipWarm: 300, submenu: 100, toast: 4000, toastAction: 8000 } as const;

/**
 * The canvas chrome palette the engine draws with (§1.4). The ORDER IS THE
 * ABI: append only, never reorder.
 */
export const CHROME_COLORS = [
  "selection",
  "handleFill",
  "handleStroke",
  "hover",
  "component",
  "sizeBadgeFill",
  "sizeBadgeText",
  "frameTitleOnLight",
  "frameTitleOnDark",
  "measure",
  "measureText",
  "snapGuide",
  "spacingGuide",
  "layoutGapFill",
  "layoutGapStroke",
  "marqueeFill",
  "marqueeStroke",
  "rulerBg",
  "rulerTick",
  "rulerText",
  "rulerSelectionBand",
  "rulerSelectionText",
  "textCaret",
  "textSelection",
  "prototypeNoodle",
  "slotFill",
  "slotStroke",
  "canvasDefault",
  "pixelGrid",
  "frameTitleSelectedOnLight",
  "frameTitleSelectedOnDark",
  "frameTitleComponentOnLight",
  "frameTitleComponentOnDark",
  "radiusHandleFill",
  "radiusHandleStroke",
] as const;

export type ChromeColorName = (typeof CHROME_COLORS)[number];

export const canvasChrome: Record<ChromeColorName, Pair> = {
  selection: ["#0d99ff", "#0c8ce9"],
  handleFill: ["#ffffff", "#ffffff"],
  handleStroke: ["#0d99ff", "#0c8ce9"],
  hover: ["#0d99ff", "#0c8ce9"],
  component: ["#9747ff", "#8a38f5"],
  sizeBadgeFill: ["#0d99ff", "#0c8ce9"],
  sizeBadgeText: ["#ffffff", "#ffffff"],
  frameTitleOnLight: ["#00000080", "#00000080"],
  frameTitleOnDark: ["#ffffff76", "#ffffff76"],
  measure: ["#f24822", "#f24822"],
  measureText: ["#ffffff", "#ffffff"],
  snapGuide: ["#f24822", "#f24822"],
  spacingGuide: ["#ff24bd", "#f316b0"],
  layoutGapFill: ["#ff24bd40", "#f316b040"],
  layoutGapStroke: ["#ff24bd", "#f316b0"],
  marqueeFill: ["#0d99ff1a", "#0c8ce91a"],
  marqueeStroke: ["#0d99ff", "#0c8ce9"],
  rulerBg: ["#ffffff", "#2c2c2c"],
  rulerTick: ["#b3b3b3", "#7a7a7a"],
  rulerText: ["#00000080", "#ffffffb2"],
  rulerSelectionBand: ["#0d99ff33", "#0c8ce933"],
  rulerSelectionText: ["#007be5", "#7cc4f8"],
  textCaret: ["#0d99ff", "#0c8ce9"],
  textSelection: ["#0d99ff4d", "#0c8ce94d"],
  prototypeNoodle: ["#0d99ff", "#0d99ff"],
  slotFill: ["#ff24bd40", "#f316b040"],
  slotStroke: ["#ff24bd", "#f316b0"],
  canvasDefault: ["#f5f5f5", "#1e1e1e"],
  pixelGrid: ["#0000001a", "#ffffff1a"],
  // Titles of selected frames and of components follow Figma's text-selected / text-component on the page's
  // background (live Figma 2026-10-08: #7cc4f8 and #d1a8ff over the dark canvas).
  frameTitleSelectedOnLight: ["#007be5", "#007be5"],
  frameTitleSelectedOnDark: ["#7cc4f8", "#7cc4f8"],
  frameTitleComponentOnLight: ["#8638e5", "#8638e5"],
  frameTitleComponentOnDark: ["#d1a8ff", "#d1a8ff"],
  // The corner radius handles: white circles with a selection-coloured ring.
  radiusHandleFill: ["#ffffff", "#ffffff"],
  radiusHandleStroke: ["#0d99ff", "#0c8ce9"],
};

/** Chrome metrics in CSS px at any zoom (§1.4). */
export const canvasChromeMetrics = {
  selectionStroke: 1,
  // Live Figma (2026-10-08 captures): a hovered layer's outline is twice the selection's line.
  hoverStroke: 2,
  handle: 7,
  sizeBadge: { height: 16, padX: 4, radius: 2, gap: 6 },
  titleBaseline: 10,
  ruler: { thickness: 20, tick: 4, fontSize: 10 },
  titleSize: 11,
  // Live Figma (canvas-section-selected): the name in a 22 px pill above the section's top-left corner, 5 px off it.
  sectionPill: { height: 22, padX: 6, fontSize: 11, gap: 5 },
  // Live Figma: a 9 px ring whose centre sits 12 px in from each corner (radius 0).
  radiusHandle: { size: 9, inset: 12 },
} as const;

/** What a document paints before anything else (boot.js, main's setBackgroundColor). */
export type Surface = "app" | "tabbar" | "viewer";

export function surfaceBackground(surface: Surface, theme: ThemeName): string {
  const i = theme === "light" ? 0 : 1;
  if (surface === "tabbar") return appColor["tabbar-bg"][i];
  if (surface === "viewer") return appColor["canvas-default"][i];
  return figmaColor.bg[i];
}

export function resolveFigmaColor(name: FigmaColorName, theme: ThemeName): string {
  return figmaColor[name][theme === "light" ? 0 : 1];
}

/** "#rgb", "#rrggbb", "#rrggbbaa", "rgb()/rgba()" → [r, g, b, a] in 0..1 (straight alpha); null if not a colour. */
export function parseColor(value: string): [number, number, number, number] | null {
  const v = value.trim().toLowerCase();
  let m = /^#([0-9a-f]{3})$/.exec(v);
  if (m) return [...m[1].split("").map((c) => parseInt(c + c, 16) / 255), 1] as [number, number, number, number];
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(v);
  if (m) {
    const h = m[1];
    return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255, m[2] ? parseInt(m[2], 16) / 255 : 1];
  }
  m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(v);
  if (m) return [Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255, m[4] === undefined ? 1 : Number(m[4])];
  return null;
}

/** The chrome palette for the engine: CHROME_COLORS.length × RGBA, straight-alpha sRGB 0..1 (§2.4). */
export function chromePalette(theme: ThemeName): Float32Array {
  const i = theme === "light" ? 0 : 1;
  const out = new Float32Array(CHROME_COLORS.length * 4);
  CHROME_COLORS.forEach((name, k) => {
    const rgba = parseColor(canvasChrome[name][i]);
    if (!rgba) throw new Error(`Bad chrome colour ${name}`);
    out.set(rgba, k * 4);
  });
  return out;
}

/** The custom properties that change with the theme. */
export function themeVariables(theme: ThemeName): Record<string, string> {
  const i = theme === "light" ? 0 : 1;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(figmaColor)) out[`--figma-color-${k}`] = v[i];
  for (const [k, v] of Object.entries(appColor)) out[`--ds-color-${k}`] = v[i];
  for (const [k, v] of Object.entries(elevation)) out[`--ds-elevation-${k}`] = v[i];
  // Declared with the themed colours: a var() is resolved where it is declared, so a re-themed subtree needs its own.
  out["--ds-focus-color"] = focus.color;
  return out;
}

/** The custom properties that are the same in both themes. */
export function staticVariables(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(space)) out[`--ds-space-${k}`] = `${v}px`;
  for (const [k, v] of Object.entries(size)) out[`--ds-size-${k}`] = `${v}px`;
  for (const [k, v] of Object.entries(radius)) out[`--ds-radius-${k}`] = `${v}px`;
  out["--ds-font-family"] = fontFamily.sans;
  out["--ds-font-family-mono"] = fontFamily.mono;
  for (const [k, t] of Object.entries(text) as [string, TextStyle][]) {
    out[`--ds-font-${k}`] = `${t.weight} ${t.size}px/${t.line}px ${t.mono ? fontFamily.mono : fontFamily.sans}`;
    out[`--ds-tracking-${k}`] = t.tracking;
    out[`--ds-weight-${k}`] = String(t.weight);
  }
  for (const [k, v] of Object.entries(z)) out[`--ds-z-${k}`] = String(v);
  for (const [k, v] of Object.entries(motion)) out[`--ds-${k}`] = v;
  out["--ds-focus-width"] = `${focus.width}px`;
  out["--ds-focus-offset"] = `${focus.offset}px`;
  out["--ds-checkerboard"] = checkerboard;
  return out;
}
