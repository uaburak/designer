# Using the design system

## Status at handoff (2026-10-06, round 3)

Everything compiles and the DS's checks pass: `npm run typecheck` and `npm run lint` are clean for `src/renderer/src/ds`, `scripts/gen-tokens.ts` and `scripts/gen-icons.ts` (the one lint warning in the repo is in `src/renderer/src/store/memory/memoryStore.ts`, not the DS); `npm test` runs 47 files / 381 tests, all green (the DS's own: 19 files); `npm run tokens -- --check` and `npm run icons -- --check` pass. Nothing was committed.

### Round 3: done

- **Looked at the gallery in a real browser** (Chrome through playwright-core, dark and light; script and screenshots in `/tmp/designer-work/ds/`). Fixed:
  - ColorPicker: the hue and opacity thumbs and the gradient stops hung half off their tracks at 0 and 100%. Their centres now travel from 6px to width − 6px, and the pointer maps over the same inset track, so the thumb stays under the pointer.
  - ColorPicker, Image paint: the empty preview showed one stray checkerboard tile (the `checker` class with `background-repeat: no-repeat`). It now shows a tertiary image glyph until there is an image.
  - Checked and left as they are: the picker is 240 wide; AlignmentMatrix is 88 × 56; EditorToolbar measures 529 × 48 (530 ± 1 in the reference); the divider is #444 and the mode switch #444 / #2c2c2c in dark; the Home sidebar (28 highlight on a 32 pitch, label at x 44, bell in the account row), cards 268 × 213 with 36 gaps.
- **Component tests (happy-dom):** `tabBar.test.ts` (4px threshold, dragging right and left with the others making room, drop index, close button doesn't drag, middle click, ← →, unsaved dot), `scrollArea.test.ts` (thumb size and offset, show while scrolling and hide after 1s, hover, thumb drag, track paging, forceVisible), `dialog.test.ts` (initial focus, Tab / ⇧Tab trap, Esc, focus back to the opener, Enter on the primary, the scrim, static).
- **New for the file browser and other lists** (all exported from `@/ds`, demos in `?gallery&section=components`, tests in `selection.test.ts` and `fileBrowser.dom.test.ts`):

  ```ts
  // A selectable collection (Home's grid and list). Items are descendants with data-collection-item + data-id
  // (FileCard, FileRow, FolderCard, ListRow carry both).
  <CollectionView layout?="grid" | "list" label="Files" header?={<ListHeader …/>}
    onNavigate?={(id, extend) => …}            // arrows by layout, Home/End; extend = ⇧
    onSelectAll?={() => …} onClearSelection?={() => …} onDelete?={() => …}   // ⌘A, Esc or an empty click, ⌫/Delete
    onMarquee?={(ids, { additive, final }) => …}   // drag on empty space; additive = ⇧/⌘ held at the press
    role? className? … />
  collectionTarget(key, items, from, layout)     // the pure arrow-key logic

  // Selection state (pure helpers + a hook)
  const sel = useSelection(orderedIds);  // { selected, isSelected, anchor, select(id, event?), extendTo(id, extend), selectAll, clear, set(ids, anchor?) }
  clickSelection(order, state, id, { shift, toggle }) · moveSelection · inOrder · idsInRect · isToggleModifier(e) · selectionModifiers(e)

  // List view
  type ListColumn = { id: string; label: string; width?: number | string; align?: "start" | "end"; sortable?: boolean };
  type ListSort = { column: string; direction: "ascending" | "descending" };
  <ListHeader columns sort? onSort?={(column) => setSort(nextSort(sort, column, firstDirection?))} />
  <ListRow id columns cells={{ [columnId]: ReactNode }} selected? dropTarget? muted? onOpen? onSelect?={(e) => …} onContextMenu? forceHover? />
  listTemplate(columns), nextSort(sort, column, firstDirection = "ascending")

  <FolderCard id title subtitle thumbnails?={string[] /* up to 4 */} color?={cssColor} starred? selected? renaming? dropTarget?
    onOpen? onSelect?={(e) => …} onContextMenu? onRename?={(name | null) => …} onStar? forceHover? />
  <FolderGlyph color? size?={16 | 24 | 48} />

  <Breadcrumb items={{ id, label, icon? }[]} onNavigate={(id) => …} menu?={MenuEntry[]} onMenuSelect?={(id) => …}
    maxItems?={4} size?="large" | "default" label? />       // long paths fold the middle into "…"

  <InlineEdit label="Rename" value editing onCommit={(next) => …} onCancel?={() => …} onEditingChange?={(editing) => …}
    onExit?={(reason) => …} select?="all" | "name" | "end" editOnDoubleClick? placeholder? maxLength? />
  renameSelection(value, select)

  <Banner tone?="default" | "brand" | "warning" | "danger" icon?={IconName | null} action?={{ label, onClick }} onDismiss?>text</Banner>
  <Skeleton width? height?={16} radius?="small" | "medium" | "medium-large" | "full" />
  ```

  - `InlineEdit` swaps the text for a field in the same font and place, focused with the text selected (`select="name"` leaves out the extension). Enter, Tab or blur keeps a trimmed, changed, non-empty name (`onCommit`); otherwise `onCancel`. Keys stop at the field.
  - `CollectionView` leaves keys typed in fields alone, so a rename inside a card is safe. The marquee works in content coordinates, so it survives the collection's own scrolling.
  - The toast with an action (Undo) already existed: `showToast({ message, action: { label: "Undo", onAction } })`.
  - Additions to existing pieces: FileCard and FileRow roots carry `data-collection-item`.
  - New tokens: `--ds-size-list-row` (40), `--ds-size-list-header` (32), `--ds-size-breadcrumb-max` (160), `--ds-color-marquee-fill`.
  - New icons: `16.arrow.up`, `16.arrow.down` (sort), `24.info`, `24.warning` (Banner).
- The gallery's Home screen now uses `Breadcrumb` and `CollectionView`. A live file browser demo (`CollectionView` in the gallery) wires all of it: grid/list toggle, sorting, ⌘/⇧-click, arrows, ⌘A, Esc, marquee, a context menu with Rename and Move to trash, and Undo in the toast.

### Round 3, follow-up fixes (asked for by the Home and Editor agents)

- **Folder colours.** There are tokens `--ds-color-folder-{red, orange, yellow, green, teal, blue, purple, pink, gray}` (light and dark, G). Their ids are the store's `FolderColor`, and a test keeps them in step with `src/shared/store/types.ts`. Exports:
  - `FOLDER_COLOR_IDS`, `FolderColorId`;
  - `FOLDER_COLOR_VARS` (id → `var(--ds-color-folder-*)`; "none" is `--figma-color-icon-secondary`);
  - `FOLDER_COLOR_LABEL` ("No color", "Red"…);
  - `folderColor(id)` (undefined for "none" or an unknown id). Pass it as `FolderCard` or `FolderGlyph` `color`. Don't use `color-mix()`.
- **`24.star` is solid now.** It was an outline drawn in even-odd fill, so starred and unstarred looked the same. `24.star.outline` is unchanged.
- **Overlay theme.** A `Portal` without an anchor (Dialog, Popover) takes its theme from what had focus, but now skips forced-dark overlays. Menus, Select lists, tooltips and toasts mark their wrapper `data-theme-forced`. So a dialog opened from a context-menu item gets the app's theme. With nothing focused it uses the document root's theme. A themed subtree, such as the Gallery's columns, still wins. The logic is in `inheritedTheme(el)`.
- **EditorToolbar.**
  - `disabledTools?: ToolId[]`: a disabled tool is dimmed, can't be clicked, and keeps its tooltip (`aria-disabled`, not the `disabled` attribute). It is greyed in its slot's menu too. A slot's chevron is disabled only when every tool in that slot is.
  - Disabled modes use the same approach. They now draw in `icon-disabled` with no hover brightening, so they read as disabled in light too.
  - `ToolButton` gained `menuDisabled` (default: `disabled`). `ToolButton` with `disabled` now uses `aria-disabled`.
- Tests: `round2fixes.dom.test.ts` and two new cases in `editorToolbar.test.ts`. Gallery: the folder colour row, a starred FolderCard and FileCard, "a dialog from a context menu" (live), and a disabled EditorToolbar.
- Nothing in `ds/` imports the legacy folders or Tailwind. The only matches are comments that say where `evaluate` was ported from.
- `main.tsx` currently imports the deleted `./styles/app.css` and `@/figma/tokens` (the desktop agent's work in progress). Until it is fixed, `?gallery` through the app entry fails; `ds/gallery/main.tsx` still mounts the gallery standalone.

### Not done

- ColorPicker extras: gradient handles on the canvas (the engine's), image adjustments, the "+ create style/variable" header action (the `headerActions` slot exists), a Video paint type.
- File browser extras: dragging files onto folders (`dropTarget` styling exists on FolderCard, ListRow and SidebarItem; the drag itself and its "N files" ghost are the Home agent's), auto-scroll while marquee-selecting, a "Move to…" folder-picker dialog (build it from `Dialog`, `SidebarItem` with `indent` and `FolderGlyph`).
- Editor: no gaps found that the existing `PanelSection` (title, actions, `empty` "+") and `PropertyRow` (two fields plus the 24 action column) don't cover. Figma UI3's fill rows put the visibility toggle inside the same 24 column, so no new row component was added.
- The theme aliases in `src/preload/common.ts` belong to the desktop agent (not touched here).
- Light-theme values are still unmeasured (contract §7.1).

### Next steps

1. The Home agent: build the browser from `CollectionView` + `useSelection` + `FileCard` / `FolderCard` / `ListHeader` / `ListRow` + `Breadcrumb` + `InlineEdit`; `BrowserDemos.tsx` in `ds/gallery/` is a working reference.
2. The Editor agent: adopt `ColorPicker`, `AlignmentMatrix` and `EditorToolbar` (props below). `InlineEdit` also fits page and file-name renames.

### Round 2 (for reference: the APIs it added)


- **ColorPicker** (`ds/components/ColorPicker.tsx`, model in `ds/util/paint.ts`, colour maths in `ds/util/color.ts`). A Figma UI3 picker in a 240px popover:
  - Custom / Libraries tabs.
  - Paint type: Solid, Linear, Radial, Angular, Diamond, Image.
  - A blend-mode menu.
  - A gradient stop bar. Click adds a stop and dragging it continues the same gesture; drag a stop to move it, or off the bar (more than 32px away) to remove it. ← → move a focused stop, Delete removes it, and Flip mirrors the stops.
  - A stops list.
  - The saturation/brightness square, hue and opacity sliders, all keyboard-steppable.
  - An eyedropper (`window.EyeDropper`).
  - A colour model Select (Hex, RGB, CSS, HSL, HSB) with its fields.
  - "On this page" swatches.

  ```ts
  <ColorPicker<P extends PickerPaint>
    value={paint}                       // { type: PaintType; color?: RGBA; opacity?: number; stops?: ColorStop[]; blendMode?: BlendMode; imageScaleMode?: ImageScaleMode } + any extra fields (passed through)
    onChange={(next: P, info: ChangeInfo) => …}   // drag: final:false per move, ONE final:true on release; typed/stepped/picked: final:true
    onCancel?={() => …}                 // Esc during a drag (default: a final change back to the start value)
    onClose={() => …}
    anchor={HTMLElement | DOMRect | null}
    placement?="left-of-panel" | "bottom-start" | "bottom" | "top" | "right"   // left-of-panel needs data-panel on the right panel element
    paintTypes?={PaintType[]} documentColors?={string[] /* hex or rgba() */} libraries?={ReactNode}
    initialTab?="custom" | "libraries" imageUrl?={string | null} onChooseImage?={() => …}
    colorModel?={ColorModel} onColorModelChange?={(m) => …} stop?={number} onStopChange?={(i) => …}
    headerActions?={ReactNode} static?={boolean} />
  ```

  - Types follow Figma's kiwi names: `PaintType` ("SOLID" | "GRADIENT_LINEAR" | "GRADIENT_RADIAL" | "GRADIENT_ANGULAR" | "GRADIENT_DIAMOND" | "IMAGE"), `RGBA` {r, g, b, a} in 0..1, `ColorStop` {color, position 0..1}, `BlendMode` (NORMAL…LUMINOSITY, with the labels in `BLEND_LABEL`), `ImageScaleMode` (FILL / FIT / CROP / TILE).
  - Pure helpers: `convertPaint`, `targetColor`, `withTargetColor`, `addStop`, `moveStop`, `removeStop`, `flipStops`, `colorAt`, `paintCss`.
  - SOLID keeps `color.a = 1`; its alpha is the paint's `opacity`.
- **AlignmentMatrix** (`ds/components/AlignmentMatrix.tsx`): 88 × 56 on the field colour, a 3 × 3 grid. The chosen cell shows bars in `icon-brand`, a hovered cell shows a preview, and the arrows move the choice.

  ```ts
  <AlignmentMatrix direction="horizontal" | "vertical" value={{ primary: "MIN"|"CENTER"|"MAX"|"SPACE_BETWEEN", counter: "MIN"|"CENTER"|"MAX" }} onChange={(next) => …} disabled? label? />
  ```

  - `primary` and `counter` are the kiwi `stackPrimaryAlignItems` / `stackCounterAlignItems`.
  - With SPACE_BETWEEN a whole row (horizontal) or column (vertical) is chosen, and a click changes only the counter alignment.
  - Pure helpers: `cellAlignment`, `cellSelected`.
- **Bottom toolbar** (`ds/components/EditorToolbar.tsx`). It matches the owner's screenshots, measured at 1 CSS px = 1.3228 image px: 530 × 48, padding 8, tools 32 with a 16px chevron 1px after, 8px between slots, a full-height #444 line, then the mode switch (a #444 track, 2px padding, 28px items 2px apart, the chosen one #2c2c2c with a blue glyph).

  ```ts
  <EditorToolbar tool={ToolId} groupTools?={Partial<Record<ToolGroupId, ToolId>>} onTool={(t: ToolId) => …}
    onActions?={() => …} actionsActive? mode={EditorMode} onMode={(m) => …} disabledModes?={EditorMode[]} floating? offset? />
  ```

  - **Slots and tools** (`TOOL_GROUPS` / `TOOLS`), with their shortcuts:
    - move: Move V, Hand H, Scale K
    - region: Frame F, Section ⇧S, Slice S
    - shape: Rectangle R, Line L, Arrow ⇧L, Ellipse O, Polygon, Star, Image/video ⇧⌘K
    - creation: Pen P, Pencil ⇧P
    - text: Text T, Text on a path
    - comment: Comment C, Annotation ⇧T, Measurement ⇧M
    - then Actions ⌘K.
  - **Modes** (`EDITOR_MODES`): Draw, Design, Motion, Dev Mode (⇧D). This order is from the screenshot, with the names confirmed against Figma's docs and forum.
  - **Helpers:** `groupOf(tool)`, and `toolForKey(keyboardEvent) → ToolId | null` for the editor's keymap. The editor keeps `groupTools` (the last tool chosen in each slot).
  - **Building blocks:** `ToolButton` now takes `menuLabel`, its chevron points down, and `ToolbarDivider` is full height.
- **Generators:**
  - `npm run tokens` (`scripts/gen-tokens.ts`, run by vite-node) writes:
    - `ds/tokens.css`;
    - the `// <generated` block of `src/renderer/public/boot.js` (`SURFACE_BG`, each surface's background [light, dark]; the shell's code around it is untouched apart from that one lookup line);
    - `engine/src/render/ChromePalette.generated.h`.
  - `npm run icons` (`scripts/gen-icons.ts`) builds `ds/icons/registry.ts` from `ds/icons/svg/{16,24}/*.svg`. 236 icons: the legacy set exported once with `--export`, plus new ones: `24.scale`, `24.slice`, `24.text-on-path`, `24.annotation`, `24.measurement`, `24.draw`, `24.design`, `24.motion`, `24.gradient.radial|angular|diamond.small`, `24.folder`. It reads Figma's own SVG exports too.
  - Both have `--check`, and the DS tests run the same checks (`tokens.test.ts`, `icons.test.ts`).
- **Component tests in happy-dom** (`happy-dom` devDependency; `// @vitest-environment happy-dom` per file; helpers in `ds/__tests__/dom.ts`). They cover:
  - NumericInput: steps, arithmetic, Esc, a scrub as one final change, Esc cancelling a scrub, Mixed + `onStep`;
  - ContextMenu: arrows, wrap, typeahead, submenus, Esc;
  - Select: open over the trigger, pick, focus return, typeahead, Mixed;
  - ColorPicker: a drag of the square is exactly one final change; Esc cancels; opacity; steps; hex; Solid → Linear; adding and dragging a stop in one gesture; dragging a stop off removes it; document colours; RGB fields;
  - AlignmentMatrix;
  - EditorToolbar.
- **Wording fixes:**
  - `formatEdited(editedAt, now?)` / `timeAgo` (`ds/util/time.ts`): "Edited just now", "Edited 1 minute ago", "Edited 34 minutes ago", "Edited 1 day ago", "Edited 2 months ago", "Edited 1 year ago".
  - Home follows Figma's 2026 file browser:
    - Folders, not projects.
    - `SidebarItem` accepts any icon node, with Figma's measures: icon cell centred at x 24, label at x 44.
    - New pieces: a collapsible `SidebarHeader` (`open`, `onOpenChange`), `SidebarDivider`, `FolderIcon`, and `FileKindIcon` (a 16px brand square with the design glyph).
    - The `FileCard` footer is the measured one: the badge 16px in, the title 11/550 and the subtitle 11, 12px after the badge. The contract said 13px for the title, but the screenshot wins (M > D).
    - The gallery's Home screen uses: Recents | the workspace row | Drafts, All folders, Resources, Trash | Starred.
- **Other changes:**
  - `MenuIcon` draws 24px glyphs properly in menus and Select lists.
  - `Popover` takes a `header` node (the picker's tabs).
  - Pointer capture never throws (`ds/util/pointer.ts`).
  - Two new tokens: `--ds-color-picker-thumb` and `--ds-color-picker-thumb-ring`.


---

How to build the app's chrome (tab bar, Home, panels, menus, dialogs, toolbar) with `src/renderer/src/ds/`. The contract, with the reasons and sources behind every value, is `docs/design-system.md`. This page is the practical side: what to import, how to style, and what each component expects.

The DS is the chrome's look only. The user's variables, text styles and components are document data and never use these tokens.

## 1. Setup in an entry

```tsx
import "@/ds/global.css"; // first: layer order, Inter Variable, tokens.css, reset and base
import { TooltipManager, ToastHost, useThemeRoot } from "@/ds";

function Root() {
  useThemeRoot(); // keeps <html data-theme> in step (only where ThemeProvider is not mounted)
  return (
    <>
      {/* the page */}
      <TooltipManager /> {/* one per document: every data-tooltip in the page */}
      <ToastHost /> {/* one per document: showToast() draws here */}
    </>
  );
}
```

- `global.css` declares `@layer reset, tokens, theme, base, ds, components, utilities, app;` and then imports the font and `tokens.css`. Import it before any other CSS so Tailwind's layers slot in around the DS's.
- Overlays (menus, Select lists, popovers, dialogs, toasts, tooltips) render into `<div id="ds-overlays">` at the end of `<body>`. It is created on first use and never clipped by a panel's `overflow`.
- `src/renderer/src/ds/Gallery.tsx` is a complete standalone example: it imports `global.css` and mounts both managers.

## 2. Tokens

`ds/tokens.ts` is the only place a value is written. It is pure data with no imports, so the renderer, Electron main, scripts and tests can all load it. `ds/tokens.css` is generated from it and committed.

After editing `tokens.ts`, regenerate its artefacts:

```sh
npm run tokens           # ds/tokens.css, boot.js's generated block, engine/src/render/ChromePalette.generated.h
npm run tokens -- --check
```

Until then, `npm test` fails with "… is out of date: run `npm run tokens`". The renderers are in `ds/tokensCss.ts`: `renderTokensCss`, `renderBootSurfaces`, `renderChromeHeader`, plus `renderBootJs` (the contract's full boot script, for a future entry that has none).

### Names

| CSS custom property | TypeScript | What |
|---|---|---|
| `--figma-color-<name>` | `figmaColor[name]` → `[light, dark]` | Figma's 174 plugin theme colours, named exactly as Figma's. Use these first. |
| `--ds-color-<name>` | `appColor[name]` | Colours Figma doesn't publish: tab bar, rail separator, menus and tooltips (dark in both themes), scrim, translucent borders, switch, scrollbar, card hover, canvas default |
| `--ds-checkerboard` | `checkerboard` | A `background` value for alpha behind swatches |
| `--ds-space-<0, half, 1, 1-5, 2, 3, 4, 5, 6, 8, 10, 12, 16>` | `space` | The 4px grid (`half` = 2, `1-5` = 6) |
| `--ds-size-<name>` | `size` | Metrics: `control` 24, `control-large` 32, `row` 32, `layer-row` 24, `section-header` 40, `field` 88, `panel` 240, `rail` 48, `tabbar` 38, `toolbar` 48, `ruler` 20, `card-width` 268… |
| `--ds-radius-<none, small, medium, medium-large, large, full>` | `radius` | 0 / 2 / 5 / 9 / 13 / 9999 |
| `--ds-font-<style>` + `--ds-tracking-<style>` + `--ds-weight-<style>` | `text` | `body-small`, `body-medium` (11/16 450), `body-medium-strong` (550), `body-ruler`, `menu` (12/16), `body-large` (13/22), `body-large-strong`, `heading-medium`, `heading-large`, `code` |
| `--ds-elevation-<100, 200, 400-menu-panel, 500-modal-window, menu>` | `elevation` | Box shadows, per theme |
| `--ds-focus-color`, `--ds-focus-width`, `--ds-focus-offset` | `focus` | The selection blue, 1px, 1px out |
| `--ds-z-<base, panel, floating, resize, scrim, dialog, popover, menu, toast, tooltip, drag>` | `z` | Stacking within one document |
| `--ds-duration-*`, `--ds-ease-out`, `--ds-delay-*`, `--ds-toast-duration*` | `motion`, `timing` (numbers) | The chrome is instant by default; only switches, chevrons and toasts move |

Light values sit on `:root` and on any `[data-theme="light"]` element; dark values sit on `[data-theme="dark"]`. Any subtree can be re-themed by putting `data-theme` on it. The Gallery uses this to show both themes side by side.

### In a component's CSS Module

```css
@layer app {
  .header {
    height: var(--ds-size-section-header);
    padding: 0 var(--ds-size-panel-pad-right) 0 var(--ds-size-panel-pad-left);
    border-bottom: 1px solid var(--figma-color-border);
    font: var(--ds-font-body-medium-strong);
    letter-spacing: var(--ds-tracking-body-medium-strong);
    color: var(--figma-color-text);
  }
}
```

Always write `font:` and `letter-spacing:` together; the tracking isn't part of the shorthand.

### In TypeScript

- `resolveFigmaColor("bg-brand", theme)`, `surfaceBackground("tabbar", theme)` (Electron main: `BrowserWindow`/`WebContentsView` backgrounds).
- `chromePalette(theme)`: a `Float32Array` of `CHROME_COLORS.length × 4` straight-alpha RGBA for the engine. The order of `CHROME_COLORS` is the ABI, so only append to it.
- `canvasChromeMetrics`: selection stroke, handle size, size badge, ruler metrics.

## 3. Theme

```ts
import { useTheme, setThemePreference, onThemeChange, currentTheme, applyTheme } from "@/ds";

const { preference, resolved } = useTheme(); // "system" | "light" | "dark", and "light" | "dark"
setThemePreference("dark");
```

- **Desktop app.** Main owns the preference. `theme.ts` reads the preload's boot snapshot (`window.designer.theme`), sets a new preference with `window.designer.setTheme` (invoke `theme:set`), and follows `window.designer.onThemeChanged` (event `theme:changed`).
- **Browser.** The web viewer, `npm run web` and the Gallery's dev server fall back to localStorage `designer-theme` (absent means system) and `prefers-color-scheme`.
- **Legacy pages.** A change is also written to that localStorage key and announced with the `designer-theme-change` event, so the legacy `context/ThemeContext.tsx` follows until it is removed.
- `applyTheme(resolved)` sets `data-theme` and `color-scheme` on `<html>`. For two frames it also sets `data-theme-switching`, which turns transitions off so nothing animates between the themes' colours.

## 4. Conventions every component follows

- **Plain CSS Modules** (`Name.module.css`). Every rule sits in `@layer ds { … }`. There is no Tailwind in `ds/`. `ds/__tests__/no-raw-values.test.ts` rejects hex, `rgb()`, `hsl()`, shadow and font literals in DS stylesheets, and `tokens.test.ts` checks that every `var(--…)` they read exists.
- **Root attributes.** Each component spreads `className`, `style`, `id`, `data-*` and `aria-*` onto its root and sets `data-ds="<Name>"`. Tests and `scripts/drive.mjs` select by `data-ds`, never by generated class names.
- **Forced states**, for the Gallery and tests: `data-hover`, `data-pressed`, `data-focus-visible` and `data-open` on the root draw the same look as the pseudo-class. Overlays take `static` and render in place.
- **Mixed.** `import { MIXED } from "@/ds"`. `value={MIXED}` shows "Mixed" in the secondary text colour. On a NumericInput, the arrow keys then call `onStep(delta)`.
- **Gestures and undo.** Continuous edits (scrubbing, resizing) call `onChange(value, { final: false, source })` on every frame and make exactly one `final: true` call on release. Esc during a scrub calls `onCancel`. Typed and stepped values are always `final: true`. Map non-final calls to a live preview and the final call to one undo step.
- **Fields keep their keys.** `keydown` stops at the field, so canvas shortcuts never fire while typing. `onExit(reason)` reports Enter, Esc, Tab, Shift+Tab or blur, so an editor can give focus back to the canvas.
- **Tooltips are attributes**, read by the one `TooltipManager`. IconButton, ToolButton, RailItem and icon segments set them from their `label`. Anything else can spread `tooltipProps("Label", "⌘K", "bottom")`. Never use the native `title`, except in the tab bar view, whose DOM tooltips can't leave its 38px.
- **Icons are names** (`IconName`), never JSX, so components control size and tone.
- **Strings** owned by the DS are in `ds/strings.ts`, in English and in Figma's wording.
- **Fields fill their container.** Size the container: a `PropertyRow` cell, a `width` style or a flex item.

## 5. Components

Import everything from `@/ds`. Sizes are CSS px.

| Component | Use | Key props | Keyboard |
|---|---|---|---|
| `Button` | Text buttons | `variant`: primary, secondary, destructive, destructive-secondary, ghost, link, tinted; `size`: default 24 / large 32; `icon`, `loading`, `fullWidth`, `tooltip`, `shortcut` | Native button |
| `IconButton` | 24/32 icon buttons | `icon`, `label` (aria-label and tooltip), `tone`: default/secondary, `size`, `tooltipPlacement`, `tooltip={false}` | Native button |
| `ToggleIconButton` | Pressed toggles (clip content, constrain proportions) | `pressed: Mixed<boolean>`, `onPressedChange` | Native button; mixed → on |
| `TextInput`, `TextArea` | Text fields | `label`, `value: Mixed<string>`, `onCommit` (draft) or `onChange` (live), `prefix` (IconName or letters), `suffix`, `variant`: filled/outlined/ghost, `size`, `invalid`, `onExit` | First click selects all; Enter commits, Esc reverts; ⌘Enter commits a TextArea |
| `NumericInput` | Numbers | `label`, `prefix` (scrub handle), `value: Mixed<number> \| null`, `onChange(v, info)`, `onCancel`, `onClear`, `onStep`, `min`, `max`, `step`, `bigStep`, `precision`, `unit`, `scrub`, `variant` | Arithmetic (`100+20`, `48/2`); a typed unit is ignored; ↑↓ step (⇧ big step); drag the prefix: 1 unit/px, ⇧ ×10, ⌥ ×0.1 |
| `Swatch` | Colour chit | `color`, `opacity` (0–100: a split solid/alpha chit), `shape`: square 14 / round 16, `mixed` | – |
| `ColorInput` | A fill row | `color`, `opacity`, `onColor(hex, info)`, `onOpacity`, `onSwatchClick(rect)` (open your picker), `swatch` (override) | Hex: 3 or 6 digits, with or without #, or a colour name |
| `SearchField` | Search boxes | `value`, `onChange`, `size`, `onSubmit`, `onExit` | Esc clears, then a second Esc leaves; ↓ calls `onExit("tab")` |
| `Select` | Dropdowns (Figma's, never native) | `label`, `value: Mixed<string>`, `options` (`{value, label, icon?, hint?, disabled?}` or `"-"`), `variant`: filled/outlined/ghost, `prefix`, `width` (px or "hug") | Enter, Space or ↓ opens with the checked item over the trigger; ↑↓ Home End, typeahead, Enter picks, Esc closes |
| `ContextMenu`, `MenuButton` | Menus | `entries: MenuEntry[]` (`{id, label, shortcut?, accelerator?, hint?, icon?, checked?, disabled?, items?}`, `"-"`, `{header}`), `onSelect(id)`, `onClose`, `renderer: "native"` (OS menu through `window.designer.menu.popup`), `above` | ↑↓ Home End, typeahead, → or Enter opens a submenu, ← or Esc goes back, Enter or Space picks. Hover intent and a safe triangle protect submenus |
| `keys([...])` | Shortcut text | `keys(["mod","shift","h"])` → ⇧⌘H on a Mac, Ctrl+Shift+H elsewhere | – |
| `Checkbox`, `Switch`, `RadioGroup` | Booleans and choices | `checked: Mixed<boolean>` / `checked` / `value` + `options` | Space toggles; radios use arrows (roving tabindex) |
| `SegmentedControl` | Icon or text segments | `value: Mixed<string>`, `options` (`{value, label?, icon?, tooltip?, shortcut?}`), `tone`: panel/toolbar, `fullWidth` | ← → move and select |
| `Tabs` | Design / Prototype | `value`, `tabs` (`{value, label, badge?}`), `idBase` (wires `aria-controls`) | ← → Home End |
| `PanelSection` | A panel section | `title`, `actions`, `empty` (secondary title; pass only "+"), `collapsible`, `open`, `onOpenChange(open, alt)`, `pad` | Header button when collapsible |
| `PropertyGrid`, `PropertyRow` | The right panel's grid | Grid `labels`; row `span` 1/2, `action` (the 24 column), `label` | – |
| `LayerRow` | The layer tree | `id`, `depth`, `name`, `icon`, `kind`, `expanded`, `selected`, `selectedAncestor`, `hovered`, `locked`, `hidden`, `strong`, `renaming`, `run` (start/middle/end/single), `drop` (before/after/inside), `onToggleExpand(alt)`, `onToggleLock`, `onToggleVisible`, `onRename(name \| null, exit)`, `onRequestRename` | Enter asks to rename; in rename, Enter, Tab or blur keeps and Esc cancels |
| `PageRow` | Pages | `id`, `name`, `current`, `renaming`, `divider`, `onSelect`, `onRename` | Enter or Space selects |
| `ResizeHandle` | Panel edges | `side`, `value`, `min`, `max`, `defaultValue`, `onChange(px, info)` | None (Figma); double-click resets |
| `Dialog` (= `Modal`) | Modals | `title`, `size` (320/480/640), `open`, `onClose`, `footer`, `initialFocus`, `closeOnScrim`, `static` | Focus trap; Esc closes; Enter clicks the primary/destructive button; focus returns on close |
| `Popover`, `FloatingPanel` | Property windows, pickers | `anchor` (element or rect), `placement` (`left-of-panel`, which needs `data-panel` on the right panel, `bottom-start`, …), `title` (40px draggable header), `headerActions`, `width`, `static` | Esc or an outside press closes it; focus moves in but isn't trapped |
| `showToast`, `dismissToast`, `Toast` | The visual bell | `showToast({ message, kind: default/error/success, action: {label, onAction}, duration })` | One at a time; 4s (8s with an action), paused on hover |
| `TabBar` | The desktop tab bar (presentational) | `tabs` (`{id, title, dirty?}`), `active`, `onActivate`, `onClose`, `onMove(id, toIndex)`, `onContextMenu(id, at)`, `onNew`, `trailing`, `fullScreen` | ← → between tabs; middle-click closes; drag to reorder (4px threshold) |
| `Toolbar`, `ToolbarGroup`, `ToolbarDivider`, `ToolButton`, `HelpButton` | The bottom toolbar | Toolbar `floating`, `offset` (to centre on the window); ToolButton `icon`, `label`, `shortcut`, `active`, `onSelect`, `menu`, `onMenuSelect` | Buttons; a chevron opens the tool menu upwards |
| `Rail`, `RailItem`, `RailSeparator` | The 48px left rail | `icon`, `label`, `shortcut`, `active` | ↑↓ move focus |
| `SidebarItem`, `SidebarHeader` | Home navigation | `icon`, `label`, `selected`, `count`, `indent`, `trailing`, `dropTarget` | Buttons |
| `FileCard`, `FileRow` | Home files | `id`, `title`, `subtitle`, `thumbnail`, `starred`, `selected`, `renaming`, `onOpen`, `onSelect`, `onContextMenu`, `onRename`, `onStar` | Enter opens, Space selects |
| `Badge`, `Avatar`, `Spinner`, `EmptyState`, `Divider`, `Kbd`, `CodeBlock` | Support pieces | See each file's doc comment | – |
| `FolderCard`, `FolderGlyph` | Home folders | FileCard's props plus `thumbnails` (≤ 4), `color`, `dropTarget` | Enter opens, Space selects |
| `ListHeader`, `ListRow` | List views | `columns` (`{id, label, width?, align?, sortable?}`), header `sort` + `onSort` (`nextSort`); row `cells` by column id, `selected`, `dropTarget`, `muted` | Enter opens, Space selects |
| `CollectionView` | Home's grid / list (selection, keys, marquee) | `layout`, `label`, `header`, `onNavigate(id, extend)`, `onSelectAll`, `onClearSelection`, `onDelete`, `onMarquee(ids, {additive, final})`; pair with `useSelection(order)` | Arrows by layout, Home End, ⌘A, Esc, ⌫ |
| `Breadcrumb` | Where you are | `items` (`{id, label, icon?}`), `onNavigate`, `menu` + `onMenuSelect` (the current place's menu), `maxItems` | Buttons; the fold and the current place open menus |
| `InlineEdit` | Rename in place | `value`, `editing`, `onCommit`, `onCancel`, `onEditingChange`, `select` (all / name / end), `editOnDoubleClick` | Enter, Tab or blur keeps; Esc cancels |
| `Banner`, `Skeleton` | Notices in a page; loading blocks | Banner `tone`, `icon`, `action`, `onDismiss`; Skeleton `width`, `height`, `radius` | – |
| `ScrollArea`, `VirtualList` | Scrolling | ScrollArea `axis`, `viewportRef(el)`; VirtualList `count`, `rowHeight` (fixed), `renderRow`, `scrollToIndex` | Native scrolling, with overlay thumbs that can be dragged |
| `Icon` | Glyphs | `name: IconName`, `size`, `label` | – |

### Example: a right-panel section

```tsx
<PanelSection title="Frame" actions={<IconButton icon="24.styles" label="Apply styles" tone="secondary" />}>
  <PropertyGrid>
    <PropertyRow>
      <NumericInput label="Width" prefix="W" value={w} onChange={(v, info) => preview(v, info.final)} onCancel={revert} />
      <NumericInput label="Height" prefix="H" value={mixedHeight ? MIXED : h} onChange={setH} onStep={nudgeEachH} />
    </PropertyRow>
    <PropertyRow span={2} action={<IconButton icon="24.minus.small" label="Remove fill" tone="secondary" />}>
      <ColorInput label="Fill" color={hex} opacity={pct} onColor={setHex} onOpacity={setPct} onSwatchClick={openPicker} />
    </PropertyRow>
  </PropertyGrid>
</PanelSection>
```

## 6. Icons

- `ds/icons/registry.ts` is generated by `npm run icons` from `ds/icons/svg/<box>/<name>.svg` (236 glyphs, named `<box>.<name>`: `24.frame`, `16.chevron.down`, `24.close.small`, `24.home`, `24.help`…). The SVGs were exported once from the legacy sets: `components/admin/figmaKitIcons.ts` (the UI3 kit export, which won on duplicates), `components/admin/figmaIcons.tsx` and `app/icons.tsx`.
- `<Icon name="24.plus.small" />` draws an inline SVG in `currentColor`. A 24 icon fills its whole 24px box, with the glyph in the middle; a 16 icon fills 16. The kit's secondary tone is drawn at a third of the colour's opacity.
- To add an icon, drop an SVG into `ds/icons/svg/16/` or `ds/icons/svg/24/`. Either Figma's own export (`fill-opacity` 0.9 is primary and 0.3 secondary; even-odd is kept) or a stroked drawing (`stroke="currentColor"`; a `viewBox` of `-4 -4 24 24` is a 16px drawing in a 24 box). Then run `npm run icons`. `icons.test.ts` fails while `registry.ts` is out of date.
- The kit glyphs are for this personal app only; don't redistribute them.

## 7. The Gallery

- **In the app:** open `?gallery` (`main.tsx` routes it to `ds/Gallery.tsx`). In a browser, `npm run web` and then `http://localhost:5199/?gallery`.
- **URL parameters:** `theme=both|light|dark`, `section=tokens|icons|components|screens`, `component=<name filter>`, `static=1` (no animations or carets, for screenshots).
- **Sections:**
  - Tokens: every colour read back with `getComputedStyle`, the engine palette, type, spacing, radii, elevation, sizes, z-index and motion.
  - Icons.
  - Components: every state, forced with the `data-*` attributes, each cell tagged `data-gallery-id="<Component>/<variant>/<size>/<state>"`.
  - Screens: an editor and Home at 1512 × 945, built only from DS components.
- **Reference overlay:** above each screen, "Reference…" opens a Figma screenshot over it at 1/1.3228 (the owner's screenshot scale), at 50% opacity or in Difference mode. The arrow keys nudge it 1px, Shift+arrow 10px.

## 8. Tests

`npm test` runs `src/renderer/src/ds/__tests__/*.test.ts` in Node. They cover:

- tokens: the 174 names and light values against `figma-color-tokens-light.txt`, light/dark parity, colour parsing, the frozen chrome palette, `tokens.css` in sync, and every `var()` defined;
- the no-raw-values rule;
- `evaluate` and stepping/scrubbing;
- `keys()`;
- the menu model (tidy, navigation, native template, safe triangle), typeahead and roving focus;
- floating placement;
- the theme's pure parts;
- the icon registry;
- tab drop index, scroll thumbs, virtual list range, initials and colour parsing.

- the generators: `tokens.test.ts` and `icons.test.ts` run the same checks as `npm run tokens -- --check` and `npm run icons -- --check`;
- relative times.

Component tests run in happy-dom (`// @vitest-environment happy-dom` per file; helpers in `__tests__/dom.ts`; plain `.test.ts` files with `createElement`, because Vitest only picks up `*.test.ts`). They cover NumericInput, ContextMenu, Select, ColorPicker, AlignmentMatrix, EditorToolbar, TabBar (drag), ScrollArea, Dialog (focus), and the file-browser pieces (CollectionView, ListHeader/ListRow, InlineEdit, Breadcrumb, FolderCard, Banner). The selection model, arrow-key targets and list helpers are tested in Node (`selection.test.ts`).

## 9. Not done yet

See "Status at handoff" at the top. Still open outside `ds/`:

- a `gallery.html` entry, `npm run gallery` and `gallery:shots`;
- the ESLint `no-restricted-imports` and Tailwind rules for `ds/**`;
- **migration**: mount `<TooltipManager/>` and `<ToastHost/>` in each entry, replace `context/ThemeContext.tsx` with `ds/theme.ts`, and move the legacy screens onto these components (contract §4.35).
