# 02 — Editor chrome (UI3): toolbar, panels, layers, pages

Figma Design desktop 126.9.13, read 2026-10-16 from the cached editor build (`~/.cache/figma-rea/figma/`, outside the
repo) under `~/.cache/figma-rea/BRIEF.md`. Figma's code is not copied here: this file records behaviour, numbers,
enums and strings, each with its evidence. CONFIRMED = read directly in the build or a live capture; INFERRED =
deduced from code shape or naming.

## 1. Scope and sources

**Scope.** Everything around the canvas in the Design editor: the bottom toolbar (toolbelt) and its flyouts, the left
navigation rail, the left panel (file header, Pages, Layers, Assets), the right panel (header, Design / Prototype tabs,
zoom and view menu, Share / Present, multiplayer avatars), panel widths and resizing, Minimize UI / Show-Hide UI, the
number-field component (scrub, nudge, expressions, Mixed), the file name menu, the Main menu, tooltips, the canvas
contextual toolbars, and toasts ("visual bells"). Section contents of the Design panel are owned by chapters 07, 09, 10
and 13; this chapter keeps only their order and headers. Shortcuts are listed only where they belong to the chrome
(chapter 03 owns the full table).

**Sources read**

| Source | What it gave |
|---|---|
| `figma_app.min.js` (8.2 MB) | The SCSS design-constants object (≈1 700 keys: toolbelt, panel, row, tooltip, visual-bell sizes) around the key `devHandoffDefaultLeftPanelWidth`; the left-panel container (`LoadedLeftPanel`, defaults 240 / 240 / 500); the tooltip manager (default delay, hide delay, warm re-show); the toolbelt tool groups (`moveFlyout`, `regionFlyout`, `shapeFlyout`, `penFlyout`, `typeFlyout`, `commentsFlyout`, `codeFlyout`); the scrubbable control defaults; the page-limit table; the page-divider gate; EditorPreferences getters (`pagesPanelHeight`, `propertiesPanelSplitPosition`, `leftNavigationBarMinimized` …). |
| `5581.min.js` | The properties-panel container: resize min / max, the locale width multiplier, the Buzz-only 290 px minimum. |
| `5904.min.js` | The Layers panel ("ObjectsPanel"): scroll-to-selection, sticky headers, drag threshold, hover-to-expand while dragging; the zoom / view menu (`zoom_menu`). |
| `813425` module (in `figma_app`) | The object-row size context (row height, selection gap, icon size, bold names). |
| `7290.min.js` | The Pages panel row (divider rendering, titled dividers, page status). |
| `5519.min.js` module 421124 | The page-divider name rules (regexes). |
| `3187.min.js` | The ScrubManager (scrub math, wheel batching, the wrapping cursor) and the field expression evaluator (operator table). |
| `7621.min.js` / `2108.min.js` | The FPL visual bell (one-at-a-time queue, timeout rules, halving when queued, icons). |
| `2b17fec9.min.js` | The editor file-name dropdown (`EDITOR_FILENAME_DROPDOWN`) item list. |
| `fullscreen__fullscreen-wasm__compiled_wasm.wasm` @47251835–47316004 | The keyboard-shortcut JSON (`keyboard-shortcuts.schema.json`, 261 actions) for the chrome actions. |
| Repo, live captures | `docs/research/figma/live/`: `toolbar/*.txt`, `left/*.txt`, `menus/*.txt`, `design/*.txt` (RIGHT / LEFT sections), `behaviour/{layers,pages,ui,fields,keyboard}.md`, `left/rail-assets-page-components.txt` (full 1440×900 frame: rail, header, tabs). These are live Figma captures of the same version line; they give the English text and pixel positions. |
| Repo, prior research | `docs/research/figma/R6-ui3.md` (tokens), `R7-editor.md` (checklist). Summarised here, not repeated. |

No English locale file is in the build (only i18n keys); English labels come from the live captures, the repo's
`src/shared/i18n`, or are written as keys.

**Prior work in one line each.** R6 lists the `--figma-color-*` token values light / dark and left panel widths,
row heights and toolbar size as "unverified" — this chapter settles them (§3, §5, §6). R7 lists tools and shortcuts
as a parity checklist — §2 gives the exact toolbelt order and flyouts.

## 2. Bottom toolbar (toolbelt)

### 2.1 Geometry

| Name | Value | Unit | Evidence | Status |
|---|---|---|---|---|
| Toolbelt height | 48 | px | consts `toolbeltHeight:"48px"`, `designToolbarHeight:"48px"` | CONFIRMED |
| Toolbelt bottom margin | 12 | px | consts `toolbeltBottomMargin:"12px"`; `toolbeltHeightAndMargin:"60px"` | CONFIRMED |
| Inner padding | 8 | px | consts `toolbeltElementPadding:"8px"`; live: first button at 8,8 | CONFIRMED |
| Live size (Design, nothing selected) | 529 × 48 at x 456, y 840 in a 1440×900 window | px | `live/toolbar/bottom-toolbar.txt` | CONFIRMED |
| Tool button | 32 × 32, radius 5 | px | live `8,8 32x32 button [Move] … r=5px` | CONFIRMED |
| Flyout chevron | 16 × 32, joined to the tool button (group 49 × 32) | px | live `41,8 16x32 button [Move tools]` | CONFIRMED |
| Gap between groups | 8 (group pitch 57) | px | live x = 8, 65, 122, 179, 236, 293, 350 | CONFIRMED |
| Active tool | bg `#0c8ce9` (brand), PRESSED | — | live `bg=#0c8ce9 r=5px PRESSED` | CONFIRMED |
| Divider before the mode switch | 1 × 48, `#444444` | px | live `390,0 1x48 div bg=#444444` | CONFIRMED |
| Mode segmented control | height 32, padding 2, option 28 wide (hit target 30), option gap 2 | px | consts `toolbeltModeSegmentedControl{Height:32px,Padding:2px,OptionWidth:28px,OptionHitTargetWidth:30px,OptionGap:2px}` | CONFIRMED |
| Secondary (contextual) toolbelt | height 40, 8 above the toolbelt | px | consts `secondaryToolbeltHeight:"40px"`, `secondaryToolbeltBottomMargin:"8px"` | CONFIRMED |
| Toolbelt banner | 40 tall, overlaps the secondary toolbelt by 8 | px | consts `toolbeltBannerHeight`, `toolbeltBannerSecondaryToolbeltOverlap` | CONFIRMED |

### 2.2 Order and flyouts (Design mode)

Order left → right (CONFIRMED, `figma_app` design toolbelt + live):

| # | Group (tooltip key) | Recording key | Items in order (shortcut) |
|---|---|---|---|
| 1 | Move tools (`fullscreen.flyout.move_tools`) | `moveFlyout` | Move V · Hand H · Scale K (disabled in some modes) |
| 2 | Region tools (`fullscreen.flyout.region_tools`) | `regionFlyout` | Frame F (also A) · Section ⇧S · [Code component — gated `bake_canvas`] · Slice S |
| 3 | Shape tools (`fullscreen.flyout.shape_tools`) | `shapeFlyout` | Rectangle R · Line L · Arrow ⇧L · Ellipse O · Polygon · Star · Image/video… ⇧⌘K |
| 4 | Drawing tools (`fullscreen.flyout.drawing_tools`) | `penFlyout` | Pen P · Pencil ⇧P |
| 5 | Type tools (`fullscreen.flyout.type_tools`) | `typeFlyout` | Text T · Text on path (only when that feature is on) |
| 6 | Comment tools (`fullscreen.flyout.comment_tools`) | `commentsFlyout` | Comment C · Annotation Y / ⇧T · Measurement ⇧M · [Sticky, Stamp — lab `collab-tool-shortcuts-in-design`] |
| 7 | Code tools (`fullscreen.flyout.code_tools`) | `codeFlyout` | gated (`bake_canvas_toolbelt_entry`, `fspc_0`); absent in a normal file |
| 8 | Actions (tooltip `qa.extensions.tooltip_actions`) | — | single button; opens the Actions palette (⌘K / ⌘P / ⌘/, action `toggle-menu`) |
| — | divider, then the mode switch | — | Draw (`illustration`) · Design · Motion (`metronome`, Beta) · Dev Mode (`handoff`, ⇧D) |

Rules:

- A group's main button shows the **active tool** when that tool belongs to the group (`activeToolId` passed into the
  group). CONFIRMED. Which tool it shows after you leave the group (last used or the group's first) is not settled
  statically — INFERRED: last used, as in Figma's UI; see Open questions.
- Choosing **Comment** while the Comment tool is already active returns to **Move** (`COMMENTS && active===COMMENTS ?
  SELECT`). CONFIRMED (`figma_app`).
- Picking an edit-mode tool from a group first runs `leave-edit-mode`. CONFIRMED.
- In Dev Mode the left side shows only Move (labelled `fullscreen_actions.set-tool-default-dev-handoff`); in Draw
  (`illustration`) the comment group shrinks to Comment only. CONFIRMED.
- Flyout menus: 196 px wide, 24 px rows, a title row ("Shape tools"), check-mark gutter, shortcut right-aligned at
  70 % white; the checked row has a brand `#0c8ce9` 180 × 24 pill, radius 5. CONFIRMED (`live/toolbar/shape-tools-menu.txt`).
- Mode switch: an option tooltip (`motion_beta_special_tooltip`), a toast on switch (`…segmented_control.switched_to_
  {design,dev_mode,draw}`), and Alt+Tab / ⌥⇧Tab quick toggle behind the flag `mode_quick_toggle`. CONFIRMED (keys +
  shortcut JSON).

### 2.3 Contextual (secondary) toolbars

Shown as a second, 40 px bar 8 px above the toolbelt (consts above). Close key `fullscreen.toolbar.secondary_toolbar.close`.

| Context | Items (keys, in source order) | Evidence | Status |
|---|---|---|---|
| Image selected (`image-secondary-toolbar`) | Edit image with prompt (`fullscreen_actions.edit_image.with_prompt`) · Upscale (`upscale_image`) · Expand (`expand_image.shortened`) · Vectorize (`vectorize-image`) · Remove background (`remove_background`) · Lasso select (`fullscreen.toolbar.image.lasso_select`) · Crop (`…image.crop`) · More (`…image.more`) · Visual search (`fullscreen.toolbar.visual_search`) | `figma_app` around `fullscreen.toolbar.image.aria_label` | CONFIRMED (order of rendering INFERRED from source order) |
| Crop mode | Crop label, a slider (`…crop.slider.aria_label`), aspect-ratio presets (Landscape / Portrait, `whiteboard.crop_presets.*`), Resize to fit (`…crop.resize_to_fit.tooltip`) | same | CONFIRMED |
| Vector edit | Move, Lasso, Paint, Bend, Cut, Erase, More ▾, ✕ | `live/toolbar/vector-edit-toolbar.txt`; chapter 05 | CONFIRMED |
| Offset path | slider (`offset-path-slider-label`), join Round / Square, Apply / Cancel | keys `fullscreen.toolbar.offset-path-*` | CONFIRMED |
| Simplify vector | Threshold slider ("Simpler" ↔ "More detailed"), Apply / Cancel | keys `fullscreen.toolbar.simplify_vector.*` | CONFIRMED |
| Recolor (image / vector) | Full color / Grayscale / Black and white, Number of colors / grays, B&W threshold, Done | keys `fullscreen.toolbar.recolor.*` | CONFIRMED |
| Dev Mode inspect | Re-center (`dev_handoff.recenter`, runs `zoom-to-selection`), frame counter ← → | `secondary_toolbelt_for_dev_mode_inspect` | CONFIRMED |

## 3. Left navigation rail and left panel

### 3.1 Navigation rail

| Name | Value | Evidence | Status |
|---|---|---|---|
| Rail width | 57 (56 + 1 border) | live `0,0 57x900 toolbar [Navigation Bar]` | CONFIRMED |
| Main menu (Figma logo) button | 32 × 32 at 12,8 | live `[Main menu]` | CONFIRMED |
| Items | File · Agents (`design.navbar.chat`) · Assets · Tools · Variables (`design.navbar.variables_view`); 56 × 56 cells, 9 px / 450 labels; the active one has a 32 × 32 `#394360` pill | live `rail-assets-page-components.txt`; keys `design.navbar.{file,assets,tools,variables_view,chat}` | CONFIRMED |
| Minimise the rail | View › "Minimize left navigation bar" (pref `leftNavigationBarMinimized`) | live `menus/main-view.txt`; EditorPreferences getter | CONFIRMED |
| Variables | opens a full-window view (`view=variables`) that replaces the canvas | live README | CONFIRMED |

### 3.2 Left panel geometry

| Name | Value | Unit | Evidence | Status |
|---|---|---|---|---|
| Default width | 240 | px | `figma_app` left panel wrapper `defaultWidth:i=240` | CONFIRMED |
| Min width | 240 | px | same, `minWidth:s=240` | CONFIRMED |
| Max width | 500 | px | same, `maxWidth:o=500` | CONFIRMED |
| Double-click on the handle | resets to the default width (240) | — | `doubleClickDefaultSize:u` (= defaultWidth) | CONFIRMED |
| Resize handle | 8 px wide, on the panel's right edge (`side:"right"`) | px | live `295,0 8x900 slider [Resize handle]`; code `side:"right"` | CONFIRMED |
| Rulers during resize | "ghost rulers" while dragging when canvas update is deferred | — | `shouldShowGhostRulers`, `shouldDeferCanvasUpdateOnPanelResize` | CONFIRMED |
| Rendered width | 241 (240 + 1 border) | px | live `57,0 241x900 div` | CONFIRMED |
| Panel header (Assets) | 49 tall, title 13 px / 550 | px | live `240x49`, `"Assets" 13px/550` | CONFIRMED |
| Section title (Pages / Layers) | 11 px / 550 at x 16 | — | live `"Pages" 11px/550` | CONFIRMED |
| Header icon buttons | 24 × 24, radius 5 (`iconButtonSizeUI3:"24px"`) | px | live; consts | CONFIRMED |
| Full-height sidebar header | 40 tall, margin 12 | px | consts `ui3FullHeightSidebarHeaderHeight`, `ui3FullHeightSidebarMargin` | CONFIRMED |
| Scrollbar area | 12 (UI3), bar 6 | px | consts `ui3ScrollbarAreaThickness`, `scrollBar{X,Y}…6px` | CONFIRMED |

### 3.3 File header and file name menu

The file name sits above Pages (key `fullscreen.filename_view.file_input_title`, placeholder `…title_placeholder`).
Clicking it opens the file-name dropdown (`EDITOR_FILENAME_DROPDOWN`). Item order (CONFIRMED, `2b17fec9` `e4=[…]`,
each line conditional on permissions / file type):

1. Branch items (only on a branch).
2. Add to sidebar / Remove from sidebar (Starred) · Pin to workspace / Edit pin / Remove pin.
3. — separator —
4. Show version history / Hide version history (`fullscreen.filename_view.version-history-{show,hide}`).
5. Library actions (`library_actions`) → Publish styles and components (`publish-styles-and-components`).
6. Code Connect (`dev_handoff.component_browser.menu_item`, when available).
7. View file analytics (`file_analytics`).
8. Export (`export`, runs `export-selected-exportables`).
9. Copy page to Figma Slides (when available).
10. — separator — then the **File color profile** submenu: sRGB / Display P3 with a check, and "Assign/Convert to …"
    (`change-document-color-profile-to-srgb` / `…-display-p3`); a legacy file shows the legacy-assign variants.
11. — separator — Duplicate (`duplicate`, `duplicate-to-drafts`, `duplicate-as-new`) · Rename (`rename` /
    `rename-branch`) · Restore (literal "Restore", trashed files) · Go to project · Move to project (`move_file`) ·
    Move to trash (`move_to_trash`) / Archive branch / Delete branch.
12. — separator — Restore default thumbnail (`restore_default_file_thumbnail` or `restore_default_thumbnail`) when a
    custom thumbnail is set.

Badges next to the name: `view-only`, `locked`, `free`, `drafts` (keys `fullscreen.filename_view.*`). CONFIRMED (keys).

### 3.4 Main menu (Figma logo)

Top level (CONFIRMED, `live/menus/main-menu.txt`): Back to files · Actions… ⌘K · File · Edit · View · Object · Text ·
Arrange · Vector · Plugins · Widgets · Preferences · Libraries · Open in desktop app (browser only) · Help and account.
Menu text 11 px / 450, highlight `#0c8ce9` radius 5, check gutter 32 px, shortcuts at 70 % white (live README).
The submenus are chapter 03's. The View menu's chrome items, in order (live): … Memory usage · Additional labels ▸ ·
Minimize left navigation bar · Minimize UI ⇧⌘\ · Show/Hide UI ⌘\ · Multiplayer cursors ⌥⌘\ · Switch to Draw ·
Switch to Dev Mode ⇧D · Panels ▸ (Open layers panel ⌥1, Libraries ⌥2, Open design panel ⌥8, Open prototype panel ⌥9,
Toggle variables) · Zoom in ⌘+ · Zoom out ⌘– · Zoom to 100% ⌘0 · Zoom to fit ⇧1 · Zoom to selection ⇧2 · Previous
page / Next page (fn↑ / fn↓) · Zoom to previous / next frame ⇧N / N · Find previous / next frame Home / End.
The code's View list (`7621`) has the same actions in the same order (`toggle-sidebar`, `toggle-ui`,
`toggle-multiplayer-cursors`, `enter-design-mode`, `enter-draw-mode`, `enter-inspect-mode`, `panels-menu`, zoom group,
page group, artboard group). CONFIRMED.

### 3.5 Pages

| Name | Value | Evidence | Status |
|---|---|---|---|
| Row height | 32 (pill 24 tall, 224 wide, inset 8) | consts `pageRowHeight:"32px"`, `ui3PageRowHeight:"24px"`; live rows at y 44 / 76 / 108 | CONFIRMED |
| Divider row height | 16 | consts `pageDividerRowHeight:"16px"` | CONFIRMED |
| Active page | text weight 550, row bg `#383838` | live `"Capture" 11px/550`, `bg=#383838` | CONFIRMED |
| Header buttons | Find (24 × 24 at 180,8), Add new page (208,8) | live | CONFIRMED |
| Pages / Layers split | an 8 px "Resize handle" slider between them; the pages list keeps a fixed height with its own scroll | live `0,142 240x8 slider [Resize handle]`; `behaviour/pages.md` | CONFIRMED |
| Persisted | `pagesPanelHeight`, `pagesPanelIsOpen` (EditorPreferences) | `figma_app` getters | CONFIRMED (min / max of the split not found) |
| "+" | creates "Page N" and opens it in inline rename with the name selected; Enter commits | live `pages-add-page-rename.txt` | CONFIRMED |
| Page limit | Starter (free) team or no team: **3 pages** per Design file (FigJam 1; Slides / Sites / Buzz / Make / Spec 3); paid: unlimited. Hitting it opens the Pro upsell (`CREATE_PAGE`, entry point `CREATE_NEW_PAGE`) instead of creating | `figma_app` 586815 `A={DESIGN:3,WHITEBOARD:1,…}`, `t>=L(e)` | CONFIRMED |

**Divider pages** (CONFIRMED, `5519` module 421124 and `figma_app` 682485):

- A page is a divider when it has **no children** and its name matches `^(-+|–+|—+|\*+|\s+)$`: one or more hyphens,
  en dashes, em dashes, asterisks, or only whitespace. So "-" and "***" are dividers; "– Divider test" is not (live
  agrees).
- **Titled dividers** (gate `uxp_page_divider_title`): a name of 2+ `-`, `–`, `—` or `*` followed by text
  (`--- Components`) is a divider with the title "Components", unless the title itself is all dashes. Renaming a
  divider writes `--- <title>`; an empty title writes `---`.
- A divider is drawn as a thin rule (or a rule plus the small title), has no hover, no page-type icon, and is skipped
  by batch rename and by the page counts used for limits.
- Page row context menu (live): Copy link to page · Rename page · Duplicate page · Move up · Move down · Move to top ·
  Move to bottom · Delete page. Screen-reader announcements for moves (`pages_moved_{up,down,to_top,to_bottom}_announcement`).
- `Page Up` / `Page Down` = previous / next page (shortcut JSON `page-previous` / `page-next`).
- Page status (gate `page_status`) and archived pages (`show_archived_pages` / `hide_archived_pages`) exist behind flags.

### 3.6 Layers

**Row geometry** (CONFIRMED, `figma_app` 813425 object-row context; live dumps):

| Name | Value | Unit | Evidence |
|---|---|---|---|
| Top-level row height | 32 | px | `topLevelObjectRowHeight:32` |
| Nested row height | 32 | px | `nestedObjectRowHeight:32` |
| Selection gap (pill inset top/bottom) | 4 → selected pill 24 tall, inset 8 left | px | `rowSelectionGap:4`; live `8,-479 247x24 div r=5px` |
| Drop insertion-line offset | 4 | px | `insertionLineBoxOffset:4` |
| Icon size | 16 (top-level and nested) | px | `topLevelIconSize:16`, `nestedIconSize:16` |
| Bold names | on (`boldLayerNames:!0`) | — | INFERRED: top-level frames bold |
| Indent per level | 24 (icon x 28 → 52 → 76) | px | live; consts `indentWidthWithMargin:"24px"` (`indentWidth:"16px"` + margin) |
| Text | 11 px / 400; component and instance rows purple `#d1a8ff` (dark) | — | live |
| Hover row bg | `#383838`; selected `#394360`, selected children `#32394d` | — | live README |
| Chevron | always drawn at 40 % white, not hover-only | — | `behaviour/layers.md` §6 |
| Row actions | lock and eye on hover (48 wide, gap 4, right margin 12) | px | consts `rowActionsWidth`, `rowActionsGap`, `rowActionsRightMargin` |
| Slides / Buzz variant | 40 / 32 rows, 32 / 24 icons, no bold, gap 0 | — | the alternate context object |

**Icons per node type.** Tooltip keys `layer_icon.tooltip.*`: frame, auto_layout, layout (grid), group, section,
component, variant, instance, slot, rectangle, ellipse, line, polygon, star, vector, text, image, video, mask, union,
subtract, intersect, exclude, slice, transform, table, sticky, connector, shape_with_text, stamp, widget, embed,
link_preview, code_layer, code_component, code_instance, code_block, code_library, code_connect, native_code_layer,
webpage, repeater, module, canvas, home, slide, audio, weave, cms_rich_text. Live aria labels: Frame, Auto layout,
Component, Variant, Instance, Text, Section, Group, Rectangle, Union, Ellipse, Vector, Line, Star, Polygon. Row
variants in CSS: `object_row--{frame,group,section,componentLike,instance,instanceChild,mask,slot,stack,module,
codeComponent,codeInstance,immutableFrame,locked,disabled,reversed,highlight,hovered,selected,parentSelected,
layerAboveSelected,layerBelowSelected}`. CONFIRMED (keys / class names).

**Order.** A plain frame lists its last child (highest z) on top; an auto-layout frame lists children in flow order,
first on top (`behaviour/layers.md` §1). With `stackReverseZIndex` the order follows the canvas stacking (chapter 09).

**Behaviour** (CONFIRMED unless marked):

| Rule | Value | Evidence |
|---|---|---|
| Canvas selection → row | If the row is not built yet, the parent is expanded first (`X.hq(parentGuid)`) and the scroll happens after the update | `5904` `scrollToNode` |
| Scroll only when needed | Only when the row is outside the visible area (or needs horizontal autoscroll for deep nesting) | `isVerticallyVisible`, `shouldHorizontallyAutoscroll` |
| Scroll target | Row above the view → aligned to the top (minus the sticky header height when an ancestor is sticky); row below → placed at **mid-height** (`scrollTo(top − viewHeight/2)`) | `scrollNodeIntoView` |
| Sticky headers | An expanded container's row sticks at the top while its children scroll | `stickyHeaderGuid`, `determineStickyHeader` |
| Reopen left panel | scrolls to the top selected node | `onLeftPanelCollapsedChange` |
| Scroll settle | "is scrolling" ends 200 ms after the last scroll event (hover is suppressed meanwhile) | `setTimeout(this.doneScrolling,200)` |
| Drag threshold | 3 px from mouse-down before a drag starts | `distanceTo(...)>3` |
| Drop target | from the pointer Y and the X offset from mouse-down (X decides nesting depth) | `OL(…, e.clientX-mouseDown.x, …)` (INFERRED meaning) |
| Autoscroll while dragging | when the pointer leaves the list top / bottom, speed from the distance and the 32 px row height | `bm(distance, topLevelObjectRowHeight)` |
| Hover-to-expand while dragging | pointer in the **middle third** of a collapsed container that has children for **1000 ms** → it expands | `expandDropTargetIfNeeded`, `setTimeout(…,1e3)` |
| Snap feedback | a haptic "SNAP" when the drop index changes (trackpad haptics) | `F.H.trigger(x.JA.SNAP)` |
| Click | toggles / selects; ⇧-click range-selects from an anchor (`rangeSelectAnchorNodeId`) | `toggleSelected` |
| Keyboard after a row click | focus stays on the canvas input: Enter = canvas Enter (enter children / vector edit) | `behaviour/layers.md` §2 |
| Rename | double-click the name text (not empty row space) → inline input with all text selected; Esc cancels; ⌘R with one layer renames inline, with several opens "Rename N layers" (Match, Rename to, Current name / Number ↑ / Number ↓, Start ascending from) | live |
| Chevron | click toggles; ⌥-click toggles recursively | live |
| Collapse layers | ⌥L collapses every expanded row (button "Collapse layers" in the Layers header at 208,8) | shortcut JSON `collapse-layers: Alt+L`; live |
| Drag across eye icons | hides every row it crosses (same for lock, INFERRED) | live |
| Thumbnail icon | double-clicking a layer's thumbnail icon pans the canvas to it (`layer_icon.button.pan_to_node`) | `5904` |
| Instance internals | instance children can be "temporarily expanded" (`temporarilyExpandedInstanceLayers`) | `5904` |

**Find / filter.** The search button in the Pages header replaces the whole left panel with a find view (⌘F
`canvas-search`, ⇧⌘F next, ⇧⌘D previous). Filter menu: Find / Replace, All / Text / Frame-Group / Component /
Instance / Image / Shape / Other, Match case, Whole words (live `left/find-filter-menu.txt`).

### 3.7 Assets tab

From the live capture (`left/rail-assets*.txt`): header "Assets" (13 / 550) with a Libraries button; a search field
(180 × 24, "Search in this library"), a "Libraries and settings" button; a breadcrumb (Back, "Created in this file /
<page>"); library cards ("Created in this file", "N components", "Add more libraries"); per-page component grids of
96 × 96 tiles (radius 10, 2 per row at 240 px) with the name under each, a variant-count badge (16 × 16 "3",
"Includes 3 variants"), and the instruction "Press Enter or Space to insert. Press Command+Enter to view details.".
Build sizes: tile grid padding 16 (`tilePaddingGridUI3`), list rows 32 / 48 (`tileHeightList`, `tileHeightListLarge`),
list thumbs 24 / 40, `localComponentsHeaderHeight` 40, insert modal 320 × 680 (`figmaInsertModal{Width,Height}`).
Grid columns adapt to the sidebar width (`componentLayouts` from `sidebarWidth`, normal / wide / small presets:
small = 3–5 columns, aspect 1, max height 72). CONFIRMED (consts + `figma_app`).

## 4. Right panel

### 4.1 Geometry

| Name | Value | Unit | Evidence | Status |
|---|---|---|---|---|
| Min width | **241** (240 px + 1) × locale factor, capped at 500 | px | `5581` `th=jz("240px")+1`, locale table `t_` | CONFIRMED |
| Locale factor | 1 for every shipped locale; 1.3 only for the `aal` pseudo-locale | — | `t_={aaa:1,aal:1.3,en:1,…}` | CONFIRMED |
| Max width | 500 | px | `tx=500` | CONFIRMED |
| Default | the persisted `propertiesPanelSplitPosition`; if missing or below the min, the min (241) | px | `E=… g<th ? set(th) : g` | CONFIRMED |
| Buzz only | min 290 | px | `tg=290`, applied when the Cooper (Buzz) editor is active | CONFIRMED |
| Resize handle | on the panel's left edge (`side:"left"`); width saved on drag end | — | `recordingKey:"propertiesPanelContainer.resizablePanel"` | CONFIRMED |
| Header row | 40 tall | px | consts `ui3PropertiesPanelHeaderHeight:"40px"` | CONFIRMED |
| Section rows | 32 tall, inputs 24 tall | px | consts `ui3RowHeight`, `ui3InputHeight` | CONFIRMED |
| Left padding / right margin | 16 / 8 | px | consts `propertiesPanelLeftPaddingUI3`, `propertiesPanelRightMarginUI3` | CONFIRMED |
| Bottom padding | 12 | px | consts `ui3PropertiesPanelBottomPadding` | CONFIRMED |
| Grid | 28 columns (36 wide), 32 px rows, 8 px side padding | — | consts `rightNavGridNumCols`, `rightNavGridNumColsWide`, `rightNavGridRowHeight`, `rightNavHorizontalPadding` | CONFIRMED |
| Panel gap | 12 | px | consts `ui3PanelGap` | CONFIRMED |
| Dev Mode right panel | 320 wide; left 240 | px | consts `devHandoffRightPanelWidth`, `devHandoffDefaultLeftPanelWidth` | CONFIRMED |

### 4.2 Header (top right)

Live, 1440×900, right panel at x 1199 (`left/rail-assets-page-components.txt`), all CONFIRMED:

- Row 1 (y 8–40): **Multiplayer tools** pill 50 × 24, radius 50, with 28 × 28 round avatars (yours first); **Present**
  32 × 32 (left half of a split button) + **Prototype view** chevron 16 × 32; **Share** 55 × 32, brand bg `#0c8ce9`,
  label 11 / 450.
- Row 2 (y 48–72): tabs **Design** (selected, bg `#383838`, 11 / 550) and **Prototype** (11 / 450–550 at 70 % white);
  then at the right the **zoom and view options** button "300%" (62 × 24; aria "300%, zoom and view options").
- Tabs by mode: Design / Prototype in Design mode; Inspect / Plugins in Dev Mode (⌥8 / ⌥9 map to
  `show-design-panel` / `show-prototype-panel` or `show-dev-mode-inspect-panel` / `show-dev-mode-plugins-panel`).
  Analytics event `properties-panel-select-tab`. CONFIRMED (shortcut JSON, `5581`).
- In version history the tabs are replaced by the version-history header; when the right sidebar is a comments /
  version pill, the tabs hide (`showRightSidebarPill`). CONFIRMED (`5581` `tp`).
- Multiplayer menu strings: "Currently viewing", Follow / Unfollow <name>, spotlight, agents rows
  (`fullscreen.toolbar.multiplayer.*`). The maximum number of avatars shown before "+N" was not found (Open questions).

### 4.3 Zoom and view menu

Order (CONFIRMED, `5904` zoom menu component):

1. A text field showing the current zoom ("300%"); typing a number and Enter sets the zoom to n / 100 (`parseInt`);
   Escape blurs; digits, `%`, Enter and Escape are kept from reaching canvas shortcuts.
2. — separator —
3. Zoom in (⌘+) · Zoom out (⌘–) (disabled at the zoom limits) · Zoom to fit (⇧1) · Zoom to 50% · Zoom to 100% (⌘0) ·
   Zoom to 200% — the three percentages are check items (checked when the zoom equals them).
4. — separator —
5. Pixel preview ▸ Disabled / 1x / 2x (Design files only; radio; drives `toggle-pixel-preview` and `toggle-retina-mode`).
6. Pixel grid (⇧') · Snap to pixel grid (⇧⌘') · Layout guides (⇧G) · Rulers (⇧R).
7. — separator — Multiplayer cursors (⌥⌘\) · Property labels (`toggle-show-property-labels`) · Comments (⇧C).
8. — separator — Outlines ▸ (Outlines ⇧⌘O / ⌘Y; Show hidden layers; Show object bounds).
9. Annotations ▸ (Show annotations ⇧Y; Show all categories; one row per category).
10. Prototyping information (⇧E) — Design files, edit access only.

Each choice logs `source:"zoom-menu"`. Width 60 (`zoomMenuWidth`). Property labels default comes from the pref
`showPropertyLabels` and a `property-labels-visible` local-storage key.

### 4.4 Design-panel structure (summary)

Section order per selection (live captures, detailed in chapters 07 / 09 / 10):

| Selection | Sections |
|---|---|
| Nothing | Page (canvas colour + opacity + visibility) · Styles (+) · Export (+) · MCP |
| Frame | header (type ▾ + Create component, Boolean ▾, Edit object, Ready for dev, More) · Position · Layout · Appearance · Fill · Stroke · Effects · Selection colors · Layout guide · Export |
| Auto layout | as Frame with "Auto layout" instead of Layout |
| Shape | Position · Layout · Appearance · Fill · Stroke · Effects · Export |
| Text | adds Typography after Appearance |
| Component / set | Properties first |
| Instance | component name ▾, "From this file", property controls, then the rest |
| Vector edit | Vector · Alignment · Position · Mirroring · Corner radius · Fill · Stroke |
| Grid track selected | a "Grid" panel replaces the Design panel |

Section headers: 11 px / 550 title at x 16, a 24 × 24 action at x 208 ("+": Add fill / Add stroke / Add effect / Add
export settings / Create style; or Apply styles, Apply variable mode, Select matching layers). An empty section's
title is drawn at 70 % white (live "Export" `#ffffffb2`). CONFIRMED.

### 4.5 Number fields (scrubbable inputs)

| Rule | Value | Evidence | Status |
|---|---|---|---|
| Defaults | scrubMultiplier 1, wheelMultiplier 1, small nudge 1, big nudge 10 | `figma_app` `v={scrubMultiplier:1,wheelMultiplier:1,smallNudgeAmount:1,bigNudgeAmount:10}` | CONFIRMED |
| Percent fields | scrubMultiplier 4, wheelMultiplier 2 | `U={...v,scrubMultiplier:4,wheelMultiplier:2}` | CONFIRMED |
| Corner radius | scrub 0.1 × nudge | `scrubMultiplier:.1*n` | CONFIRMED |
| Nudge amounts | from the user's "Nudge amount" preference (small / big); ↑↓ = small, ⇧↑↓ = big | `(0,g.sT)()`; live: 1 and 10 | CONFIRMED |
| Scrub start | press on the field's label / icon and drag horizontally; a commit is made at start and at end | `onScrubBegin`, `Y5.commit()` | CONFIRMED |
| Scrub delta | Δvalue = Δx(px) × scrubMultiplier × 0.5 × precision | `postScrubMultiplier ?? .5` | CONFIRMED |
| Precision by vertical distance | f = Δy / screen height clamped to ±1; above the start: > 12.5 % ×2, > 25 % ×4, > 50 % ×8 (coarser); below: ×½, ×¼, ×⅛ (finer) | `F(e)`, `L(e)` in `3187` | CONFIRMED |
| Snapping | the result snaps to the field's resolution or the nudge amount; with ⇧ (big increment) to the big nudge (10) | `ql(...{snap:!0,coarse:e.isBigIncrement})` | CONFIRMED |
| Cursor | a 24 × 24 custom cursor ("all-scroll" by default) that **wraps around the window edges** | ScrubManager `E={x:24,y:24}`, modulo by `innerWidth` / `innerHeight` | CONFIRMED |
| Wheel over a field | changes the value; deltas batch into one change and end 200 ms after the last wheel event | `setTimeout(this.onBatchTimeout,200)` | CONFIRMED |
| Mixed | shows "Mixed"; scrubbing or nudging applies the delta to each layer; typing `Mixed+100` adds 100 to each | `mixedMathHandler`; live | CONFIRMED |
| Comma lists | in multi-value fields ("1,2,3,4") the caret position picks which value ↑ / ↓ changes | `getIncrementTargets` | CONFIRMED |
| Focus | click selects all; Enter commits and returns focus to the canvas; Esc reverts and stays (second Esc returns to the canvas) | live `fields.md` | CONFIRMED |

**Expressions** (CONFIRMED, operator table in `3187`):

| Token | Meaning | Precedence / associativity |
|---|---|---|
| `( )` | grouping | — |
| `+ -` | add, subtract | 1, left |
| `* /` | multiply, divide | 2, left |
| unary `+ -` | sign | 4 |
| `^` | power | 5, right |
| postfix `%` | percent of the **current** value (`current × n / 100`) | 6 |
| postfix `x` / `X` | multiple of the current value (`current × n`) | 6 |
| postfix `px` | ignored unit | 6 |

Errors (no change, error callback): unbalanced parentheses, missing operand, unknown token, NaN, infinite result.
"+10" typed over a selected value is absolute (live), so `x+10` needs the old text kept.

## 5. Panel collapse and UI hiding

| Action | Shortcut (mac) | Effect | Evidence | Status |
|---|---|---|---|---|
| Minimize UI (`toggle-sidebar`) | ⇧⌘\ · ⇧\ · ⇧. (not in Slides / Buzz) | Panels collapse; the canvas becomes full width; two floating pills: top-left [logo · file name · sidebar toggle], top-right [avatar · zoom · play · Share]; the toolbelt stays; selecting shows a floating Design card on the right that hides on deselect; menu label toggles "Minimize UI" / "Expand UI" | shortcut JSON; `7621` labels `fullscreen_actions.minimize-ui` / `expand-ui`; live `behaviour/ui.md` | CONFIRMED |
| Show/Hide UI (`toggle-ui`) | ⌘\ · ⌘. | Hides all chrome (canvas only) | shortcut JSON; live View menu | CONFIRMED |
| Panels | ⌥1 Layers · ⌥2 Libraries (`toggle-publish`) · ⌥3 (`toggle-library`) · ⌥8 Design · ⌥9 Prototype | open / switch panels | shortcut JSON; live View › Panels | CONFIRMED |
| Focus areas | F6 / ⇧F6 | move keyboard focus between toolbar, panels and canvas | `focus-next-area` / `focus-previous-area` | CONFIRMED |
| Narrow windows | under 900 px the layout switches to a compact arrangement for agent / comment panels | `h=r<900` in the panel-layout hook | CONFIRMED (code), visuals not captured |

## 6. Tooltips

| Name | Value | Evidence | Status |
|---|---|---|---|
| Show delay (default) | **1000 ms** | `timeoutDelay:c.timeoutDelay||1e3` | CONFIRMED |
| Warm re-show | when a tooltip is already showing, moving to another target shows the new one **at once** | `s.state===SHOWING||c.showImmediately ? show` | CONFIRMED |
| Hide delay | **300 ms** by default (`hideAfterDelay ?? 300`); `hideImmediately` skips it; a still-pending tooltip is cancelled at once | tooltip manager | CONFIRMED |
| Per-element overrides | `data-tooltip-timeout-delay` (used values: 50, 150, 300, 500, 1000), `-show-immediately`, `-hide-immediately`, `-show-above / -below / -left / -right`, `-max-width`, `-offset-x / -y`, `-interactive`, `-shortcut-key` | attribute census | CONFIRMED |
| Default position | below the target; flips above when there is not enough room below; left / right on request | `case TEXT: t=BELOW … ABOVE` | CONFIRMED |
| Geometry | distance 6, arrow 6, padding 8 (h) × 6 (v); z-index 14 | consts `tooltipDist`, `tooltipArrowHeight`, `tooltipContent{Horizontal,Vertical}Padding`, `tooltipZ` | CONFIRMED |
| Shortcut text | a tooltip can carry the shortcut of an action (`data-tooltip-shortcut-key`), e.g. toolbelt tools and the Dev Mode toggle (offset-y −4) | `figma_app` | CONFIRMED |
| Canvas tooltips | separate delay / position from the engine (`getCanvasTooltipDelay`) | `figma_app` | CONFIRMED (value in wasm, not read) |

## 7. Toasts (visual bells)

| Rule | Value | Evidence | Status |
|---|---|---|---|
| How many at once | **one**; bells queue FIFO and the head is shown | `p=queue, h=p[0], f=p.length` in `7621` | CONFIRMED |
| Duration (no override) | error, PROGRESS / SPINNER / RETURN_TO_INSTANCE icon → **until dismissed**; with a button → **10 s**; rich content or message longer than 25 characters → **6 s**; otherwise **3 s** | `246354` `R(e)` | CONFIRMED |
| Explicit override | `timeoutOverride` ms (e.g. 3000, 5000, 15 000, ∞) | call sites | CONFIRMED |
| Queue speed-up | with n bells queued and `timeoutType` "suggested" (the default), the head's time is × 0.5^(n−1); "exact" keeps it | `r*=Math.pow(.5,t-1)` | CONFIRMED |
| Delay | `delay` ms is added and the bell appears only after it | same | CONFIRMED |
| Repeats | a `count` badge on a repeated bell | `h.count` | CONFIRMED |
| Look | always dark theme unless `useSystemTheme`; radius 5, horizontal padding 16; error variant "danger"; optional icon (Spinner, Check, Green check, Check in circle, Exclamation, Return to instance, Progress, Undo, From URL, …, MCP), message, up to two buttons, a dismiss ✕ when it has `onDismiss` or is an error | `7621`; consts `visualBellCornerRadius`, `visualBellHorizontalPadding` | CONFIRMED |
| Position | bottom centre, raised above the toolbelt by its height, resting inset 12 (UI3; 24 in UI2), 8 from the edge; shifted by half the left / right panel width in some modes; hidden by `translateY(100vh)`; z 11 | `950872` positioner; consts `visualBellMarginBottomUi3` | CONFIRMED (code), INFERRED (which offset applies in Design) |
| Dismiss reasons | timeout / dismiss / action-button click | `WX` enum | CONFIRMED |
| Screen readers | role "status" / "alert"; also announced into an open modal | `7621` | CONFIRMED |

## 8. UI strings

i18n keys of this area (English given where a live capture or the repo attests it):

- Toolbelt: `fullscreen.flyout.{move_tools,region_tools,shape_tools,drawing_tools,type_tools,comment_tools,code_tools}`
  ("Move tools", "Region tools", "Shape tools", "Creation tools" — live shows "Creation tools" for the pen group,
  "Type tools", "Comment tools"); `qa.extensions.tooltip_actions` ("Actions"); `fullscreen.toolbar.toolbelt_mode_
  segmented_control.{design,dev_mode,draw,animate,toolbelt_mode,switched_to_design,switched_to_dev_mode,switched_to_draw,
  view_only_info}` ("Toolbelt Mode", "Draw", "Design", "Motion", "Dev Mode"); `fullscreen.toolbar.secondary_toolbar.close`.
- Image / crop toolbar: `fullscreen.toolbar.image.{aria_label,crop,lasso_select,more}`, `fullscreen.toolbar.crop.{label,
  aria_label,slider.aria_label,aspect_ratio.tooltip,resize_to_fit.tooltip}`, `fullscreen.toolbar.visual_search`,
  `fullscreen_actions.{edit_image.with_prompt,upscale_image,expand_image.shortened,vectorize-image,remove_background}`.
- Rail: `design.navbar.{file,chat,assets,tools,variables_view}` ("File", "Agents", "Assets", "Tools", "Variables"),
  "Main menu", "Navigation Bar".
- File name: `fullscreen.filename_view.{file_input_title,title_placeholder,version-history-show,version-history-hide,
  library_actions,publish-styles-and-components,file_analytics,export,duplicate,duplicate-to-drafts,duplicate-as-new,
  rename,rename-branch,go_to_project,move_file,move_to_trash,archive-branch,delete-branch,restore_default_thumbnail,
  restore_default_file_thumbnail,color_management.*,view-only,locked,free,drafts}`.
- Pages: `fullscreen.pages_panel.{pages,add_new_page,page_name,page_divider,more_options,more_pages_actions,
  page_row.more_actions,pages_moved_*_announcement,show_archived_pages,hide_archived_pages,memory_usage*,
  unavailable_offline}` ("Pages", "Add new page", "Page name", "Find"); page menu "Copy link to page", "Rename page",
  "Duplicate page", "Move up", "Move down", "Move to top", "Move to bottom", "Delete page".
- Layers: `fullscreen.layer_panel.{layer,mask_decorator,form_label}`, `fullscreen.object_row.{toggle_lock,
  toggle_visibility,turn_on_visibility,turn_off_visibility}`, `layer_icon.tooltip.*`, `layer_icon.button.pan_to_node`
  ("Layers", "Collapse layers", "Rename 3 layers", "Preview", "Current name", "Number ↑", "Number ↓",
  "Start ascending from", "Learn more", "Cancel", "Rename").
- Right panel: `fullscreen_actions.right_sidebar_label`, `fullscreen.zoom_menu.zoom_view_options(.aria_label)`
  ("300%, zoom and view options"), `fullscreen.toolbar.zoom_menu.{zoom_to_50,zoom_to_200,pixel_preview,
  pixel_preview_disabled,pixel_preview_1x,pixel_preview_2x}`, `fullscreen_actions.{zoom-in,zoom-out,zoom-reset,
  zoom-to-fit,toggle-grid,toggle-snapping-to-pixels,toggle-shown-layout-guides,toggle-rulers,
  toggle-multiplayer-cursors,toggle-show-comments,toggle-outlines,outline-mode-hidden-layers,
  outline-mode-object-bounds,outlines-menu,toggle-show-annotations,show-all-annotation-categories,annotations-menu,
  toggle-prototyping-information}`; "Design", "Prototype", "Present", "Prototype view", "Share", "Multiplayer tools";
  `fullscreen.toolbar.multiplayer.*`.
- View / UI: `fullscreen_actions.{minimize-ui,expand-ui}` ("Minimize UI"), "Show/Hide UI", "Minimize left navigation
  bar", "Open layers panel", "Libraries", "Open design panel", "Open prototype panel", "Toggle variables".
- Toasts: per-feature `*.visual_bell.*` keys (see the chapters); generic dismiss button; `fpl.visual_bell_shown`
  (analytics only).

## 9. DesignerV2 today

From a read-only survey of `src/renderer/src` and `engine/` (paths are relative to `src/renderer/src`).

| Area | Matches | Differs | Missing |
|---|---|---|---|
| Left panel width | default 240, min 240, double-click resets to 240, rendered +1 px border (`ds/tokens.ts:326-328`, `ds/components/ResizeHandle.tsx:27,72`, `editor/panels/LeftPanel.tsx:37,58`) | max **480** (Figma 500) | — |
| Right panel width | resizable on its left edge, persisted (`editor/panels/RightPanel.tsx:91`, `editor/persistence.ts:42,64`) | min 240 (Figma 241), max 480 (Figma 500); double-click resets (Figma has no double-click default for this panel) | — |
| Layer rows | pitch 32, indent 24, icons 16, chevron always visible (`ds/tokens.ts:318,324`, `ds/components/LayerRow.module.css:46-56,107`) | "strong" top-level rows only recolour the icon; Figma has `boldLayerNames` on (which rows get bold is still open) | — |
| Layers behaviour | expands ancestors and scrolls the selection into view (`editor/panels/Layers.tsx:271-295,474`); ⌥-click recursive chevron; drag across lock / eye cells | drag threshold 4 px (Figma 3); autoscroll 24 px edge × 8 px per move (Figma scales speed with distance); the scroll target placement (Figma: above → top, below → mid-height); ⌥L keeps the selection's branch open (Figma collapses every row) | hover-to-expand while dragging (middle third, 1000 ms); sticky headers |
| Pages | divider name rule matches Figma's regex, empty page only (`editor/panels/Pages.tsx:39-41,57`); "Page N" + inline rename (`engine/src/editor/Commands.cpp:1093`); row pitch 32 | list capped at 40 % of window height, resizable to 70 % (Figma's split range not yet known) | titled dividers (`--- Title`); the 3-page Starter limit (not needed for personal use, but V1 quotas may want it) |
| Tooltips | below by default, flips, 6 px gap (`ds/overlay/TooltipManager.tsx:30,103`) | show delay **500 ms** (Figma 1000); warm re-show within 300 ms of the last hide (Figma: instant while one is showing, then a 300 ms hide delay); hides immediately (Figma 300 ms) | — |
| Toasts | one at a time, bottom centre (`ds/components/Toast.tsx:15-26,56`) | 4 s / 8 s with an action (Figma 3 s / 6 s for > 25 characters / 10 s with a button / ∞ for errors and progress); a new toast replaces the current one (Figma queues FIFO and halves times while queued); 68 px from the bottom | count badge for repeats; queue |
| Number fields | ↑↓ 1, ⇧ 10; `+ - * / ^ ( )`; Mixed math; unit stripping (`ds/util/scrub.ts`, `ds/util/evaluate.ts`, `NumericInput.tsx:106,124-127`) | scrub 4 px per step with 60 px vertical bands (Figma: 0.5 units per px × multiplier, bands at 12.5 / 25 / 50 % of screen height, ×8 … ×⅛); `%` is stripped as a unit (Figma: postfix `%` = percent of the current value) | postfix `x` (multiple of the current value); wrapping scrub cursor; ⇧-scrub snapping to 10; wheel scrubbing; comma-list caret targeting |
| Toolbelt | groups and order, Actions, mode switch, 48 px at 12 px from the bottom, secondary toolbar 40 px 8 above (`ds/components/EditorToolbar.tsx:64-116`, `Toolbar.module.css`) | Draw-mode set differs (Brush etc. — chapter 05 owns Draw) | Comment re-click returns to Move (to verify) |
| Zoom / view menu | zoom in / out / fit, 50 / 100 / 200 %, pixel grid, snap, layout guides, rulers, outlines (`editor/panels/RightPanel.tsx:138-171`) | adds Zoom to selection (Figma's menu has none); Outlines is a flat item (Figma: submenu with hidden layers / object bounds) | zoom % input at the top; Pixel preview submenu; Multiplayer cursors, Property labels, Comments, Annotations submenu, Prototyping information |
| Minimize / hide UI | ⇧⌘\ Minimize UI, ⌘\ Show/Hide UI, floating panels (`editor/commands.ts:460-478`, `editor/panels/Minimized.tsx`) | — | ⇧\ and ⇧. aliases for Minimize UI, ⌘. for Show/Hide UI (note: Figma binds bare `\` to select parent too, so ⇧\ is free) |
| File name menu | Rename, Duplicate, Move, version history, publish, analytics, branches, color profile (`editor/panels/LeftPanel.tsx:178-191`) | order differs: Figma puts version history / library / analytics / export first, then Color profile, then Duplicate / Rename / Move / Trash | Export, Move to trash, Restore default thumbnail, Add to sidebar |
| Image toolbar | Edit with prompt, Remove background, select area, More (Expand, upscale, Vectorize) (`editor/imageTools/ImageToolbar.tsx`) | Figma lists Upscale / Expand / Vectorize as their own buttons | Crop toolbar (slider, aspect presets, resize to fit); Visual search |
| Rail | File, Agents, Assets, Tools, Variables, 56 px cells, tile 32 (`editor/panels/Rail.tsx`, `ds/tokens.ts:332-334`) | extra Brands item (ours); labels off by default (Figma: 9 px labels under each icon) | — |

### As built (2026-10-17, wave 1)

Branch `chrome` (worktree `worktree-agent-aea9139fc139ea134`), in this section's order. Paths are relative to
`src/renderer/src`.

**Built**

- **Panels.** Left panel 240–500 (`ds/tokens.ts` `panel-max: 500`), double-click resets to 240. Right panel 240–499
  inside its 1px line, so Figma's 241–500 (`right-panel-max`). It has no double-click reset (`ResizeHandle`
  `defaultValue={null}`).
- **Layers drag** (`editor/panels/Layers.tsx`, `editor/model/layerTree.ts`):
  - The drag starts past 3 px (`LAYER_DRAG_THRESHOLD`).
  - Autoscroll runs only while the pointer is past the list's top or bottom. It moves farther the farther out, at most
    a row per move (`dragScrollStep`). The step curve is ours: Figma's `bm` was not read.
  - Resting 1000 ms on the middle third of a closed layer with children opens it (`hoverExpandTarget`,
    `LAYER_HOVER_EXPAND_MS`). It never opens from the pinned row. The drag's handlers read the rows as they are now,
    so a drop after an expand lands right.
- **Layers sticky header** (`stickyHeader`, drawn by `VirtualList`'s new `sticky` prop). The open top-level row
  whose block holds the scroll top stays pinned there. The next top-level row pushes it up as it arrives.
- **Scroll to the selection** (`VirtualList` `scrollAlign="figma"`). A row above the view goes to the top, or under
  the pinned row when it is nested. A row below goes to mid-height.
- **⌥L.** Kept as built. Figma keeps the selection's branch open too: the live probe that reads "collapses every
  layer" had nothing selected (`live/behaviour/layers.md` #9), and help says "except for your selection". The table
  above was wrong on this point.
- **Pages** (`editor/panels/Pages.tsx`, `ds` `PageRow`):
  - Figma's exact divider regex. `-*-` is no longer a divider.
  - Titled dividers (`--- Components`, `dividerTitle`). Renaming a divider edits its title and writes `--- <title>`,
    or `---` for none (`dividerName`).
  - A plain divider takes 16 of the list (`pageDividerRowHeight`). A titled one keeps a page row's 32 (G).
  - Drag-reorder uses the rows' real positions, so mixed heights work. The dragged row follows the pointer.
- **Tooltips** (`ds/overlay/TooltipManager.tsx`):
  - They show after 1000 ms. While one is showing, the next target's shows at once.
  - Leaving the target hides it 300 ms later. A pending tooltip is dropped at once.
  - Per-element overrides: `data-tooltip-delay`, `-show-immediately`, `-hide-immediately`.
- **Toasts** (`ds/components/Toast.tsx`):
  - One at a time, FIFO.
  - Durations: 3 s; 6 s for a message over 25 characters; 10 s with an action; errors and `duration: 0` until
    dismissed.
  - The head's time is halved for each toast waiting (`timeoutType: "exact"` opts out).
  - A repeat bumps a count pill instead of queueing. `delay` holds a toast back before it joins the queue.
  - The × shows only on a toast that never times out, as Figma's dismiss button.
- **Number fields** (`ds/util/evaluate.ts`, `ds/util/scrub.ts`, `ds/util/scrubLock.ts`, `ds/components/NumericInput.tsx`):
  - Postfix `%` is a percent of the current value and `x` a multiple of it. `px` is ignored. The field's own unit
    (`%` in an opacity field) stays a unit. On Mixed they apply per layer.
  - Scrub bands are Figma's: share of `screen.height`, past 12.5 / 25 / 50 % gives ×2 / ×4 / ×8 up and ½ / ¼ / ⅛ down.
  - `scrubMultiplier` (percent fields 4).
  - ⇧ scrubs by 10 on the 10 grid (61 → 70).
  - The pointer is locked during a scrub, with Figma's 24 × 24 cursor wrapping around the window edges. Esc, which
    releases the lock, cancels. This was checked in Chrome: the lock holds, the cursor is drawn and the value moves.
- **Zoom menu** (`editor/panels/RightPanel.tsx`). Figma's order:
  - The zoom as a field: a number and Enter zooms to n / 100, Esc leaves the field, and its keys stay in it
    (`MenuButton`'s new `head`).
  - In / out / fit; 50 / 100 / 200 %, checked at that zoom.
  - Pixel preview ▸ Disabled / 1x / 2x; Pixel grid, Snap to pixel grid, Layout guides, Rulers.
  - Multiplayer cursors, Property labels, Comments.
  - Outlines ▸; Annotations ▸.
  - Zoom to selection is gone from this menu.
- **Minimize UI / Show/Hide UI.** ⇧\ and ⇧. added for Minimize UI, ⌘. for Show/Hide UI (`editor/commands.ts`).
- **File name menu.** Figma's order: the branch rows; version history, publish, analytics and Export (added); color
  profile; Duplicate, Rename, Move.
- **From 21 (panel-level).** Toggle toasts: "Snap to geometry / objects / pixel grid enabled / disabled", "Pixel grid
  visible / hidden", "Layout guides visible / hidden". The English is worded from the `visual_bell.*` key names, after
  the attested "Pixel preview enabled (1x)".

**Still open**

- Needs a live probe (§10): whether the live 0.24 / px scrub rate means our 4 px a step stays, or Figma's 0.5 × factor
  applies; Figma's ⇧-scrub speed (only the snapping is built); the toast's bottom offset (still 68); the Pages / Layers
  split range; the zoom field's and the count pill's look (G); a titled divider's row height; which nodes
  `isNodeSticky` accepts (every open top-level layer with children is pinned here); the exact English of the toggle
  toasts.
- Not built: wheel scrubbing over a field (when it applies is not read); comma-list caret targeting (↑ ↓ on the value
  under the caret); zoom-out disabled at the zoom limit; Outlines ▸ Show hidden layers / Show object bounds;
  Annotations ▸ categories; Prototyping information (⇧E); Move to trash / Restore default thumbnail / Add to sidebar in
  the file menu (no editor-side trash yet); the image Crop toolbar and Visual search; the Comment tool's re-click
  returning to Move (lives in `editor/canvas/BottomToolbar.tsx`, the canvas branch's); rail labels on by default (the
  owner's round 14 choice keeps them off); bold top-level layer names (open question); the 3-page Starter limit.

## 10. Open questions

| Question | Live probe that settles it |
|---|---|
| Which tool a flyout group's main button shows after you switch away (last used vs first) | Pick Ellipse, press V, look at the shape group's icon; reload and look again (is it persisted?) |
| Pages / Layers split: min and max height, default height | Drag the "Resize handle" between Pages and Layers to both extremes on a 900 px window; read `pagesPanelHeight` |
| Max multiplayer avatars before "+N" | Open a file with 4–8 collaborators and dump the header |
| The exact toast bottom offset in Design (above the 48 + 12 toolbelt?) | Trigger "Copied link" and measure the toast's rect |
| Live scrub ratio vs the 0.5 px factor (live measured ≈ 0.24 / px) — pointer-lock movement units or device-pixel scaling | Scrub the X label 100 px exactly with no vertical motion; repeat with ⇧ |
| Bold layer names: which rows (top-level frames only?) | Dump layer row font weights for a top-level frame, a nested frame and a shape |
| Hover-to-expand delay for a page row while dragging layers onto Pages | Drag a layer over a page row and time the switch |
| Left-panel width when the Assets tab is open (same 240–500 range?) | Drag the Assets panel handle to both extremes |
