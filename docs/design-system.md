# Design system: the app's chrome (Figma UI3, light and dark)

This is the contract for the app's **own** look: the tab bar, Home, the editor's panels, menus, dialogs, the toolbar and the shared viewer. The **user's** design variables, styles and components are document data (see the document/variables contracts) and never use these tokens.

Goal: a 1:1 copy of Figma UI3 (desktop app) in both themes. Where a value is unknown, we pick one, mark it **G** and check it in the Gallery against Figma screenshots. Values change only in `tokens.ts`.

Everything in this document is binding for the parallel implementers. Where it disagrees with the old `AGENTS.md`, `docs/architecture.md`, `figma/tokens.ts` or `styles/app.css`, this document wins.

## 0. Sources and provenance tags

Every value in the tables below has one of these tags:

| Tag | Source |
|---|---|
| **D** | Figma's published plugin token list, https://developers.figma.com/docs/plugins/css-variables/. Light values come from the page HTML (`docs/research/figma/figma-color-tokens-light.txt`; all 174 match). Dark values come from the page's JS chunk `assets/js/0336f8dc.2c2d3b7a.js` (object `a`, key `design_dark`), fetched 2026-10-06. |
| **M** | Measured from the owner's Figma screenshots (`docs/research/visual-diff.md`). These are dark theme only. 1 CSS px = 1.3228 image px, accurate to about ±1 px. |
| **F** | figui3 (`@rogieking/figui3@10.0.5` `components.css`), a UI3 web-component kit by Rogie King of Figma. Used to corroborate values and to fill gaps. It is not authoritative on its own. |
| **K** | The owner's existing kit-derived code: `figma/ui.tsx`, `components/admin/ContextMenu.tsx`, `/Users/burak/Desktop/Burak/Code/Designer/Designer/DesignSystem/Theme.swift`. |
| **G** | Our decision without a primary source. Verify it in the Gallery (section 5) and correct it in `tokens.ts` only. |

Rule for resolving conflicts: **M > D > K > F > G**, with one exception. When M contradicts a D value, the whole D token family moves together, using F's values where F agrees with M (see 1.2).

---

## 1. Tokens

All tokens are defined once in `src/renderer/src/ds/tokens.ts` (section 2) and emitted as CSS custom properties in the generated `src/renderer/src/ds/tokens.css`. There are two namespaces:

- `--figma-color-*`: Figma's published names, **exactly** (174 tokens). Any future plugin iframe can receive the same block unchanged.
- `--ds-*`: everything Figma does not publish. This covers app colours, spacing, sizes, radii, type, elevation, focus, z-index and motion.

### 1.1 Figma colour tokens (`--figma-color-*`, 174)

The values below are the ones `tokens.ts` must contain. **†** marks a dark value moved away from D (reasons in 1.2). Hex with alpha is `#rrggbbaa`.

**bg** (43)

| token (`--figma-color-…`) | light | dark |
|---|---|---|
| bg | #ffffff | #2c2c2c |
| bg-brand | #0d99ff | #0c8ce9 |
| bg-brand-hover | #007be5 | #0a6dc2 |
| bg-brand-pressed | #007be5 | #0a6dc2 |
| bg-brand-secondary | #0768cf | #105cad |
| bg-brand-tertiary | #e5f4ff | #394360 |
| bg-component | #9747ff | #8a38f5 |
| bg-component-hover | #8638e5 | #7a2ed6 |
| bg-component-pressed | #8638e5 | #7a2ed6 |
| bg-component-secondary | #7c2bda | #652ca8 |
| bg-component-tertiary | #f1e5ff | #473956 |
| bg-danger | #f24822 | #e03e1a |
| bg-danger-hover | #dc3412 | #c4381c |
| bg-danger-pressed | #dc3412 | #c4381c |
| bg-danger-secondary | #bd2915 | #963323 |
| bg-danger-tertiary | #ffe2e0 | #7c2622 |
| bg-disabled | #d9d9d9 | #757575 |
| bg-disabled-secondary | #b3b3b3 | #b3b3b3 |
| bg-hover | #f5f5f5 | #383838 |
| bg-inverse | #2c2c2c | #ffffff |
| bg-onselected | #bde3ff | #4a5878 † |
| bg-onselected-hover | #bde3ff | #4a5878 † |
| bg-onselected-pressed | #bde3ff | #4a5878 † |
| bg-pressed | #f5f5f5 | #383838 |
| bg-secondary | #f5f5f5 | #383838 |
| bg-selected | #e5f4ff | #394360 † |
| bg-selected-hover | #bde3ff | #4a5878 † |
| bg-selected-pressed | #bde3ff | #4a5878 † |
| bg-selected-secondary | #f2f9ff | #32394d † |
| bg-selected-strong | #0d99ff | #0c8ce9 |
| bg-selected-tertiary | #f2f9ff | #32394d † |
| bg-success | #14ae5c | #198f51 |
| bg-success-hover | #009951 | #078348 |
| bg-success-pressed | #009951 | #078348 |
| bg-success-secondary | #008043 | #0a5c35 |
| bg-success-tertiary | #cff7d3 | #0a4c2d |
| bg-tertiary | #e6e6e6 | #444444 |
| bg-warning | #ffcd29 | #f3c11b |
| bg-warning-hover | #ffc21a | #f2b50d |
| bg-warning-pressed | #ffc21a | #f2b50d |
| bg-warning-secondary | #fab815 | #e4a711 |
| bg-warning-tertiary | #fff1c2 | #c58011 |
| bg-slot | rgba(255, 36, 189, 0.25) | rgba(243, 22, 176, 0.25) |

**border** (30)

| token (`--figma-color-…`) | light | dark |
|---|---|---|
| border | #e6e6e6 | #444444 |
| border-brand | #bde3ff | #105cad |
| border-brand-strong | #007be5 | #7cc4f8 |
| border-component | #e4ccff | #652ca8 |
| border-component-hover | #9747ff | #8a38f5 |
| border-component-strong | #8638e5 | #d6b6fb |
| border-danger | #ffc7c2 | #963323 |
| border-danger-strong | #dc3412 | #fca397 |
| border-disabled | #e6e6e6 | #444444 |
| border-disabled-strong | #0000004d | #ffffff66 |
| border-onbrand | #007be5 | #0a6dc2 |
| border-onbrand-strong | #ffffff | #ffffff |
| border-oncomponent | #8638e5 | #7a2ed6 |
| border-oncomponent-strong | #ffffff | #ffffff |
| border-ondanger | #dc3412 | #c4381c |
| border-ondanger-strong | #ffffff | #ffffff |
| border-onselected | #bde3ff | #667799 |
| border-onselected-strong | #000000e5 | #ffffffe5 |
| border-onsuccess | #009951 | #078348 |
| border-onsuccess-strong | #ffffff | #ffffff |
| border-onwarning | #fab815 | #e4a711 |
| border-onwarning-strong | #000000e5 | #000000e5 |
| border-selected | #0d99ff | #0c8ce9 |
| border-selected-strong | #007be5 | #7cc4f8 |
| border-strong | #2c2c2c | #ffffffe5 |
| border-success | #aff4c6 | #0a5c35 |
| border-success-strong | #009951 | #79d297 |
| border-warning | #ffe8a3 | #925711 |
| border-warning-strong | #b86200 | #f7d15f |
| border-slot | #ff24bd | #f316b0 |

**icon** (54)

| token (`--figma-color-…`) | light | dark |
|---|---|---|
| icon | #000000e5 | #ffffff |
| icon-brand | #007be5 | #7cc4f8 |
| icon-brand-pressed | #0768cf | #0c8ce9 |
| icon-brand-secondary | #80caff | #536383 |
| icon-brand-tertiary | #bde3ff | #394360 |
| icon-component | #8638e5 | #d1a8ff |
| icon-component-pressed | #7c2bda | #d6b6fb |
| icon-component-secondary | #c5b2dc | #6b5884 |
| icon-component-tertiary | #c5b2dc | #6b5884 |
| icon-danger | #f24822 | #e03e1a |
| icon-danger-hover | #bd2915 | #fbbcb6 |
| icon-danger-pressed | #bd2915 | #fbbcb6 |
| icon-danger-secondary | #f24822 | #e03e1a |
| icon-danger-secondary-hover | #f24822 | #e03e1a |
| icon-danger-tertiary | #f24822 | #e03e1a |
| icon-disabled | #0000004d | #ffffff66 |
| icon-hover | #000000e5 | #ffffff |
| icon-onbrand | #ffffff | #ffffff |
| icon-onbrand-secondary | #ffffffcc | #ffffffcc |
| icon-onbrand-tertiary | #ffffff66 | #ffffff66 |
| icon-oncomponent | #ffffff | #ffffff |
| icon-oncomponent-secondary | #ffffffcc | #ffffffcc |
| icon-oncomponent-tertiary | #ffffff66 | #ffffff66 |
| icon-ondanger | #ffffff | #ffffff |
| icon-ondanger-secondary | #ffffffcc | #ffffffcc |
| icon-ondanger-tertiary | #ffffff66 | #ffffff66 |
| icon-ondisabled | #ffffff | #2c2c2c |
| icon-oninverse | #ffffffe5 | #000000e5 |
| icon-onselected | #000000e5 | #ffffff |
| icon-onselected-secondary | #00000080 | #ffffffb2 |
| icon-onselected-strong | #ffffff | #ffffff |
| icon-onselected-tertiary | #0000004d | #ffffff66 |
| icon-onsuccess | #ffffff | #ffffff |
| icon-onsuccess-secondary | #ffffffcc | #ffffffcc |
| icon-onsuccess-tertiary | #ffffff66 | #ffffff66 |
| icon-onwarning | #000000e5 | #000000e5 |
| icon-onwarning-secondary | #ffffffcc | #00000080 |
| icon-onwarning-tertiary | #ffffff66 | #0000004d |
| icon-pressed | #007be5 | #0a6dc2 |
| icon-secondary | #00000080 | #ffffffb2 |
| icon-secondary-hover | #000000e5 | #ffffff |
| icon-selected | #007be5 | #7cc4f8 |
| icon-selected-secondary | #007be5 | #7cc4f8 |
| icon-selected-tertiary | #007be5 | #7cc4f8 |
| icon-success | #14ae5c | #198f51 |
| icon-success-pressed | #008043 | #a1e8b9 |
| icon-success-secondary | #14ae5c | #198f51 |
| icon-success-tertiary | #14ae5c | #198f51 |
| icon-tertiary | #0000004d | #ffffff66 |
| icon-tertiary-hover | #000000e5 | #ffffff |
| icon-warning | #ffcd29 | #f3c11b |
| icon-warning-pressed | #b86200 | #f7d15f |
| icon-warning-secondary | #ffcd29 | #f3c11b |
| icon-warning-tertiary | #ffcd29 | #f3c11b |

**text** (47)

| token (`--figma-color-…`) | light | dark |
|---|---|---|
| text | #000000e5 | #ffffff |
| text-brand | #007be5 | #7cc4f8 |
| text-brand-secondary | #007be5 | #7cc4f8 |
| text-brand-tertiary | #007be5 | #7cc4f8 |
| text-component | #8638e5 | #d1a8ff |
| text-component-pressed | #7c2bda | #d6b6fb |
| text-component-secondary | #c5b2dc | #6b5884 |
| text-component-tertiary | #c5b2dc | #6b5884 |
| text-danger | #dc3412 | #fca397 |
| text-danger-secondary | #dc3412 | #fca397 |
| text-danger-tertiary | #dc3412 | #fca397 |
| text-disabled | #0000004d | #ffffff66 |
| text-hover | #000000e5 | #ffffff |
| text-onbrand | #ffffff | #ffffff |
| text-onbrand-secondary | #ffffffcc | #ffffffcc |
| text-onbrand-tertiary | #ffffff66 | #ffffff66 |
| text-oncomponent | #ffffff | #ffffff |
| text-oncomponent-secondary | #ffffffcc | #ffffffcc |
| text-oncomponent-tertiary | #ffffff66 | #ffffff66 |
| text-ondanger | #ffffff | #ffffff |
| text-ondanger-secondary | #ffffffcc | #ffffffcc |
| text-ondanger-tertiary | #ffffff66 | #ffffff66 |
| text-ondisabled | #ffffff | #2c2c2c |
| text-oninverse | #ffffffe5 | #000000e5 |
| text-onselected | #000000e5 | #ffffffe5 |
| text-onselected-secondary | #00000080 | #ffffffb2 |
| text-onselected-strong | #ffffff | #ffffff |
| text-onselected-tertiary | #0000004d | #ffffff66 |
| text-onsuccess | #ffffff | #ffffff |
| text-onsuccess-secondary | #ffffffcc | #ffffffcc |
| text-onsuccess-tertiary | #ffffff66 | #ffffff66 |
| text-onwarning | #000000e5 | #000000e5 |
| text-onwarning-secondary | #00000080 | #00000080 |
| text-onwarning-tertiary | #0000004d | #0000004d |
| text-secondary | #00000080 | #ffffffb2 |
| text-secondary-hover | #000000e5 | #ffffff |
| text-selected | #007be5 | #7cc4f8 |
| text-selected-secondary | #007be5 | #7cc4f8 |
| text-selected-tertiary | #007be5 | #7cc4f8 |
| text-success | #009951 | #79d297 |
| text-success-secondary | #009951 | #79d297 |
| text-success-tertiary | #009951 | #79d297 |
| text-tertiary | #0000004d | #ffffff66 |
| text-tertiary-hover | #000000e5 | #ffffff |
| text-warning | #b86200 | #f7d15f |
| text-warning-secondary | #b86200 | #f7d15f |
| text-warning-tertiary | #b86200 | #f7d15f |

### 1.2 Conflicts and how they were resolved

| Token (dark) | D | F | M | Chosen | Why |
|---|---|---|---|---|---|
| bg-selected | #4a5878 | #394360 | #3a4360 (selected layer row, active rail item) | **#394360** | M |
| bg-selected-secondary / -tertiary | #394360 | #32394d | – | **#32394d** | Must differ from the new bg-selected (children of a selected layer); F |
| bg-selected-hover / -pressed | #536383 | #4a5878 / #394360 | – | **#4a5878** | One step lighter than bg-selected; F |
| bg-onselected / -hover / -pressed | #667799 | #4a5878 | – | **#4a5878** | Same family; F |

Measured values that confirm D unchanged: panel #2c2c2c = bg; border #444 = border; field #383838 = bg-secondary; brand #0c8ce9 = bg-brand; selected page row #373737 ≈ bg-secondary; active tab icon #7cc4f8 = text-brand; segmented container #383838 and active segment #2c2c2c with a #444 border; toolbar mode group #444 = bg-tertiary; Home pills #383838.

**Not adopted.** F disagrees with D on these tokens and nothing measured supports F, so D stays: bg-brand-pressed, bg-component-pressed, bg-danger/success/warning-tertiary, border-component, border-success, border-warning, icon-brand-secondary, icon-component-secondary, icon-selected-secondary/-tertiary, icon-success*, icon-warning*, text-component-secondary, text-success*, and **light** text-secondary (D #00000080, F #00000099; see Open questions).

**Fixes to the owner's `figma/tokens.ts`.** These come with the move:
- text-component dark #c9a5ff → #d1a8ff.
- icon-component light #b49ee0 → #8638e5.
- icon-component dark #9d82cf → #d1a8ff.
- Layer/page row selection was grey (#f0f0f0 / #1e1e1e) by the owner's choice. It becomes Figma's: layers use bg-selected, the current page uses bg-secondary.

### 1.3 App colour tokens (`--ds-color-*`)

These are colours Figma does not publish. Components use `--figma-color-*` whenever one fits, and only these when none does.

| Token | Light | Dark | Tag | Used by |
|---|---|---|---|---|
| `--ds-color-tabbar-bg` | #e6e6e6 | #3b3b3b | G / M | TabBar background, tab bar view's `setBackgroundColor` |
| `--ds-color-tabbar-line` | #d9d9d9 | #4a4a4a | G / M | 1px bottom line of the tab bar (inside its 38px) |
| `--ds-color-tabbar-separator` | #cfcfcf | #4f4f4f | K / M | full-height 1px lines between tabs, including next to the active one |
| `--ds-color-tabbar-hover` | #dcdcdc | #444444 | K / G | inactive tab hover |
| `--ds-color-tabbar-text` | #00000080 | #ffffffb2 | K | inactive tab label and glyph |
| `--ds-color-rail-separator` | #e6e6e6 | #404040 | G / M | 16×1 lines in the rail |
| `--ds-color-menu-bg` | #1e1e1e | #1e1e1e | K / F | Menu, Tooltip, Toast (dark in both themes) |
| `--ds-color-menu-text` | #ffffff | #ffffff | K | menu/tooltip/toast text and icons |
| `--ds-color-menu-text-secondary` | #ffffff73 (.45) | #ffffff73 | K | shortcuts, hints, tooltip shortcut |
| `--ds-color-menu-text-disabled` | #ffffff59 (.35) | #ffffff59 | K | disabled menu items |
| `--ds-color-menu-highlight` | #0d99ff | #0d99ff | K | highlighted menu item |
| `--ds-color-menu-text-on-highlight-secondary` | #ffffffcc | #ffffffcc | K | shortcut/hint on the highlighted item |
| `--ds-color-menu-separator` | #383838 | #383838 | F (≈ K white/10) | menu separators |
| `--ds-color-scrim` | #00000066 | #00000066 | K | dialog backdrop |
| `--ds-color-border-translucent` | #0000001a | #ffffff1a | K / F | swatch/chit outline, secondary button border |
| `--ds-color-border-translucent-strong` | #00000033 | #ffffff33 | F | unchecked checkbox, radio |
| `--ds-color-bg-transparent-hover` | #0000000d | #ffffff0d | F | ghost button hover |
| `--ds-color-bg-transparent-pressed` | #0000001a | #ffffff1a | F | ghost/secondary button pressed |
| `--ds-color-switch-hover` | #f4f4f4 | #585858 | K | Switch off + hover track |
| `--ds-color-scrollbar-thumb` | #00000033 | #ffffff33 | K | ScrollArea thumb |
| `--ds-color-scrollbar-thumb-hover` | #00000059 | #ffffff59 | K | ScrollArea thumb hover/drag |
| `--ds-color-text-selection` | #0d99ff66 | #0d99ff66 | F | DOM `::selection` in fields |
| `--ds-color-card-border-hover` | #cccccc | #5c5c5c | K | FileCard hover |
| `--ds-color-file-design` | #0c8ce9 | #0c8ce9 | K | Design-file glyph (Home, tab) |
| `--ds-color-canvas-default` | #f5f5f5 | #1e1e1e | K | Gallery canvas stand-in; mirrors the engine's `canvasDefault` |
| `--ds-color-folder-{red, orange, yellow, green, teal, blue, purple, pink, gray}` | #f24822 #ffa629 #ffcd29 #14ae5c #0fa8a8 #0d99ff #9747ff #ff24bd #b3b3b3 | #e03e1a #f0941d #f3c11b #198f51 #119a9a #0c8ce9 #8a38f5 #e81fae #8c8c8c | G (red/yellow/green/blue/purple = Figma's danger/warning/success/brand/component) | folder glyphs; ids = the store's `FolderColor` ("none" = icon-secondary) |
| `--ds-color-marquee-fill` | #0d99ff1a | #0c8ce926 | G | drag-select rectangle in Home's grid and list (`CollectionView`); its border is `--figma-color-border-selected` |
| `--ds-checkerboard` | `repeating-conic-gradient(#e6e6e6 0% 25%, #ffffff 0% 50%) 0 0 / 8px 8px` | same | G | alpha behind chits and swatches |

### 1.4 Canvas chrome colours (the engine's palette)

The Wasm renderer draws all canvas chrome itself: selection, handles, rulers, labels and guides. There is no DOM over the canvas. It receives these values as numbers (mechanism in 2.4). Order is the ABI: **append only, never reorder**.

| # | Name (`ChromeColor`) | Light | Dark | Tag |
|---|---|---|---|---|
| 0 | `selection` | #0d99ff | #0c8ce9 | D / M |
| 1 | `handleFill` | #ffffff | #ffffff | M |
| 2 | `handleStroke` | #0d99ff | #0c8ce9 | M |
| 3 | `hover` | #0d99ff | #0c8ce9 | G |
| 4 | `component` (main/instance outlines, labels) | #9747ff | #8a38f5 | D (bg-component) |
| 5 | `sizeBadgeFill` | #0d99ff | #0c8ce9 | M |
| 6 | `sizeBadgeText` | #ffffff | #ffffff | M |
| 7 | `frameTitleOnLight` (page luminance ≥ 0.5) | #00000080 | #00000080 | G |
| 8 | `frameTitleOnDark` (page luminance < 0.5) | #ffffff76 | #ffffff76 | M (#898989 on #232323) |
| 9 | `measure` | #f24822 | #f24822 | K / D |
| 10 | `measureText` | #ffffff | #ffffff | K |
| 11 | `snapGuide` | #f24822 | #f24822 | G |
| 12 | `spacingGuide` | #ff24bd | #f316b0 | K / D (border-slot) |
| 13 | `layoutGapFill` | #ff24bd40 | #f316b040 | D (bg-slot) |
| 14 | `layoutGapStroke` | #ff24bd | #f316b0 | D (border-slot) |
| 15 | `marqueeFill` | #0d99ff1a | #0c8ce91a | G |
| 16 | `marqueeStroke` | #0d99ff | #0c8ce9 | G |
| 17 | `rulerBg` | #ffffff | #2c2c2c | M |
| 18 | `rulerTick` | #b3b3b3 | #7a7a7a | G / M |
| 19 | `rulerText` | #00000080 | #ffffffb2 | G |
| 20 | `rulerSelectionBand` | #0d99ff33 | #0c8ce933 | G |
| 21 | `rulerSelectionText` | #007be5 | #7cc4f8 | G (text-brand) |
| 22 | `textCaret` | #0d99ff | #0c8ce9 | G |
| 23 | `textSelection` | #0d99ff4d | #0c8ce94d | G |
| 24 | `prototypeNoodle` | #0d99ff | #0d99ff | K |
| 25 | `slotFill` | #ff24bd40 | #f316b040 | D |
| 26 | `slotStroke` | #ff24bd | #f316b0 | D |
| 27 | `canvasDefault` (shown for a page with the default background) | #f5f5f5 | #1e1e1e | K |
| 28 | `pixelGrid` | #0000001a | #ffffff1a | G |

Frame titles pick their colour from the **page background's luminance**, not from the UI theme (rows 7 and 8). Selected and component titles use `selection` and `component`.

Chrome metrics go to the engine in the same generated header (`kChromeMetrics`), in CSS px at any zoom:

| Metric | Value | Tag |
|---|---|---|
| Selection stroke | 1 | M |
| Hover stroke | 1 | G |
| Handle size (incl. 1px stroke) | 7 | G |
| Size badge (and auto layout's gap / padding badges) | height 17, padding-x 4, radius 2, 6 below the selection (live Figma round 10, the captures scaled by their 11 px frame title: 17.3–17.8 high, text 4.0 in; `docs/engine-build.md` "Round 10") | M |
| Size badge text | Inter 11/16, weight 450 | G |
| Frame title text | Inter 11/16, weight 450, baseline 10 above the frame top | M |
| Ruler | thickness 20; labels Inter 10, centred on the tick; ticks 4 long | M |

### 1.5 Spacing (4px grid)

| Token | px | Token | px |
|---|---|---|---|
| `--ds-space-0` | 0 | `--ds-space-4` | 16 |
| `--ds-space-half` | 2 | `--ds-space-5` | 20 |
| `--ds-space-1` | 4 | `--ds-space-6` | 24 |
| `--ds-space-1-5` | 6 | `--ds-space-8` | 32 |
| `--ds-space-2` | 8 | `--ds-space-10` | 40 |
| `--ds-space-3` | 12 | `--ds-space-12` | 48 |
| | | `--ds-space-16` | 64 |

Off-grid values are allowed only where measured (marked M below, e.g. 38, 55, 67, 213).

### 1.6 Sizes and panel metrics (`--ds-size-*`)

| Token / metric | Value | Tag |
|---|---|---|
| `--ds-size-control` | 24 (fields, icon buttons, tabs, menu items, segmented) | M |
| `--ds-size-control-large` | 32 (large buttons, tools, rail items, Home pills) | M |
| `--ds-size-row` | 32 (property-row pitch, page-row pitch) | M / K |
| `--ds-size-layer-row` | 24 (pitch = highlight height) | M |
| `--ds-size-section-header` | 40 | M |
| `--ds-size-field` | 88 (one half-width field) | M |
| Panel padding | left 16, right 8 | M |
| Property grid | `16 + 88 + 8 + 88 + 8 + 24 + 8 = 240` (two fields, 8 gap, 8 gap, 24 icon column, right pad) | M |
| `--ds-size-panel` | 240 default; resizable to min 240, max 480; double-click on the handle resets | M / G |
| `--ds-size-panel-header` | 64 (left panel: file name 13/22 550, ink top ≈ 19; location 11/16 below) | M |
| `--ds-size-right-header` | 80 = 48 (avatar · Present · Share) + 32 (Design/Prototype tabs · zoom %); divider at 80 | M |
| Share button | 55 × 32 (hug: 12 + label + 12) | M |
| `--ds-size-rail` | 48 wide; items 32 × 32 at a 40 pitch; separators 16 × 1 | M |
| `--ds-size-tabbar` | 38 including the 1px bottom line | M |
| Traffic-light room | 80 (macOS windowed), 8 (full screen) | M |
| `--ds-size-tab-home` | 40 | M |
| File tab | `12 + 16 glyph + 8 + text + 8 + 24 close slot + 8` (= text + 76); min 72, max 240 | M / G |
| `--ds-size-toolbar` | 48 high; radius 13; 12 from the window bottom, centred on the **window**; tools 32 | M |
| Help button | 32 circle, 12 from bottom and right | M |
| `--ds-size-ruler` | 20 | M |
| Menu | item 24, padding 8, width 208–320 | K |
| `--ds-size-popover` | 240 wide (colour picker, floating property panels) | K |
| Dialog widths | 320 / 480 / 640 (`small` / `medium` / `large`) | G |
| `--ds-size-home-topbar` | 48 | M |
| `--ds-size-home-sidebar` | 240 | G |
| Home nav row | 32 pitch, 28 highlight | M |
| `--ds-size-card` | 268 × 213 (thumbnail 268 × 151, footer 62); grid gap 36; first row 67 below the top bar | M / G (split) |
| `--ds-size-list-row` | 40 (Home list view row, §4.27) | K |
| `--ds-size-list-header` | 32 (list view column header) | G |
| `--ds-size-breadcrumb-max` | 160 (an ancestor crumb's width before it ellipsizes) | G |
| Checkbox / radio | 16 | M / F |
| Switch | 28 × 16 track, 14 × 10 knob | K |
| Chit (colour field) | 14 in a 24 cell, radius 2 | K |
| Round swatch (styles list) | 16 | M |
| Styles list pitch | 30 | M |
| Avatar | 16 / 24 / 32 | G |

### 1.7 Radii

| Token | px | Use | Tag |
|---|---|---|---|
| `--ds-radius-none` | 0 | docked panels | K |
| `--ds-radius-small` | 2 | chits, canvas size badge | F / K |
| `--ds-radius-medium` | 5 | every control: field, button, icon button, menu item, row highlight, checkbox, tab, segment | M / F / K |
| `--ds-radius-medium-large` | 9 | FileCard, Toast | F / M (~10) / K |
| `--ds-radius-large` | 13 | Menu, Popover, Dialog, Toolbar | M / F / K |
| `--ds-radius-full` | 9999 | Switch, Avatar, Radio, help button, Home create pills | F / G |

### 1.8 Typography

Font: **Inter Variable** (`@fontsource-variable/inter`, weight axis 100–900, bundled, offline). Stack: `"Inter Variable", Inter, system-ui, -apple-system, sans-serif`. Mono: `ui-monospace, "SF Mono", Menlo, monospace`. `-webkit-font-smoothing: antialiased`. Numbers in fields and rulers use `font-variant-numeric: tabular-nums`.

Each style emits `--ds-font-<style>` (a `font` shorthand: weight size/line-height family) and `--ds-tracking-<style>` (letter-spacing). Components write `font: var(--ds-font-body-medium); letter-spacing: var(--ds-tracking-body-medium);`.

| Style | Size / line | Weight | Tracking | Use | Tag |
|---|---|---|---|---|---|
| `body-small` | 9 / 14 | 450 | 0.045px (0.005em) | tiny counters | F (size) / G |
| `body-medium` | 11 / 16 | 450 | 0.055px | **default UI text**: panels, fields, tooltips, tabs, layer rows | M / K / F |
| `body-medium-strong` | 11 / 16 | 550 | 0.055px | section titles, active tab, top-level layer names, dialog body emphasis | K / F |
| `body-ruler` | 10 / 12 | 450 | 0.05px | ruler labels (engine) | M |
| `menu` | 12 / 16 | 450 | 0 | Menu items | K |
| `body-large` | 13 / 22 | 450 | −0.0325px (−0.0025em) | Home: nav, file lists, Home text | K / M |
| `body-large-strong` | 13 / 22 | 550 | −0.0325px | left-panel file name, Home top-bar title, dialog titles, card titles | M |
| `heading-medium` | 15 / 25 | 550 | −0.13px | empty-state titles in large views | G (Inter dynamic metrics) |
| `heading-large` | 24 / 32 | 550 | −0.47px | viewer and Home empty-state hero | G (Inter dynamic metrics) |
| `code` | 11 / 16 mono | 400 | 0 | CodeBlock (Dev Mode inspect) | G |

Only the weights 450 and 550 are used, plus 400 for mono. The current code's 500/600/650/700/750 weights are replaced by 450/550.

### 1.9 Elevation (`--ds-elevation-*`)

Values are per theme, written explicitly (no `light-dark()`). They come from F, which names them like Figma's internal tokens.

| Token | Light | Dark | Use |
|---|---|---|---|
| `100` | `0 0 0.5px #0000004d, 0 1px 3px #00000026` | `0 0 0.5px #00000080, inset 0 0.75px 0 #ffffff1a, 0 1px 3px #00000066` | Toolbar, help button, floating canvas bars |
| `200` | `0 0 0.5px #0000002e, 0 3px 8px #0000001a, 0 1px 3px #0000001a` | `0 3px 8px #00000059, 0 1px 3px #00000080, inset 0 0.5px 0 #ffffff14, inset 0 0 0.5px #ffffff4d` | dragged tab, dragged layer ghost |
| `400-menu-panel` | `0 0 0.5px #0000001f, 0 10px 16px #0000001f, 0 2px 5px #00000026` | `0 10px 16px #00000059, 0 2px 5px #00000059, inset 0 0.5px 0 #ffffff14, inset 0 0.75px 0 #ffffff1a` | Popover, ColorPicker, floating panels |
| `500-modal-window` | `0 0 0.5px #00000014, 0 10px 24px #0000002e, 0 2px 5px #00000026` | `0 10px 24px #00000073, 0 3px 5px #00000059, inset 0 0.75px 0 #ffffff1a` | Dialog |
| `menu` (both themes) | `0 0 0.5px #0000004d, 0 5px 17px #00000040, 0 2px 7px #00000026` | same | Menu, Tooltip, Toast (K) |

### 1.10 Focus

- **Fields** (TextInput, NumericInput, ColorInput, Select-field, SearchField): the 1px border turns `--figma-color-border-selected` while focused (`:focus-within`). There is no outer ring. (K)
- **Everything else**: `:focus-visible { outline: 1px solid var(--figma-color-border-selected); outline-offset: 1px; }`. Inside menus and lists, focus is shown as the highlight, not the outline. (F)
- Tokens: `--ds-focus-color: var(--figma-color-border-selected)`, `--ds-focus-width: 1px`, `--ds-focus-offset: 1px`.
- Mouse clicks never show a ring (`:focus-visible` only). Inside an editor document, Esc from a field returns focus to the canvas (see `onExit` in 4.0).

### 1.11 Z-index (per document; every WebContentsView is its own document)

| Token | Value | Layer |
|---|---|---|
| `--ds-z-base` | 0 | canvas, panels' content |
| `--ds-z-panel` | 10 | docked panels over the canvas |
| `--ds-z-floating` | 20 | Toolbar, help button, floating bars |
| `--ds-z-resize` | 30 | ResizeHandles |
| `--ds-z-scrim` | 100 | Dialog backdrop |
| `--ds-z-dialog` | 110 | Dialog |
| `--ds-z-popover` | 200 | Popover, ColorPicker (above dialogs: a picker opened from a dialog) |
| `--ds-z-menu` | 300 | Menu, Select list |
| `--ds-z-toast` | 400 | Toast |
| `--ds-z-tooltip` | 500 | Tooltip |
| `--ds-z-drag` | 600 | drag ghosts |

All overlays render into one portal root per document, `<div id="ds-overlays">`. The portal root is created by `ds/overlay/Portal.tsx` on first use.

### 1.12 Motion

Figma's chrome is **instant**: hover, press, selection, panel show/hide, menu open/close and dialog open do not animate (K: "no transitions, as Figma's"). The base CSS sets `transition: none` and only the cases below opt in.

| Token | Value | Use | Tag |
|---|---|---|---|
| `--ds-duration-instant` | 0ms | everything by default | K |
| `--ds-duration-fast` | 80ms | Switch knob, collapse chevron rotation | F |
| `--ds-duration-medium` | 150ms | Toast enter/exit (translateY 8px + opacity) | G |
| `--ds-ease-out` | `cubic-bezier(0, 0, 0.2, 1)` | the above | F (ease-out) |
| `--ds-delay-tooltip` | 500ms | first tooltip | K |
| `--ds-delay-tooltip-warm` | 300ms | another tooltip within this window after one hides shows at once | G |
| `--ds-delay-submenu` | 100ms | hover intent before a submenu opens (switching to a sibling submenu is immediate) | G |
| `--ds-toast-duration` | 4000ms; 8000ms with an action | Toast auto-dismiss (paused while hovered) | G |

Under `prefers-reduced-motion: reduce`, fast and medium become 0ms. During a theme switch, `<html data-theme-switching>` disables every transition for two frames.

### 1.13 Icons

- **Two sets, as in Figma's UI kit.** The `24.*` set has 24×24 boxes with a ~16px glyph: icon buttons, tools (centred in 32), rail items, section actions. The `16.*` set has 16×16 boxes: chevrons in fields and menus, menu checks, layer-type icons, tree chevrons. Tokens: `--ds-size-icon-24: 24px`, `--ds-size-icon-16: 16px`.
- **Colour** is `currentColor`. The kit's two tones map to path opacity: primary 0.9 → `opacity: 1`, secondary 0.3 → `opacity: 0.333`. The colour token already carries the 0.9 alpha.
- **Names** are `<box>.<kit name>` (`24.frame`, `16.chevron.down`, `24.plus.small`). Every legacy name without a box prefix is normalised during import.
- **Licence.** Figma's UI-kit glyphs are fine for this personal, non-commercial app and for the view-only previews shared with friends. They are not to be redistributed.

---

## 2. Theming mechanism

### 2.1 One source of truth: `src/renderer/src/ds/tokens.ts`

- Pure data plus pure functions. It has **no imports**, no DOM, no React and no Node APIs, and uses only erasable TypeScript (no enums or namespaces). That lets four consumers import it:
  - the renderer bundles (every view, the viewer, the Gallery);
  - Electron main (via the alias `@ds` → `src/renderer/src/ds`, added to `electron.vite.config.ts` main/preload `resolve.alias` and to `tsconfig.node.json`);
  - the generator script, run directly by Node 24 (`node scripts/gen-tokens.ts`, type stripping);
  - tests.
- Shape (load-bearing):

```ts
export type ThemeName = "light" | "dark";
export type ThemePreference = "system" | "light" | "dark";
type Pair = readonly [light: string, dark: string];

export const figmaColor = { "bg": ["#ffffff", "#2c2c2c"], /* …174, names without the --figma-color- prefix */ } as const satisfies Record<string, Pair>;
export const appColor = { "tabbar-bg": ["#e6e6e6", "#3b3b3b"], /* … 1.3, names without --ds-color- */ } as const satisfies Record<string, Pair>;
export const space = { "0": 0, "half": 2, "1": 4, "1-5": 6, "2": 8, "3": 12, "4": 16, "5": 20, "6": 24, "8": 32, "10": 40, "12": 48, "16": 64 } as const;
export const size = { control: 24, "control-large": 32, row: 32, "layer-row": 24, "section-header": 40, field: 88, panel: 240, "panel-min": 240, "panel-max": 480, "panel-header": 64, "right-header": 80, rail: 48, tabbar: 38, "tab-home": 40, toolbar: 48, ruler: 20, popover: 240, /* … 1.6 */ } as const;
export const radius = { none: 0, small: 2, medium: 5, "medium-large": 9, large: 13, full: 9999 } as const;
export const text = { "body-medium": { size: 11, line: 16, weight: 450, tracking: "0.055px" }, /* … 1.8 */ } as const;
export const elevation = { "100": ["…light…", "…dark…"], /* … 1.9 */ } as const satisfies Record<string, Pair>;
export const z = { base: 0, panel: 10, /* … 1.11 */ } as const;
export const motion = { "duration-fast": "80ms", /* … 1.12 */ } as const;
export const CHROME_COLORS = ["selection", "handleFill", /* … 1.4, ABI order */] as const;
export const canvasChrome: Record<(typeof CHROME_COLORS)[number], Pair> = { /* 1.4 */ };
export const canvasChromeMetrics = { selectionStroke: 1, handle: 7, sizeBadge: { height: 17, padX: 4, radius: 2, gap: 6 }, /* … */ } as const;
export type Surface = "app" | "tabbar" | "viewer";
export function surfaceBackground(surface: Surface, theme: ThemeName): string; // app → bg, tabbar → tabbar-bg, viewer → canvas-default
export function resolveFigmaColor(name: keyof typeof figmaColor, theme: ThemeName): string;
export function chromePalette(theme: ThemeName): Float32Array;               // CHROME_COLORS.length * 4, straight-alpha sRGB 0..1
```

### 2.2 Generated artefacts: `scripts/gen-tokens.ts` → `npm run tokens`

`src/renderer/src/ds/tokensCss.ts` holds pure renderers: `renderTokensCss()`, `renderBootJs()`, `renderChromeHeader()`. The script writes:

1. **`src/renderer/src/ds/tokens.css`**, structured as:
   ```css
   /* GENERATED by scripts/gen-tokens.ts from ds/tokens.ts — do not edit */
   @layer reset, tokens, theme, base, ds, components, utilities, app;
   @layer tokens {
     :root { --ds-space-…; --ds-size-…; --ds-radius-…; --ds-font-…; --ds-tracking-…; --ds-z-…; --ds-duration-…; }
     :root, [data-theme="light"] { color-scheme: light; --figma-color-…: …; --ds-color-…: …; --ds-elevation-…: …; }
     [data-theme="dark"] { color-scheme: dark; /* same names, dark values */ }
   }
   ```
   Any subtree can be re-themed by putting `data-theme` on an element. The Gallery uses this to show light and dark side by side. Menu, Tooltip and Toast roots carry `data-theme="dark"`, so their insides always resolve dark.
2. **`src/renderer/public/boot.js`**, the pre-paint script:
   ```js
   // GENERATED — sets data-theme, color-scheme and background before the first paint
   (function () {
     var d = document.documentElement, t = null;
     try { t = window.designer && window.designer.theme; } catch (e) {}
     var pref = t ? t.preference : (function () { try { return localStorage.getItem("designer-theme") || "system"; } catch (e) { return "system"; } })();
     var dark = t ? t.resolved === "dark" : pref === "dark" || (pref !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
     var BG = /* from surfaceBackground */ { app: ["#ffffff", "#2c2c2c"], tabbar: ["#e6e6e6", "#3b3b3b"], viewer: ["#f5f5f5", "#1e1e1e"] };
     d.setAttribute("data-theme", dark ? "dark" : "light");
     d.style.colorScheme = dark ? "dark" : "light";
     d.style.backgroundColor = (BG[d.getAttribute("data-surface")] || BG.app)[dark ? 1 : 0];
   })();
   ```
   Every HTML entry declares its surface: `<html data-surface="tabbar">` (tab bar view), `"app"` (Home, editor tabs, Gallery) and `"viewer"` (the shared preview page).
3. **The engine header**, `ENGINE_PALETTE_HEADER` (default `engine/src/overlay/ChromePalette.generated.h`; the engine contract may move it, and the path is that one constant):
   ```cpp
   // GENERATED by scripts/gen-tokens.ts — do not edit
   #pragma once
   #include <cstddef>
   #include <cstdint>
   namespace ds {
   enum class ChromeColor : uint8_t { Selection = 0, HandleFill = 1, /* … */ PixelGrid = 28, Count };
   inline constexpr float kChromeLight[size_t(ChromeColor::Count)][4] = { /* … */ };
   inline constexpr float kChromeDark [size_t(ChromeColor::Count)][4] = { /* … */ };
   struct ChromeMetrics { float selectionStroke, hoverStroke, handle, badgeHeight, badgePadX, badgeRadius, badgeGap, titleBaseline, rulerThickness, rulerTick, rulerFontSize; };
   inline constexpr ChromeMetrics kChromeMetrics{ 1, 1, 7, 16, 4, 2, 6, 10, 20, 4, 10 };
   }
   ```

`src/renderer/src/ds/__tests__/tokens.test.ts` re-renders all three outputs and fails `npm run check` if a committed file differs. It also checks:
- all 174 `figmaColor` names match `docs/research/figma/figma-color-tokens-light.txt` with the same light values, except the † list (which is empty for light);
- every value parses as a colour;
- `CHROME_COLORS.length === 29`, and the order matches a frozen snapshot (append-only).

### 2.3 Preference, resolution, switching

- **Preference** is `"system" | "light" | "dark"` and is owned by **Electron main**. It is persisted with the app's settings under key `theme`; the store itself belongs to the shell contract. In the menus it appears as Light / Dark / Use system setting.
- **Resolution**: main sets `nativeTheme.themeSource = preference` and reads `nativeTheme.shouldUseDarkColors`. Native menus, the window background and the traffic lights therefore follow.
- **Delivery to views**: each WebContentsView gets `additionalArguments: ["--designer-theme=<preference>:<resolved>"]`. Its preload exposes a synchronous snapshot, `window.designer.theme = { preference, resolved }`, which `boot.js` reads before first paint. On any change (a user choice, or the OS appearance changing while the preference is `system`), main runs `nativeTheme.on("updated")`, sends **`theme:changed`** `{ preference, resolved }` to every view, and calls `view.setBackgroundColor(surfaceBackground(surface, resolved))` for each one. Views request a change with **`theme:set`** (invoke, `ThemePreference`). These two channel names are the DS's requirement. They are registered with the shell's IPC map (`src/shared/ipc.ts`); if the shell contract renames them, the semantics stay.
- **Renderer API**, `src/renderer/src/ds/theme.ts`:
  ```ts
  export function currentTheme(): { preference: ThemePreference; resolved: ThemeName };
  export function setThemePreference(p: ThemePreference): void;        // desktop: IPC theme:set; web/viewer: localStorage "designer-theme" + matchMedia
  export function onThemeChange(cb: (t: { preference: ThemePreference; resolved: ThemeName }) => void): () => void;
  export function useTheme(): { preference: ThemePreference; resolved: ThemeName }; // useSyncExternalStore
  export function applyTheme(resolved: ThemeName): void;                // data-theme + color-scheme + 2-frame data-theme-switching
  ```
  Without a preload (the web viewer, `npm run web`), `theme.ts` falls back to localStorage `designer-theme` and `matchMedia`. That is the same key the current `ThemeContext.tsx` uses, which this module replaces.
- **Electron main** imports `@ds/tokens` for `BrowserWindow.backgroundColor` and `WebContentsView.setBackgroundColor`. Main code never hard-codes another hex value: this replaces `src/main/index.ts:50` and the colours in `signIn.ts`. Any HTML page main serves itself (e.g. a future Firebase sign-in page on localhost) inlines `renderTokensCss()`.

### 2.4 How the engine gets its colours

1. On boot, and from `onThemeChange`, the editor host calls `engine.setChromePalette(chromePalette(resolved))`. This is one Float32Array of `CHROME_COLORS.length × 4`: straight-alpha sRGB, RGBA in 0..1. The engine copies it into its overlay uniform/constant buffer, converts to its working space (linear, premultiplied) as its pipeline needs, and requests one redraw.
2. The binding's namespace and name belong to the engine contract (flat generated TsApi functions per R1). This document fixes only the **layout**: index = `ChromeColor`, 4 floats each, length checked (`n !== Count*4` → the engine logs and keeps the old palette).
3. Native C++ tests and the engine's default state use `ds::kChromeLight` / `kChromeDark` from the generated header, so the engine renders correctly before the first call.
4. Chrome text (badges, frame titles, rulers) uses Inter. The engine loads the same Inter variable font file the chrome uses. Font loading belongs to the engine/fonts contract; the weights are 450 and the sizes are in 1.4.
5. The page colour is document data. `canvasDefault` is used only for a page whose background is the default.

---

## 3. Styling approach

**Decision: plain CSS with CSS Modules (`*.module.css`), on top of the generated custom properties, in explicit cascade layers. No Tailwind in new code, no vanilla-extract, no StyleX.**

Why:
1. **It is what Figma does.** Figma's `figma_app.css` is CSS Modules (~12.5k module classes) plus StyleX atomics, in `@layer` blocks, with no Tailwind (R1, binary inspection). Tailwind appears in Figma only for *user* code layers.
2. **States belong in selectors.** `:hover`, `:focus-visible`, `[aria-pressed="true"]`, `[aria-checked="mixed"]` and `[data-state]` live in CSS, not in `cn()` conditionals. Today the same string `text-[11px] … tracking-[0.055px]` is repeated 170 times; it becomes one `font:` and one `letter-spacing:` declaration per component.
3. **Zero runtime, no plugin.** Vite supports CSS Modules natively in every renderer entry: the tab bar, Home, editor tabs, the viewer and the Gallery.
4. **The token types live in `tokens.ts`, not in a CSS-in-TS compiler.** vanilla-extract would add a build plugin to every entry for typing we already get from `tokens.ts`, plus a test that every `var(--…)` used in `ds/**/*.module.css` exists in `tokens.css`. StyleX needs a Babel compile step. Neither pays off for a one-person app.

Rules:
- Each component is `ds/components/<Name>.tsx` + `<Name>.module.css`. Each module file wraps its rules in `@layer ds { … }`. Screen-level styles (Home layout, editor layout) are `*.module.css` next to their screens, in `@layer app`.
- Class names are combined with `clsx` (already a dependency). `tailwind-merge` and `cn()` stay legacy-only.
- Selectors for tests and the drive script are `data-ds="<Name>"` attributes on component roots, never generated class names.
- No colour, shadow or font literals in `ds/**/*.module.css`. Use `var(--figma-color-*)` / `var(--ds-*)` only. `transparent`, `currentColor`, `inherit` and `0` are allowed. This is enforced by `ds/__tests__/no-raw-values.test.ts`, which greps for `#hex`, `rgb(`, `hsl(` and `box-shadow:` values without `var(` in `ds/**/*.module.css`. Pixel lengths are allowed (metrics are spelled out in each module and mirrored in 1.6).
- `ds/` imports nothing from `@/engine`, `firebase`, `@/lib/*`, `@/figma/*` or `@/home/*`. This is enforced with ESLint `no-restricted-imports` scoped to `src/renderer/src/ds/**`.

**Tailwind already in the repo** (`tailwindcss`, `@tailwindcss/vite`, `tailwind-merge`, `@import "tailwindcss"` in `styles/app.css`):
- **Now.** It stays installed so that legacy screens (`figma/`, `home/`, `app/`, `cv/`) keep rendering while they are replaced. `ds/global.css` declares the layer order before Tailwind's own: `@layer reset, tokens, theme, base, ds, components, utilities, app;`. With that order, Tailwind preflight (`base`) sits under DS components and legacy utilities (`utilities`) still win inside legacy markup. `@custom-variant dark` keeps working because `data-theme` stays on `<html>`.
- **Rule.** No Tailwind class strings in `src/renderer/src/ds/**`, nor in any file created after this document. ESLint `no-restricted-syntax` flags `className` string/template literals in `ds/**`; new screens use their module classes.
- **Removal.** Once no file outside `ds/` matches Tailwind syntax (`npm run lint` check `scripts/check-tailwind.mjs` lists remaining files), uninstall `tailwindcss`, `@tailwindcss/vite` and `tailwind-merge`. At the same time, delete `@import "tailwindcss"`, `@custom-variant dark` and `@theme inline` from `styles/app.css`, and delete `app.css` itself; its surviving base rules move to `ds/global.css`.

`ds/global.css` (imported once by every entry, before anything else) contains:
- the layer order statement, `@import "@fontsource-variable/inter";` and `@import "./tokens.css";`;
- a `@layer reset` block: border-box, zero margins, `button { font: inherit; color: inherit; cursor: default; }`, `img { -webkit-user-drag: none; }`;
- a `@layer base` block:
  - `html, body, #root { height: 100%; overflow: hidden; }`;
  - `body { font: var(--ds-font-body-medium); letter-spacing: var(--ds-tracking-body-medium); color: var(--figma-color-text); background: var(--figma-color-bg); -webkit-font-smoothing: antialiased; user-select: none; }`;
  - `input, textarea, [contenteditable] { user-select: text; }`;
  - `::selection { background: var(--ds-color-text-selection); }`;
  - `* { transition: none; }` (motion opt-ins come from component modules);
  - the `.ds-drag` / `.ds-no-drag` app-region helpers;
  - the default thin scrollbar for overflow outside `ScrollArea` (8px, thumb `--ds-color-scrollbar-thumb`);
  - `[data-theme-switching] * { transition: none !important; }`;
  - the reduced-motion overrides.

---

## 4. Components

### 4.0 Conventions (all components)

Common types live in `ds/types.ts`:

```ts
export const MIXED: unique symbol = Symbol("mixed");
export type Mixed<T> = T | typeof MIXED;
export type ControlSize = "default" | "large";                 // 24 | 32
export type ChangeInfo = { final: boolean; source: "type" | "step" | "scrub" | "drag" | "pick" };
export type ExitReason = "enter" | "escape" | "tab" | "shift-tab" | "blur";
```

- **Gestures and undo.** Continuous edits (scrub, slider, picker drag) call `onChange(value, { final: false, … })` per frame. On release they make exactly one call with `final: true`. Esc during a gesture calls `onCancel()` and reverts. The editor maps non-final calls to an open engine transaction (live preview) and the final call to its commit, so one gesture is one undo step. Typed and stepped values always arrive with `final: true`.
- **Keys in fields.** Keys stop at the field (`stopPropagation`), so canvas shortcuts never fire while typing. Fields call `onExit?.(reason)` after Enter/Esc/Tab so an editor document can return focus to the canvas (Figma does this after Enter and Esc).
- **Mixed.** `MIXED` renders the word "Mixed" in `--figma-color-text-secondary`, in place of the value.
- **Root attributes.** Every root spreads `className`, `style`, `id` and any `data-*` / `aria-*` props. It also sets `data-ds="<Name>"`.
- **Forced states (Gallery and tests).** CSS pairs every interactive pseudo-class with an attribute: `.x:hover, .x[data-hover]`, `.x:active, .x[data-pressed]`, `.x:focus-visible, .x[data-focus-visible]`, `[data-open]`. Overlay components accept `static` to render in place instead of in the portal (Gallery only).
- **Tooltips** are declarative attributes read by one global manager (4.9): `tooltip?: string` and `shortcut?: string` props set `data-tooltip` / `data-tooltip-shortcut`. There are no wrapper components and no native `title` (except in the tab bar view, 4.23).
- **Icons** are `IconName` strings (the generated union), never JSX, so components control size and tone.
- **Strings** owned by the DS are English, in Figma's wording, in `ds/strings.ts`: "Mixed", "Search", "Clear", "Close", "No results", "Untitled".
- **Overlays are confined to their own WebContentsView.** Menus, popovers and tooltips cannot cross a view's bounds. That matters only for the 38px tab bar view, which uses native menus (4.8, `renderer: "native"`).

### 4.1 Button

- **Anatomy**: `[icon 24?] label`. With an icon, padding-left is 4.
- **Props**:
  ```ts
  {
    variant: "primary" | "secondary" | "destructive" | "destructive-secondary" | "ghost" | "link" | "tinted";
    size?: ControlSize;
    icon?: IconName;
    children: ReactNode;
    disabled?: boolean;
    loading?: boolean;
    fullWidth?: boolean;
    type?: "button" | "submit";
    tooltip?: string;
    shortcut?: string;
    onClick?: (e: React.MouseEvent) => void;
  }
  ```
- **Metrics**:
  - default: height 24, padding 0 8;
  - large: height 32, padding 0 12 (Share = 55 × 32, M);
  - radius 5; font `body-medium` (450; verify the Share label weight, Open questions).
- **States** (bg / text):

| Variant | Default | Hover | Pressed | Disabled |
|---|---|---|---|---|
| primary | bg-brand / text-onbrand | bg-brand-hover | bg-brand-pressed, text-onbrand-secondary | bg-disabled / text-ondisabled |
| secondary | transparent + inset 1px `--ds-color-border-translucent` / text | bg-secondary | `--ds-color-bg-transparent-pressed` | text-disabled, no border |
| destructive | bg-danger / text-ondanger | bg-danger-hover | bg-danger-pressed, text-ondanger-secondary | as primary |
| destructive-secondary | inset 1px border-danger / text-danger | bg-danger-tertiary | + border-danger-strong | text-disabled |
| ghost | transparent / text | `--ds-color-bg-transparent-hover` | `--ds-color-bg-transparent-pressed` | text-disabled |
| link | transparent / text-brand | underline | bg-selected | text-disabled |
| tinted (Home create pills) | bg-secondary / text, radius full, size large | bg-tertiary | bg-tertiary | text-disabled |

- **Focus**: outline (1.10).
- **Loading**: Spinner 16 replaces the label at the same width; the button is disabled while loading.
- **Keyboard**: native button (Enter/Space).
- **Tags**: F (variants), M (Share size), K.

### 4.2 IconButton

- **Anatomy**: 24×24 (or 32×32) box with the icon centred.
- **Props**: `{ icon: IconName; label: string /* aria-label + tooltip */; shortcut?: string; size?: ControlSize; tone?: "default" | "secondary"; disabled?: boolean; tooltipPlacement?: Placement; onClick }`.
- **States**:
  - default: `--figma-color-icon` (`secondary` tone: `--figma-color-icon-secondary`);
  - hover: bg `--figma-color-bg-hover`, icon `--figma-color-icon-hover`;
  - pressed: bg `--figma-color-bg-pressed`;
  - disabled: `--figma-color-icon-disabled`, no hover;
  - focus-visible: outline;
  - radius 5.
- **Sizes**: 24 (panels, section headers), 32 (tab bar, rail, toolbar, floating bars).
- **Keyboard**: native button.
- **Tags**: K / F.

### 4.3 ToggleIconButton

- **Props**: IconButton props + `{ pressed: Mixed<boolean>; onPressedChange: (next: boolean) => void }`. It sets `aria-pressed` (`"mixed"` for MIXED).
- **States**:
  - on: bg `--figma-color-bg-selected`, icon `--figma-color-icon-selected`; hover stays the same;
  - off: as IconButton;
  - mixed: bg `--figma-color-bg-selected-secondary`, icon `--figma-color-icon-secondary`;
  - clicking from mixed → on.
- **Use**: constrain proportions, clip content (icon variant), independent corners, layout options.
- **Tags**: K / F.

### 4.4 TextInput (and TextArea)

- **Anatomy**: `[prefix cell 24 (IconName | 1–2 letters)] text [suffix ReactNode]`. Without a prefix, the text starts at padding-left 8.
- **Props**:
  ```ts
  {
    label: string;                       // aria-label
    value: Mixed<string>;
    onCommit?: (v: string) => void;      // draft mode
    onChange?: (v: string) => void;      // live mode
    placeholder?: string;
    prefix?: IconName | string;
    suffix?: ReactNode;
    variant?: "filled" | "outlined" | "ghost";
    size?: ControlSize;
    autoFocus?: boolean;
    selectAllOnFocus?: boolean;          // default true
    maxLength?: number;
    onExit?: (r: ExitReason) => void;
  }
  ```
  `onCommit` (draft mode) **or** `onChange` (live mode).
- **Metrics**: height 24 (32 large), radius 5, 1px border (always present, transparent by default), text `body-medium`, placeholder `--figma-color-text-secondary` (K).
- **Variants**:
  - filled: bg-secondary;
  - outlined: transparent + border `--figma-color-border` (instance properties);
  - ghost: no bg until hover (inline rename in rows and headers).
- **States**:

| State | Appearance |
|---|---|
| hover | border `--figma-color-border` (filled) / `--figma-color-icon-tertiary` (outlined) |
| focus | border `--figma-color-border-selected` |
| disabled | 0.4 opacity, no hover |
| mixed | "Mixed" placeholder style; focusing it empties the field |
| invalid (`aria-invalid`) | border `--figma-color-border-danger-strong` |

- **Behaviour**:
  - the first click on an unfocused field selects all (port `selectAllOnClick`, K);
  - Enter commits and blurs (`onExit("enter")`);
  - Esc reverts and blurs (`"escape"`);
  - Tab / Shift+Tab commits and moves;
  - blur commits;
  - in draft mode, nothing is committed if the text is unchanged.
- **TextArea** uses the same styles, padding 4 8, grows from 3 to 8 rows, and Enter inserts a newline. ⌘Enter commits.
- **Tags**: K.

### 4.5 NumericInput

- **Anatomy**: `[scrub prefix 24: letter (W, H, X, Y) or IconName, text-secondary] number [unit hugging the number] [suffix]`.
- **Props**:
  ```ts
  {
    label: string;
    prefix: IconName | string;
    value: Mixed<number> | null;                 // null = empty
    onChange: (v: number, info: ChangeInfo) => void;
    onCancel?: () => void;
    onClear?: () => void;                         // empty text committed
    onStep?: (delta: number) => void;             // arrow keys while the value is MIXED
    min?: number;                                 // default -1e6
    max?: number;                                 // default 1e6
    step?: number;                                // default 1
    bigStep?: number;                             // default 10
    precision?: number;                           // default 2 (display and clamp)
    unit?: "%" | "°" | "px" | string;
    scrub?: boolean;                              // default true
    placeholder?: string;
    suffix?: ReactNode;
    disabled?: boolean;
    variant?: "filled" | "ghost";
    onExit?: (r: ExitReason) => void;
    onFocusChange?: (focused: boolean) => void;   // canvas highlights what a padding/gap field edits
  }
  ```
- **Typing**: accepts a number or arithmetic, `+ − × ÷ * / ( )`, with `,` as a decimal point. Parsing is `evaluate()`, ported from `figma/ui.tsx` with its test; it is a hand parser and never `eval`. A typed unit suffix is ignored (`50%` → 50). The result is clamped and rounded to `precision`. Invalid input reverts. Enter, Tab or blur commits (`final: true`, source `"type"`).
- **Arrow keys**: ↑/↓ `±step`, Shift `±bigStep` (`source: "step"`, final), with the text selected after the step. On MIXED, the arrows call `onStep(delta)` instead, and the editor applies the delta to each node.
- **Scrubbing** (pointer on the prefix):
  - cursor `ew-resize`, forced globally while dragging (`html[data-cursor="ew-resize"]`);
  - uses `setPointerCapture`;
  - **1 unit per 1px** of horizontal movement (×10 with Shift, ×0.1 with Alt when `precision > 0`);
  - emits `final: false` per frame, then `final: true` on release;
  - Esc calls `onCancel`;
  - a press without movement (< 2px) just focuses the field;
  - G: verify the rate (Open questions). The current 4px-per-unit code is replaced.
- **Units**: with `unit`, the input is as wide as its digits and the unit hugs it (`100%`, `0°`); clicking the remaining area focuses the input (K).
- **States**: as TextInput. Disabled shows 0.4 opacity and no scrub cursor.
- **Tags**: K (behaviour), G (scrub rate and modifiers).

### 4.6 ColorInput, Swatch, ColorPicker

**Swatch**
- **Props**: `{ color: string; opacity?: number; shape?: "square" | "round"; size?: 14 | 16 }`.
- **Square chit**: 14×14, radius 2, inset 1px `--ds-color-border-translucent`, sitting in a 24 cell. Alpha is drawn over `--ds-checkerboard`: the left half is opaque, the right half has the alpha (G).
- **Round**: 16 (styles list, M).

**ColorInput**
- **Anatomy**: `[Swatch cell 24] hex (6 digits, upper case) | 1px divider in --figma-color-bg | opacity NumericInput (53 wide, unit %)`.
- **Props**:
  ```ts
  {
    label: string;
    color: Mixed<string>;
    opacity: Mixed<number>;
    onColor: (hex: string, info: ChangeInfo) => void;
    onOpacity?: (o: number, info: ChangeInfo) => void;
    onSwatchClick?: (anchor: DOMRect) => void;    // opens the ColorPicker
    swatch?: ReactNode;                           // override, e.g. a variable chip
    disabled?: boolean;
  }
  ```
- **Hex typing**: accepts 3 or 6 digits, with or without `#`. A CSS colour name is accepted and converted. Esc reverts.
- **States**: as TextInput, on the whole field.

**ColorPicker** (a Popover, 240 wide; port the HSV math from `figma/ColorPicker.tsx`)
- **Header** (40): `Tabs` "Custom" / "Libraries" (Libraries is a slot filled by the editor with this file's and enabled libraries' variables and styles) and IconButton "Close".
- **Paint-type row**: SegmentedControl of icons (Solid, Linear, Radial, Angular, Diamond, Image), plus an IconButton for blend mode.
- **Body**:
  - the saturation/brightness square, 224 × 184, radius 5 (K);
  - the hue slider and alpha slider: track height 12, radius 6, thumb 12 round with a 2px white border and `0 0 0 1px #0000004d` (K);
  - an eyedropper IconButton (`24.eyedropper.small`), which calls the main-process native eyedropper via the editor;
  - the model Select ("Hex", "RGB", "CSS", "HSL", "HSB") with value fields;
  - "On this page" document swatches (round 16, 8 gap, wrap).
- **Gradient**: a stop bar (stops 12 round, the selected one with the border-selected ring) and a stops list.
- **Behaviour**: emits `onChange({ paint }, info)`, with `final: false` while dragging. It closes on Esc or an outside press, and is draggable by its header.
- **Keyboard**: the square and sliders are focusable; arrows move by 1% (Shift 10%).
- **Tags**: K (layout), G (exact gradient/slider metrics).

### 4.7 Select / Dropdown

- **Anatomy**: `[prefix?] value text [16.chevron.down in icon-secondary, 4 from the right]`.
- **Props**:
  ```ts
  {
    label: string;
    value: Mixed<string>;
    options: Array<{ value: string; label: string; icon?: IconName; hint?: string; disabled?: boolean } | "-">;
    onChange: (v: string) => void;
    variant?: "filled" | "outlined" | "ghost";
    size?: ControlSize;
    prefix?: IconName | string;
    width?: number | "hug";
    disabled?: boolean;
  }
  ```
  - filled: panel fields;
  - outlined: instance properties;
  - ghost: no fill until hover, e.g. Home "Last viewed ⌄" and the sizing "Fixed/Hug/Fill" trigger.
- **List**: a **Menu** (4.8, dark), with a check column. It opens so that the **checked item lies over the trigger** (macOS style), and is clamped to the viewport. The list is at least as wide as the trigger.
- **States**: trigger as TextInput (hover border, focus border, open = border-selected). Mixed shows "Mixed".
- **Keyboard**:
  - Enter, Space or ↓ opens;
  - in the list: ↑/↓, Home/End, typeahead (500ms buffer), Enter picks, Esc closes and keeps focus on the trigger;
  - with the trigger focused and closed: ↑/↓ do nothing (Figma).
- Native `<select>` is **not** used.
- **Tags**: K / G.

### 4.8 Menu / ContextMenu

Port `components/admin/ContextMenu.tsx` (MenuPanel, `tidy`, `keys`) into `ds/components/Menu.tsx`.

- **Model** (serialisable, so the same entries can build a native menu):
  ```ts
  export type MenuItem = {
    id: string;
    label: string;
    shortcut?: string;                  // display string from keys()
    accelerator?: string;               // Electron accelerator, native menus only
    hint?: string;
    icon?: IconName;
    checked?: boolean;                  // check column appears when any item defines it
    disabled?: boolean;
    danger?: boolean;
    items?: MenuEntry[];
  };
  export type MenuEntry = MenuItem | "-" | { header: string };
  ```
- **Props**: `ContextMenu { at: {x, y}; entries: MenuEntry[]; onSelect: (id: string) => void; onClose: () => void; renderer?: "dom" | "native"; static?: boolean }`. `MenuButton { entries; onSelect; children; placement? }` is a trigger that opens a Menu under it.
- **Look**:
  - bg `--ds-color-menu-bg`, radius 13, padding 8, width 208–320, max-height `100vh − 16` (scrolls);
  - shadow `--ds-elevation-menu`;
  - `data-theme="dark"` on the root;
  - items: height 24, padding 0 8, radius 5, font `menu` (12/16), text `--ds-color-menu-text`;
  - check column 16 (`16.check`) and icon column 16, shown only if any item uses them;
  - shortcut right-aligned, padding-left 16, `--ds-color-menu-text-secondary`, tabular-nums;
  - submenu chevron `16.chevron.right`;
  - separator: 1px `--ds-color-menu-separator`, full bleed (−8px margins), 8px vertical margin;
  - `{ header }` rows: 24 high, `body-medium-strong` (11/16), `--ds-color-menu-text-secondary`.
- **States**: highlighted (hover or keyboard) is bg `--ds-color-menu-highlight` with shortcut/hint `--ds-color-menu-text-on-highlight-secondary`. Disabled is `--ds-color-menu-text-disabled` and cannot be highlighted. `danger` has no special colour (Figma's menus don't colour delete).
- **Positioning**: at the pointer. The menu flips left or up at the edges with an 8px margin. A submenu opens beside its item (x = item right + 4, y = item top − 8) and flips to the left side when there is no room.
- **Keyboard**:
  - ↑/↓ wrap over enabled items, Home/End;
  - → or Enter on a submenu item opens it focused; ← or Esc in a submenu goes back;
  - Esc at the root closes;
  - Enter/Space picks;
  - typeahead on labels.
- **Hover intent**: a submenu opens after `--ds-delay-submenu`. A pointer moving diagonally toward an open submenu inside the triangle "safe area" does not switch it.
- **Dismiss**: outside pointerdown, wheel, window blur, resize, Esc. Picking closes the whole menu.
- **Native renderer**: `window.designer.menu.popup(template, at): Promise<string | null>` (IPC **`menu:popup`**). `toNativeTemplate(entries)` maps the fields to Electron's `MenuItemConstructorOptions` (`type: "checkbox"` for `checked`, `accelerator`, `enabled`, `submenu`; headers become disabled items). It is used by the tab bar view, and by any trigger whose menu would not fit its view.
- **`keys()` fixes**: the Apple modifier order is **⌃⌥⇧⌘** (today: ctrl, shift, alt, mod) and the ctrl glyph is `⌃` (today `^`). On other platforms: `Ctrl+Alt+Shift+X`.
- **Tags**: K (look, keyboard), F (separator colour).

### 4.9 Tooltip

- **Mechanism**: one `TooltipManager` per document, mounted by the root of each entry. It holds a delegated `pointerover` / `focusin` listener on `document` and reads the target's (closest) `data-tooltip`, `data-tooltip-shortcut`, `data-tooltip-placement` (`"bottom" | "top" | "right" | "left"`, default bottom) and `data-tooltip-disabled`. It renders a single node in the portal at `--ds-z-tooltip`. This is the same pattern as Figma's `data-tooltip` attributes.
- **Look**:
  - bg `--ds-color-menu-bg`, text `--ds-color-menu-text`, `body-medium`;
  - padding 4 8, radius 5, shadow `--ds-elevation-menu`;
  - max-width 240, at most two lines with ellipsis;
  - shortcut after the label: 8 gap, `--ds-color-menu-text-secondary`;
  - no beak.
- **Placement**:
  - 6px from the target (K), flipped or shifted to stay 8px inside the view;
  - rail: right;
  - toolbar: top;
  - section/header icon columns: aligned to the button's right edge (K `.f-icons`).
- **Timing**: shows after 500ms. A warm window lets the next tooltip within 300ms show immediately. It hides on pointerleave, pointerdown, keydown, wheel and blur. It never shows while a mouse button is down or a menu is open.
- **Keyboard**: focus-visible on a target shows it after the same delay; Esc hides it.
- **Tags**: K / G.

### 4.10 Checkbox

- **Anatomy**: `[box 16] label (body-medium, 8 gap)`. The row is 24 high (inside a 32 property row).
- **Props**: `{ label: string; checked: Mixed<boolean>; onChange: (c: boolean) => void; disabled?: boolean; hideLabel?: boolean }`.
- **States**:

| State | Box |
|---|---|
| unchecked | radius 5, transparent, inset 1px `--ds-color-border-translucent-strong` |
| hover (unchecked) | ghost check at 25% `--figma-color-icon` |
| checked | bg-brand, inset 1px border-selected-strong, `16.check` in icon-onbrand |
| mixed | bg-brand, 8×1.5 dash in icon-onbrand (`aria-checked="mixed"`) |
| disabled | bg-disabled, no border; checked check in icon-disabled |
| focus-visible | outline, offset 1 |

- **Keyboard**: Space toggles; clicking the label toggles. Mixed → checked.
- **Tags**: F / M (16).

### 4.11 Switch

- **Props**: `{ label: string; checked: boolean; onChange: (c: boolean) => void; disabled?: boolean }`, `role="switch"`.
- **Look**:
  - track 28×16, radius full;
  - off: bg `--figma-color-bg-tertiary`, 1px border `--figma-color-icon-tertiary`; hover bg `--ds-color-switch-hover`;
  - on: bg and border bg-brand;
  - knob: 14×10 oval, white, 1px border icon-tertiary (white when on), left 2 (off) / 10 (on);
  - the knob and colours move over `--ds-duration-fast`.
- **States**: disabled is 0.4 opacity; focus-visible shows the outline.
- **Keyboard**: Space/Enter toggles.
- **Tags**: K.

### 4.12 Radio / RadioGroup

- **Props**: `RadioGroup { label: string; value: Mixed<string>; options: { value: string; label: string; disabled?: boolean }[]; onChange; orientation?: "vertical" | "horizontal" }`.
- **Look**:
  - 16 circle, bg-secondary, inset 1px `--ds-color-border-translucent`;
  - checked: bg-brand, inset border-selected-strong, a white dot of 6;
  - hover (unchecked): dot at 25% icon;
  - disabled: transparent, icon-disabled.
- **Keyboard**: arrows move and select (roving tabindex); Tab enters at the checked option.
- **Tags**: F.

### 4.13 SegmentedControl

- **Props**: `{ label: string; value: Mixed<string>; options: { value: string; label?: string; icon?: IconName; tooltip?: string; shortcut?: string }[]; onChange; tone?: "panel" | "toolbar"; fullWidth?: boolean }`.
- **Look**:
  - container height 24, radius 5, **no padding**, bg `--figma-color-bg-secondary` (`toolbar` tone: `--figma-color-bg-tertiary`);
  - segments: icon-only 24 wide (or equal width when `fullWidth`), text segments padding 0 8;
  - text and icons in `--figma-color-text-secondary` / `--figma-color-icon-secondary`;
  - the **selected** segment fills the full 24px: bg `--figma-color-bg`, inset 1px `--figma-color-border`, radius 5, text and icon primary;
  - hover on an unselected segment makes its icon or text primary;
  - mixed: no segment selected.
- **Keyboard**: `role="radiogroup"`; ←/→ move and select (automatic activation); Tab enters at the selected segment.
- **Tags**: M.

### 4.14 Tabs (Design / Prototype, Custom / Libraries, File / Assets)

- **Props**: `{ label: string; value: string; tabs: { value: string; label: string; badge?: number }[]; onChange }`.
- **Look**: each tab is height 24, padding 0 8, radius 5, gap 0, `body-medium`.
  - Active: `body-medium-strong`, text primary, bg `--figma-color-bg-secondary`.
  - Inactive: text-secondary; hover → text primary.
- **Keyboard**: `role="tablist"`; ←/→ move and activate; Home/End.
- **Tags**: K.

### 4.15 PanelSection

- **Anatomy**: header 40 (padding-left 16, padding-right 8), then the title, then the action IconButtons at the right (24 each, gap 0), then the content, then a 1px `--figma-color-border` bottom line. Content padding-bottom is 8 (12 for `pad="large"`).
- **Props**: `{ title: string; actions?: ReactNode; empty?: boolean; collapsible?: boolean; open?: boolean; onOpenChange?: (o: boolean) => void; pad?: "none" | "default" | "large"; children? }`.
- **Title**: `body-medium-strong`, text primary. When `empty` (no fills, strokes, effects…), the title is `body-medium` in text-secondary and only the "+" action shows (M: no Styles icon on empty Stroke/Effects).
- **Collapsible** (Pages): a `16.chevron.down` in icon-secondary before the title, rotated −90° when closed (`--ds-duration-fast`). Clicking the header toggles; Alt-click is passed to `onOpenChange`.
- **Keyboard**: the header is a button (`aria-expanded`), Enter/Space.
- **Tags**: M / K.

### 4.16 PropertyGrid / PropertyRow

- **PropertyGrid** (CSS grid): `grid-template-columns: minmax(88px, 1fr) minmax(88px, 1fr) 24px; column-gap: 8px; padding: 0 8px 0 16px;`. At 240 that is exactly 88 / 88 / 24 (M). Wider panels grow the two field columns.
- **PropertyRow**: `{ children; span?: 1 | 2 /* 2 = one field over both columns: 184 at 240 */; action?: ReactNode /* the 24 column */; label?: string }`. The row is min-height 32 (field 24 + 4 top/bottom).
- **Property labels** (Figma's zoom-menu option "Property labels"): when enabled by the editor (`<PropertyGrid labels>`), each row shows its label above the fields in `body-medium` text-secondary, 16 high with 4 gap.
- **Section header alignment**: header text sits at x+16, the same column as the fields (M: "remove the header button's extra padding").
- **Tags**: M.

### 4.17 LayerRow

- **Anatomy** (live capture `docs/research/figma/live/left/layers-row-*.txt`; pitch `--ds-size-layer-row` 32):
  - `| 8 inset | highlight box 24 high, 4 above and below (radius 5) |`, and inside the highlight:
  - `4 pad, depth × 24 indent (--ds-size-layer-indent), chevron cell 16 (empty for leaves; always drawn, live), type glyph 16 + 8 gap, name (flex, ellipsis), [lock 24][eye 24] flush right |`, then the 8 inset.
  - At depth 0 the glyph is at 28 and the name at 52 from the panel edge; each level adds 24 (live: 28 / 52, then 52 / 76). Lock at 184, eye at 208.
  - A run of highlighted rows (selection, selected ancestors) fills the pitch: one block, top corners on the first row, bottom corners on the last.
- **Props**:
  ```ts
  {
    id: string;
    depth: number;
    name: string;
    icon: IconName;
    kind: "default" | "component" | "instance";
    expanded?: boolean;                 // undefined = leaf
    selected?: boolean;
    selectedAncestor?: boolean;
    hovered?: boolean;                  // canvas-driven hover
    locked?: boolean;
    hidden?: boolean;
    strong?: boolean;                   // top-level frame/section/component names
    renaming?: boolean;
    onToggleExpand(alt: boolean);
    onToggleLock();
    onToggleVisible();
    onRename(name: string | null);
    onPointerDown(e);
    onDoubleClick(e);
  }
  ```
- **Text**: `body-medium-regular` (11 / 400, live), text primary. The glyph is `--figma-color-icon-secondary`, primary on a selected row.
  - component/instance and every layer inside one: name `--figma-color-text-component`, icon `--figma-color-icon-component` (live #d1a8ff); a selected component row keeps the blue selection;
  - hidden: text and icon `--figma-color-text-tertiary` (component colours at 0.5 opacity).
- **States**:

| State | Appearance |
|---|---|
| hover | highlight bg `--figma-color-bg-hover`; lock/eye cells appear |
| selected | bg `--figma-color-bg-selected` (dark #394360, M) |
| selected ancestor (children of a selected row) | bg `--figma-color-bg-selected-secondary` |
| locked | lock icon always visible |
| hidden | eye-closed icon always visible |
| renaming | the name becomes a ghost TextInput, 24 high, with the text selected |
| drop indicators (drag) | before/after: 2px line in border-selected spanning the name column; inside: 1px border-selected ring on the highlight |

  **Contiguous selected rows** merge into one block: only the first row gets top corners and only the last gets bottom corners (`data-run="start|middle|end|single"`, computed by the list).
- **Keyboard** (row level): a double-click on the name starts rename (live: not on empty row space). In rename: Enter commits; Esc cancels; Tab commits and renames the next row (Figma); Shift+Tab the previous. Enter / ⇧Enter after a row click act as on the canvas (live: the row takes no key focus of its own). Panel-level navigation and selection belong to the editor (R7).
- **Virtualisation**: the fixed 32 pitch is mandatory, because the Layers panel uses `ds/components/VirtualList.tsx` (fixed row height, overscan 8).
- **Tags**: M (live: pitch 32, highlight 24 inset 8 / 4, radius 5, #394360 / children #32394d, indent 24, 11 / 400), K (tree behaviour).

### 4.18 PageRow

- **Anatomy**: pitch 32, a highlight of 24 inset 4 vertical and 8 horizontal, radius 5. Inside: padding-left 8 (16 from the panel edge) and the name in `body-medium`. A trailing 24 slot holds a "check" for the current page only in the page *menu*, not in this list.
- **Props**: `{ id; name: string; current: boolean; renaming?: boolean; divider?: boolean /* names made of dashes render as a 1px --figma-color-border line */; onRename; onSelect; onContextMenu }`.
- **States**: current is bg `--figma-color-bg-secondary` (M #373737); hover is bg `--figma-color-bg-hover`. Double-click renames (as LayerRow).
- **Tags**: M.

### 4.19 ResizeHandle

- **Anatomy**: an invisible 8px hit area centred on a panel's 1px border, cursor `col-resize`, at `--ds-z-resize`.
- **Props**: `{ side: "left" | "right"; value: number; min?: number /* default 240 */; max?: number /* default 480 */; defaultValue?: number /* default 240 */; onChange: (px: number, info: ChangeInfo) => void }`.
- **Behaviour**: drag with pointer capture (cursor forced globally); double-click resets to `defaultValue`. There is no visual change on hover (G).
- **Keyboard**: none (Figma).
- **Tags**: G.

### 4.20 Dialog (modal)

- **Anatomy**: scrim `--ds-color-scrim`, then a panel:
  - bg `--figma-color-bg`, radius 13, shadow `--ds-elevation-500-modal-window`;
  - header 48: padding-left 16, title `body-large-strong`, close IconButton 24 at padding-right 8, 1px bottom border;
  - body padding 16;
  - footer padding 16, 1px top border, buttons right-aligned, gap 8, `size="large"`.
- **Props**: `{ title: string; size?: "small" | "medium" | "large" /* 320 | 480 | 640 */; open: boolean; onClose: () => void; footer?: ReactNode; initialFocus?: RefObject<HTMLElement>; closeOnScrim?: boolean /* default true */; static?: boolean }`.
- **Behaviour**:
  - focus trap; initial focus goes to `initialFocus`, else the primary button, else the first field;
  - focus is restored on close;
  - Esc closes;
  - Enter activates the primary button (unless focus is in a TextArea or a menu);
  - centred, `max-height: calc(100vh - 64px)`, body scrolls;
  - no open animation.
- **Uses**: confirm dialogs (Delete, Discard), Libraries, Share/Preview links, Version history, Preferences.
- **Tags**: F (radius, shadow), G (header 48, sizes).

### 4.21 Popover / FloatingPanel

- **Popover**: bg `--figma-color-bg`, radius 13, shadow `--ds-elevation-400-menu-panel`, width 240 (prop), at `--ds-z-popover`.
- **Props**: `{ anchor: DOMRect | HTMLElement; placement?: "left-of-panel" | "bottom-start" | "bottom" | "top" | "right"; title?: string; headerActions?: ReactNode; onClose: () => void; draggable?: boolean /* default true when titled */; width?: number; static?: boolean; children }`.
- **FloatingPanel** = Popover with a header: 40 high, padding-left 16, title `body-medium-strong`, actions, then close; 1px bottom border. The header is draggable; after a drag, the panel stays where it was dropped until closed.
- **Placement `left-of-panel`** (the default for property popovers): x = right panel's left − width − 8, y = the anchor row's top, clamped to 8px inside the view.
- **Dismiss**: Esc, an outside pointerdown that is not inside another overlay of the same chain, or the anchor unmounting.
- **Focus**: moves to the first field; it is not trapped (Figma lets you click the canvas).
- **Uses**: ColorPicker, effect/stroke/grid settings, style and variable editors, instance swap.
- **Tags**: K / F.

### 4.22 Toast (visual bell)

- **API**: `showToast({ message: string; kind?: "default" | "error" | "success"; action?: { label: string; onAction: () => void }; duration?: number }): id`, plus `dismissToast(id)`. `<ToastHost/>` is mounted once per document.
- **Look**:
  - bottom-centre of the view, 68 from the bottom (above the toolbar: 12 + 48 + 8), `data-theme="dark"`;
  - bg `--ds-color-menu-bg` (`error`: `--figma-color-bg-danger`), text `body-medium` white;
  - height 40, padding 0 8 0 16, radius 9, shadow `--ds-elevation-menu`;
  - optional action as a ghost Button (dark scope), then a close IconButton 24;
  - `success` adds a leading `24.check` in `--figma-color-icon-success`.
- **Behaviour**: one visible at a time; a new toast replaces the current one. Durations follow 1.12 and pause on hover. It enters and exits over `--ds-duration-medium`. `aria-live="polite"`.
- **Tags**: K / G.

### 4.23 TabBar and Tab (lives in the tab bar WebContentsView)

- **Bar**:
  - height 38 including a 1px `--ds-color-tabbar-line` bottom line, bg `--ds-color-tabbar-bg`;
  - padding-left 80 for the traffic lights (8 in full screen, from `window.designer.onFullScreen`); the traffic lights are vertically centred on the 37px content box;
  - the free space is `.ds-drag`;
  - right edge: a `trailing` slot, 40 wide, for the shell's icon button.
- **Home tab**: 40 wide, `24.home` centred (a glyph to export, Open questions 10).
  - Active: bg `--figma-color-bg`, icon `--figma-color-icon`.
  - Inactive: icon `--ds-color-tabbar-text`; hover bg `--ds-color-tabbar-hover`.
- **File tab**:
  - padding-left 12, glyph 16 (design file), 8 gap, title (`body-medium`, ellipsis), 8 gap, close slot 24, padding-right 8. Width = text + 76, clamped 72–240; tabs shrink evenly when they overflow.
  - Active: bg `--figma-color-bg`, text `--figma-color-text`, glyph `--figma-color-text-brand` (M #7cc4f8).
  - Inactive: text and glyph `--ds-color-tabbar-text`; hover bg `--ds-color-tabbar-hover` and text primary.
  - **Separators**: a full-height 1px `--ds-color-tabbar-separator` after every tab, **including** both sides of the active tab (M).
- **Close slot**: a 16 glyph `24.close.small` in a 24 box, radius 5, hover bg `--ds-color-bg-transparent-pressed`. It is always visible on the active tab and on hover for the others. While the file has unsaved changes, the slot shows an 8px dot in `currentColor` at 0.7 opacity; the dot swaps to the close button on hover.
- **Props**:
  ```ts
  TabBar {
    tabs: { id: string; title: string; dirty?: boolean; kind: "design" }[];
    active: string;                                   // "home" | id
    onActivate(id); onClose(id); onMove(id, toIndex);
    onContextMenu(id, at: { x, y });                  // the shell shows a native menu
    trailing?: ReactNode;
    fullScreen: boolean;
  }
  ```
- **Behaviour**:
  - drag to reorder (4px threshold; the dragged tab follows the pointer with `--ds-elevation-200` and the others shift; drop index by midpoints; port from `app/TabBar.tsx`);
  - middle-click closes;
  - double-clicking the free space is the shell's (macOS zoom);
  - tab titles use the native `title` attribute only when truncated (no DOM tooltips can leave a 38px view).
- **Keyboard**: `role="tablist"`. ⌘1–⌘9, ⌃Tab and ⌃⇧Tab come from the app menu (shell).
- **Tags**: M.

### 4.24 Toolbar and ToolButton (bottom, floating, editor document)

- **Toolbar**:
  - height 48, radius 13, bg `--figma-color-bg`, shadow `--ds-elevation-100`, padding 8, gap 8 between groups (K);
  - centred on the **window** (the editor passes the window's centre offset), 12 from the bottom, at `--ds-z-floating`;
  - content: Move, Frame, Shape, Pen, Text, Comment, Actions, then a divider, then the mode SegmentedControl (`tone="toolbar"`);
  - width = content (M: 530 for the standard set).
- **ToolButton**: `{ icon: IconName; label: string; shortcut?: string; active: boolean; menu?: MenuEntry[]; onSelect(); onMenuSelect?(id) }`.
  - Tool: 32×32, radius 5. Active: bg `--figma-color-bg-brand`, icon `--figma-color-icon-onbrand`. Hover (inactive): bg `--figma-color-bg-hover`.
  - With `menu`: a 16×32 chevron button (`16.chevron.down`) right after the tool, which opens a Menu **above** it (placement top).
  - Tooltip on top: "Move" with shortcut "V".
- **Divider**: 1×24 `--figma-color-border`, 4px margin each side.
- **Help button**: a separate IconButton (`24.help`, a glyph to export, Open questions 10), 32 circle, bg `--figma-color-bg`, shadow `--ds-elevation-100`, 12 from the bottom and right of the canvas area.
- **Keyboard**: tools are buttons (Tab order within the toolbar); the tool shortcuts belong to the editor.
- **Tags**: M / K.

### 4.25 Rail (left navigation, editor document)

Figma 2026's navigation bar (live capture `docs/research/figma/live/left/rail-*.txt`).

- **Rail**: `--ds-size-rail` 56 wide + a 1px `--figma-color-border` line (the left panel then starts at 57), bg `--figma-color-bg`.
  - Top: the Figma menu, a 32×32 tile at 12, 8 (the app mark, no chevron), which opens the main Menu (Back to files, Actions… ⌘K, File … Vector, Plugins, Widgets, Preferences, Libraries, Help and account).
  - Then the tabs **File, Agents, Assets, Tools** at y 56 / 112 / 168 / 224, a separator (a 24 line, 16 of room), **Variables** at 296; each tab is 56×56: the 32 tile at 12, 4 and its label (9px / 450) under it.
  - At the bottom: the file's notifications (missing fonts, library updates).
  - View › Additional labels off: no labels, a tab is its tile and 8 around it.
- **RailItem**: `{ icon: IconName; label: string; shortcut?: string; active: boolean; onClick }`. Tile 32×32, radius 5. Active (`aria-current`): bg `--figma-color-bg-selected` (live #394360), icon `--figma-color-icon-brand`. Hover: bg `--figma-color-bg-hover`. Tooltip to the right.
- **Behaviour**: File shows Pages and Layers; Agents, Assets and Tools replace them with a 48 tab header (title 13 / 550 at 16) and their own content; Variables toggles the full-window variables view. ⌥1 Layers, ⌥2 Assets (live View › Panels).
- **Keyboard**: buttons; ↑/↓ roving focus inside the rail.
- **Tags**: M (live positions and sizes).

### 4.26 SidebarItem (Home)

- **Anatomy**: pitch 32, highlight 28 (2 inset vertically, 8 horizontally), radius 5, padding 0 8. Content: icon 24 cell, 4 gap, label `body-large` (13/22), optional trailing count (`body-medium` text-secondary) or action.
- **Props**: `{ icon: IconName; label: string; selected?: boolean; count?: number; indent?: number /* 16 per level, for projects under a team */; trailing?: ReactNode; onClick; onContextMenu?; dropTarget?: boolean }`.
- **States**:
  - selected: bg `--figma-color-bg-selected`, text and icon primary (G: Figma's selected nav colour unverified);
  - hover: bg `--figma-color-bg-hover`;
  - drop target (dragging files): 1px border-selected ring.
- **Sidebar section header** ("Starred", "Projects"): 32 high, padding-left 16, `body-medium-strong` text-secondary, optional "+" IconButton.
- **Tags**: M / G.

### 4.27 FileCard (Home)

- **Anatomy**: 268 × 213, radius 9, 1px `--figma-color-border`.
  - Thumbnail: 268 × 151 (16:9), bg `--figma-color-bg-secondary`, image `object-fit: cover`, top corners clipped.
  - Footer: 62 high, padding 12 16, with the title `body-large-strong` (ellipsis) and "Edited 2 hours ago" in `body-medium` text-secondary. A leading file glyph 16 in `--ds-color-file-design` sits beside the title.
- **Props**: `{ id; title: string; subtitle: string; thumbnail?: string /* URL */; starred?: boolean; selected?: boolean; renaming?: boolean; onOpen(); onSelect(e); onContextMenu(e); onRename(name | null) }`.
- **States**:

| State | Appearance |
|---|---|
| hover | border `--ds-color-card-border-hover`; a star toggle appears at the thumbnail's top-right (24 IconButton) |
| selected | 2px `--figma-color-border-selected` ring (inset 0 0 0 2px) |
| focus-visible | outline |
| renaming | the title becomes a TextInput |

- **Keyboard**: Enter opens; Space selects; ⌫ moves to Trash (Home's); F2/Enter-hold renames (Home's).
- **Grid** (Home screen CSS): `grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 36px;`, first row 67 below the top bar (M). **FileRow** (list view) is 40 high with the same data.
- **Tags**: M (size, gap, offsets), G (footer split, hover).
- **Decision (2026-10-06, file browser pieces)**: the grid uses fixed 268 columns (`repeat(auto-fill, 268px)`, gap 36), not `minmax(240px, 1fr)`, because the card is fixed-width and the measured gap is 36. Added, all G: `FolderCard` (the FileCard frame; up to four of its files 2×2, or the folder glyph in the folder's colour), `ListHeader` / `ListRow` (list view: shared grid columns, 32 header with sortable buttons and `aria-sort`, 40 rows), `CollectionView` (arrow navigation by layout, ⌘A / Esc / ⌫, marquee on empty space; selection stays the caller's via `useSelection`), `Breadcrumb`, `InlineEdit` (rename in the text's own font), `Banner`, `Skeleton` (flat, no shimmer: the chrome doesn't move).

### 4.28 SearchField

- **Anatomy**: `[24.search.small cell 24] input [clear IconButton 24, only when there is text]`.
- **Props**: `{ value: string; onChange: (v: string) => void; placeholder?: string /* "Search" */; size?: ControlSize /* 24 in panels, 32 on Home */; autoFocus?: boolean; onSubmit?: () => void; onExit?: (r: ExitReason) => void }`.
- **Look**: as TextInput filled.
- **Keyboard**: Esc clears; a second Esc (empty field) blurs (`onExit("escape")`). Enter calls `onSubmit`. ↓ is passed to `onExit("tab")` so lists can take focus.
- **Tags**: K.

### 4.29 Badge

- **Props**: `{ tone?: "default" | "brand" | "component" | "danger" | "warning" | "success"; children }`.
- **Look**: height 16, padding 0 4, radius 5, `body-medium` (count badges use `body-small`).
  - default: bg-secondary / text-secondary;
  - brand: bg-brand-tertiary / text-brand;
  - component: bg-component-tertiary / text-component;
  - danger, warning, success: `bg-*-tertiary` / `text-*`.
- **Uses**: library update counts, "Draft"/"Free", "Local".
- **Tags**: G.

### 4.30 Avatar

- **Props**: `{ name: string; src?: string; size?: 16 | 24 | 32 }`.
- **Look**: a circle. Without an image: initials (1 letter at 16, 2 at 24 and 32) in `body-medium-strong` white on `--figma-color-bg-brand`. With an image: a 1px inset `--ds-color-border-translucent` ring.
- **Uses**: the right-panel header (24, the single local user), the Home account row (24), the viewer (24).
- **Tags**: G.

### 4.31 Spinner

- **Props**: `{ size?: 16 | 24 | 32; tone?: "default" | "onbrand" }`.
- **Look**: an SVG ring, 2px stroke (1.5 at 16). The track is 25% of currentColor and a 90° arc rotates every 800ms (linear; spins even under reduced motion, which halves the speed). Colour: icon-secondary, or onbrand white.
- **Tags**: G.

### 4.32 EmptyState

- **Props**: `{ icon?: IconName; title: string; body?: string; action?: { label: string; onClick: () => void }; size?: "panel" | "page" }`.
- **Look**: centred, max-width 280. The icon is 24 in a 48 circle on bg-secondary.
  - `panel`: title `body-medium-strong`, body `body-medium` text-secondary.
  - `page`: title `heading-medium`, body `body-large`.
  - Action: a secondary Button, 12 above it.
- **Tags**: G.

### 4.33 ScrollArea

Port `components/ScrollArea.tsx`.

- **Props**: `{ axis?: "y" | "x" | "both"; children; className?; onScroll?; viewportRef? }`.
- **Behaviour**: native scrolling in a viewport with the native scrollbar hidden, so momentum and keyboard scrolling stay native. Custom overlay thumbs:
  - hit area 8, thumb 4 wide (6 while hovered or dragged), radius full;
  - `--ds-color-scrollbar-thumb` (hover/drag: `-hover`);
  - visible while the pointer is over the area, while scrolling and for 1000ms after;
  - dragging the thumb scrolls; clicking the track pages.
- **Tags**: K / F.

### 4.34 Divider, Kbd, CodeBlock, VirtualList, Icon (support pieces)

- **Divider**: `{ orientation?: "horizontal" | "vertical"; inset?: number }`, 1px `--figma-color-border`.
- **Kbd**: an inline shortcut, `body-medium` text-secondary, tabular-nums, formatted by `keys()`.
- **CodeBlock** (Dev-Mode-like inspect in the viewer and editor): `code` font, bg-secondary, radius 5, padding 8, and a copy IconButton at the top-right that shows "Copied" via Toast.
- **VirtualList**: `{ count: number; rowHeight: number; overscan?: number; renderRow: (index: number) => ReactNode; scrollToIndex?: number }`, built on ScrollArea.
- **Icon**: `{ name: IconName; className? }` renders an inline SVG with box = the name's prefix (16 or 24), `aria-hidden`.

### 4.35 What to port, what to delete

| Existing | Becomes | Notes |
|---|---|---|
| `figma/ui.tsx` NumericInput, `evaluate`, `selectAllOnClick` | `ds/components/NumericInput.tsx`, `ds/util/evaluate.ts`, `ds/util/selectAll.ts` | Move `figma/__tests__/evaluate.test.ts` to `ds/__tests__/`. Rewrite scrub (rate, capture, final/cancel). |
| `figma/ui.tsx` TextInput, ColorInput, Chit, Checkbox, Switch, Tab, Section, PropRow, CollapseHeader, IconButton, BrandButton | TextInput, ColorInput, Swatch, Checkbox, Switch, Tabs, PanelSection, PropertyRow, Button | Restyle to tokens; drop Tailwind strings. |
| `figma/ui.tsx` Select (native `<select>`), ChevronMenu | Select (Menu-based), MenuButton | |
| `figma/ui.tsx` `EDITOR_CSS` | TooltipManager, `Switch.module.css`, global no-transition rule | Delete `EDITOR_CSS`, `icon24` and `icon16`. |
| `components/admin/ContextMenu.tsx` | `ds/components/Menu.tsx`, `ds/util/keys.ts` | Keyboard and submenus kept; colours tokenised; serialisable ids; typeahead, hover intent, native renderer; modifier order fixed. |
| `components/admin/figmaKitIcons.ts` (121) + `figmaIcons.tsx` (84) | `ds/icons/svg/{16,24}/*.svg` + generated `ds/icons/registry.ts` + `Icon.tsx` | One-time `node scripts/gen-icons.ts --import-legacy`. KIT wins on duplicates; shadowed/duplicate entries (`16.page`, `16.image`, `chevron.right`, `library`) are dropped; names are normalised to `<box>.<name>`. |
| `figma/ColorPicker.tsx` | `ds/components/ColorPicker.tsx` + `ds/util/color.ts` | Drop site Libraries / alt text; Libraries becomes a slot. |
| `figma/popover.tsx` `usePopover` | `ds/overlay/useAnchoredPosition.ts` (+ `useDismiss.ts`) | Delete `VariablePicker` (site variables, `tr` collation). |
| `figma/chrome.tsx` Tool, NavTab, ModeTab | ToolButton, RailItem, SegmentedControl | Delete SaveButton, SaveProblem, PublishButton, AccountButton and ZoomPercent (the editor rebuilds zoom with Select). |
| `figma/Inspector.tsx` local Segmented, PropertyWindow / WindowRow, Label / Labels | SegmentedControl, FloatingPanel, PropertyGrid labels | |
| `figma/Layers.tsx` row markup | LayerRow (+ VirtualList) | Tree logic stays in the editor. |
| `app/TabBar.tsx` | `ds/components/TabBar.tsx` | Drag logic kept; DesignGlyph and CvGlyph deleted. |
| `home/Sidebar.tsx` NavItem + search, `home/FileCard.tsx` | SidebarItem, SearchField, FileCard | Drop SiteStatus, the "burakkoc.net" covers and Live/Changed. |
| `components/ScrollArea.tsx` | `ds/components/ScrollArea.tsx` | Drop the site token `--border-hover`. |
| `context/ThemeContext.tsx` | `ds/theme.ts` | |
| `figma/tokens.ts`, `main.tsx` token injection, `styles/app.css` | `ds/tokens.ts` → `tokens.css`, `ds/global.css` | Delete `--f-*`, the site aliases (`--bg-1..5`, `--border`, `--border-hover`, `--text-title/p/subtitle`), `--edit-*`, `--tabbar-*` and `--home-*`. The Prism and page-entrance CSS goes with the site code. |
| **Delete outright** | – | `components/Button.tsx`, `Input.tsx`, `Select.tsx`, `Segmented.tsx`, `icons.tsx` (site pill controls); `app/ui.tsx` (duplicate Button / IconButton / TextField / Modal / Spinner); `app/icons.tsx` (once its glyphs exist in the registry); the second spinner. Every hard-coded chrome colour listed in `docs/research/code/look.md` §2 "Not tokens at all" moves to a token. |

Site-only modules (PageEntrance, ScrollReveal, TextScrollingEffect, Footer, CodeHighlight, Zoomable\*, demos, JsonEditor, CV) are not the DS's to port. They disappear with the site code.

---

## 5. File layout, Gallery, visual verification

### 5.1 Files

```
src/renderer/src/ds/
  tokens.ts              # the one source (2.1) — pure, no imports
  tokensCss.ts           # renderTokensCss(), renderBootJs(), renderChromeHeader() — pure
  tokens.css             # GENERATED (npm run tokens)
  global.css             # layer order, Inter, tokens.css, reset, base (3)
  theme.ts               # 2.3
  types.ts               # MIXED, Mixed<T>, ChangeInfo, ExitReason, ControlSize
  strings.ts             # DS-owned English strings
  index.ts               # public exports (components, Icon, theme, types, keys, showToast)
  icons/
    svg/16/*.svg, svg/24/*.svg   # sources (kit exports + owner glyphs)
    registry.ts          # GENERATED (npm run icons): IconName union + path data + tones
    Icon.tsx
  components/            # one .tsx + .module.css per component in section 4
    Button.tsx Button.module.css  IconButton…  ToggleIconButton…  TextInput… (TextArea)  NumericInput…
    ColorInput… Swatch… ColorPicker…  Select…  Menu… (ContextMenu, MenuButton)  Checkbox…  Switch…  Radio…
    SegmentedControl…  Tabs…  PanelSection…  PropertyGrid… (PropertyRow)  LayerRow…  PageRow…  ResizeHandle…
    Dialog…  Popover… (FloatingPanel)  Toast… (ToastHost, showToast)  TabBar…  Toolbar… (ToolButton)  Rail… (RailItem)
    SidebarItem…  FileCard… (FileRow)  SearchField…  Badge…  Avatar…  Spinner…  EmptyState…  ScrollArea…
    Divider…  Kbd…  CodeBlock…  VirtualList…
  overlay/
    Portal.tsx  useAnchoredPosition.ts  useDismiss.ts  FocusTrap.tsx  TooltipManager.tsx
  util/
    evaluate.ts  keys.ts  color.ts  selectAll.ts  scrub.ts  typeahead.ts  rovingFocus.ts
  Gallery.tsx            # the Gallery root
  gallery/
    main.tsx  TokensSection.tsx  IconsSection.tsx  ComponentMatrix.tsx  Screens.tsx  ReferenceOverlay.tsx
  __tests__/
    tokens.test.ts  no-raw-values.test.ts  evaluate.test.ts  keys.test.ts  NumericInput.test.tsx  Menu.test.tsx  Select.test.tsx
src/renderer/gallery.html          # <html data-surface="app">, loads boot.js then ds/gallery/main.tsx
src/renderer/public/boot.js        # GENERATED
scripts/gen-tokens.ts  scripts/gen-icons.ts  scripts/gallery-shots.mjs  scripts/check-tailwind.mjs
engine/src/overlay/ChromePalette.generated.h   # GENERATED (path per engine contract)
```

**package.json additions**:
- scripts:
  - `"tokens": "node scripts/gen-tokens.ts"`
  - `"icons": "node scripts/gen-icons.ts"`
  - `"gallery": "DESIGNER_GALLERY=1 electron-vite dev"`
  - `"gallery:shots": "node scripts/gallery-shots.mjs"`
- devDependencies: `happy-dom` and `@testing-library/react` (component tests), `pngjs` and `pixelmatch` (Gallery diffs).

**Build wiring**:
- Vitest gets `environment: "happy-dom"` for `ds/__tests__/*.test.tsx` only.
- electron-vite's renderer `build.rollupOptions.input` adds `gallery: "src/renderer/gallery.html"` next to the shell's own entries. `vite.web.config.ts` serves it at `http://localhost:5199/gallery.html`.

### 5.2 Gallery (`ds/Gallery.tsx`)

**Opening it.**
- `npm run gallery` (or any build run with `DESIGNER_GALLERY=1|light|dark`): main opens **only** a 1512 × 945 `BrowserWindow` on `gallery.html`, so Playwright's first window is the Gallery.
- In dev builds: Help ▸ Developer ▸ Open Design System Gallery.
- On the web: `/gallery.html`.

**URL parameters.** `?theme=both|light|dark` (default both), `&section=<id>`, `&component=<Name>`, `&static=1` (no tooltip timers, no animations, carets hidden; used for screenshots).

**Top bar** (built from DS components):
- a theme SegmentedControl (Both / Light / Dark);
- a section Select;
- a SearchField filtering components;
- a zoom Select (100% / 200%);
- "Reference…" (5.3).

**Layout.** With `theme=both`, each section renders twice side by side: the left column in `<div data-theme="light">` and the right in `<div data-theme="dark">`. Each column's background is `--figma-color-bg`.

**Sections**:
1. **Tokens.**
   - Every `--figma-color-*` and `--ds-color-*` as a swatch with name and hex, resolved through `getComputedStyle` so the CSS is what gets checked.
   - The canvas chrome palette from `chromePalette()`.
   - A specimen of every type style: "Frame 1" / "The quick brown fox" plus the metrics.
   - The spacing scale bars, radii samples, elevation cards, z-index table and motion demos (switch, chevron).
2. **Icons.** Every registry icon at its box size in `--figma-color-icon` and `--figma-color-icon-secondary`, with its name; a duplicate/missing report from `gen-icons`.
3. **Components.** One matrix per component. The rows are variants × sizes. The columns are the states each supports, out of: default, hover, pressed, focus-visible, disabled, selected/on, mixed, open, error. States are forced with the `data-*` attributes from 4.0. Overlays render with `static`. Every cell has `data-gallery-id="<Component>/<variant>/<size>/<state>"`.
4. **Screens.** Static compositions sized like the owner's references (1512 × 945 CSS px):
   - **Editor**: tab bar (two tabs, one dirty), rail, left panel (header, Pages with 3 pages, Layers with nested frames, a component, an instance, a hidden and a locked layer, a multi-row selection), right panel (header 80, Frame section with W/H/X/Y grid, Auto layout, Appearance, Fill with 2 paints, Stroke empty, Effects empty, Export), canvas stand-in in `--ds-color-canvas-default`, toolbar, help button.
   - **Home**: top bar, sidebar, filter row, 8 cards.
   - **Open menus**: a context menu with a submenu, a Select list.
   - **Open overlays**: a Dialog, the ColorPicker, a Toast, tooltips.

   Each screen has `data-gallery-id="screen/<name>"`.

### 5.3 Visual verification

1. **Reference overlay** (`gallery/ReferenceOverlay.tsx`): drop or open a PNG from Figma for a screen.
   - It is drawn over the screen at scale `1 / 1.3228` (editable; for the owner's screenshots) with opacity 50% (slider) and blend Normal / Difference.
   - The arrow keys nudge it 1px (Shift 10px).
   - The setting is kept per screen in localStorage.
   - Acceptance: in Difference mode, every metric in 1.6 lines up within ±1 px. Colours are checked against the screenshot's sampled pixels (the screenshots are sRGB).
2. **Screenshots with the driver.** `scripts/drive.mjs` gains three commands:
   - `gallery [both|light|dark]` launches with `DESIGNER_GALLERY`;
   - `ss-el <selector> <name>` takes an element screenshot;
   - `theme <system|light|dark>` invokes `theme:set`.

   Example: `npm run build && node scripts/drive.mjs gallery "ss gallery-both" "ss-el [data-gallery-id='screen/editor'] editor" quit`.
3. **Regression.** `npm run gallery:shots -- [--out <dir>] [--baseline <dir>]`:
   - launches the Gallery at `?static=1`;
   - for `theme` in light and dark, it screenshots every `[data-gallery-id]` element to `<out>/<theme>/<id>.png`;
   - with `--baseline`, it diffs with pixelmatch (threshold 0.1), prints the changed ids and pixel counts, and exits 1 on any difference.

   Baselines live outside the repo (in the scratchpad or `~/DesignerV2-gallery-baseline`).
4. **When to run it.** Every DS change: `npm run check` (tokens sync, raw-value test, unit tests), then `gallery:shots` against the previous baseline. Inspect the intended diffs and re-baseline.

---

## 6. Mismatches to fix (from `docs/research/visual-diff.md`)

**Owner**: DS = this system's tokens and components. Editor, Engine and Shell are the other contracts; they consume the DS values named here.

| # | Area | Today | Figma (M) | Fix | Owner | Gallery check |
|---|---|---|---|---|---|---|
| 1 | Canvas selection | `--edit-accent` undefined: white/black outlines, badge without a background | #0c8ce9 1px outline, white handles with a blue border, blue 16px size badge 6 below, blue frame title when selected | `canvasChrome` rows 0–6 and metrics (1.4); there is no CSS variable for canvas chrome any more | Engine (DS palette) | Tokens ▸ chrome palette |
| 2 | Tab bar | 40px, #585858, Home 56, room 78, no lines beside the active tab, close slot 20, padding-right 6 | 38 incl. a #4a4a4a line, #3b3b3b, Home 40, room 80, separators #4f4f4f everywhere, active #2c2c2c, tab = text + 76, active glyph #7cc4f8, right-edge icon | `--ds-size-tabbar`, `--ds-color-tabbar-*`, TabBar (4.23) | DS + Shell | TabBar matrix, screen/editor |
| 3 | Selected layer and page rows | layer #1e1e1e, 28 high, flush right; page #1e1e1e, 32 | layer bg-selected #394360, 24 high, inset 8, radius 5; page bg-secondary #383838, 24 within a 32 pitch | bg-selected family (1.2), LayerRow, PageRow | DS | LayerRow / PageRow |
| 4 | Left rail | items 28 at a 36 pitch, active #4a5878, chevron on the logo, site icons | 32 at a 40 pitch, active #394360 radius 5, no chevron, 16px #404040 separators | Rail (4.25), `--ds-color-rail-separator` | DS + Editor (icon set) | Rail |
| 5 | New frame fill and page colour | black "Arka plan/1" variable; canvas #1e1e1e while the Page field shows F5F5F5 | unbound #FFFFFF fill; canvas drawn in the page colour | not DS: the model default fill, and the engine draws the page colour (`canvasDefault` only for a default page) | Engine / Editor | – |
| 6 | Site-only UI | Published/Update, Language, Narrow screens, Link, Canvas/Page Editor/Code switcher | none; tabs divider at 80 | right-header 80 (1.6); the components are deleted (4.35) | Editor | screen/editor |
| 7 | Left header and section headers | header 56; header text 32 from the edge | header 64 (name 13/550, ink top 19); text 16 from the edge; headers 40 | `--ds-size-panel-header`, PanelSection padding 16 | DS + Editor | PanelSection, screen/editor |
| 8 | Right panel grid | padding-right 12, fields 85.5, header text at x+21 | padding-left 16, padding-right 8, two 88 fields with an 8 gap, a 24 icon column; header text at x+16 | PropertyGrid (4.16) | DS | PropertyGrid |
| 9 | Segmented controls | 2px padding, a 20px raised segment, radius 3 and a shadow; Home toggle inverted | the active segment fills 24: #2c2c2c with a 1px #444 border, container #383838 | SegmentedControl (4.13) | DS | SegmentedControl |
| 10 | Section header icons and wording | Styles icon on empty Stroke/Effects; "Layout grid"; Appearance icons drop, eye | only "+" on empty sections; "Layout guide"; Appearance icons eye, drop | PanelSection `empty` rule; the wording and order are the Editor's | DS + Editor | PanelSection empty |
| 11 | Styles list | grouped folders at a 28 pitch | flat list at a 30 pitch: "Ag" previews + "name · size/lh", round 16 swatches, effect squares | Swatch round 16; row pitch 30 (1.6) | DS + Editor | Swatch |
| 12 | Toolbar | centred on the canvas, 16 from the bottom, no help button | centred on the window, 12 from the bottom; Move/Frame/Shape/Pen/Text/Comment/Actions + a #444 mode group with an active #2c2c2c segment; a 32 "?" circle at the bottom right | Toolbar (4.24), SegmentedControl `tone="toolbar"`, help button | DS + Editor | Toolbar, screen/editor |
| 13 | Rulers | 9px labels right of the tick; ticks 6px #444; dark in the light theme | ~10px labels centred; ticks 4px #7a7a7a; follow the theme | chrome rows 17–21, metrics (1.4); the engine draws the rulers | Engine | Tokens ▸ chrome palette |
| 14 | Frame title on canvas | #bcbcbc, baseline 6.5 above | #898989, baseline ~10 above | chrome rows 7–8, metric `titleBaseline` 10 | Engine | – |
| 15 | Home | 24px heading; 28px dropdowns; Create/View site buttons; cards 278×215 radius 8, 32 gaps, first card 88 below; nav rows 32 with counts | title only in the top bar (13); 24px dropdowns; Design/FigJam/Slides/Make/More pills (#383838, 32); cards 268×213 radius ~10, ~36 gaps, first 67 below; nav highlight 28 at a 32 pitch; bell icon in the account row | Select ghost 24, Button `tinted` large, FileCard, SidebarItem, `--ds-size-card`; the pills offer only file types this app has (Design, plus "Import") | DS + Shell/Home | screen/home |
| 16 | Token values | `--f-text-component` dark #c9a5ff; icon-component #b49ee0 / #9d82cf; grey row selection; `--f-bg-toggle-hover`; tab bar/home colours unsourced | D values; row selection = bg-selected | 1.1–1.3 | DS | Tokens |
| 17 | Hard-coded colours | danger/warning/success, menu #1e1e1e/#0d99ff, tooltip, noodles, file-kind, covers (look.md §2) | tokens | replace with `--figma-color-*` / `--ds-color-*` / chrome palette | DS + consumers | `no-raw-values` test |
| 18 | Three primitive libraries (24/5 editor, 32/6 shell, round site) | – | one UI3 kit | section 4; delete the duplicates (4.35) | DS | – |

---

## 7. Open questions

1. **No light-theme measurements.** Every M value is dark. The light values of the app tokens (tab bar #e6e6e6/#d9d9d9/#cfcfcf/#dcdcdc, rail separator, ruler tick #b3b3b3) are K/G. The owner should supply the same screenshot set in light. Fix any differences in `tokens.ts` only.
2. **Light text-secondary**: D gives #00000080 and F gives #00000099. D is kept; check against a light screenshot.
3. **Scrub rate** in NumericInput: 1 unit per px, Shift ×10, Alt ×0.1 (G; the old code used 4px per unit). Verify by dragging "W" 100px in Figma.
4. **Layer-row pitch**: 24 is inferred from the measured 24px highlight. If Figma's pitch is larger (rows with gaps), change `--ds-size-layer-row` and the VirtualList row height together.
5. **Canvas default colour in dark**: the measurement says the canvas is "#232323". Is that the owner's page colour, or Figma's default page shown in dark? `canvasDefault` is #1e1e1e (K) until checked.
6. **Weights**: is the Share button label 450 or 500 (F uses 500)? Is the menu text 12px (K) or 11px?
7. **Checkbox and Switch shapes**: checkbox checked = brand fill (F) and switch 28×16 (K, while F has 32×16). Check against the instance-properties panel and "Clip content".
8. **Tooltip beak**: F draws one; K and our spec have none. Check one hovered tool in the toolbar.
9. **Home selected nav colour**: blue bg-selected or grey bg-secondary?
10. **Rail icons**: the measured set (page, 4-point star, plus-in-circle, briefcase, hex nut), plus `24.home` (tab bar) and `24.help` (help button), have no kit glyphs in the repo yet. Export them from Figma into `ds/icons/svg/24/`.
11. **Frame-title luminance switch** (chrome rows 7–8) is inferred. Confirm on a light page in the dark theme.
12. **The engine binding name** for `setChromePalette` and the header path are owned by the engine contract. This document fixes only the palette layout and order.
