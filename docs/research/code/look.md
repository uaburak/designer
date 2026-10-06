# Visual layer, tokens, UI primitives, prior art — DesignerV2

Read-only survey of `/Users/burak/Desktop/Burak/Code/DesignerV2` (paths below are relative to `src/renderer/src` unless they start with `src/` or are absolute). Every claim cites file:line.

---

## 1. How the look is put together today

There is **no single design-system package**. The look is assembled from five places that overlap:

| Layer | File | What it holds |
|---|---|---|
| Figma chrome colours (light/dark) | `figma/tokens.ts:4-28` | `FIGMA_TOKENS` — 31 `--f-*` colours + 11 site-named aliases (`--bg-1..5`, `--border`, `--border-hover`, `--text-title/p/subtitle`) + 3 `--edit-*` |
| Shell colours + base CSS | `styles/app.css:11-57` | `--tabbar-*` (5), `--home-*` (9), `--scrollbar-*` (2), `--tabbar-height`, `--font-inter` |
| Editor-only CSS (string) | `figma/ui.tsx:430-464` (`EDITOR_CSS`) | tooltips (`[data-tip]`), the toggle (`[data-switch]`), "instant" no-transition rule, grid-cell and page-scrollbar visibility |
| Editor primitives | `figma/ui.tsx` (464 lines), `figma/chrome.tsx` (122), `figma/popover.tsx` (125), `components/admin/ContextMenu.tsx` (227) | UI3 kit components at 11px / 24px fields |
| Shell primitives | `app/ui.tsx` (142), `app/TabBar.tsx` (165), `app/icons.tsx` (116) | 13px / 32px shell buttons, modal, text field, spinner, tab bar, shell icons |
| Site primitives (not Figma) | `components/Button.tsx`, `Input.tsx`, `Select.tsx`, `Segmented.tsx`, `ScrollArea.tsx`, `icons.tsx` | burakkoc.net's pill-shaped controls (28/32/40/48 px, `rounded-full`) |

### Theming pipeline (light/dark)
1. **Pre-paint**: `public/boot.js:2-10` reads `localStorage["designer-theme"]`, sets `data-theme` and `color-scheme` on `<html>`, and hard-codes the page background (`#2c2c2c` / `#ffffff`, `boot.js:9`). Loaded from `index.html` before the bundle.
2. **Tokens on :root**: `main.tsx:16-20` serialises `FIGMA_TOKENS.light` into `:root{…}` and `.dark` into `[data-theme="dark"]{…}` in a `<style>` prepended to `<head>` — this is what portalled menus read.
3. **Shell tokens**: `app.css:11-34` (`:root`) and `app.css:36-57` (`[data-theme="dark"]`).
4. **Tailwind `dark:`** is rebound to the attribute: `app.css:4` `@custom-variant dark (&:where([data-theme="dark"], …))`.
5. **React state**: `context/ThemeContext.tsx` — preference `system|light|dark` in localStorage (`:14-24`), resolved against `prefers-color-scheme` (`:25-26`), subscribed via `useSyncExternalStore` to a custom event, `storage` events (so every tab iframe follows, `:28-39`) and the media query; writes `data-theme` (`:54-59`) and tells Electron (`native()?.setTheme`, `:68`) → `nativeTheme.themeSource` (`src/main/index.ts:230`), which also repaints the window background (`src/main/index.ts:50,124,295`).
6. **Editor re-applies tokens inline**: `figma/FigmaEditor.tsx:2156` spreads `FIGMA_TOKENS[theme]` as inline style on the editor root and mounts `<style>{EDITOR_CSS}</style>` (`:2157`). Redundant with step 2 for colours, but it is the *only* place `EDITOR_CSS` exists.

### Typography
- Font: **Inter Variable** via `@fontsource-variable/inter` (`main.tsx:3`, `package.json:28`), `--font-inter: "Inter Variable"` (`app.css:12`), Tailwind `--font-sans` (`app.css:59-61`), `body` (`app.css:82-86`); the editor root sets the family again inline (`FigmaEditor.tsx:2156`).
- Editor (UI3): 11px / 16px (`leading-4`), weight 450 text / 550 strong, tracking 0.055px — documented in `figma/ui.tsx:7-12` and repeated as literal classes (`tracking-[0.055px]` ×44, `text-[11px]` ×170 across figma/home/app/components/tab).
- Shell: 13px / 20px, weights 500/600, tracking −0.0325px (`app/ui.tsx:32,81,93,122`; `home/Sidebar.tsx:60,99`).
- Context menu items: **12px** (`ContextMenu.tsx:152`) — different from the editor's 11px.
- Tooltips: 11/16, weight 400 (`ui.tsx:442`); tool tooltips `font-medium` (`chrome.tsx:111`).
- Rulers draw 9px Inter on a 2D canvas (`figma/Rulers.tsx:29,58`).
- Tally of arbitrary values (figma/home/app/components/tab .tsx): font sizes 12 distinct (11px×170, 13px×37, 12px×16, 10px×9, 14px×7, 16px×5, 9px×3, …); weights 7 distinct (550×31, 450×22, 600×17, 500×12, 700, 650, 750).

---

## 2. Token inventory (values)

### `FIGMA_TOKENS` — `figma/tokens.ts`
| Token | Light | Dark |
|---|---|---|
| `--f-bg` | #ffffff | #2c2c2c |
| `--f-bg-secondary` | #f5f5f5 | #383838 |
| `--f-bg-tertiary` | #e6e6e6 | #444444 |
| `--f-bg-toggle-hover` | #f4f4f4 | #585858 |
| `--f-bg-hover` | #f5f5f5 | #383838 |
| `--f-bg-selected` | #e5f4ff | #4a5878 |
| `--f-bg-selected-secondary` | #f2f9ff | #394360 *(unused)* |
| `--f-bg-brand` | #0d99ff | #0c8ce9 |
| `--f-bg-menu` | #1e1e1e | #1e1e1e |
| `--f-bg-row-hover` | #f5f5f5 | #262626 |
| `--f-bg-row-selected` | #f0f0f0 | #1e1e1e (grey by owner's choice, `tokens.ts:7`) |
| `--f-bg-row-selected-secondary` | #f7f7f7 | #232323 |
| `--f-border` | #e6e6e6 | #444444 |
| `--f-border-translucent` | rgba(0,0,0,.1) | rgba(255,255,255,.1) |
| `--f-border-selected` | #0d99ff | #0c8ce9 |
| `--f-text` | rgba(0,0,0,.9) | #ffffff |
| `--f-text-secondary` | rgba(0,0,0,.5) | rgba(255,255,255,.7) |
| `--f-text-tertiary` | rgba(0,0,0,.3) | rgba(255,255,255,.4) |
| `--f-text-brand` | #007be5 | #7cc4f8 |
| `--f-text-component` | #8638e5 | #c9a5ff |
| `--f-icon-component` | #b49ee0 | #9d82cf |
| `--f-icon` / `-secondary` / `-tertiary` | .9 / .5 / .3 black | #fff / .7 / .4 white |
| site aliases `--bg-1,2,3,4,5` | #fff ×3, #f5f5f5, #e6e6e6 | #2c2c2c ×3, #383838, #444444 |
| `--border` / `--border-hover` | #e6e6e6 / #b3b3b3 | #444444 / #5c5c5c |
| `--text-title` / `-p` / `-subtitle` | .9 / .9 / .5 black | #fff / .9 / .7 white |
| `--edit-component` | #8638e5 | #c9a5ff |
| `--edit-canvas` | #f5f5f5 | #1e1e1e |
| `--edit-selected` | #e5f4ff | #4a5878 *(unused)* |

### Shell — `styles/app.css`
`--tabbar-height: 40px` (`:13`); `--tabbar-bg` #e6e6e6 / #585858, `--tabbar-hover` #dcdcdc / #636363, `--tabbar-divider` #cfcfcf / #696969, `--tabbar-text` .9 black / #fff, `--tabbar-text-secondary` .5 black / .7 white (`:15-19`, `:38-42`); `--home-thumb` #f5f5f5 / #1e1e1e, `--home-card-border` #e6e6e6 / #444, `--home-card-border-hover` #ccc / #5c5c5c, `--home-field` #f5f5f5 / #383838, `--home-badge-bg` #e5f4ff / #394360, `--home-badge-text` #007be5 / #91b7d8, `--home-nav-selected` #e5f4ff / #394360, `--home-live` #14ae5c / #3dd68c, `--home-changed` #e5a000 / #ffc700 (`:21-29`, `:44-52`); `--scrollbar-thumb(-hover)` .2/.35 alpha (`:31-32`, `:54-55`).

### Referenced but never defined in this repo
- `--edit-accent` — 16 uses (`figma/Canvas.tsx:1136,1389,1397,1401,1404,1419,1420,1424,1455,1489,1512,1572`; `figma/NodeView.tsx:459`). Only the site defines it (`burakkoc.net/Web/portfolio/src/app/globals.css:26,66`). Several uses have **no fallback** (e.g. `Canvas.tsx:1136` `tone`, used for the selection box `:1407` and the size badge background `:1559`), so in DesignerV2 they resolve to the property's initial value (border → currentColor, background → transparent). Likely visible: selection outlines in text colour, white size label on no background — verify in `npm run dev:demo`.
- `--edit-snap` (`Canvas.tsx:1428,1430`, fallback #ff00ff), `--progress-track/-fill` (`cv/CVPage.tsx:703-727`), `--project-accent` (`components/project/RichText.tsx:15`, fallback).

### Not tokens at all (hard-coded)
- Danger red `#f24822`: `chrome.tsx:34,54,72`, `app/ui.tsx:35,95,98`, `ImagesPanel.tsx:259,265,282,296`, `VersionsWindow.tsx:50`, `home/Home.tsx:498`, `Canvas.tsx:118` (`MEASURE`).
- Warning yellow `#ffc700`: `chrome.tsx:36`, `home/FileCard.tsx:109,161`. Warning banner `#fff1e6`/`#b44d00`: `Inspector.tsx:1335`.
- Success green `#14ae5c`: `home/Sidebar.tsx:98`, `app/icons.tsx:78`.
- Menu surface `#1e1e1e` and highlight `#0d99ff`: `ContextMenu.tsx:130,153` (not `var(--f-bg-menu)` / `--f-bg-brand`); tooltip `#1e1e1e`: `ui.tsx:441`; menu hover in VariablesTable `#0d99ff`: `VariablesTable.tsx:150`.
- Canvas chrome: `GAP_COLOR #ff24bd` (`Canvas.tsx:120`), `BLUE #0d99ff` / `PURPLE #9747ff` (`Noodles.tsx:25-26`), noodle label colours `#e4ccff/#2c0059`, `#bde3ff` (`Noodles.tsx:151,169`), ruler span `#0d99ff` (`Rulers.tsx:33,57`), component outline fallback `#9747ff` (`NodeView.tsx:382,416`).
- File kind colours `#0c8ce9`/`#9747ff`/`#14ae5c` (`app/icons.tsx:78`), covers palette (`home/FileCard.tsx:14-23`).
- Same Figma values duplicated outside tokens.ts: `boot.js:9`, `src/main/index.ts:50`, `src/main/signIn.ts:124-136`, and the prior-art `Designer/DesignSystem/Theme.swift:20-80`.

### Missing token families (vs a proper UI3 system)
- **Spacing**: none; Tailwind's 4px scale used ad hoc (`pl-4 pr-3` rows in `ui.tsx:18,30`; `pl-4 pr-2` window headers in 6 files).
- **Radius**: none; 16 distinct arbitrary radii (5px×89, 3px×16, 6px×15, 13px×13, 32px×10, 4px×8, 8px×7, 9px×4, 2px×3 …). Shell uses 6px (`app/ui.tsx:31,55,93`), editor 5px, cards 8px (`FileCard.tsx:101`), toasts 9px (`Home.tsx:594`, `chrome.tsx:48`), popover 8px (`popover.tsx:84`).
- **Elevation**: none; 20 distinct `shadow-[…]` strings, e.g. windows `0_0_0.5px_rgba(0,0,0,0.3),0_10px_16px_rgba(0,0,0,0.2)` (Inspector ×4, ColorPicker, Settings, Versions), floating bars `…0_1px_3px…` (FigmaEditor ×5), modal a 4-layer one (`app/ui.tsx:120`), menu a 3-layer one (`ContextMenu.tsx:130`), VariablePicker its own (`popover.tsx:84`).
- **Typography**: no text-style tokens (UI3's body/strong/large/heading scale); every component repeats the class string.
- **Motion**: none. Only `150ms` for the toggle (`ui.tsx:457`), tooltip delay `0.5s` (`ui.tsx:446`), `[data-instant]` disabling all transitions (`ui.tsx:461`), Tailwind defaults in the shell, reduced-motion override (`app.css:241-250`).
- **Z-index**: none; z-10/20/30/40/50/60/70/90/100 plus 9998/9999/10000 in Zoomable* (`components/ZoomableImage.tsx:293-349` etc.).
- **Canvas-chrome colours** for a WebGL renderer (selection, hover, component, measure, gap, snap, noodles) as numeric RGBA in JS — today partly CSS vars read through `getComputedStyle` (`Rulers.tsx:23-24`) and partly constants.

---

## 3. Primitive components inventory

### Editor (UI3 kit) — `figma/ui.tsx`
| Component | Lines | Props / states / sizes |
|---|---|---|
| `Section` | 15-25 | `title, strong=true, muted, icons, pb 8/12/0`; 40px header `pl-4 pr-3`, bottom border |
| `PropRow` | 28-35 | `children, icons, className`; `py-1` row, 8px gap, icon column `.f-icons` |
| `IconButton` | 38-56 | `label, icon, active, disabled, onClick`; 24×24, 5px radius, hover `--f-bg-secondary`, active `--f-bg-selected` + `--f-text-brand`, disabled 30%; tooltip via `data-tip`; **no focus style** |
| `icon24` / `icon16` | 59-61 | identical bodies, **unused anywhere** |
| `Prefix` | 64-66 | 24px letter/icon in secondary colour |
| `FIELD` / `FIELD_OUTLINED` | 68, 70 | class strings: 24px, 5px, `--f-bg-secondary`, hover border, focus `--f-border-selected` |
| `selectAllOnClick` | 77-90 | first click selects all (Figma field behaviour) |
| `NumericInput` | 97-183 | `label, prefix, value|null, min, max, unit, placeholder, fallback, onChange, onClear, suffix, disabled, onFocusChange`; Enter/blur commit, Esc cancel, ↑↓ ±1 (⇧ ±10) (`:164-170`), arithmetic via `evaluate` (`:205-245`), scrub by dragging the prefix at **4px per unit** (`:130-144`), clamps to 2 decimals (`:120`), unit hugging (`:155,174-179`) |
| `Switch` | 192-198 | `label, checked, onChange`; 28×16 track drawn **only** by `EDITOR_CSS` (`:451-457`) |
| `TextInput` | 248-277 | `label, value, placeholder, prefix, onChange` (live) or `onCommit` (draft), Esc reverts |
| `Select` | 280-292 | `label, value, options, onChange, prefix, outlined`; a **native `<select>`** with a kit chevron |
| `ChevronMenu` | 296-321 | `label, items, children, hover`; opens `ContextMenu` under it; `width` prop ignored (`void width`, `:299`) |
| `Checkbox` | 324-334 | 16px box on secondary bg, kit check; no mixed/disabled/focus |
| `Tab` | 337-343 | 24px tab, active 550 on secondary bg |
| `Chit` | 346-352 | 14px colour square, 2px radius, translucent border; ignores alpha (no checkerboard) |
| `ColorInput` | 362-400 | chit + hex + opacity (embedded `NumericInput`, 53px, `:393-397`); default chit opens **native `<input type=color>`** (`:381`) |
| `CollapseHeader` | 403-413 | 40px header with rotating chevron |
| `BrandButton` | 416-422 | 32px blue, 12px in, 5px radius |
| `EDITOR_CSS` | 430-464 | `data-tip` tooltip (`:437-449`, below by default, `.f-icons` right-aligned, `.f-nav` to the right, `.f-tip-start` left), `data-tip-key` shortcut, switch, `[data-instant]` |

### Editor chrome — `figma/chrome.tsx`
`NavTab` (20-26, 48px rail tab, 28px tile), `SaveButton` (29-39), `SaveProblem` (42-61, a toast-like alert), `PublishButton` (64-76), `AccountButton` (79-88, inline SVG avatar placeholder), `ModeTab` (91-97, 32px tab), `Tool` (100-117, 32px tool + 16px chevron, its **own** hover tooltip at `:111-114`), `ZoomPercent` (120-122).

### Popovers — `figma/popover.tsx`
`usePopover(width)` (17-42: fixed position under/over an anchor, closes on outside pointerdown / any scroll), `popoverStyle` (45-48), `Swatch` (51-53: 14px, **3px** radius, `--border-hover` border — differs from `Chit`), `VariablePicker` (62-125: search + grouped list; drawn with **site** token names `--bg-1`, `--bg-4`, `--border`, `--text-title`, `--text-subtitle`, 8px/6px radii, `toLocaleLowerCase("tr")` at `:71,75`).

### Menu — `components/admin/ContextMenu.tsx`
`ContextMenuItem` (15-29: label, shortcut, hint, icon, checked, disabled, items, onSelect), `MenuEntry = item | "-"` (32), `keys(...)` platform shortcut formatting (37-43; `navigator.platform` at `:34`), `tidy` separators (46-54), `MenuPanel` (59-187: portal, flip at edges `:79-87`, keyboard ↑↓ Enter Space → ← Esc `:116-127`, submenus beside items `:89-94,166-184`, check/icon columns appear only when some item has them `:75-76`, 24px items 12px text, 208–320px wide, 13px radius, highlight `#0d99ff`), `ContextMenu` (194-227: closes on outside press, wheel, Esc, blur, resize). This is the most complete primitive in the repo.

### Editor primitives defined *locally* (not shared)
`figma/Inspector.tsx`: `Label` 128, `Labels` 133, `BoundNumber` 146 (variable chip + detach), `PaintRow` 197, **`Segmented`** 291 (icon segmented control with raised active segment), `ButtonGroup` 307 / `GroupButton` 312, `StyleRow` 321, `InlineInput` 1300, `ConflictWarning` 1326 (hard-coded orange), `PropertyRow` 1402, `PropertyWindow` 1439 (floating window shell), `WindowRow` 1466, `FieldRow` 1889, `TextArea` 1899. `figma/Layers.tsx:74-180` layer row (28px, indent `12 + depth*24`, hover/selected cell inset 8px). `figma/FindPanel.tsx:285,299` `Group`/`Row`. `figma/SettingsWindow.tsx:8` `SettingRow`. Floating-window shells re-written 8× with identical classes: `ColorPicker.tsx:182`, `Inspector.tsx:451,908,1166,1455`, `SettingsWindow.tsx:30`, `VersionsWindow.tsx:41`, `VariablesTable.tsx:53` (header `h-12 pl-4 pr-2 border-b` in 6 of them). Floating bars in `FigmaEditor.tsx:2358,2363,2430` (13px radius, 48px).

### Shell — `app/ui.tsx`, `app/TabBar.tsx`, `home/*`
- `Button` (12-43): `kind primary|secondary|danger|ghost`, `size large(32px/13px)|small(24px/11px)`, 6px radius, **has** `focus-visible` ring (`:31`).
- `IconButton` (46-60): 32×32, 6px, native `title` tooltip — a second IconButton.
- `TextField` (63-101): label above, 32px, `--home-field`, invalid red.
- `Modal` (104-132): overlay `bg-black/40`, 13px radius, 48px header with ×, Esc closes, z-100.
- `Spinner` (135-142) — a second spinner exists in `components/icons.tsx:27-51`.
- `TabBar` (`app/TabBar.tsx:58-165`): 40px bar, traffic-light room 78px (`:15-24`), Home tab 56px (`:99-109`), tabs 96–220px (`:131`), dirty dot ↔ × on hover (`:138-153`), dividers between inactive tabs (`:113-114,154`), pointer drag-to-reorder (dragged tab translates, drop index by midpoints, `:64-94`), middle-click close (`:124`), context menu (`:125-128`), + button (`:159-161`).
- `home/Sidebar.tsx:18-32` `NavItem` (32px, 6px), search field (`:66-85`), account button (`:56-62`).
- `home/FileCard.tsx` `Thumbnail` (27-39), `SiteStatus` (42-55), `FileCard` (76-127: 8px card, 16:9 thumb, 58px footer), `FileRow` (129-174).
- `home/Home.tsx` `Pill` (615-622), `Empty` (624-654), toast (593-607).

### Site controls — `components/*`
`Button.tsx` (`IconButton` 37-57 round 28–48px; `PillButton` 75-108), `Input.tsx` (32-85, round), `Select.tsx` (68-162, custom popover 24px radius), `Segmented.tsx` (37-111, sliding indicator), `ScrollArea.tsx` (20-157: overlay scrollbars 5px thumb, `--border-hover`, drag to scroll), `icons.tsx` (site icons; Turkish comment `:1`). Used by the CV editor, embeds and Zoomable* (`cv/CVEditor.tsx`, `figma/embeds/Media.tsx`, `components/Zoomable*.tsx`); `ScrollArea` is the only one the editor uses (`FigmaEditor.tsx`, `FindPanel.tsx`, `ImagesPanel.tsx`).

### Tooltips — three mechanisms
1. CSS `::after` from `data-tip` (`ui.tsx:437-463`) — only inside `FigmaEditor` (where `EDITOR_CSS` is mounted); clipped by overflowing ancestors (acknowledged `ui.tsx:445`); 14 uses in `figma/`, 0 in `home/`, `app/`, `tab/`.
2. `Tool`'s own `group-hover` span (`chrome.tsx:111-114`).
3. Native `title=`: 52 in `figma/`, 11 in `home/`, 9 in `app/`.

### Toasts / banners — no component
`home/Home.tsx:593-607` (action toast, 3.5s/6s), `figma/FigmaEditor.tsx:2376-2378` (notice), `figma/chrome.tsx:48-60` (save problem), `home/Home.tsx:498` (red banner), `figma/Inspector.tsx:1335` (orange banner).

---

## 4. Icons

1. **Figma UI3 kit exports** — `components/admin/figmaKitIcons.ts` (`KIT`, 121 icons): `[box, evenOdd, "opacity|d", …]` (`:8`), from the community "Figma's UI Kit" file (fileKey cited at `:3`), 24-set `:11-103`, 16-set `:105-136`; 13 paths carry the kit's 0.3 secondary tone.
2. **Mixed set** — `components/admin/figmaIcons.tsx` (`ICONS`, 84 entries, `:20-137`): kit paths plus glyphs "drawn after Figma's panels" (`close.small` `:40`, `corners.independent` `:65`, `16.cursor`/`16.hand` `:108,112`, `16.variant` `:115`…), stroked ones (`s16` `:25-27`), and the owner's own 11×11 SVGs (`s11`, `:123-136`).
   - Lookup `pathsOf` checks `KIT` first (`:143`), so `ICONS["16.page"]` (`:98`) and `ICONS["16.image"]` (`:106`) are **shadowed/dead**; `chevron.right` (`:35`) duplicates `24.chevron.right` exactly; `library` (`:51`) ≈ `24.library`.
   - `FigmaIcon` (`:155-173`) renders an inline SVG in `currentColor`, opacity from the kit tone; `fi()` helper (`:175`).
   - Both files are monolithic objects (51 KB + 77 KB source) — imported whole by every chunk that uses any icon.
3. **Shell icons** — `app/icons.tsx` (18 hand-drawn 1px-stroke icons via `stroke()` `:13-21`, plus `FolderIcon`, `StarIcon`, `PlayIcon`, `FileKind` `:77-95`, `AppMark` `:98-116`).
4. **Site icons** — `components/icons.tsx` (4).
5. **Inline SVGs** — `TabBar.tsx:27-46` (design / CV glyphs), `chrome.tsx:83` (avatar), `components/Select.tsx:31-66`, two spinners.

Gaps vs Figma: icons are a curated subset (~205 names) of the kit; no icon registry/codegen; no sprite or per-icon modules; licence of the kit's icons should be checked before shipping a public clone.

---

## 5. Prior art outside the repo

### `/Users/burak/Desktop/Burak/Code/Designer` (SwiftUI, same owner) — worth mining as a spec
- `ARCHITECTURE.md` "Visual language" defines the UI3 tokens/metrics/type/icon/component contract explicitly.
- `Designer/DesignSystem/Theme.swift`: the same FIGMA_TOKENS (`:20-51`) **plus** what DesignerV2 lacks — `borderStrong` (`:37`), `canvas` (`:54`), `selection` #0d99ff (`:56`), `componentAccent` #8638e5/#9747ff (`:58`), `measure` #f24822 (`:60`), `danger/success/warning` (`:63-65`), menu text/secondary/disabled/separator/highlight (`:76-80`); **metrics constants** (`:172-230`: row 32, field 24, header 40, corner 5, insets 16/8, gap 8, rail 64, panels 240 (200–480), layer row 28 + indent 24, toolbar 48/8/32/13, menu 8/24/208–320/13, chit 14, checkbox 16, ruler 20); **type** (`:232-282`: weights 300–700 incl. 450/550, `tracking(for:)` 0.055@11 / 0.05@10 / −0.0325@13, presets body/strong/navLabel 10/badge 9/title 13/largeTitle 20/display 28); **surfaces** (`:356-382`: floating + menu shadows).
- Components (`UIControls.swift`, `UIFields.swift`, `UIOverlays.swift`, `UILayout.swift`): `UIIconButton`, `UIPrefix`, `UICheckbox`, `UISegmented`/`UITab` (2 sizes), brand/secondary/ghost/AI/danger button styles, `UISpinner`, `UIBadge`, `UIChip`, `UIChit` (with checkerboard), `UICheckerboard`, `UIDivider`, `UINavTab`, `UIToolButton`, `UIToolbar`, `UIToast`, `UIField`, `UINumberField` (scrub with `onScrubBegin/End` for one undo step, mixed values, `fractionDigits`), `UIColorField`, `UITextArea`, `ArithmeticExpression`, `uiTooltip` (0.5s delay, instant when moving between tooltips, placements), `UIMenuPresenter`, `UIMenuButton`, `UIDropdown`, `uiContextMenu`, `UISection`, `UIPropRow`, `UILabeledRow`, `UICollapseHeader`, `UIRow`, `UIEmptyState`, `UIDialogHeader/Footer`. Not reusable as code (SwiftUI/AppKit) but the most complete written spec of the owner's UI3 system.

### `/Users/burak/Desktop/Burak/Code/figmaKlon` (Vite React) — not worth reusing
`src/index.css:1-70` defines a generic glassy theme (translucent panels `rgba(38,38,38,.92)`, zinc greys, radii 6/10/14/18, springy motion), 11–13px mixed font sizes, icons from `lucide-react`. Not UI3-accurate; no component library.

---

## 6. What a Figma-UI3 design system needs that is missing or partial

| Needed | Today | Gap |
|---|---|---|
| Token package (colour, spacing, radius, elevation, type, motion, z) | colours only, split over 5+ files | build one TS module → CSS vars + JS numeric values for the WebGL renderer |
| IconButton | 3 versions (`figma/ui.tsx:38`, `app/ui.tsx:46`, `components/Button.tsx:37`) | one, with focus ring, toggle state, tooltip |
| NumericInput with scrubbing | `ui.tsx:97-183` | ⇧/⌥ scrub modifiers, pointer lock / global `ew-resize`, begin/end for one undo step, "Mixed", precision |
| Dropdown/Select | native `<select>` (`ui.tsx:280`), `ChevronMenu`, site `Select` | a Figma dropdown on the dark menu (selected item over the field, typeahead) |
| Menu | `ContextMenu.tsx` | tokenise colours; typeahead; scroll for long menus; submenu hover-intent |
| Tooltip | CSS `data-tip`, Tool span, native `title` | one portalled tooltip with delay groups and shortcut |
| Tabs / SegmentedControl | `Tab`, `ModeTab`, `NavTab`; `Segmented` local to Inspector | shared components |
| Checkbox / Toggle | `Checkbox`, CSS-only `Switch` | mixed state, focus, work outside EDITOR_CSS |
| ColorSwatch | `Chit` vs `Swatch` (different radius/border) | one, with alpha checkerboard |
| PanelSection / Row | `Section`, `CollapseHeader`, 6 row variants | consolidate |
| Modal/Dialog/Window | `Modal` + 8 hand-rolled window shells | one Window/Popover shell with focus trap |
| Toast | 3 ad-hoc | component + queue |
| TabBar tab | inline in `TabBar.tsx` | overflow, sibling animation, file-kind glyphs for Figma types |
| FileCard / Sidebar item | `home/FileCard.tsx`, `home/Sidebar.tsx` (site-specific) | Figma file card (thumbnail, editors, location), team/project tree |
| Not present at all | — | Radio, Slider, Popover with focus management, SearchInput, Avatar, Badge, Divider, EmptyState, ResizeHandle, Banner, Kbd, Toolbar container, font picker |

---

## 7. Site / Firebase coupling in this layer
- Site-named token aliases in the chrome (`tokens.ts:12-14`, comment `:3`) colliding with the site's design-variable CSS (`components/project/designVariables.tsx:121`, `[data-design-scope]`) and `tab/siteTokens.ts:8-11`; chrome code still reads them (`popover.tsx:84-121`, `FigmaEditor.tsx:2156` `text-[var(--text-title)]`, `ScrollArea.tsx:125`).
- `--edit-*` names borrowed from the site's admin (`globals.css:22-34`), half of them not ported.
- `app.css:138-149` (site page entrance) and `:157-238` (Prism colours for code embeds).
- Site controls `components/Button|Input|Select|Segmented|icons.tsx`, and `PageEntrance`, `ScrollReveal`, `TextScrollingEffect`, `Footer`, `CodeHighlight`, `Zoomable*`, `demos/ComponentRegistry`, `admin/JsonEditor`.
- `SaveButton`/`SaveProblem`/`PublishButton` (`chrome.tsx:29-76`) — Firestore save and publish-to-site; `AccountButton` (`:79-88`) — Firebase user.
- Tab bar: CV glyph and kinds (`TabBar.tsx:39-46,136`), "New project" (`:159`).
- Home: burakkoc.net "team" with Admin badge, Drafts/All projects/Library/CV/Trash, Published view (`home/Sidebar.tsx:89-107`); covers stamped "burakkoc.net" (`FileCard.tsx:35`); Live/Changed status (`FileCard.tsx:42-55`, `app.css:28-29,51-52`).
- `VariablePicker` built on the site's two-mode `DesignVariable` (`popover.tsx:2-4`) and Turkish collation (`:71,75`).
- Duplicated Figma colours in the Firebase sign-in page (`src/main/signIn.ts:124-136`).

## 8. Problems (summary)
1. `--edit-accent` undefined → canvas selection chrome colours likely wrong (`Canvas.tsx:1136,1407,1559` …).
2. Tokens duplicated across `tokens.ts`, `app.css`, `boot.js:9`, `main/index.ts:50`, `signIn.ts:124`, site globals, Theme.swift.
3. Three parallel primitive libraries with conflicting metrics (24/5px editor, 32/6px shell, 28–48/round site).
4. `EDITOR_CSS` scoped to the editor → `data-tip` and `Switch` silently do nothing elsewhere (`ui.tsx:192`, `FigmaEditor.tsx:2157`).
5. CSS tooltips clipped by overflow; native `title` used 72×.
6. 20 shadow strings, 16 radii, 11 z-levels, 12 font sizes hard-coded.
7. Dead code: `icon24/icon16` (`ui.tsx:59-61`), `ChevronMenu.width` (`:299`), shadowed icons (`figmaIcons.tsx:98,106`), unused tokens (`tokens.ts:6,15` `--f-bg-selected-secondary`, `--edit-selected`).
8. Inconsistent component purple: `--edit-component` #8638e5 (`tokens.ts:15`) vs `#9747ff` (`NodeView.tsx:382`, `Noodles.tsx:26`, site `globals.css:27`).
9. Comment/token mismatch: Layers says "light blue" selection (`Layers.tsx:9,128`) but token is grey (`tokens.ts:8`).
10. No keyboard focus styling in editor primitives; Layers row buttons `tabIndex={-1}` (`Layers.tsx:142,167,171`).
11. NumericInput emits onChange per pointermove with no gesture begin/end (`ui.tsx:137-143`).
12. Native `<select>` and `<input type=color>` break the Figma look (`ui.tsx:284,381`).
13. Icon modules not tree-shakeable (128 KB source).
14. For the proposed WebGL renderer, all canvas overlays (`Canvas.tsx:1389-1572`, `Rulers.tsx`, `Noodles.tsx`) are DOM/canvas2d reading CSS vars; tokens must be exposed numerically.
