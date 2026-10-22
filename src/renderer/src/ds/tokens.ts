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
  /** Live capture (left/rail-assets.txt): a library card's thumbnail ground (light unverified) */
  "asset-card-bg": ["#0000001a", "#ffffff1a"],
  /** Live capture (left/rail-assets-page-components.txt): a set tile's variant count dot, black 50 % (light unverified) */
  "asset-variants-bg": ["#00000080", "#00000080"],
  /** Live (menus.txt, Manage libraries): a library thumbnail's 1 px ring (light unverified) */
  "library-thumb-ring": ["#0000000d", "#0000000d"],
  "switch-hover": ["#f4f4f4", "#585858"], // K
  "switch-knob": ["#ffffff", "#ffffff"], // K — the knob is white in both themes
  "picker-thumb": ["#ffffff", "#ffffff"], // K — colour picker thumbs and gradient stops: white rings in both themes
  "picker-thumb-ring": ["#0000004d", "#0000004d"], // K — their 1px dark outline
  "scrollbar-thumb": ["#00000033", "#ffffff33"], // K
  "scrollbar-thumb-hover": ["#00000059", "#ffffff59"], // K
  "text-selection": ["#0d99ff66", "#0d99ff66"], // F
  "field-selection": ["#0d99ff66", "#325f88"], // a field's selected text (dark: the owner's panel17/73.png, "154" selected in W on #383838)
  "layer-component-glyph": ["#a38cc0", "#7f699b"], // an unselected component / variant / instance row's glyph in Layers: Figma's design-editor --color-icon-component-secondary (figma_app.css [data-editor-theme=design]: pale-purple-450 / -500; live #80699b on #2c2c2c)
  "card-border-hover": ["#cccccc", "#5c5c5c"], // K
  "file-design": ["#0c8ce9", "#0c8ce9"], // K
  "canvas-default": ["#f5f5f5", "#242424"], // K (dark: live Figma 2026-10-22, the owner's 119.png)
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
  // Tab group colours (atlas 01 §2.3: Figma's `--ramp-pale-*-400`, grey `--ramp-grey-400`). G — Figma's palette as the
  // folders have it until the pale ramp's values are read live; persimmon unverified
  "tabgroup-blue": ["#0d99ff", "#0c8ce9"],
  "tabgroup-red": ["#f24822", "#e03e1a"],
  "tabgroup-yellow": ["#ffcd29", "#f3c11b"],
  "tabgroup-green": ["#14ae5c", "#198f51"],
  "tabgroup-purple": ["#9747ff", "#8a38f5"],
  "tabgroup-pink": ["#ff24bd", "#e81fae"],
  "tabgroup-persimmon": ["#ff7237", "#f0632b"],
  "tabgroup-grey": ["#b3b3b3", "#8c8c8c"],
  // Dev Mode's green chrome (the owner's capture docs/research/figma/live/owner-2026-10-18/figma-devmode-inspect, dark
  // sampled K; light G): the selected layer row and the rows inside it, the rail's active tab; the rulers' selection
  // band and its edge labels. Share and the active tool are bg-success (live devmode-inspect-right.txt: #198F51).
  "devmode-selected": ["#cff7d3", "#4f7460"],
  "devmode-selected-secondary": ["#e5f9e8", "#486557"],
  "devmode-ruler-band": ["#14ae5c33", "#507360"],
  "devmode-text": ["#009951", "#79d297"],
  // Dev Mode's code: a CSS value's colour (the owner's capture, dark sampled ≈ #d88fcd; light G)
  "code-value": ["#b5338a", "#d88fcd"],
  // Agents at work (the chat's Thinking… row, an image being made — in the chat and on the canvas): Figma AI's
  // blue → purple → pink → orange sweep, from Figma's own palette (bg-brand, bg-component, the pink and orange above;
  // Figma's exact AI gradient unverified). The fill is the soft wash under it, the shine the light that crosses it.
  "ai-1": ["#0d99ff", "#0c8ce9"],
  "ai-2": ["#9747ff", "#8a38f5"],
  "ai-3": ["#ff24bd", "#e81fae"],
  "ai-4": ["#ffa629", "#f0941d"],
  "ai-fill": ["#9747ff1f", "#8a38f533"],
  "ai-shine": ["#ffffffb3", "#ffffff4d"],
} as const satisfies Record<string, Pair>;

export type AppColorName = keyof typeof appColor;

/**
 * Settings › Account › "Enhance contrast" (§2.5): "When enabled, contrast between text and controls and their
 * backgrounds will be increased." On `[data-contrast="more"]` these replace their tokens in both themes: secondary,
 * tertiary and disabled text and icons get more opaque, borders and separators darker (light) or lighter (dark).
 * Figma publishes no values for its enhanced contrast (R17-settings.md): these are ours (G), each at least 4.5:1 for
 * text on `bg` (secondary) and 3:1 for borders and tertiary text against `bg`.
 */
export const figmaColorContrast = {
  "text-secondary": ["#000000c2", "#ffffffdb"],
  "text-tertiary": ["#00000094", "#ffffffad"],
  "text-disabled": ["#00000073", "#ffffff8c"],
  "text-secondary-hover": ["#000000", "#ffffff"],
  "icon-secondary": ["#000000c2", "#ffffffdb"],
  "icon-tertiary": ["#00000094", "#ffffffad"],
  "icon-disabled": ["#00000073", "#ffffff8c"],
  "text-onselected-secondary": ["#000000c2", "#ffffffdb"],
  "icon-onselected-secondary": ["#000000c2", "#ffffffdb"],
  "border": ["#949494", "#7a7a7a"],
  "border-disabled": ["#c2c2c2", "#5c5c5c"],
  "border-strong": ["#000000", "#ffffff"],
  "border-selected": ["#007be5", "#7cc4f8"],
  "text-brand": ["#0060b3", "#9dd3fa"],
  "text-danger": ["#b02a0f", "#fdbdb4"],
} as const satisfies Partial<Record<FigmaColorName, Pair>>;

export const appColorContrast = {
  "tabbar-text": ["#000000c2", "#ffffffdb"],
  "tabbar-line": ["#949494", "#7a7a7a"],
  "tabbar-separator": ["#949494", "#7a7a7a"],
  "rail-separator": ["#949494", "#7a7a7a"],
  "menu-text-secondary": ["#ffffffdb", "#ffffffdb"],
  "menu-text-disabled": ["#ffffff8c", "#ffffff8c"],
  "menu-separator": ["#6b6b6b", "#6b6b6b"],
  "border-translucent": ["#00000066", "#ffffff66"],
  "border-translucent-strong": ["#00000099", "#ffffff99"],
} as const satisfies Partial<Record<AppColorName, Pair>>;

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
  "layer-fade": 12, // a layer name fades out over its last 12 at the cut (owner's capture of Figma, docs/research/layers-polish)
  // Figma 126.9.13 (docs/research/atlas/02-editor-chrome.md §3.2, §4.1): the left panel 240 (min 240, max 500), the
  // right panel's min 240 + its 1px line (241) and its max 500 with the line (499 inside it)
  panel: 240,
  "panel-min": 240,
  "panel-max": 500,
  "right-panel-max": 499,
  // Live (docs/research/figma/live/2026-10-18/devmode-inspect-right.txt): Dev Mode's right panel is 320 wide
  "dev-panel": 320,
  "panel-header": 64,
  "right-header": 80,
  rail: 56, // live: the navigation bar (a 1px line after it)
  "rail-item": 56, // live: a tab button, 56 × 56 (tile + label)
  "rail-tile": 32,
  tabbar: 38,
  "tab-home": 40,
  // Figma 126.9.13 (atlas 01 §2.1): a file tab at least 40, its title at most 200 (faded out over its last 8, not cut
  // with an ellipsis); in a tab group, tabs are 24-high pills
  "tab-min": 40,
  "tab-title-max": 200,
  "tab-title-fade": 8,
  "tab-pill": 24,
  // The tabs menu at the bar's right end: 40 × 38
  "tabs-menu": 40,
  "traffic-room": 80,
  "traffic-room-fullscreen": 8,
  // Windows: the system's caption buttons (titleBarOverlay, 3 × 46) at the right, Figma's main menu button (40) at the left
  "window-controls-room": 138,
  "main-menu": 40,
  toolbar: 48,
  "toolbar-bottom": 12,
  // The Keyboard shortcuts panel along the editor's bottom (the owner's screenshots of live Figma, 1512-wide window):
  // 240 high (its top line 1), a 38 tab row (its line under it 1), three 300 columns 48 apart centred, rows 37 apart, 26 caps; the Layout tab's keyboard
  // keys 26 × 25, 32 apart across, 33 down.
  // Motion's timeline along the editor's bottom (docs/motion.md §6.2 [unverified]): 240 high, a 40 header (Collapse timeline leaves it).
  "motion-timeline": 240,
  "motion-timeline-header": 48,
  // Social's posts table, docked the same way (docs/social.md §4.5 [ours]): 240 high.
  "social-table": 240,
  "shortcuts-panel": 240,
  "shortcuts-tabs": 38,
  "shortcuts-column": 300,
  "shortcuts-gap": 48,
  "shortcuts-row": 37,
  "shortcuts-cap": 26,
  "keyboard-key": 26,
  "keyboard-key-height": 25,
  tool: 32,
  ruler: 20,
  popover: 240, // K
  "nudge-window": 180, // C: Preferences › Nudge amount…, a draggable window 180 wide (atlas 21 §3.1)
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
  "home-sidebar": 240, // the owner's Home (2026-10-19): 240 with its 1px right border inside
  "home-nav": 28,
  "home-nav-pitch": 32,
  // Home's tile grid (docs/research/atlas/01-app-shell-home.md §4.1): columns at least 260 wide sharing the row's
  // width, 32 apart both ways (the owner's Home, 2026-10-19: four 260 × 208 cards at 1440 — a 5:4 card, the thumbnail
  // over a 60 high footer)
  "card-width": 260,
  "card-footer": 60,
  "card-gap": 32,
  "list-row": 40, // the Home list view's row (§4.27)
  "list-header": 32, // G — the list view's column header
  "breadcrumb-max": 160, // G — an ancestor crumb's width before it ellipsizes
  checkbox: 16,
  "switch-width": 28, // K
  "switch-height": 16, // K
  "switch-width-large": 32, // M: the Settings modal's toggles are 32 × 16
  // The Settings modal (5–9.png ÷ 2): 650 wide, a 40 header, 48 in at the sides, the Account tab's content 200 in past a
  // 120 photo; at most 730 high.
  "settings-modal": 650,
  "settings-modal-height": 720, // live 2026-10-19 (settings.txt): 650 × 720
  "settings-header": 40,
  "settings-pad": 48,
  "settings-content": 200,
  "settings-photo": 120,
  // Manage libraries (live 2026-10-18, menus.txt): 591 × 641, a 200 nav, rows 74 apart with 102 × 58 thumbnails
  "library-modal": 591,
  "library-modal-height": 641,
  "library-nav": 200,
  "library-row": 74,
  "library-thumb-width": 102,
  "library-thumb-height": 58,
  "library-banner": 128,
  // Home's account menu (live 2026-10-19, settings.txt): 224 wide, a 120 profile block with a 40 photo, 24 rows.
  "account-menu": 224,
  "account-photo": 40,
  "account-row": 24,
  "account-profile": 120,
  chit: 14, // K
  "swatch-round": 16,
  "styles-row": 30,
  "icon-16": 16,
  "icon-24": 24,
} as const;

/** Corner radii, `--ds-radius-<key>` (px, §1.7). */
export const radius = { none: 0, small: 2, thumb: 3, "home-row": 4, medium: 5, tile: 6, "tab-preview-thumb": 8, "home-search": 8, "medium-large": 9, "asset-tile": 10, large: 13, full: 9999 } as const;

export const fontFamily = {
  /** "Inter Symbols" (global.css): Inter 3.19's key glyphs (⌘ ⇧ ⌥ ⌃ ⌫ ↵ arrows) — live's widths (11px: ⌫ 13, ⌘ 11, ⌃ 9) */
  sans: '"Inter Symbols", "Inter Variable", Inter, system-ui, -apple-system, sans-serif',
  mono: 'ui-monospace, "SF Mono", Menlo, monospace',
  /**
   * A context menu's key glyphs (12px / 400): the ones Inter lacks (⌘ ⇧ ⌥ ⌃ ⌫) from the browser's sans-serif — live's
   * widths (menus/context-*.txt: ⌘ 13, ⇧ 13; system-ui's are 11, 12). The 11px / 450 menu keys keep the UI font's
   * fallback: there it matches live (toolbar/*-tools-menu.txt "⇧M" 21, "⇧⌘K" 30).
   */
  keys: '"Inter Symbols", "Inter Variable", Inter, sans-serif',
} as const;

export type TextStyle = { size: number; line: number; weight: number; tracking: string; mono?: boolean; keys?: boolean };

/** Type styles (§1.8): `--ds-font-<style>` (a `font` shorthand) and `--ds-tracking-<style>`. 450 / 550; 400 for mono, for the live capture's layer and page names and field prefixes; 500 for the panel labels, as Figma draws them. */
export const text = {
  "body-small": { size: 9, line: 14, weight: 450, tracking: "0.045px" },
  /**
   * The Design panel's field labels ("Position", "Corner radius"): 9px/500 at 70% — Figma's live panel
   * (docs/research/figma/live). Live's face draws them wider than Inter 4 at 9px: 0.26px tracking gives live's width for
   * 19 of the 23 captions measured and 1 px under it for the rest (Start point 48 / 49, Line height, Letter spacing,
   * Constraints).
   */
  "panel-label": { size: 9, line: 11, weight: 500, tracking: "0.26px" },
  "body-medium": { size: 11, line: 16, weight: 450, tracking: "0.055px" },
  "body-medium-strong": { size: 11, line: 16, weight: 550, tracking: "0.055px" },
  /** Live capture: layer and page names, Find's results and counts, a field's prefix letter (X, Y, W, H) are 11px / 400 */
  "body-medium-regular": { size: 11, line: 16, weight: 400, tracking: "0.055px" },
  "body-ruler": { size: 10, line: 12, weight: 450, tracking: "0.05px" },
  /** Live capture: every menu and dropdown list is 11px / 450 (menus/*.txt, popovers/*-menu.txt) */
  menu: { size: 11, line: 16, weight: 450, tracking: "0.055px" },
  /** Live capture (menus/context-*.txt): a context menu's shortcut is one 12px / 400 glyph per key */
  "menu-key": { size: 12, line: 15, weight: 400, tracking: "0px", keys: true },
  "body-large": { size: 13, line: 22, weight: 450, tracking: "-0.0325px" },
  "body-large-strong": { size: 13, line: 22, weight: 550, tracking: "-0.0325px" },
  /** Live capture (toolbar/actions-panel.txt): the Actions palette's rows are 13px / 400 */
  "body-large-regular": { size: 13, line: 22, weight: 400, tracking: "-0.0325px" },
  "heading-medium": { size: 15, line: 25, weight: 550, tracking: "-0.13px" },
  "heading-large": { size: 24, line: 32, weight: 550, tracking: "-0.47px" },
  /**
   * The Settings modal (the owner's screenshots of live Figma, 5–9.png, widths matched in Inter): a section's heading
   * ("Name", "Theme", "Sessions") 14px, "Your spaces" 15px, the sessions table and the uploaded fonts' rows 12px, "Closed
   * captions" 13px, an uploaded font's "Rag 123" sample 16px in its own face. Body lines are body-medium (11 / 16).
   */
  "settings-heading": { size: 14, line: 24, weight: 450, tracking: "0px" },
  "settings-title": { size: 15, line: 24, weight: 450, tracking: "0px" },
  "settings-cell": { size: 12, line: 16, weight: 450, tracking: "0px" },
  "settings-caption": { size: 13, line: 20, weight: 400, tracking: "0px" },
  "settings-sample": { size: 16, line: 20, weight: 400, tracking: "0px" },
  /**
   * The Keyboard shortcuts panel (the owner's live-*.webp at 1.3228, ink widths matched in Inter, 2026-10-19): tabs, row
   * labels, "and", hints and the Essential descriptions 12px ("Move tool" 54.4, "Annotation tool" 86.2, "Essential" 49.1
   * CSS px; the descriptions’ lines 16 apart); the Essential heading and its three names 14px ("Essential keyboard
   * shortcuts" 189.7, "Component search" 124). The caps' text is body-medium (11px: "Home" 29.5, "End" 18.1).
   */
  shortcuts: { size: 12, line: 16, weight: 450, tracking: "0px" },
  "shortcuts-heading": { size: 14, line: 20, weight: 450, tracking: "0px" },
  code: { size: 11, line: 16, weight: 400, tracking: "0px", mono: true },
} as const satisfies Record<string, TextStyle>;

export type TextStyleName = keyof typeof text;

/** Elevation, `--ds-elevation-<key>` (§1.9, F), [light, dark]. */
export const elevation = {
  "100": ["0 0 0.5px #0000004d, 0 1px 3px #00000026", "0 0 0.5px #00000080, inset 0 0.75px 0 #ffffff1a, 0 1px 3px #00000066"],
  "200": ["0 0 0.5px #0000002e, 0 3px 8px #0000001a, 0 1px 3px #0000001a", "0 3px 8px #00000059, 0 1px 3px #00000080, inset 0 0.5px 0 #ffffff14, inset 0 0 0.5px #ffffff4d"],
  "400-menu-panel": ["0 0 0.5px #0000001f, 0 10px 16px #0000001f, 0 2px 5px #00000026", "0 10px 16px #00000059, 0 2px 5px #00000059, inset 0 0.5px 0 #ffffff14, inset 0 0.75px 0 #ffffff1a"],
  "500-modal-window": ["0 0 0.5px #00000014, 0 10px 24px #0000002e, 0 2px 5px #00000026", "0 10px 24px #00000073, 0 3px 5px #00000059, inset 0 0.75px 0 #ffffff1a"],
  // Live 2026-10-18 (menus.txt): every menu's surface, dark in both themes
  menu: ["0 2px 5px #00000059, inset 0 0 0.5px #ffffff59, 0 10px 16px #00000059, inset 0 0.5px 0 #ffffff14", "0 2px 5px #00000059, inset 0 0 0.5px #ffffff59, 0 10px 16px #00000059, inset 0 0.5px 0 #ffffff14"],
  // Live 2026-10-18 (toolbar.txt): the mode switch's thumb (light: elevation 100's, unmeasured)
  thumb: ["0 0 0.5px #0000004d, 0 1px 3px #00000026", "0 0 0.5px #00000080, 0 1px 3px #00000066, inset 0 0.5px 0 #ffffff1a, inset 0 0 0.5px #ffffff4d"],
  // Live 2026-10-18 (menus.txt): Figma's draggable modals (Manage libraries) — elevation 500 with the menus' light rims (light: 500's)
  "draggable-modal": ["0 0 0.5px #00000014, 0 10px 24px #0000002e, 0 2px 5px #00000026", "0 10px 24px #00000073, 0 3px 5px #00000059, inset 0 0.5px 0 #ffffff14, inset 0 0 0.5px #ffffff59"],
  // A slider's 12 px thumb (live 2026-10-18 slider.txt, dark; light: the same without the inner light rims)
  "slider-thumb": ["0 1px 3px #00000040, 0 0 0.5px #0000004d, 0 3px 8px #00000026", "0 1px 3px #00000080, inset 0 0 0.5px #ffffff4d, 0 3px 8px #00000059, inset 0 0.5px 0 #ffffff14"],
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
  // Figma's tooltip manager (atlas 02 §6): shows after 1000 ms, at once while another is showing, hides 300 ms after
  // the pointer leaves
  "delay-tooltip": "1000ms",
  "delay-tooltip-hide": "300ms",
  "delay-submenu": "100ms",
  // Figma's visual bell (atlas 02 §7): 3 s; 6 s for a message over 25 characters; 10 s with a button
  "toast-duration": "3000ms",
  "toast-duration-long": "6000ms",
  "toast-duration-action": "10000ms",
  /** Agents at work: the text shimmer, the light sweep over an image being made, a placeholder fading out */
  "duration-shimmer": "1600ms",
  "duration-sweep": "1800ms",
  "duration-fade": "300ms",
  /** An agent's picture arriving: a last brighter sweep, then the grey dissolving over it */
  "duration-reveal": "700ms",
} as const;

/** The same timings as numbers (ms) for code. */
export const timing = { tooltip: 1000, tooltipHide: 300, submenu: 100, toast: 3000, toastLong: 6000, toastAction: 10000 } as const;

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
  "canvasTooltipFill",
  "canvasTooltipText",
  "readyForDev",
  "prototypeNoodleQuiet",
  "canvasScrollbarFill",
  "canvasScrollbarFillHover",
  "canvasScrollbarRim",
  "prototypeLabelText",
  "prototypeNoodleChangeTo",
  "prototypeChangeToLabelText",
  "statusDone",
  "statusRToMerge",
  "statusToBeDone",
  "statusProcess",
  "statusRevised",
  "statusCancelled",
] as const;

export type ChromeColorName = (typeof CHROME_COLORS)[number];

export const canvasChrome: Record<ChromeColorName, Pair> = {
  // 2026-10-19 (owner: "the same as Figma"): the light canvas's selection blue is Figma's #0c8ce9 too — the owner's
  // light-theme recording samples it as #0a8ce8 (the capture's colour profile), not the UI's #0d99ff.
  selection: ["#0c8ce9", "#0c8ce9"],
  handleFill: ["#ffffff", "#ffffff"],
  handleStroke: ["#0c8ce9", "#0c8ce9"],
  hover: ["#0c8ce9", "#0c8ce9"],
  // Group 1 (2026-10-19): the canvas's component purple is #8a38f5 on a light canvas too — the owner's light-theme
  // captures components15/figma-instance-child-{hover,selected}.png sample #8a38f5 (their red reads its exact #e30614).
  component: ["#8a38f5", "#8a38f5"],
  sizeBadgeFill: ["#0c8ce9", "#0c8ce9"],
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
  // Group 1 (2026-10-19, G6): fainter — live 800 % reads the lines a few levels over the canvas, 300 % hardly at all
  // (behaviour/img/pixel-grid-{300,800}.png; ours at 10 % stood out).
  pixelGrid: ["#0000000f", "#ffffff0f"],
  // Titles of selected frames and of components follow Figma's text-selected / text-component on the page's
  // background (live Figma 2026-10-08: #7cc4f8 and #d1a8ff over the dark canvas).
  frameTitleSelectedOnLight: ["#007be5", "#007be5"],
  frameTitleSelectedOnDark: ["#7cc4f8", "#7cc4f8"],
  frameTitleComponentOnLight: ["#8638e5", "#8638e5"],
  frameTitleComponentOnDark: ["#d1a8ff", "#d1a8ff"],
  // The corner radius handles: white circles with a selection-coloured ring.
  radiusHandleFill: ["#ffffff", "#ffffff"],
  radiusHandleStroke: ["#0d99ff", "#0c8ce9"],
  // Round 15: the canvas's own tooltip (the `</>` button's "Mark as ready for dev", live Figma 47.png) — the menu /
  // tooltip background, dark in both themes — and the green of a design ready for dev (its `</>` button).
  canvasTooltipFill: ["#1e1e1e", "#1e1e1e"],
  canvasTooltipText: ["#ffffff", "#ffffff"],
  readyForDev: ["#14ae5c", "#14ae5c"],
  // Round 16 (the owner's live Figma 61–67.png): a connection that isn't the selection's is light blue, opaque (#b2d6f7
  // on the screenshots, less the shift they show on #7cc4f8 → #8cc2f3); the canvas scrollbars' thumb is black at
  // 30 % (40 % hovered or dragged) in a 1 px white rim at 31 % (58 / 59.png: #151515 inside, #646464 rim on #1e1e1e).
  prototypeNoodleQuiet: ["#a8d6fb", "#a8d6fb"],
  canvasScrollbarFill: ["#0000004d", "#0000004d"],
  canvasScrollbarFillHover: ["#00000066", "#00000066"],
  canvasScrollbarRim: ["#ffffff4f", "#ffffff4f"],
  // Round 17 (the owner's live Figma 61–63.png): a connection's trigger label ("While hovering", "On drag"…) on a
  // quiet chip — dark text (#081825 sampled) on prototypeNoodleQuiet; the selected connection's chip is the selection
  // colour with white text.
  prototypeLabelText: ["#081825", "#081825"],
  // Round 17 (live Figma 2026-10-10, a Change to between two variants): its line, start ring, arrow and chip in a
  // lavender (sampled #d5b9fa against the blue chip's #b0d6fb for #a8d6fb — Figma's #d6b6fb), the chip's text dark
  // purple (#1d0736 sampled); selected, the component purple with white.
  prototypeNoodleChangeTo: ["#d6b6fb", "#d6b6fb"],
  prototypeChangeToLabelText: ["#1d0736", "#1d0736"],
  // Frame status (ours, docs/editor.md "Frame status (ours)", 2026-10-12): the owner's statuses' chips in the frame
  // title, the colours of their dots in the chrome (Ready to Dev is readyForDev): Done bg-brand, R to Merge
  // folder-teal, To be done folder-orange, Process bg-danger, Revised bg-component, Cancelled bg-disabled.
  statusDone: ["#0d99ff", "#0c8ce9"],
  statusRToMerge: ["#0fa8a8", "#119a9a"],
  statusToBeDone: ["#ffa629", "#f0941d"],
  statusProcess: ["#f24822", "#e03e1a"],
  statusRevised: ["#9747ff", "#8a38f5"],
  statusCancelled: ["#d9d9d9", "#757575"],
};

/** Chrome metrics in CSS px at any zoom (§1.4). */
export const canvasChromeMetrics = {
  selectionStroke: 1,
  // Live Figma (2026-10-08 captures): a hovered layer's outline is twice the selection's line.
  hoverStroke: 2,
  handle: 7,
  // Live Figma (round 10): the size badge and auto layout's gap / padding badges are 17 high, the text 4 px in from
  // each end. Measured on the captures scaled by their own 11 px text (the frame title, which the 1440 × 900 captures
  // show is Inter 11): canvas-autolayout-selected-hover-gap "10" 20.8 × 17.4, -padding "16" 20.6 × 17.3,
  // "232 Hug × 72 Hug" 102 × 17.3; canvas-rect-selected "120 × 90" 53.9 × 17.8 (text 4.0 in); the 1440 captures'
  // "320 × 200" 16.4–17.4 high. (docs/engine-build.md "Round 10".)
  sizeBadge: { height: 17, padX: 4, radius: 2, gap: 6 },
  titleBaseline: 10,
  ruler: { thickness: 20, tick: 4, fontSize: 10 },
  titleSize: 11,
  // Live Figma (canvas-section-selected, round 9 at 1×): the name in a 23 px pill above the section's top-left corner,
  // 6 px off it (the name semibold, 550: the engine's OverlayStyle). Group 1 (2026-10-19, the same capture zoomed: the
  // pill 48.8 px, its text ~5.6 px in): 5 px either side, not 6 ("Section" 53 → 50).
  sectionPill: { height: 23, padX: 5, fontSize: 11, gap: 6 },
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

/** Enhance contrast's replacements for a theme (§2.5). */
export function contrastVariables(theme: ThemeName): Record<string, string> {
  const i = theme === "light" ? 0 : 1;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(figmaColorContrast)) out[`--figma-color-${k}`] = v[i];
  for (const [k, v] of Object.entries(appColorContrast)) out[`--ds-color-${k}`] = v[i];
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
  out["--ds-font-family-keys"] = fontFamily.keys;
  for (const [k, t] of Object.entries(text) as [string, TextStyle][]) {
    out[`--ds-font-${k}`] = `${t.weight} ${t.size}px/${t.line}px ${t.mono ? fontFamily.mono : t.keys ? fontFamily.keys : fontFamily.sans}`;
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
