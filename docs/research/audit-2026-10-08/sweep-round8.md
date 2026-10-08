# Visual-parity sweep, round 8 (Design side vs real Figma)

Measured on `main` at e88f289 on 2026-10-08, while r8-design-panel, r8-render and r8-selection were in progress. Read-only sweep: no repo edits except this file.

**Truth:** `docs/research/figma/live/` (DOM dumps in design/, popovers/, grid/, menus/, left/, toolbar/; canvas screenshots in img/). Where live has no data it is marked unverified.

**Method.** `vite --config vite.web.config.ts --mode demo --port 5491`; headless Chrome, 1440x900, dark, `?editor&doc=capture` (the live capture's layers) and, for component states, `?editor&doc=components`. Each live state was reproduced and our DOM dumped with `figma-dump.js`'s `__dump2` logic (plus an opacity-0 check), then diffed element by element on position, size, label/text, font, colour, radius and background. A SHIFT line means that from that live y on, everything is the same distance lower or higher in ours. Canvas screenshots in `live/img/` were put side by side with ours at the same camera, with the selection set through the engine.

**Caveats.**
- The `capture` fixture lacks the live file's component states (Button, Chip, Card, slots), so those use `doc=components`, whose layers differ. Differences of that kind are listed as fixture, not as gaps.
- Our Vector `7:66` has no vector network and does not render, so vector edit mode could not be entered (the toolbar's vector-edit bar and its More menu are not compared).
- Hidden accessibility text in the live dumps (11px/450 white duplicates of aria labels, clipped radio labels) was filtered, and live elements at negative coordinates (closed dropdown options) were ignored.
- aria-label differences that do not change what is drawn are only listed when the wording shows in a tooltip or visible text.
- The live canvas screenshots have an unknown scale (pane DPR), so canvas-chrome sizes are only compared in proportion.

**Not reproduced** (marked in the appendix as "no ours"):
- Component, instance and slot states that need Card and slot fixtures: `component-with-slot`, `instance-with-slot`, `component-create-slot-property`.
- `grid/row-track-menu` and `row-track-selected-panel`.
- The text hover baseline underline and the rotated star.
- The layout-guide columns canvas states.
- Vector edit mode.
- `layout-guide-settings-columns` (the type switch re-renders into fragments the dumper cannot group).

## Summary

The resting Design panel is within 1 px of live for the rectangle, ellipse, polygon, star, vector, boolean, group, frame, section, text and the plain auto-layout frames. The remaining differences are:
1. Every dropdown, context and main menu uses 12px text and its own widths, where live uses 11px.
2. Every Design-panel popover docks about 8 px left of and below where Figma puts it.
3. A handful of panels differ in structure.
4. Several canvas affordances are missing.

## Systematic differences (apply to many states)

| # | Severity | Difference |
|---|---|---|
| S1 | high | **Menu typography and geometry.** Live dropdown/context/main menus: item text 11px/450 (context menus 11px/400) starting at x=32 (x=16 when there is no check gutter), width fitted to content (blend 118, stroke position 105, individual strokes 117, boolean ops 151, sizing 166, constraint 126/136, font size 96, effect type 147, move tools 151, shape tools 196, context menus 200, main menu 194). Ours: 12px/450, text at x=36 (x=16 for items without a check), widths 208/213/216/233/246/280. Shortcut text live 11px/450 #ffffffb2 (context menus: one 12px glyph span per key, #ffffffb2); ours 12px/450 #ffffff73. Disabled item colour live #ffffff66, ours #ffffff59. |
| S2 | high | **Popover placement.** Live Design-panel popovers dock flush to the panel's left edge (x = 959/960 for 240-wide ones) and keep a 16 px bottom margin (bottom = 884). Ours sit 8-9 px further left (951) and 8 px from the bottom (892); y is therefore also 8-50 px off (stroke settings live (960,660) / ours (951,708); effect settings (959,660) / (951,668); font picker (960,415) / (951,452); type settings (960,378) / (951,432); shader browser (959,374) / (951,404)). |
| S3 | med | **Text weight in panel rows.** Live uses 11px/400 for visible row text such as the effect row ("Drop shadow", x=41), "Hug", "3 × 2" and the grid sizes; ours renders the same text at 11px/450 (and x=44 for the effect row). |
| S4 | low | Fill and stroke swatches: live 14x14 with radius 2px, ours 14x14 square. Swatch row buttons in live are not separate 24x24 buttons (ours: 24x24 `[Solid color hex]` button around the span). |
| S5 | low | Small caption text is 1-3 px narrower in ours ("Alignment" 44 vs 46, "Corner radius" 59 vs 62, "Letter spacing" 62 vs 66); text range height 14 vs 13. Same face, probably a letter-spacing difference. Sum of effects: field widths 64 vs 61 for Line height / Letter spacing inputs. |
| S6 | low | Empty-section titles: live shows empty Stroke / Effects / Export / Layout guide titles in #ffffffb2 and the same titles at #ffffff once they hold rows; ours keeps #ffffffb2 once the section has a row (Effects, Stroke with rows). |
| S7 | low | Popover close: live popovers have no ✕ except Auto layout settings / Layout guide settings / Fill picker (Fill picker has "New style or variable" at x=180); ours add a `[Close]` ✕ to the shader browser, fill picker, styles menus, type settings, etc. |

## Design panel, by state

**Header actions**
- *(med)* For a layer nested in a frame, auto-layout or grid (autolayout-child, frame-child-constraints, grid-child) live shows `[Select matching layers]` (x=124), `[Create component]` (152), `[Use as mask]` checkbox (180), `[More actions]` (208) and no Boolean/Edit-object buttons. Ours shows Create component (107), Use as mask (135), Boolean operations + Union (163/188) and Edit object / More actions as for a top-level layer.
- *(med)* Component, component set and variant: live header is the layer name as an editable input (`8,12 136x24`, 13px/550) plus `[Add variant]` (152), `[Component configuration]` (180), `[More actions]` (208); component set also has `[Multi-edit variants]` (124), variant has `[Multi-edit variants]` (152), `[Select matching layers]` (180) and `[Component configuration]` (208). Ours: a purple "Component" / "Component set" 11px/550 label at x=36 and only `[Add variant]` at x=208; no configuration button, no More actions, no multi-edit toggle, no select-matching.
- *(low)* Page with nothing selected: live Page header has `[Apply variable mode]` (208,8) and an **MCP** section ("MCP", "Figma MCP in Claude" chip, `[Set up agents for Figma MCP]`); ours has neither.
- *(low)* Frames: live exposes the dev-status toggle as `toggle-ready-for-dev-status`; ours `Toggle ready for dev status` (visible tooltip text may differ).

**Component panel**
- *(high)* Properties section: live rows are 208x24 buttons `icon span [Boolean property | Text property | Instance swap property]` with one line "Show icon ・ True" (11px/400, "・" separator #ffffffb2), header "Properties" 11px/550 #ffffffb2, add button `[Create property]` (208,44). Ours: 196x32 rows with the name left and value right-aligned, a minus "Delete property" button per row, an exposed-nested-instance row (Icons/Star with "Stop exposing") and a Description textarea inside the panel; header "Properties" is #ffffff and the add button is `[Create component property]`. Live keeps the Description (rich text) and Link in the Component configuration popover, which ours lacks.
- *(med)* Variant panel: live "Current variant" header 11px/550 #ffffffb2 with `[Select component]` (208,44) and rows `[Edit property name for State]` 92x24 + value dropdown 92x32 (`[Edit property value for State]`); ours shows plain label + combobox.
- *(med)* Instance header: live shows the name as 13px/550 text with `[More actions]`, then a `[Go to main component]` row (8,36 104x24, "From this file" 11px/450 #ffffffb2), property rows with `[Apply variable/property to <prop>]` 24x24 buttons at x=208, a 32x16 checkbox for booleans, a textarea `[Label]` 88x24 at x=112 and a 88x24 swap button with the current instance; ours has one `[Instance menu: Button]` dropdown button at (8,12), no From-this-file/Go-to-main row, no apply-variable/property buttons, 28x16 switches, a combobox for variants.
- *(low)* Nested instance: live also shows the parent's name row; ours omits the property rows of nested instances (fixture differs, verify).

**Position / Layout**
- *(low)* Constraints: live expanded state keeps the toggle `[Constraints]` highlighted `#32394d` (ours `#394360`).
- *(med)* Gap field: live has a hover chevron with a menu (`10` / `Auto`, popover 156x64 at (1244,473), options 140x24, text 11px/400 at x=34). Ours shows only an Apply-variable hexagon on hover; "Auto" gap can only be typed.
- *(low)* Width/Height fields: ours has an extra 9x24 `[Width sizing]` / `[Height sizing]` chevron button; live shows only the "Hug" / "Fixed" label with no extra labelled button (menu opens from the field).
- *(low)* Auto-layout alignment grid: structurally the same (3 bars preview, dots); live uses `div` dots #ffffff66 r=2.

**Appearance / Fill / Stroke / Effects / Export**
- *(med)* Individual corners: live is a 2x2 grid of 88x24 fields (rows at y=441 and 473) with no captions; ours adds "Top corners" / "Bottom corners" 9px captions and rows 48 px apart.
- *(low)* Image fill row: live is a 100x24 `[Image]` button at (17,494); ours a 24x24 swatch plus a 77x24 `[Color: Image]` button at x=40.
- *(med)* Selection colors (multi-selection): live lists every colour (swatch 14x14 + hex input per row); ours shows one row and a "See all 4 colors" link (#7cc4f8).
- *(med)* Line/Arrow stroke: live captions "Start point" and "End point" sit above two dropdowns 76x24 (x=16) and 72x24 (x=100) at y=635, each showing an end-cap preview svg; ours has one caption "Start point and end point" and two 88x24 buttons at x=16 and x=112 (y=633), which moves Effects and Export 2 px up.
- *(low)* Rectangle stroke default: live "Add stroke" gives Inside; ours gives Center.
- *(low)* Effects row: live "Drop shadow" text is 11px/400 at x=41 and the row uses a `[Add effect]` button with bg #ffffff0d when the section has rows; ours `[Effect settings]` 24x24 + text at x=44 11px/450, no #ffffff0d.
- *(low)* Export row: live `Export constraints…` input 49x24 + `[Select an option]` 24x24 + `[Export file type]` combobox 74x24; ours Scale 60x24 + presets 16x24 + File format 76x24 (labels `Scale`, `Scale presets`, `File format`); "Preview" header live 11px/550 #ffffffb2, ours 11px/450 #ffffff.
- *(low)* Typography: live font-family combobox is 184x32 with the field inside 184x24 at y+4, font-size is a 88x32 listbox; ours 184x24 and a 72x24 field plus a 16x24 `[Font sizes]` chevron. Visually equivalent apart from the chevron.
- *(low)* Create link: live `[Create link]` is hidden text under the hyperlink toggle; ours shows a labelled button at (124,12).

## Popovers and menus

| Popover | Sev | Live | Ours |
|---|---|---|---|
| Fill picker (Solid) | high | 240x537 at (959,347): paint-type radios Solid, Gradient, Pattern, Image, Video, Shader (28 px pitch, 24x24), Blend mode + Check color contrast buttons (180/208), colour area 208x208 at (16,97), Sample color button, Hue/Opacity sliders 180x24 at x=48, "Color format" combobox 55x24 + hex input 89x24 + opacity 54x24, swatch-set combobox 208x24, swatches 16x16 squares (r=20%) in 9 per row | 240x433 at (968,459): tablist 119x24, radiogroup 96x24 with only Solid, Gradient, Image, Video (no Pattern, no Shader tab), colour area 224x184 at (8,80), eyedropper 24x24, "Color model" combobox 64x24, Hex 104x24, sliders 192x12, swatches are circles (r=9999) from y=381, extra `[Close]` ✕ |
| Fill picker tabs | med | Custom / Libraries tab at (8,8) 58x24 / 62x24; Libraries tab content per `fill-picker-libraries-tab.txt` | tablist 119x24; Libraries shows a search plus "No styles or variables in this file" |
| Gradient / pattern / image / video / shader panels | high | Pattern tab and Shader (beta) tab exist | no Pattern or Shader paint types in the picker |
| Stroke settings | med | 240x224 at (960,660): Stroke Type Basic/Dynamic/Brush (Dynamic/Brush text #ffffffb2), Style row, "Width profile" with profile preview + `[Flip width points]`, Join (3 radios 43 px wide at 96/139/181), Miter angle 128x24 at x=96, all labels left-aligned at x=16 | 240x184 at (951,708): labels right-aligned (Style at x=61, Join x=66, Miter angle x=29), no Width profile row, Join radiogroup 128x24, Miter angle field 104x24 at x=120, Dynamic/Brush #ffffff66 |
| Stroke position menu | med | order Center, Inside, Outside; 105x88 at (1208,678); text 11px/450 at x=32 | order Inside, Center, Outside; 104x88 at (1196,677); 12px at x=36 |
| Individual strokes menu | med | 117x159 at (1315,539), items 101x24 with text at x=60, checked row blue | 208x160 at (1224,732), text x=36 |
| Effect settings | med | see S2; header type button 117x24 for Drop shadow (icon then text at x=32, 11px/400), fields 136x24 labels at x=88 (inputs 110x24 at 113), "Position" caption, "Type" caption for blurs (Uniform/Progressive), Glass sliders 96x44 with 48x15 values at x=175 | header button 98x24 with text at x=16, 11px/450; "Blur" / "Spread" / "Color" captions at x=16; Glass values 80x16 at x=88 |
| Effect type menu | med | 147x207 at (967,449): text x=44 11px/450, ends with "Shader" after a separator at y=189 | 170x225 at (939,644): text x=60 12px/450 |
| Shader effects browser | low | 240x510 at (959,374); "Try an example" button #0c8ce9; onboarding text at y=230, "Got it" y=294 | 240x488 at (951,404); button #757575; text at y=245, "Got it" y=309; extra Close |
| Blend mode menu | med | 118x555 at (1315,472), groups separated, text 11px/450 | 208x557 at (1224,335), 12px |
| Boolean ops menu | low | 151x120 at (1253,129); shortcuts #ffffffcc/#ffffffb2 | 208x136 at (1224,120); shortcuts #ffffff73; items disabled-colour #ffffff59 when one layer is selected |
| Auto layout settings | high | 240x345 at (960,481): Preview graphic, "Inside stroke > Included", "Canvas stacking > Last on top", "Align text baseline" with Disabled/Enabled 24x24 pair, "Auto spacing > Between" greyed (tooltip "Only applicable for Auto gap"), "Layout > Updated" with a 16x16 More info button, Close at (208,8) | 300x184 at (891,484): "Auto spacing", "Strokes > Excluded from layout", "Canvas stacking", "Text baseline alignment" as 150x24 comboboxes, no Preview, no Layout version row, Close at (268,8) |
| Grid auto layout settings | med | 240x249 at (960,485): Preview, Inside stroke, Layout Updated | 300x120 at (891,484): Strokes, Canvas stacking only |
| Grid dimensions picker | med | 210x204 at (1204,427): "N ×" and "M" fields at the top (85x24 each), 16x16 cells at 16 px pitch from (8,40), label "Grid dimensions" | 240x332 at (951,484): fields 80x24 at (36,48)/(148,48), cells 16x16 at 18 px pitch from (12,80) |
| Sizing menus (width/height) | med | 166x129 at (1138,399); options 150x24 r=5, text 11px/400 at x=58 ("Fixed width (232)", "Hug contents", "Add min width…", "Add max width…"); selected option bg #0c8ce9 | 208x170 at (1224,462); text 12px at x=36; plus an "Apply variable…" item |
| Constraint menus | low | "Left + Right", "Top + Bottom"; 126x136 / 136x136 at (1208,280/312) | "Left and right", "Top and bottom"; 128x136 / 142x136 at (1196,278/310) |
| Frame presets menu | high | 222x1887 at (1208,125): flat list starting with Section, Frame, Group, then iPhone 17, iPhone 16 & 17 Pro, … MacBook Air … Apple Watch 41mm … Archived presets; sizes as three 11px texts "402" "×" "874" at x≈150-206 | 280x884 at (1152,8): group headers "Frame Layout Options", "Phone Presets", "Tablet Presets", "Desktop Presets", "Presentation Presets", "Watch Presets", "Paper Presets", "Social Media Presets", "Figma Presets", "Archived Presets" (11px/550 #ffffff73), different device names (Apple Watch Series 10 42mm, iPad Pro 11, MacBook Pro 14/16, iPhone 16 Pro…), sizes as one string "402×874" (12px #ffffff73) |
| Font picker | med | 240x469 at (960,415): "Fonts" title, search 176x24 with value "Inter" and a Clear button, option rows 240x28 | 240x440 at (951,452): no title, search 200x24 at (32,0) with empty value, no Clear button |
| Font style menu | med | 167x313 at (1208,575): Thin … Black, then separator, Thin Italic … Black Italic, then "Variable font axes…" | 143x448 at (1196,444): upright/italic interleaved (Thin, Thin Italic, Extra Light, …), no "Variable font axes…" |
| Font size menu | low | 96x437 at (1312,455): options 80x24, text 11px/400 at x=34, labelled "10 px" … | 208x441 at (1224,451), 12px/450 x=36 |
| Type settings | med | 240x506 at (960,378): Basics/Details/Variable are separate sections (preview 16px, Alignment, Decoration, Case, Vertical trim, List style, Paragraph spacing, Truncate text) | 240x460 at (951,432): tablist at the top (Basics / Details / Variable) with controls 27-32 px wide where live has 24 px |
| Instance swap picker | med | 240x441 at (1160,237): "Choose instance" 11px/550, "Search in this library" 197x16 + `[Settings]` 24x24, rows grouped by page then component | 240x304 at (951,212): "Preferred", "Components", "Icons" group headers, no Settings button |
| Instance More actions | low | 221x309 at (1211,129) with "Reset name" and a Union/Subtract/Intersect/Exclude group | 246x153 at (1186,120), no Reset name, no boolean group |
| Create property menu | med | 156x207 at (1277,161); caption "Create property"; order Variant, Text, Boolean, Instance swap, Slot; "Expose properties from" 11px/450 #ffffffb2 | 208x201 at (1224,156); order Variant, Boolean, Instance swap, Text, Slot; no caption; section title 11px/550 #ffffff73 |
| Component configuration | high | 320x317 at (880,81): Description (rich text) and Link | no popover (no header button) |
| Layout guide settings / type menu | low | 240x128 at (960,756): header `[Close]` at (208,8), "Size" label with 136x24 Width field, "Color" label with 14x14 swatch at (93,97); type menu 110x88 at (968,792) | 240x120 at (951,772): type combobox in the header, no Close, colour as a 24x24 button + hex + opacity row; type menu 102x88 at (939,772) |
| Layout guide styles | low | 216x165 at (984,719): `[Create style]` at (160,8), search 176x40, "No layout guide styles." + `[Browse libraries…]` | 240x145 at (951,747): `[Create style]` at (8,121), "No styles or variables in this file" |
| Export format / advanced | n/a | `export-format-menu`, `export-advanced-settings` | not opened: our row's controls are `Export settings` / `File format` (labels differ), so the live trigger labels were not found |
| Find filter menu | med | 167x338 at (237,105) with counts in the menu (All 20, Frame/Group 5, Shape 15, …) | 208x338, no counts, 12px |

## Menus

- Item labels are the same as live for the context menus (empty canvas, shape, text, frame, multi) and for main File / Edit / View / Object submenus apart from the entries below.
- *(med)* Main menu: live has "Back to files", "Actions…", File … Vector, Plugins, Widgets, Preferences, Libraries, "Open in desktop app", "Help and account" at x=12 (194x444) with 11px/450; "Actions…" is enabled and carries an icon at x=40; ours opens at x=0 (208x420), "Actions…" is disabled (#ffffff59) at x=16, "Open in desktop app" missing, Text / Arrange / Vector / Plugins / Widgets submenus are disabled with nothing selected (live enabled while capturing, with a layer selected, so re-check with a selection).
- *(med)* Preferences submenu: live 27 items (Snap to geometry, Snap to objects, Snap to pixel grid ⇧⌘′, Keep tool selected after use, Highlight layers on hover, Rename duplicated layers, Show dimensions on objects, Hide canvas UI during changes, Use smart quotes/symbols, Flip objects while resizing, Keyboard zooms into selection, Invert zoom direction, Ctrl+click opens right click menus, Use number keys for opacity, Use old shortcuts for outlines, Use ⌘⌥↑/↓ to rotate layers, Play audio notifications in AI chat, Open links in desktop app, Show text suggestions, Show tool suggestions, Show Agents on canvas, Use scroll wheel zoom, Right-click and drag to pan, Theme, Color profile…, Keyboard layout…, Accessibility settings…, Permissions and helpers…, Nudge amount…); ours has Snap to pixel grid, Highlight layers on hover, Theme, Color profile…, Nudge amount… only. Items that change behaviour (snap options, keep tool, show dimensions, flip while resizing, invert zoom, number keys for opacity, scroll-wheel zoom) are missing.
- *(low)* Help submenu: live 9 items (Help page, Keyboard shortcuts ⌃⇧?, Support forum, Video tutorials, Release notes, Open font settings, Legal summary, Account settings, Log out); ours only Keyboard shortcuts (the others are web-account items).
- *(low)* File submenu: live has a "New" group and no "Share preview…"; ours has "Share preview…" and no "New" entry; Edit: live Esc shown as ⎋ (ours "Esc"); View: live "Switch to Dev Mode" with 🌐↑/🌐↓ page shortcuts, ours "Dev Mode", PgUp/PgDn, and the "Additional labels" entry appears twice in ours.
- *(low)* Object submenu: live has "Reset instance", "Delete contents"; ours has "Rename" instead.
- *(low)* Frame context menu: live shows "Remove auto layout" for an auto-layout frame (ours "Add auto layout"); multi-selection context menu: ours adds "Create multiple components".
- *(med)* Page-row context menu: live Copy link to page, Rename page, Duplicate page, Move up, Delete page (200x187 at (131,146)); ours Copy link to page, Rename, Duplicate, Delete (208x129), no Move up.
- *(med)* Context menu geometry: see S1; live text x=16 (no icons), ours x=36 for items without a check mark gutter (ours reserves the gutter).
- *(med)* Bottom toolbar: tool groups match (Move/Frame/Rectangle/Pen/Text/Comment + chevrons, Actions, Draw/Design/Motion/Dev Mode); the tool dropdowns follow S1 (move tools live 151x72 at (497,764), ours 208x88 at (468,752); shape tools live 196x168, ours 213x184). Type tools dropdown could not be opened in ours (chevron label `Type tools` not found).
- *(med)* Actions panel: live is a 529x354 command palette at (456,478) (search 431x32, All / Assets / Plugins & widgets, Recents, AI actions, "Image editing", "Design tools", "Riffing and writing"); ours shows a toast "Actions come later".

## Left side

- *(low)* Rail: item positions match live (File 56, Agents 112, Assets 168, Tools 224, Variables 296; labels 9px/450). Main-menu button: live `[Main menu]` 32x32 at (12,8), ours 56x32 at (0,8).
- *(med)* Assets: live header has `[Libraries]` (261,12), search 156x16 at (97,65), "All libraries", a "Created in this file" card (206x115) with "6 components", "Add more libraries"; ours shows "No components yet" for the capture fixture and search 156x24 at (97,61), no Libraries button (doc=components not compared in detail).
- *(low)* Tools: live shows suggested plugins/shaders and an AI promo card; ours "No tools — Plugins, widgets and shaders aren't part of this app." (intended). Live Create label #ffffff, ours #ffffff66; filter comboboxes live 79x24 / 91x24 with bg #2c2c2c, ours 65x24 / 77x24, no bg.
- *(med)* Variables window: live header shows the file name, "Collections" with options + create buttons, "Groups" (All, color, space) as a second panel, the collection name "Tokens" as a 13px title, columns "Name / Light / Dark" with "Create variable" row at the bottom; ours titles the window "Local variables", has no "Groups" header (groups are listed beneath the collections), titles the table with the collection ("Primitives") and shows a single Value column for the first collection.
- *(low)* Find: live row icons carry aria labels (`img [Auto layout]`, `[Rectangle]`), results show name + parent in 11px/10px; ours the same structure without icon labels. Live filter popover counts missing in ours (see above).
- *(low)* Layers: live rows have `img [Frame|Auto layout|Component|Variant|Instance|Text|Section|Group|Rectangle|Union|Ellipse|Vector|Line|Star|Polygon]` icons with aria-labels (used as tooltips); ours dumps no icon labels. Live toolbar of the Layers header has `[Collapse layers]` (208,121); ours shows it only when hovering.
- *(low)* Pages: ours new page row `[Rename]` input 221x24 at (11,141) vs live inline rename at the row (8,76 224x24).

## Canvas screenshots vs `live/img` (visual, same camera as far as possible)

- *(high)* Ellipse arc handle, star handles (radius, ratio, count) and polygon handles (radius, count) are not drawn in ours; `docs/engine-build.md` already lists on-canvas arc handles as open. Live: ellipse has one handle on its right edge inside the bounding box; star has three (top, inner point, right tip); polygon has two (top, bottom-right).
- *(med)* Selection handles and radius circles are smaller in ours relative to the size label and the shape (live corner handles ≈ 12 px squares, radius circles ≈ 15 px, label pill ≈ 86x26 with 15 px text at the screenshot scale; ours ≈ 5 px, 8 px and 54x15 with 10 px text at the same shape size). Absolute sizes are unverified because the screenshot scale is unknown, but proportion to the label differs (handle/label 0.46 live vs 0.33 ours).
- *(low)* Selection colour: pixels sampled from `canvas-rect-selected-hover-radius-handles.png` give about rgb(63,137,226) for the outline and size pill; ours draws rgb(12,140,233) (#0c8ce9).
- *(low)* AI sparkle button outside the top-right of a selection (live) is not drawn in ours (AI feature).
- *(med)* Selected auto-layout frame: live shows the frame title in the selection colour, a `</>` dev-mode icon at the frame's top-right, and padding/gap bars; ours shows the same bars but a pill "Mark as ready for dev" next to the title instead of the icon at the right.
- *(med)* Selected grid frame: live draws every cell outlined in light blue, mid-edge padding bars, and a pill `||| 1fr ▾` over the hovered column with that column outlined in blue; ours shows blue track bars along the top and left edges at all times and no cell outlines or hover pill (our own overlay design, `engine-build.md` "Grid on the canvas").
- *(low)* Auto-layout hover: ours shows the pink gap badge ("10") and a blue padding badge ("16"); the padding badge sits left of the frame in ours versus above the top padding in live.
- *(low)* Section: live label is a grey pill with bold 14 px text above the top-left corner; ours a smaller pill with regular text.
- *(med)* Frame / layer titles: live canvas frame titles (e.g. AL_horizontal) read about 1.35x wider relative to the frame than ours at the same camera (scale unverified).
- Group centre dots, multi-selection smart-selection pink handles, hover outline: matched structure (not pixel-compared).


## Appendix 0: menu item list diffs (labels only)
```
## context-empty-canvas: live 7 ours 7
## context-shape: live 23 ours 23
## context-frame: live 27 ours 27
  only-live: Remove auto layout
  only-ours: Add auto layout
## context-multi: live 24 ours 25
  only-ours: Create multiple components
## context-page-row: live 5 ours 4
  only-live: Rename page | Duplicate page | Move up | Delete page
  only-ours: Rename | Duplicate | Delete
## main-menu: live 15 ours 14
  only-live: Open in desktop app
## main-file: live 10 ours 10
  only-live: New
  only-ours: Share preview…
## main-view: live 34 ours 35
  only-live: Switch to Dev Mode | 🌐↑ | 🌐↓
  only-ours: Dev Mode | PgUp | PgDn
  ORDER differs: live Pixel grid > Layout guides > Rulers > Show slices > Comments > Annotations > Outlines > Pixel preview > Mask outlines > Frame outlines > Memory usage > Additional labels > Minimize left navigation bar > Minimize UI
                ours Pixel grid > Layout guides > Rulers > Show slices > Comments > Annotations > Outlines > Pixel preview > Mask outlines > Frame outlines > Memory usage > Additional labels > Additional labels > Minimize left navigation bar
## main-object: live 36 ours 35
  only-live: Reset instance | Delete contents
  only-ours: Rename
## main-preferences: live 29 ours 5
  only-live: Snap to geometry | Snap to objects | Keep tool selected after use | Rename duplicated layers | Show dimensions on objects | Hide canvas UI during changes | Use smart quotes/symbols | Flip objects while resizing | Keyboard zooms into selection | Invert zoom direction | Ctrl+click opens right click menus | Use number keys for opacity | Use old shortcuts for outlines | Use ⌘⌥↑/↓ to rotate layers | Play audio notifications in AI chat | Open links in desktop app | Show text suggestions | Show tool suggestions | Show Agents on canvas | Use scroll wheel zoom | Right-click and drag to pan | Keyboard layout… | Accessibility settings… | Permissions and helpers…
## main-help: live 9 ours 1
  only-live: Help page | Support forum | Video tutorials | Release notes | Open font settings | Legal summary | Account settings | Log out
```

## Appendix A: Design panel (RIGHT) machine diffs, live vs ours (x,y w×h relative to panel body; SHIFT = constant vertical offset from that live y on; fixture-caused noise possible)
```
## arrow (10)
  MISSING 16,619 49x11 "Start point" 9px/500 #ffffffb2
  MISSING 15,636 55x13 "Start point" 11px/400 #ffffff
  MISSING 25,635 200x24 svg [Line arrow]
  MISSING 100,619 43x11 "End point" 9px/500 #ffffffb2
  MISSING 99,636 49x13 "End point" 11px/400 #ffffff
  SHIFT   from live y=690 (T:Effects) ours is -2px (live 690, ours 688); was 0
  EXTRA   24,590 36x14 "Center" 11px/450 #ffffff
  EXTRA   16,617 107x11 "Start point and end point" 9px/500 #ffffffb2
  EXTRA   16,633 88x24 button [Start point] bg=#383838 r=5px
  EXTRA   112,633 88x24 button [End point] bg=#383838 r=5px
## autolayout-child (13)
  MISSING 124,12 24x24 button [Select matching layers] r=5px
  DIFF    [Create component]: pos/size live 152,12 24x24 ours 107,12 24x24
  MISSING 180,12 24x24 input =unchecked [mask-selection]
  DIFF    [X-position]: bg live #2c2c2c ours #383838
  DIFF    [Y-position]: bg live #2c2c2c ours #383838
  MISSING 39,306 48x24 input =80 [Width] r=2px
  MISSING 135,306 48x24 input =50 [Height] r=2px
  EXTRA   135,12 24x24 button [Use as mask] r=5px
  EXTRA   163,12 41x24 group [Boolean operations]
  EXTRA   163,12 24x24 button [Union] r=5px 0px 0px 5px DISABLED
  EXTRA   188,12 16x24 button [Boolean operations] r=0px 5px 5px 0px
  EXTRA   95,306 9x24 button [Width sizing]
  EXTRA   191,306 9x24 button [Height sizing]
## autolayout-grid (7)
  MISSING 39,354 48x24 input =320 [Width] r=2px
  MISSING 135,354 48x24 input =200 [Height] r=2px
  DIFF    T:3: font live 11px/400 ours 11px/450
  DIFF    T:×: font live 11px/400 ours 11px/450
  DIFF    T:2: font live 11px/400 ours 11px/450
  EXTRA   95,354 9x24 button [Width sizing]
  EXTRA   191,354 9x24 button [Height sizing]
## autolayout-horizontal (2)
  EXTRA   95,354 9x24 button [Horizontal resizing sizing]
  EXTRA   191,354 9x24 button [Vertical resizing sizing]
## autolayout-parent-fixed (8)
  MISSING 39,354 48x24 input =400 [Width] r=2px
  MISSING 135,354 48x24 input =100 [Height] r=2px
  DIFF    [Solid color hex: 8080E5]: bg live #8080e5 ours #e58033
  DIFF    [Color]: value live "8080E5" ours "E58033"
  DIFF    [Solid color hex: E58033]: bg live #e58033 ours #8080e5
  DIFF    [Color]: value live "E58033" ours "8080E5"
  EXTRA   95,354 9x24 button [Width sizing]
  EXTRA   191,354 9x24 button [Height sizing]
## autolayout-vertical (2)
  EXTRA   95,354 9x24 button [Horizontal resizing sizing]
  EXTRA   191,354 9x24 button [Vertical resizing sizing]
## autolayout-wrap (3)
  MISSING 39,354 48x24 input =170 [Horizontal resizing] r=2px
  EXTRA   95,354 9x24 button [Horizontal resizing sizing]
  EXTRA   191,354 9x24 button [Vertical resizing sizing]
## boolean (0)

## ellipse (0)

## frame (0)

## frame-child-constraints (13)
  MISSING 124,12 24x24 button [Select matching layers] r=5px
  DIFF    [Create component]: pos/size live 152,12 24x24 ours 107,12 24x24
  MISSING 180,12 24x24 input =unchecked [mask-selection]
  DIFF    [Constraints]: bg live #394360 ours none
  MISSING 16,191 53x11 "Constraints" 9px/500 #ffffffb2
  SHIFT   from live y=271 (T:Rotation) ours is -82px (live 271, ours 189); was 0
  EXTRA   135,12 24x24 button [Use as mask] r=5px
  EXTRA   163,12 41x24 group [Boolean operations]
  EXTRA   163,12 24x24 button [Union] r=5px 0px 0px 5px DISABLED
  EXTRA   188,12 16x24 button [Boolean operations] r=0px 5px 5px 0px
  EXTRA   40,409 64x24 input =100% [Opacity]
  EXTRA   136,409 64x24 input =0 [Corner radius]
  EXTRA   118,494 38x24 input =100 [Color opacity]
## frame-child-constraints-expanded (18)
  MISSING 124,12 24x24 button [Select matching layers] r=5px
  DIFF    [Create component]: pos/size live 152,12 24x24 ours 107,12 24x24
  MISSING 180,12 24x24 input =unchecked [mask-selection]
  DIFF    [Constraints]: bg live #32394d ours #394360
  SHIFT   from live y=191 (T:Constraints) ours is -2px (live 191, ours 189); was 0
  EXTRA   135,12 24x24 button [Use as mask] r=5px
  EXTRA   163,12 41x24 group [Boolean operations]
  EXTRA   163,12 24x24 button [Union] r=5px 0px 0px 5px DISABLED
  EXTRA   188,12 16x24 button [Boolean operations] r=0px 5px 5px 0px
  EXTRA   24,211 20x14 "Left" 11px/450 #ffffff
  EXTRA   24,243 20x14 "Top" 11px/450 #ffffff
  EXTRA   112,205 88x57 group [Constraint widget]
  EXTRA   146,205 20x17 button [Top] CHECKED
  EXTRA   146,245 20x17 button [Bottom]
  EXTRA   112,223 22x21 button [Left] CHECKED
  EXTRA   178,223 22x21 button [Right]
  EXTRA   144,230 24x7 button [Center horizontally]
  EXTRA   152,223 8x21 button [Center vertically]
## autolayout-individual-padding (11)
  SHIFT   from live y=8 ([Frame, Frame Dimension Presets]) ours is +4px (live 8, ours 12); was 0
  EXTRA   152,12 24x24 button [Toggle ready for dev status] r=5px
  EXTRA   16,306 184x24 radiogroup [Layout] bg=#383838 r=5px
  EXTRA   95,354 9x24 button [Horizontal resizing sizing]
  EXTRA   191,354 9x24 button [Vertical resizing sizing]
  EXTRA   16,404 88x56 radiogroup [Alignment] bg=#383838 r=5px
  EXTRA   40,653 64x24 input =100% [Opacity]
  EXTRA   136,653 64x24 input =0 [Corner radius]
  EXTRA   118,738 38x24 input =100 [Color opacity]
  EXTRA   118,905 38x24 input =100 [Color opacity]
  EXTRA   118,937 38x24 input =100 [Color opacity]
## grid-child (26)
  MISSING 124,12 24x24 button [Select matching layers] r=5px
  DIFF    [Create component]: pos/size live 152,12 24x24 ours 107,12 24x24
  MISSING 180,12 24x24 input =unchecked [mask-selection]
  DIFF    [X-position]: bg live #2c2c2c ours #383838
  DIFF    [Y-position]: bg live #2c2c2c ours #383838
  MISSING 39,306 48x24 input =60 [Width] r=2px
  MISSING 135,306 48x24 input =40 [Height] r=2px
  MISSING 16,340 59x11 "Column span" 9px/500 #ffffffb2
  DIFF    [Column span]: pos/size live 16,356 88x24 ours 40,354 64x24; bg live #383838 ours none
  MISSING 40,356 64x24 input =1 [Column span] r=5px
  MISSING 112,340 44x11 "Row span" 9px/500 #ffffffb2
  DIFF    [Row span]: pos/size live 112,356 88x24 ours 136,354 64x24; bg live #383838 ours none
  MISSING 136,356 64x24 input =1 [Row span] r=5px
  SHIFT   from live y=411 (T:Appearance) ours is -2px (live 411, ours 409); was 0
  EXTRA   135,12 24x24 button [Use as mask] r=5px
  EXTRA   163,12 41x24 group [Boolean operations]
  EXTRA   163,12 24x24 button [Union] r=5px 0px 0px 5px DISABLED
  EXTRA   188,12 16x24 button [Boolean operations] r=0px 5px 5px 0px
  EXTRA   16,109 88x24 radiogroup [Horizontal alignment in cell] bg=#383838 r=5px
  EXTRA   112,109 88x24 radiogroup [Vertical alignment in cell] bg=#383838 r=5px
  EXTRA   95,306 9x24 button [Width sizing]
  EXTRA   191,306 9x24 button [Height sizing]
  EXTRA   16,338 22x11 "Span" 9px/500 #ffffffb2
  EXTRA   40,457 64x24 input =100% [Opacity]
  EXTRA   136,457 64x24 input =0 [Corner radius]
  EXTRA   118,542 38x24 input =100 [Color opacity]
## group (0)

## image-fill (3)
  DIFF    [Image]: pos/size live 17,494 100x24 ours 16,494 24x24
  EXTRA   40,494 77x24 button [Color: Image]
  EXTRA   40,499 32x14 "Image" 11px/450 #ffffff
## line (10)
  MISSING 16,619 49x11 "Start point" 9px/500 #ffffffb2
  MISSING 15,636 55x13 "Start point" 11px/400 #ffffff
  MISSING 25,635 200x24 svg [None]
  MISSING 100,619 43x11 "End point" 9px/500 #ffffffb2
  MISSING 99,636 49x13 "End point" 11px/400 #ffffff
  SHIFT   from live y=690 (T:Effects) ours is -2px (live 690, ours 688); was 0
  EXTRA   24,590 36x14 "Center" 11px/450 #ffffff
  EXTRA   16,617 107x11 "Start point and end point" 9px/500 #ffffffb2
  EXTRA   16,633 88x24 button [Start point] bg=#383838 r=5px
  EXTRA   112,633 88x24 button [End point] bg=#383838 r=5px
## mixed-multi (25)
  MISSING 40,440 64x13 "Clip content" 11px/450 #ffffff
  SHIFT   from live y=489 (T:Appearance) ours is -32px (live 489, ours 457); was 0
  DIFF    [Font family]: pos/size live 16,618 184x32 ours 16,590 184x24
  MISSING 112,650 88x32 listbox [Font size: 24 px]
  MISSING 119,660 14x13 "24" 11px/450 #ffffff
  DIFF    [Line height]: pos/size live 40,704 61x24 ours 40,672 64x24
  DIFF    T:Letter spacing: pos/size live 112,688 66x11 ours 112,656 62x11
  DIFF    [Letter spacing]: pos/size live 136,704 61x24 ours 136,672 64x24
  DIFF    [Solid color hex: D9D9D9]: bg live #d9d9d9 ours #3380ff
  DIFF    [Color]: value live "D9D9D9" ours "3380FF"
  DIFF    [Solid color hex: 000000]: bg live #000000 ours #d9d9d9
  DIFF    [Color]: value live "000000" ours "D9D9D9"
  DIFF    [Solid color hex: 3380FF]: bg live #3380ff ours #000000
  DIFF    [Color]: value live "3380FF" ours "000000"
  MISSING 21,1105 14x14 button [Solid color hex: FFFFFF] bg=#ffffff r=2px
  MISSING 40,1100 77x24 input =FFFFFF [Color] r=5px
  EXTRA   40,505 64x24 input =100% [Opacity]
  EXTRA   136,505 64x24 input =0 [Corner radius]
  EXTRA   16,622 88x24 combobox [Font style] r=5px
  EXTRA   24,627 40x14 "Regular" 11px/450 #ffffff
  EXTRA   184,622 16x24 button [Font sizes]
  EXTRA   16,720 88x24 radiogroup [Text align horizontal] bg=#383838 r=5px
  EXTRA   112,720 88x24 radiogroup [Text align vertical] bg=#383838 r=5px
  EXTRA   118,972 38x24 input =100 [Color opacity]
  EXTRA   24,1069 81x14 "See all 4 colors" 11px/450 #7cc4f8
## multi-two-shapes (0)

## page-nothing-selected (5)
  MISSING 208,8 24x24 button [Apply variable mode] r=5px
  MISSING 16,181 25x13 "MCP" 11px/550 #ffffff
  MISSING 45,179 75x16 span [Figma MCP in Claude]
  MISSING 49,181 67x13 "1 connection" 11px/450 #ffffff
  MISSING 208,175 24x24 button [Set up agents for Figma MCP] r=5px
## polygon (0)

## rectangle (0)

## rectangle-individual-corners (31)
  DIFF    [Top left corner radius]: pos/size live 16,441 88x24 ours 40,457 64x24; bg live #383838 ours none
  MISSING 40,441 63x24 input =0 [Top left corner radius] r=2px
  DIFF    [Top right corner radius]: pos/size live 112,441 88x24 ours 136,457 64x24; bg live #383838 ours none
  MISSING 136,441 63x24 input =0 [Top right corner radius] r=2px
  DIFF    [Bottom left corner radius]: pos/size live 16,473 88x24 ours 40,505 64x24; bg live #383838 ours none
  MISSING 40,473 63x24 input =0 [Bottom left corner radius] r=2px
  DIFF    [Bottom right corner radius]: pos/size live 112,473 88x24 ours 136,505 64x24; bg live #383838 ours none
  MISSING 136,473 63x24 input =0 [Bottom right corner radius] r=2px
  SHIFT   from live y=473 ([Corner smoothing]) ours is -16px (live 473, ours 457); was 0
  SHIFT   from live y=528 (T:Fill) ours is +32px (live 528, ours 560); was -16
  DIFF    T:Stroke: color live #ffffff ours #ffffffb2
  MISSING 21,648 14x14 button [Solid color hex: 000000] bg=#000000 r=2px
  MISSING 40,643 77x24 input =000000 [Color] r=5px
  MISSING 180,643 24x24 input =checked [Toggle visibility]
  MISSING 208,643 24x24 button [Remove] r=5px
  MISSING 16,677 37x11 "Position" 9px/500 #ffffffb2
  MISSING 100,677 32x11 "Weight" 9px/500 #ffffffb2
  MISSING 100,693 72x24 label [Stroke weight] bg=#383838 r=5px
  MISSING 124,693 47x24 input =1 [Stroke weight] r=2px
  MISSING 180,693 24x24 button [Advanced stroke settings] r=5px
  MISSING 208,693 24x24 button [Individual strokes] r=5px
  SHIFT   from live y=748 (T:Effects) ours is -62px (live 748, ours 686); was 32
  DIFF    T:Effects: color live #ffffff ours #ffffffb2
  MISSING 41,784 69x13 "Drop shadow" 11px/400 #ffffff
  MISSING 180,778 24x24 input =checked [Toggle visibility]
  MISSING 208,778 24x24 button [Remove] r=5px
  SHIFT   from live y=833 (T:Export) ours is -106px (live 833, ours 727); was -62
  EXTRA   16,441 52x11 "Top corners" 9px/500 #ffffffb2
  EXTRA   16,489 67x11 "Bottom corners" 9px/500 #ffffffb2
  EXTRA   118,590 38x24 input =100 [Color opacity]
  EXTRA   208,639 24x24 button [Add stroke] r=5px
## rectangle-with-effect (4)
  DIFF    [Add effect]: bg live #ffffff0d ours none
  DIFF    T:Drop shadow: pos/size live 41,720 69x13 ours 44,719 70x14; font live 11px/400 ours 11px/450
  EXTRA   24,634 32x14 "Inside" 11px/450 #ffffff
  EXTRA   16,714 24x24 button [Effect settings] r=5px
## rectangle-with-export (28)
  DIFF    T:Stroke: color live #ffffff ours #ffffffb2
  MISSING 21,584 14x14 button [Solid color hex: 000000] bg=#000000 r=2px
  MISSING 40,579 77x24 input =000000 [Color] r=5px
  MISSING 180,579 24x24 input =checked [Toggle visibility]
  MISSING 208,579 24x24 button [Remove] r=5px
  MISSING 16,613 37x11 "Position" 9px/500 #ffffffb2
  MISSING 100,613 32x11 "Weight" 9px/500 #ffffffb2
  MISSING 100,629 72x24 label [Stroke weight] bg=#383838 r=5px
  MISSING 124,629 47x24 input =1 [Stroke weight] r=2px
  MISSING 180,629 24x24 button [Advanced stroke settings] r=5px
  MISSING 208,629 24x24 button [Individual strokes] r=5px
  SHIFT   from live y=684 (T:Effects) ours is -94px (live 684, ours 590); was 0
  DIFF    T:Effects: color live #ffffff ours #ffffffb2
  MISSING 41,720 69x13 "Drop shadow" 11px/400 #ffffff
  MISSING 180,714 24x24 input =checked [Toggle visibility]
  MISSING 208,714 24x24 button [Remove] r=5px
  SHIFT   from live y=769 (T:Export) ours is -138px (live 769, ours 631); was -94
  MISSING 16,799 49x24 input =1x [Export constraints for content scale or width/height dimensions] r=5px 0px 0px 5px
  MISSING 66,799 24x24 button [Select an option] bg=#383838 r=0px 5px 5px 0px
  MISSING 98,799 74x24 combobox [Export file type] bg=#2c2c2c r=5px
  DIFF    T:Export Rect: pos/size live 89,837 62x13 ours 93,698 61x14
  DIFF    T:Preview: pos/size live 24,869 43x13 ours 28,734 42x14; font live 11px/550 ours 11px/450; color live #ffffffb2 ours #ffffff
  EXTRA   16,661 60x24 input =1x [Scale]
  EXTRA   76,661 16x24 button [Scale presets]
  EXTRA   96,661 76x24 combobox [File format] r=5px
  EXTRA   104,666 24x14 "PNG" 11px/450 #ffffff
  EXTRA   180,661 24x24 button [Export settings] r=5px
  EXTRA   208,661 24x24 button [Remove export settings] r=5px
## rectangle-with-stroke (1)
  EXTRA   24,634 36x14 "Center" 11px/450 #ffffff
## section (2)
  DIFF    [Solid color hex: FFFFFF]: pos/size live 21,536 14x14 ours 16,531 24x24; bg live #ffffff ours none; r live 2px ours 5px
  EXTRA   24,586 32x14 "Inside" 11px/450 #ffffff
## star (0)

## text (9)
  MISSING 136,25 57x13 "Create link" 11px/450 #ffffff
  DIFF    [Font family]: pos/size live 16,538 184x32 ours 16,542 184x24
  MISSING 112,570 88x32 listbox [Font size: 24 px]
  MISSING 119,580 14x13 "24" 11px/450 #ffffff
  DIFF    [Line height]: pos/size live 40,624 61x24 ours 40,624 64x24
  DIFF    T:Letter spacing: pos/size live 112,608 66x11 ours 112,608 62x11
  DIFF    [Letter spacing]: pos/size live 136,624 61x24 ours 136,624 64x24
  EXTRA   24,579 40x14 "Regular" 11px/450 #ffffff
  EXTRA   184,574 16x24 button [Font sizes]
## text-editing-caret (10)
  MISSING 164,25 57x13 "Create link" 11px/450 #ffffff
  DIFF    [Font family]: pos/size live 16,538 184x32 ours 16,542 184x24
  MISSING 112,570 88x32 listbox [Font size: 24 px]
  MISSING 119,580 14x13 "24" 11px/450 #ffffff
  DIFF    [Line height]: pos/size live 40,624 61x24 ours 40,624 64x24
  DIFF    T:Letter spacing: pos/size live 112,608 66x11 ours 112,608 62x11
  DIFF    [Letter spacing]: pos/size live 136,624 61x24 ours 136,624 64x24
  EXTRA   124,12 24x24 button [Create link] r=5px
  EXTRA   24,579 40x14 "Regular" 11px/450 #ffffff
  EXTRA   184,574 16x24 button [Font sizes]
## frame-with-layout-guide (13)
  SHIFT   from live y=8 ([Frame, Frame Dimension Presets]) ours is -72px (live 8, ours -64); was 0
  DIFF    T:Position: pos/size live 16,59 44x13 ours 16,65 35x11; font live 11px/550 ours 9px/500; color live #ffffff ours #ffffffb2
  DIFF    T:Position: pos/size live 16,137 37x11 ours 16,-13 43x14; font live 9px/500 ours 11px/550; color live #ffffffb2 ours #ffffff
  DIFF    [Layout guide settings]: bg live #394360 ours none
  EXTRA   152,-64 24x24 button [Toggle ready for dev status] r=5px
  EXTRA   16,230 184x24 radiogroup [Layout] bg=#383838 r=5px
  EXTRA   40,413 64x24 input =100% [Opacity]
  EXTRA   136,413 64x24 input =0 [Corner radius]
  EXTRA   118,498 38x24 input =100 [Color opacity]
  EXTRA   118,665 38x24 input =100 [Color opacity]
  EXTRA   118,697 38x24 input =100 [Color opacity]
  EXTRA   44,787 50x14 "Grid 10px" 11px/450 #ffffff
  EXTRA   180,782 24x24 button [Hide layout guide] r=5px
## component (47)
  DIFF    T:Button: pos/size live 16,16 42x16 ours 162,121 35x14; font live 13px/550 ours 11px/450; color live #ffffff ours #ffffffb2
  DIFF    [Add variant]: pos/size live 152,12 24x24 ours 208,8 24x24
  MISSING 180,12 24x24 button [Component configuration] r=5px
  MISSING 208,12 24x24 button [More actions] r=5px
  SHIFT   from live y=50 (T:Properties) ours is +4px (live 50, ours 54); was 0
  DIFF    T:Properties: color live #ffffffb2 ours #ffffff
  MISSING 17,76 24x24 span [Boolean property]
  DIFF    T:Show icon: pos/size live 41,82 54x13 ours 40,89 55x14; font live 11px/400 ours 11px/450
  MISSING 95,82 11x13 "・" 11px/400 #ffffffb2
  DIFF    T:True: pos/size live 106,82 23x13 ours 172,89 24x14; font live 11px/400 ours 11px/450
  MISSING 17,108 24x24 span [Text property]
  DIFF    T:Label: pos/size live 41,114 28x13 ours 40,121 29x14; font live 11px/400 ours 11px/450
  MISSING 69,114 11x13 "・" 11px/400 #ffffffb2
  MISSING 80,114 28x13 "Label" 11px/400 #ffffffb2
  MISSING 17,140 24x24 span [Instance swap property]
  DIFF    T:Icon: pos/size live 41,146 22x13 ours 40,153 23x14; font live 11px/400 ours 11px/450
  MISSING 63,146 11x13 "・" 11px/400 #ffffffb2
  DIFF    T:Star: pos/size live 74,146 21x13 ours 175,153 21x14; font live 11px/400 ours 11px/450
  SHIFT   from live y=195 (T:Position) ours is +86px (live 195, ours 281); was 4
  MISSING 169,492 22x13 "Hug" 11px/450 #ffffff
  DIFF    [Solid color hex: 0D99FF]: bg live #0d99ff ours #ffc700
  DIFF    [Color]: value live "0D99FF" ours "FFC700"
  DIFF    [Color]: value live "FFB200" ours "FFFFFF"
  DIFF    [Solid color hex: FFFFFF]: bg live #ffffff ours #0d99ff
  DIFF    [Color]: value live "FFFFFF" ours "0D99FF"
  EXTRA   36,13 62x14 "Component" 11px/550 #d1a8ff
  EXTRA   208,48 24x24 button [Create component property] r=5px
  EXTRA   8,80 196x32 button [Edit property Show icon] r=5px
  EXTRA   208,84 24x24 button [Delete property Show icon] r=5px
  EXTRA   8,112 196x32 button [Edit property Label] r=5px
  EXTRA   208,116 24x24 button [Delete property Label] r=5px
  EXTRA   8,144 196x32 button [Edit property Icon] r=5px
  EXTRA   208,148 24x24 button [Delete property Icon] r=5px
  EXTRA   40,189 54x14 "Icons/Star" 11px/450 #ffffff
  EXTRA   208,184 24x24 button [Stop exposing Icons/Star] r=5px
  EXTRA   16,220 216x26 textarea [Description] bg=#383838 r=5px
  EXTRA   16,524 184x24 radiogroup [Layout] bg=#383838 r=5px
  EXTRA   95,572 9x24 button [Horizontal resizing sizing]
  EXTRA   191,572 9x24 button [Vertical resizing sizing]
  EXTRA   16,622 88x56 radiogroup [Alignment] bg=#383838 r=5px
  EXTRA   40,839 64x24 input =100% [Opacity]
  EXTRA   136,839 64x24 input =8 [Corner radius]
  EXTRA   118,924 38x24 input =100 [Color opacity]
  EXTRA   16,1091 24x24 button [Solid color hex: FFC700] r=5px
  EXTRA   118,1091 38x24 input =100 [Color opacity]
  ... 2 more
## component-set (85)
  MISSING 16,16 29x16 "Chip" 13px/550 #ffffff
  MISSING 124,12 24x24 input =unchecked [Multi-edit variants]
  DIFF    [Add variant]: pos/size live 152,12 24x24 ours 208,8 24x24
  MISSING 180,12 24x24 button [Component configuration] r=5px
  SHIFT   from live y=12 ([More actions]) ours is +247px (live 12, ours 259); was 0
  SHIFT   from live y=50 (T:Properties) ours is +4px (live 50, ours 54); was 247
  DIFF    T:Properties: color live #ffffffb2 ours #ffffff
  MISSING 17,76 24x24 span [Variant property]
  DIFF    T:State: pos/size live 41,82 28x13 ours 40,89 27x14; font live 11px/400 ours 11px/450
  MISSING 69,82 11x13 "・" 11px/400 #ffffffb2
  MISSING 80,82 122x13 "Default, Hover, Pressed" 11px/400 #ffffffb2
  SHIFT   from live y=131 (T:Position) ours is +82px (live 131, ours 213); was 4
  MISSING 16,328 62x13 "Auto layout" 11px/550 #ffffff
  MISSING 208,374 24x24 input =unchecked [Wrap]
  MISSING 16,406 38x11 "Resizing" 9px/500 #ffffffb2
  DIFF    T:W: font live 11px/450 ours 11px/400
  MISSING 39,422 24x24 input =364 [Horizontal resizing] r=2px
  MISSING 73,428 22x13 "Hug" 11px/450 #ffffff
  DIFF    T:H: font live 11px/450 ours 11px/400
  MISSING 135,422 48x24 input =40 [Vertical resizing] r=2px
  MISSING 16,456 46x11 "Alignment" 9px/500 #ffffffb2
  MISSING 112,456 18x11 "Gap" 9px/500 #ffffffb2
  MISSING 17,477 29x16 input =TOP_LEFT [Align top left]
  MISSING 46,477 29x16 input =TOP_CENTER [Align top center]
  MISSING 74,477 29x16 input =TOP_RIGHT [Align top right]
  MISSING 17,493 29x15 input =LEFT [Align left]
  MISSING 46,493 29x15 input =CENTER [Align center]
  MISSING 74,493 29x15 input =RIGHT [Align right]
  MISSING 17,508 29x15 input =BOTTOM_LEFT [Align bottom left]
  MISSING 46,508 29x15 input =BOTTOM_CENTER [Align bottom center]
  MISSING 74,508 29x15 input =BOTTOM_RIGHT [Align bottom right]
  MISSING 112,472 88x24 label [Horizontal gap between objects] r=5px
  MISSING 135,472 64x24 input =16 [Horizontal gap between objects] r=2px
  MISSING 208,472 24x24 button [Auto layout settings] r=5px
  MISSING 16,538 37x11 "Padding" 9px/500 #ffffffb2
  MISSING 16,554 88x24 label [Horizontal padding] bg=#383838 r=5px
  MISSING 40,554 63x24 input =16 [Horizontal padding] r=2px
  MISSING 112,554 88x24 label [Vertical padding] bg=#383838 r=5px
  MISSING 136,554 63x24 input =16 [Vertical padding] r=2px
  MISSING 208,554 24x24 button [Individual padding] r=5px
  SHIFT   from live y=592 (T:Clip content) ours is -51px (live 592, ours 541); was 82
  DIFF    T:Stroke: color live #ffffffb2 ours #ffffff
  SHIFT   from live y=826 (T:Effects) ours is +44px (live 826, ours 870); was -51
  DIFF    [Color]: value live "99E5E5" ours "E5F4FF"
  DIFF    [Color]: value live "E6E6E6" ours "BDE3FF"
  ... 40 more
## variant (34)
  MISSING 16,16 29x16 "Chip" 13px/550 #ffffff
  MISSING 152,12 24x24 input =unchecked [Multi-edit variants]
  MISSING 180,12 24x24 button [Select matching layers] r=5px
  MISSING 208,12 24x24 button [Component configuration] r=5px
  SHIFT   from live y=50 (T:Current variant) ours is +4px (live 50, ours 54); was 0
  DIFF    T:Current variant: color live #ffffffb2 ours #ffffff
  MISSING 208,44 24x24 button [Select component] r=5px
  MISSING 8,76 92x24 button [Edit property name for State] bg=#2c2c2c r=5px
  DIFF    T:State: pos/size live 17,82 28x13 ours 16,93 27x14
  MISSING 108,72 92x32 listbox [Edit property value for State]
  MISSING 108,76 68x24 input =Default [Edit property value for State] bg=#2c2c2c r=5px 0px 0px 5px
  SHIFT   from live y=131 (T:Position) ours is +78px (live 131, ours 209); was 4
  MISSING 208,125 24x24 input =unchecked [Ignore auto layout]
  DIFF    [X-position]: bg live #2c2c2c ours #383838
  DIFF    [Y-position]: bg live #2c2c2c ours #383838
  DIFF    T:W: font live 11px/450 ours 11px/400
  MISSING 39,422 48x24 input =100 [Width] r=2px
  DIFF    T:H: font live 11px/450 ours 11px/400
  MISSING 135,422 48x24 input =40 [Height] r=2px
  DIFF    [Color]: value live "E6E6E6" ours "E5F4FF"
  EXTRA   36,13 38x14 "Variant" 11px/550 #d1a8ff
  EXTRA   208,8 24x24 button [Add variant] r=5px
  EXTRA   112,88 88x24 combobox [State] r=5px
  EXTRA   120,93 38x14 "Default" 11px/450 #ffffff
  EXTRA   16,125 22x14 "Size" 11px/450 #ffffffb2
  EXTRA   112,120 88x24 combobox [Size] r=5px
  EXTRA   120,125 29x14 "Small" 11px/450 #ffffff
  EXTRA   16,156 216x26 textarea [Description] bg=#383838 r=5px
  EXTRA   208,303 24x24 button [Constraints] r=5px
  EXTRA   16,452 184x24 radiogroup [Layout] bg=#383838 r=5px
  EXTRA   40,635 64x24 input =100% [Opacity]
  EXTRA   136,635 64x24 input =14 [Corner radius]
  EXTRA   16,720 24x24 button [Solid color hex: E5F4FF] r=5px
  EXTRA   118,720 38x24 input =100 [Color opacity]
## instance (34)
  MISSING 119,74 54x13 "Show icon" 11px/400 #ffffff
  MISSING 208,68 24x24 button [Apply variable/property to Show icon] r=5px
  MISSING 208,100 24x24 button [Apply variable/property to Label] r=5px
  SHIFT   from live y=187 (T:Position) ours is +72px (live 187, ours 259); was 0
  MISSING 39,478 17x24 input =95 [Horizontal resizing] r=2px
  MISSING 169,484 22x13 "Hug" 11px/450 #ffffff
  DIFF    [Color]: value live "0D99FF" ours "14AE5C"
  DIFF    [Color]: value live "0D99FF" ours "FFC700"
  DIFF    [Color]: value live "FFB200" ours "FFFFFF"
  DIFF    [Solid color hex: FFFFFF]: bg live #ffffff ours #14ae5c
  DIFF    [Color]: value live "FFFFFF" ours "14AE5C"
  EXTRA   8,12 71x24 button [Instance menu: Button] r=5px
  EXTRA   16,72 88x16 span [Show icon]
  EXTRA   112,72 28x16 switch [Show icon] bg=#0c8ce9 r=9999px CHECKED
  EXTRA   16,104 88x16 span [Label]
  EXTRA   16,136 88x16 span [Icon]
  EXTRA   36,177 55x14 "Icons/Star" 11px/550 #ffffff
  EXTRA   16,208 88x16 span [Filled]
  EXTRA   16,209 28x14 "Filled" 11px/450 #ffffffb2
  EXTRA   112,208 28x16 switch [Filled] bg=#0c8ce9 r=9999px CHECKED
  EXTRA   208,353 24x24 button [Constraints] r=5px
  EXTRA   16,502 184x24 radiogroup [Layout] bg=#383838 r=5px
  EXTRA   95,550 9x24 button [Horizontal resizing sizing]
  EXTRA   191,550 9x24 button [Vertical resizing sizing]
  EXTRA   16,600 88x56 radiogroup [Alignment] bg=#383838 r=5px
  EXTRA   40,817 64x24 input =100% [Opacity]
  EXTRA   136,817 64x24 input =8 [Corner radius]
  EXTRA   16,902 24x24 button [Solid color hex: 14AE5C] r=5px
  EXTRA   118,902 38x24 input =100 [Color opacity]
  EXTRA   16,1069 24x24 button [Solid color hex: FFC700] r=5px
  EXTRA   118,1069 38x24 input =100 [Color opacity]
  EXTRA   118,1101 38x24 input =100 [Color opacity]
  EXTRA   16,1133 24x24 button [Solid color hex: 14AE5C] r=5px
  EXTRA   118,1133 38x24 input =100 [Color opacity]
## variant-instance (25)
  MISSING 17,16 29x16 "Chip" 13px/550 #ffffff
  MISSING 208,68 24x24 button [Apply variable] r=5px
  SHIFT   from live y=123 (T:Position) ours is +32px (live 123, ours 155); was 0
  SHIFT   from live y=350 (T:Dimensions) ours is +80px (live 350, ours 430); was 32
  DIFF    [Color]: value live "E6E6E6" ours "E5F4FF"
  EXTRA   8,12 192x24 button [Instance menu: State=Default, Size=Small] r=5px
  EXTRA   16,16 162x16 "State=Default, Size=Small" 13px/550 #ffffff
  EXTRA   16,72 88x16 span [State]
  EXTRA   120,73 38x14 "Default" 11px/450 #ffffff
  EXTRA   16,104 88x16 span [Size]
  EXTRA   16,105 22x14 "Size" 11px/450 #ffffffb2
  EXTRA   112,100 88x24 combobox [Size] r=5px
  EXTRA   120,105 29x14 "Small" 11px/450 #ffffff
  EXTRA   208,249 24x24 button [Constraints] r=5px
  EXTRA   208,346 24x24 button [Use auto layout] r=5px
  EXTRA   16,382 21x11 "Flow" 9px/500 #ffffffb2
  EXTRA   16,398 184x24 radiogroup [Layout] bg=#383838 r=5px
  EXTRA   16,398 46x24 radio [Freeform] bg=#2c2c2c r=5px CHECKED
  EXTRA   62,398 46x24 radio [Vertical] r=5px
  EXTRA   108,398 46x24 radio [Horizontal] r=5px
  EXTRA   154,398 46x24 radio [Grid] r=5px
  EXTRA   40,581 64x24 input =100% [Opacity]
  EXTRA   136,581 64x24 input =14 [Corner radius]
  EXTRA   16,666 24x24 button [Solid color hex: E5F4FF] r=5px
  EXTRA   118,666 38x24 input =100 [Color opacity]
## nested-instance (72)
  MISSING 17,16 42x16 "Button" 13px/550 #ffffff
  MISSING 16,74 54x13 "Show icon" 11px/450 #ffffffb2
  MISSING 119,74 54x13 "Show icon" 11px/400 #ffffff
  MISSING 208,68 24x24 button [Apply variable/property to Show icon] r=5px
  MISSING 16,106 29x13 "Label" 11px/450 #ffffffb2
  MISSING 208,100 24x24 button [Apply variable/property to Label] r=5px
  MISSING 16,138 22x13 "Icon" 11px/450 #ffffffb2
  DIFF    T:Star: pos/size live 137,138 22x13 ours 16,16 25x16; font live 11px/450 ours 13px/550
  DIFF    T:Position: pos/size live 16,187 44x13 ours 16,201 35x11; font live 11px/550 ours 9px/500; color live #ffffff ours #ffffffb2
  SHIFT   from live y=181 ([Ignore auto layout]) ours is -64px (live 181, ours 117); was 0
  DIFF    T:Position: pos/size live 16,265 37x11 ours 16,123 43x14; font live 9px/500 ours 11px/550; color live #ffffffb2 ours #ffffff
  DIFF    [X-position]: bg live #2c2c2c ours #383838
  DIFF    [Y-position]: bg live #2c2c2c ours #383838
  DIFF    [Rotation]: bg live #2c2c2c ours #383838
  MISSING 16,384 62x13 "Auto layout" 11px/550 #ffffff
  MISSING 208,430 24x24 input =unchecked [Wrap] DISABLED
  MISSING 16,462 38x11 "Resizing" 9px/500 #ffffffb2
  MISSING 16,474 88x32 div [Horizontal resizing]
  MISSING 16,474 88x32 listbox [Advanced auto layout settings]
  MISSING 41,484 22x13 "Hug" 11px/450 #ffffff
  MISSING 112,474 88x32 div [Vertical resizing]
  MISSING 112,474 88x32 listbox [Advanced auto layout settings]
  MISSING 137,484 22x13 "Hug" 11px/450 #ffffff
  MISSING 16,512 46x11 "Alignment" 9px/500 #ffffffb2
  MISSING 112,512 18x11 "Gap" 9px/500 #ffffffb2
  MISSING 17,533 29x16 input =TOP_LEFT [Align top left]
  MISSING 46,533 29x16 input =TOP_CENTER [Align top center]
  MISSING 74,533 29x16 input =TOP_RIGHT [Align top right]
  MISSING 17,549 29x15 input =LEFT [Align left]
  MISSING 46,549 29x15 input =CENTER [Align center]
  MISSING 74,549 29x15 input =RIGHT [Align right]
  MISSING 17,564 29x15 input =BOTTOM_LEFT [Align bottom left]
  MISSING 46,564 29x15 input =BOTTOM_CENTER [Align bottom center]
  MISSING 74,564 29x15 input =BOTTOM_RIGHT [Align bottom right]
  MISSING 112,528 88x24 label [Horizontal gap between objects] r=5px
  MISSING 135,528 64x24 input =8 [Horizontal gap between objects] r=2px
  MISSING 208,528 24x24 button [Auto layout settings] r=5px
  MISSING 16,594 37x11 "Padding" 9px/500 #ffffffb2
  MISSING 16,610 88x24 label [Horizontal padding] bg=#383838 r=5px
  MISSING 40,610 63x24 input =16 [Horizontal padding] r=2px
  MISSING 112,610 88x24 label [Vertical padding] bg=#383838 r=5px
  MISSING 136,610 63x24 input =10 [Vertical padding] r=2px
  MISSING 208,610 24x24 button [Individual padding] r=5px
  SHIFT   from live y=648 (T:Clip content) ours is -197px (live 648, ours 451); was -64
  DIFF    T:Fill: color live #ffffff ours #ffffffb2
  ... 27 more
```

## Appendix B: popovers and menus
```
## autolayout-advanced-settings: live popups 960,481,240,345; ours 891,484,300,184
  popup live @960,481,240,345 ours @891,484,300,184
    MISSING 89,90 61x20 "Preview" 16px/500 #ffffff66
    MISSING 16,179 68x13 "Inside stroke" 11px/450 #ffffffb2
    MISSING 121,178 45x13 "Included" 11px/450 #ffffff
    SHIFT   from live y=211 (T:Canvas stacking) ours is -94px (live 211, ours 117); was 0
    DIFF    T:Last on top: pos/size live 121,210 59x13 ours 142,117 59x14
    MISSING 16,243 97x13 "Align text baseline" 11px/450 #ffffffb2
    MISSING 175,230 97x13 "Align text baseline" 11px/450 #ffffff
    MISSING 176,237 24x24 input =OFF [Disabled]
    MISSING 200,237 24x24 input =ON [Enabled]
    MISSING 0,265 240x32 div [Only applicable for Auto gap]
    SHIFT   from live y=275 (T:Auto spacing) ours is -222px (live 275, ours 53); was -94
    DIFF    T:Auto spacing: color live #ffffff66 ours #ffffffb2
    DIFF    T:Between: pos/size live 121,274 46x13 ours 142,53 46x14; color live #ffffff66 ours #ffffff
    MISSING 16,307 36x13 "Layout" 11px/450 #ffffffb2
    MISSING 92,305 16x16 button [More info]
    MISSING 121,306 46x13 "Updated" 11px/450 #ffffff
    DIFF    [Close]: pos/size live 208,8 24x24 ours 268,8 24x24
    EXTRA   134,48 150x24 combobox [Auto spacing] r=5px
    EXTRA   16,85 40x14 "Strokes" 11px/450 #ffffffb2
    EXTRA   134,80 150x24 combobox [Strokes] r=5px
    EXTRA   142,85 111x14 "Excluded from layout" 11px/450 #ffffff
    EXTRA   134,112 150x24 combobox [Canvas stacking] r=5px
    EXTRA   16,149 125x14 "Text baseline alignment" 11px/450 #ffffffb2
## autolayout-child-width-menu: live popups 1142,379,162,129; ours 1224,414,208,170
  popup live @1142,379,162,129 ours @1224,414,208,170
    MISSING 8,8 146x24 option [Fixed width (80)] bg=#0c8ce9 r=5px SELECTED
    DIFF    T:Fixed width (80): pos/size live 58,14 86x13 ours 36,12 93x15; font live 11px/400 ours 12px/450
    MISSING 8,32 146x24 option [Fill container] r=5px
    DIFF    T:Fill container: pos/size live 58,38 67x13 ours 36,36 73x15; font live 11px/400 ours 12px/450
    MISSING 8,73 146x24 option [Add min width…] r=5px
    DIFF    T:Add min width…: pos/size live 58,79 85x13 ours 36,77 93x15; font live 11px/400 ours 12px/450
    MISSING 8,97 146x24 option [Add max width…] r=5px
    DIFF    T:Add max width…: pos/size live 58,103 88x13 ours 36,101 96x15; font live 11px/400 ours 12px/450
    EXTRA   36,142 92x15 "Apply variable…" 12px/450 #ffffff
## blend-mode-menu: live popups 1315,472,118,555; ours 1224,335,208,557
  popup live @1315,472,118,555 ours @1224,335,208,557
    DIFF    T:Pass through: pos/size live 32,6 70x13 ours 36,12 75x15; font live 11px/450 ours 12px/450
    DIFF    T:Normal: pos/size live 32,30 38x13 ours 36,36 41x15; font live 11px/450 ours 12px/450
    DIFF    T:Darken: pos/size live 32,69 37x13 ours 36,77 41x15; font live 11px/450 ours 12px/450
    DIFF    T:Multiply: pos/size live 32,93 42x13 ours 36,101 45x15; font live 11px/450 ours 12px/450
    DIFF    T:Plus darker: pos/size live 32,117 59x13 ours 36,125 64x15; font live 11px/450 ours 12px/450
    DIFF    T:Color burn: pos/size live 32,141 56x13 ours 36,149 61x15; font live 11px/450 ours 12px/450
    DIFF    T:Lighten: pos/size live 32,180 39x13 ours 36,190 42x15; font live 11px/450 ours 12px/450
    DIFF    T:Screen: pos/size live 32,204 37x13 ours 36,214 40x15; font live 11px/450 ours 12px/450
    DIFF    T:Plus lighter: pos/size live 32,228 59x13 ours 36,238 63x15; font live 11px/450 ours 12px/450
    DIFF    T:Color dodge: pos/size live 32,252 65x13 ours 36,262 70x15; font live 11px/450 ours 12px/450
    DIFF    T:Overlay: pos/size live 32,291 40x13 ours 36,303 44x15; font live 11px/450 ours 12px/450
    DIFF    T:Soft light: pos/size live 32,315 48x13 ours 36,327 51x15; font live 11px/450 ours 12px/450
    DIFF    T:Hard light: pos/size live 32,339 51x13 ours 36,351 55x15; font live 11px/450 ours 12px/450
    DIFF    T:Difference: pos/size live 32,378 55x13 ours 36,392 59x15; font live 11px/450 ours 12px/450
    DIFF    T:Exclusion: pos/size live 32,402 50x13 ours 36,416 54x15; font live 11px/450 ours 12px/450
    DIFF    T:Hue: pos/size live 32,441 21x13 ours 36,457 23x15; font live 11px/450 ours 12px/450
    DIFF    T:Saturation: pos/size live 32,465 55x13 ours 36,481 58x15; font live 11px/450 ours 12px/450
    DIFF    T:Luminosity: pos/size live 32,513 57x13 ours 36,529 62x15; font live 11px/450 ours 12px/450
    EXTRA   36,505 31x15 "Color" 12px/450 #ffffff
## boolean-operations-menu: live popups 1253,129,151,120; ours 1224,120,208,136
  popup live @1253,129,151,120 ours @1224,120,208,136
    DIFF    T:Union: pos/size live 44,6 31x13 ours 60,12 33x15; font live 11px/450 ours 12px/450; color live #ffffff ours #ffffff59
    DIFF    T:⌥⇧U: pos/size live 104,6 31x13 ours 159,12 33x15; font live 11px/450 ours 12px/450; color live #ffffffcc ours #ffffff73
    DIFF    T:Subtract: pos/size live 44,30 45x13 ours 60,36 49x15; font live 11px/450 ours 12px/450; color live #ffffff ours #ffffff59
    DIFF    T:⌥⇧S: pos/size live 105,30 30x13 ours 161,36 31x15; font live 11px/450 ours 12px/450; color live #ffffffb2 ours #ffffff73
    DIFF    T:Intersect: pos/size live 44,54 47x13 ours 60,60 50x15; font live 11px/450 ours 12px/450; color live #ffffff ours #ffffff59
    DIFF    T:⌥⇧I: pos/size live 110,54 26x13 ours 165,60 27x15; font live 11px/450 ours 12px/450; color live #ffffffb2 ours #ffffff73
    DIFF    T:Exclude: pos/size live 44,78 41x13 ours 60,84 45x15; font live 11px/450 ours 12px/450; color live #ffffff ours #ffffff59
    DIFF    T:⌥⇧E: pos/size live 106,78 29x13 ours 161,84 31x15; font live 11px/450 ours 12px/450; color live #ffffffb2 ours #ffffff73
    DIFF    T:Flatten: pos/size live 44,102 37x13 ours 60,108 39x15; font live 11px/450 ours 12px/450
    DIFF    T:⌥⇧F: pos/size live 106,102 29x13 ours 161,108 31x15; font live 11px/450 ours 12px/450; color live #ffffffb2 ours #ffffff73
## component-create-property-menu: live popups 1277,161,156,207; ours 1224,156,208,201
  popup live @1277,161,156,207 ours @1224,156,208,201
    MISSING 16,6 84x13 "Create property" 11px/450 #ffffffb2
    DIFF    T:Variant: pos/size live 36,30 37x13 ours 40,12 40x15; font live 11px/450 ours 12px/450
    DIFF    T:Text: pos/size live 36,54 23x13 ours 40,84 24x15; font live 11px/450 ours 12px/450
    DIFF    T:Boolean: pos/size live 36,78 43x13 ours 40,36 46x15; font live 11px/450 ours 12px/450
    DIFF    T:Instance swap: pos/size live 36,102 76x13 ours 40,60 82x15; font live 11px/450 ours 12px/450
    DIFF    T:Slot: pos/size live 36,126 21x13 ours 40,108 22x15; font live 11px/450 ours 12px/450
    SHIFT   from live y=165 (T:Expose properties from) ours is -15px (live 165, ours 150); was 0
    DIFF    T:Expose properties from: font live 11px/450 ours 11px/550; color live #ffffffb2 ours #ffffff73
    DIFF    T:Nested instances: pos/size live 36,189 92x13 ours 40,173 99x15; font live 11px/450 ours 12px/450
## constraint-horizontal-menu: live popups 1208,280,126,136; ours 1196,278,128,136
  popup live @1208,280,126,136 ours @1196,278,128,136
    DIFF    T:Left: pos/size live 32,14 21x13 ours 36,12 22x15; font live 11px/450 ours 12px/450
    DIFF    T:Right: pos/size live 32,38 27x13 ours 36,36 29x15; font live 11px/450 ours 12px/450
    MISSING 32,62 62x13 "Left + Right" 11px/450 #ffffff
    DIFF    T:Center: pos/size live 32,86 36x13 ours 36,84 38x15; font live 11px/450 ours 12px/450
    DIFF    T:Scale: pos/size live 32,110 29x13 ours 36,108 32x15; font live 11px/450 ours 12px/450
    EXTRA   36,60 76x15 "Left and right" 12px/450 #ffffff
## constraint-vertical-menu: live popups 1208,312,136,136; ours 1196,310,142,136
  popup live @1208,312,136,136 ours @1196,310,142,136
    DIFF    T:Top: pos/size live 32,14 20x13 ours 36,12 21x15; font live 11px/450 ours 12px/450
    DIFF    T:Bottom: pos/size live 32,38 38x13 ours 36,36 41x15; font live 11px/450 ours 12px/450
    MISSING 32,62 72x13 "Top + Bottom" 11px/450 #ffffff
    DIFF    T:Center: pos/size live 32,86 36x13 ours 36,84 38x15; font live 11px/450 ours 12px/450
    DIFF    T:Scale: pos/size live 32,110 29x13 ours 36,108 32x15; font live 11px/450 ours 12px/450
    EXTRA   36,60 90x15 "Top and bottom" 12px/450 #ffffff
## effect-settings-background-blur: live popups 959,660,240,156; ours 951,700,240,124
  popup live @959,660,240,156 ours @951,700,240,124
    DIFF    [Effect settings]: pos/size live 8,8 133x24 ours 8,8 115x24
    DIFF    T:Background blur: pos/size live 32,14 85x13 ours 16,13 87x14; font live 11px/400 ours 11px/450
    MISSING 15,45 26x13 "Type" 11px/450 #ffffff
    DIFF    T:Uniform: color live #ffffffb2 ours #ffffff
    DIFF    T:Progressive: color live #ffffff ours #ffffffb2
    MISSING 113,84 110x24 input =0 [Start] r=2px
    MISSING 88,116 136x24 label [End] bg=#383838 r=5px
    MISSING 113,116 110x24 input =4 [End] r=2px
    EXTRA   16,89 21x14 "Blur" 11px/450 #ffffffb2
## effect-settings-drop-shadow: live popups 959,660,240,224; ours 951,668,240,224
  popup live @959,660,240,224 ours @951,668,240,224
    DIFF    [Effect settings]: pos/size live 8,8 117x24 ours 8,8 98x24
    DIFF    T:Drop shadow: pos/size live 32,14 69x13 ours 16,13 70x14; font live 11px/400 ours 11px/450
    DIFF    T:X: font live 11px/450 ours 11px/400
    DIFF    T:Y: font live 11px/450 ours 11px/400
    MISSING 16,124 64x16 div [Blur]
    MISSING 113,120 110x24 input =4 [Blur radius] r=2px
    MISSING 113,152 110x24 input =0 [Spread] r=2px
    MISSING 93,189 14x14 button [Solid color hex: 000000] bg=#000000 r=2px
    EXTRA   16,125 21x14 "Blur" 11px/450 #ffffffb2
    EXTRA   16,157 38x14 "Spread" 11px/450 #ffffffb2
    EXTRA   16,189 28x14 "Color" 11px/450 #ffffffb2
    EXTRA   88,184 24x24 button [Color: pick colour] r=5px
## effect-settings-glass: live popups 959,571,240,313; ours 951,580,240,312
  popup live @959,571,240,313 ours @951,580,240,312
    DIFF    [Effect settings]: pos/size live 8,8 76x24 ours 8,8 57x24
    DIFF    T:Glass: pos/size live 32,14 28x13 ours 16,13 29x14; font live 11px/400 ours 11px/450
    MISSING 87,56 27x13 "Light" 11px/450 #ffffff
    MISSING 159,62 64x15 input =-45° [Angle] r=2px
    MISSING 160,88 63x24 input =80% [Intensity] r=2px
    DIFF    [Refraction]: r live 0px 5px 5px 0px ours 5px
    DIFF    [Refraction]: pos/size live 175,149 48x15 ours 88,148 80x16
    MISSING 79,135 96x44 slider [Refraction]
    DIFF    [Depth]: r live 0px 5px 5px 0px ours 5px
    DIFF    [Depth]: pos/size live 175,181 48x15 ours 88,180 80x16
    MISSING 79,167 96x44 slider [Depth]
    DIFF    [Dispersion]: r live 0px 5px 5px 0px ours 5px
    DIFF    [Dispersion]: pos/size live 175,213 48x15 ours 88,212 80x16
    MISSING 79,199 96x44 slider [Dispersion]
    DIFF    [Frost]: r live 0px 5px 5px 0px ours 5px
    DIFF    [Frost]: pos/size live 175,245 48x15 ours 88,244 80x16
    MISSING 79,231 96x44 slider [Frost]
    DIFF    [Splay]: r live 0px 5px 5px 0px ours 5px
    DIFF    [Splay]: pos/size live 175,277 48x15 ours 88,276 80x16
    MISSING 79,263 96x44 slider [Splay]
    EXTRA   16,149 54x14 "Refraction" 11px/450 #ffffffb2
    EXTRA   16,181 32x14 "Depth" 11px/450 #ffffffb2
    EXTRA   16,213 56x14 "Dispersion" 11px/450 #ffffffb2
    EXTRA   16,245 27x14 "Frost" 11px/450 #ffffffb2
    EXTRA   16,277 29x14 "Splay" 11px/450 #ffffffb2
## effect-settings-inner-shadow: live popups 959,660,240,224; ours 951,668,240,224
  popup live @959,660,240,224 ours @951,668,240,224
    DIFF    [Effect settings]: pos/size live 8,8 118x24 ours 8,8 99x24
    DIFF    T:Inner shadow: pos/size live 32,14 70x13 ours 16,13 71x14; font live 11px/400 ours 11px/450
    DIFF    T:X: font live 11px/450 ours 11px/400
    DIFF    T:Y: font live 11px/450 ours 11px/400
    MISSING 16,124 64x16 div [Blur]
    MISSING 113,120 110x24 input =4 [Blur radius] r=2px
    MISSING 113,152 110x24 input =0 [Spread] r=2px
    MISSING 93,189 14x14 button [Solid color hex: 000000] bg=#000000 r=2px
    EXTRA   16,125 21x14 "Blur" 11px/450 #ffffffb2
    EXTRA   16,157 38x14 "Spread" 11px/450 #ffffffb2
    EXTRA   16,189 28x14 "Color" 11px/450 #ffffffb2
    EXTRA   88,184 24x24 button [Color: pick colour] r=5px
## effect-settings-layer-blur-progressive: live popups 959,660,240,156; ours 951,700,240,156
  popup live @959,660,240,156 ours @951,700,240,156
    DIFF    [Effect settings]: pos/size live 8,8 100x24 ours 8,8 81x24
    DIFF    T:Layer blur: pos/size live 32,14 52x13 ours 16,13 53x14; font live 11px/400 ours 11px/450
    MISSING 15,45 26x13 "Type" 11px/450 #ffffff
    MISSING 113,84 110x24 input =0 [Start] r=2px
    MISSING 113,116 110x24 input =4 [End] r=2px
    EXTRA   16,89 25x14 "Start" 11px/450 #ffffffb2
    EXTRA   16,121 20x14 "End" 11px/450 #ffffffb2
## effect-settings-layer-blur: live popups 959,660,240,124; ours 951,700,240,124
  popup live @959,660,240,124 ours @951,700,240,124
    DIFF    [Effect settings]: pos/size live 8,8 100x24 ours 8,8 81x24
    DIFF    T:Layer blur: pos/size live 32,14 52x13 ours 16,13 53x14; font live 11px/400 ours 11px/450
    MISSING 15,45 26x13 "Type" 11px/450 #ffffff
    MISSING 113,84 110x24 input =4 [Blur radius] r=2px
## effect-settings-noise: live popups 959,660,240,224; ours 951,668,240,224
  popup live @959,660,240,224 ours @951,668,240,224
    DIFF    [Effect settings]: pos/size live 8,8 78x24 ours 8,8 58x24
    DIFF    T:Noise: pos/size live 32,14 30x13 ours 16,13 30x14; font live 11px/400 ours 11px/450
    MISSING 15,45 57x13 "Noise type" 11px/450 #ffffff
    DIFF    T:X: font live 11px/450 ours 11px/400
    DIFF    T:Y: font live 11px/450 ours 11px/400
    MISSING 113,152 110x24 input =100% [Density] r=2px
    MISSING 93,189 14x14 button [Solid color hex: 000000] bg=#000000 r=2px
    EXTRA   16,157 40x14 "Density" 11px/450 #ffffffb2
    EXTRA   16,189 28x14 "Color" 11px/450 #ffffffb2
    EXTRA   88,184 24x24 button [Color: pick colour] r=5px
## effect-settings-texture: live popups 959,660,240,213; ours 951,688,240,204
  popup live @959,660,240,213 ours @951,688,240,204
    DIFF    [Effect settings]: pos/size live 8,8 87x24 ours 8,8 68x24
    DIFF    T:Texture: pos/size live 32,14 39x13 ours 16,13 40x14; font live 11px/400 ours 11px/450
    DIFF    T:X: font live 11px/450 ours 11px/400
    DIFF    T:Y: font live 11px/450 ours 11px/400
    MISSING 113,120 110x24 input =4 [Radius] r=2px
    SHIFT   from live y=183 (T:Clip to shape) ours is -14px (live 183, ours 169); was 0
    SHIFT   from live y=8 ([Close]) ours is +0px (live 8, ours 8); was -14
    EXTRA   16,125 36x14 "Radius" 11px/450 #ffffffb2
## effect-styles: live popups 984,719,216,165; ours 951,664,240,145
  popup live @984,719,216,165 ours @951,664,240,145
    DIFF    [Create style]: pos/size live 160,8 24x24 ours 8,121 24x24
    DIFF    [Search]: pos/size live 40,40 176x40 ours 32,40 200x24
    MISSING 65,99 86x13 "No effect styles." 11px/450 #ffffff66
    MISSING 43,129 129x24 button [Browse libraries…] r=5px
    DIFF    [Close]: pos/size live 184,8 24x24 ours 208,8 24x24
    EXTRA   0,72 240x40 menu [Effect styles]
    EXTRA   16,81 168x14 "No styles or variables in this file" 11px/450 #ffffffb2
## effect-type-menu: live popups 959,660,240,224 | 967,449,147,207; ours 939,644,170,225
  popup live @959,660,240,224 ours @939,644,170,225
    MISSING 8,8 117x24 button [Effect settings] EXPANDED
    DIFF    T:Drop shadow: pos/size live 32,14 69x13 ours 60,36 76x15; font live 11px/400 ours 12px/450
    MISSING 184,8 24x24 button [Blend mode] r=5px
    MISSING 16,62 42x13 "Position" 11px/450 #ffffffb2
    MISSING 88,56 136x24 label [Position X] bg=#383838 r=5px
    MISSING 97,62 7x13 "X" 11px/450 #ffffffb2
    MISSING 113,56 110x24 input =0 [Position X] r=2px
    MISSING 88,88 136x24 label [Position Y] bg=#383838 r=5px
    MISSING 97,94 7x13 "Y" 11px/450 #ffffffb2
    MISSING 113,88 110x24 input =4 [Position Y] r=2px
    MISSING 16,124 64x16 div [Blur]
    MISSING 88,120 136x24 label [Blur radius] bg=#383838 r=5px
    MISSING 113,120 110x24 input =4 [Blur radius] r=2px
    MISSING 88,152 136x24 label [Spread] bg=#383838 r=5px
    MISSING 113,152 110x24 input =0 [Spread] r=2px
    MISSING 93,189 14x14 button [Solid color hex: 000000] bg=#000000 r=2px
    MISSING 112,184 58x24 input =000000 [Color] r=5px
    MISSING 208,8 24x24 button [Close] r=5px
    EXTRA   60,12 77x15 "Inner shadow" 12px/450 #ffffff
    EXTRA   60,60 57x15 "Layer blur" 12px/450 #ffffff
    EXTRA   60,84 94x15 "Background blur" 12px/450 #ffffff
    EXTRA   60,108 33x15 "Noise" 12px/450 #ffffff
    EXTRA   60,132 43x15 "Texture" 12px/450 #ffffff
    EXTRA   60,156 32x15 "Glass" 12px/450 #ffffff
    EXTRA   60,197 41x15 "Shader" 12px/450 #ffffff
  popup live @967,449,147,207 ours @939,644,170,225
    DIFF    T:Inner shadow: pos/size live 44,6 71x13 ours 60,12 77x15; font live 11px/450 ours 12px/450
    DIFF    T:Drop shadow: pos/size live 44,30 70x13 ours 60,36 76x15; font live 11px/450 ours 12px/450
    DIFF    T:Layer blur: pos/size live 44,54 52x13 ours 60,60 57x15; font live 11px/450 ours 12px/450
    DIFF    T:Background blur: pos/size live 44,78 87x13 ours 60,84 94x15; font live 11px/450 ours 12px/450
    DIFF    T:Noise: pos/size live 44,102 30x13 ours 60,108 33x15; font live 11px/450 ours 12px/450
    DIFF    T:Texture: pos/size live 44,126 40x13 ours 60,132 43x15; font live 11px/450 ours 12px/450
    DIFF    T:Glass: pos/size live 44,150 29x13 ours 60,156 32x15; font live 11px/450 ours 12px/450
    DIFF    T:Shader: pos/size live 44,189 38x13 ours 60,197 41x15; font live 11px/450 ours 12px/450
## effects-add-shader-effects: live popups 959,374,240,510; ours 951,404,240,488
  popup live @959,374,240,510 ours @951,404,240,488
    SHIFT   from live y=230 (T:Add animated shaders that respond to mouse movement, right on canvas, or create your own with the Figma agent.) ours is +15px (live 230, ours 245); was 0
    DIFF    T:Got it: pos/size live 87,294 29x13 ours 91,309 28x14
    DIFF    T:Try an example: pos/size live 139,294 81x13 ours 143,309 81x14; color live #ffffff ours #2c2c2c
    SHIFT   from live y=339 (T:Created by you) ours is +10px (live 339, ours 349); was 15
    SHIFT   from live y=473 (T:Create new) ours is +6px (live 473, ours 479); was 10
    DIFF    T:AI: pos/size live 97,473 11x13 ours 92,479 11x14
    SHIFT   from live y=501 (T:By Figma) ours is +16px (live 501, ours 517); was 6
    SHIFT   from live y=633 (T:Shape-based particles) ours is +12px (live 633, ours 645); was 16
    SHIFT   from live y=765 (T:Halftone) ours is +6px (live 765, ours 771); was 12
    SHIFT   from live y=897 (T:Lens distortion) ours is +0px (live 897, ours 897); was 6
    SHIFT   from live y=1029 (T:Gradient map) ours is -6px (live 1029, ours 1023); was 0
    SHIFT   from live y=1161 (T:Pixelate) ours is -12px (live 1161, ours 1149); was -6
    SHIFT   from live y=1293 (T:Outlines) ours is -18px (live 1293, ours 1275); was -12
    SHIFT   from live y=1425 (T:Bloom) ours is -24px (live 1425, ours 1401); was -18
    SHIFT   from live y=1557 (T:Color adjust) ours is -30px (live 1557, ours 1527); was -24
    SHIFT   from live y=1689 (T:Gooey merge) ours is -36px (live 1689, ours 1653); was -30
    SHIFT   from live y=1821 (T:Slice shift) ours is -42px (live 1821, ours 1779); was -36
    SHIFT   from live y=1953 (T:Hatching) ours is -48px (live 1953, ours 1905); was -42
    SHIFT   from live y=2085 (T:Duotone filter) ours is -54px (live 2085, ours 2031); was -48
    SHIFT   from live y=2217 (T:Filter presets) ours is -60px (live 2217, ours 2157); was -54
    SHIFT   from live y=8 ([Close]) ours is +0px (live 8, ours 8); was -60
## export-advanced-settings: live popups 960,700,240,184; ours none
  (no ours popup)
## export-format-menu: live popups 1290,764,92,112; ours 1312,735,120,24
  popup live @1290,764,92,112 ours @1312,735,120,24
    MISSING 32,14 24x13 "PNG" 11px/450 #ffffff
    MISSING 32,38 28x13 "JPEG" 11px/450 #ffffff
    MISSING 32,62 23x13 "SVG" 11px/450 #ffffff
    MISSING 32,86 22x13 "PDF" 11px/450 #ffffff
    EXTRA   8,5 104x14 "Add export settings" 11px/450 #ffffff
## fill-picker-color-format-menu: live popups 959,307,240,537 | 967,672,87,136; ours 968,459,240,433 | 956,756,92,136
  popup live @959,307,240,537 ours @968,459,240,433
    DIFF    [New style or variable]: pos/size live 180,8 24x24 ours 184,8 24x24
    DIFF    [Gradient]: pos/size live 36,48 24x24 ours 32,48 24x24
    MISSING 64,48 24x24 input =PATTERN [Pattern]
    DIFF    [Image]: pos/size live 92,48 24x24 ours 56,48 24x24
    DIFF    [Video]: pos/size live 120,48 24x24 ours 80,48 24x24
    MISSING 148,48 24x24 input =CUSTOM [shader_beta_special_tooltip]
    MISSING 147,73 38x13 "Shader" 11px/450 #ffffff
    DIFF    [Blend mode]: pos/size live 180,48 24x24 ours 144,48 24x24
    MISSING 16,97 208x208 group [Color picker reticle]
    MISSING 9,120 15x15 input =0 [Color picker reticle] bg=#3b3b3b
    MISSING 15,304 1x1 input =0.15 [Color picker reticle] bg=#3b3b3b
    MISSING 16,327 24x24 button [Sample color] r=5px
    DIFF    [Hue]: pos/size live 48,313 180x24 ours 40,272 192x12
    DIFF    [Opacity]: pos/size live 48,341 180x24 ours 40,292 192x12
    MISSING 16,373 55x24 combobox [Color format] bg=#2c2c2c r=5px EXPANDED
    MISSING 80,373 89x24 input =D9D9D9 [Color] r=5px 0px 0px 5px
    DIFF    [Opacity]: pos/size live 170,373 54x24 ours 181,312 38x24
    MISSING 171,373 38x24 input =100 [Opacity] r=0px 2px 2px 0px
    MISSING 16,425 208x24 combobox [Color swatch set selector] bg=#2c2c2c r=5px
    MISSING 16,457 16x16 button [Solid color hex: FFFFFF] bg=#ffffff r=20%
    MISSING 40,457 16x16 button [Solid color hex: E5664D] bg=#e5664d r=20%
    MISSING 64,457 16x16 button [Solid color hex: D9D9D9] bg=#d9d9d9 r=20%
    MISSING 88,457 16x16 button [Solid color hex: FFB200] bg=#ffb200 r=20%
    MISSING 112,457 16x16 button [Solid color hex: 66CC80] bg=#66cc80 r=20%
    MISSING 136,457 16x16 button [Solid color hex: 0D99FF] bg=#0d99ff r=20%
    MISSING 160,457 16x16 button [Solid color hex: 000000] bg=#000000 r=20%
    MISSING 184,457 16x16 button [Solid color hex: E6E6E6] bg=#e6e6e6 r=20%
    MISSING 208,457 16x16 button [Solid color hex: 99E5E5] bg=#99e5e5 r=20%
    ... 34 more
  popup live @967,672,87,136 ours @956,756,92,136
    DIFF    T:Hex: pos/size live 32,14 21x13 ours 36,12 22x15; font live 11px/450 ours 12px/450
    DIFF    T:RGB: pos/size live 32,38 23x13 ours 36,36 25x15; font live 11px/450 ours 12px/450
    DIFF    T:CSS: pos/size live 32,62 22x13 ours 36,60 24x15; font live 11px/450 ours 12px/450
    DIFF    T:HSL: pos/size live 32,86 22x13 ours 36,84 23x15; font live 11px/450 ours 12px/450
    DIFF    T:HSB: pos/size live 32,110 23x13 ours 36,108 25x15; font live 11px/450 ours 12px/450
## fill-picker-custom: live popups 959,307,240,353 | 719,307,240,510; ours none
  (no ours popup)
  (no ours popup)
## fill-picker-gradient-type-menu: live popups 959,307,240,297 | 719,307,240,510; ours 1240,574,77,24 | 968,459,240,594
  popup live @959,307,240,297 ours @968,459,240,594
    DIFF    [New style or variable]: pos/size live 180,8 24x24 ours 184,8 24x24
    DIFF    [Gradient]: pos/size live 36,48 24x24 ours 32,48 24x24
    MISSING 64,48 24x24 input =PATTERN [Pattern]
    DIFF    [Image]: pos/size live 92,48 24x24 ours 56,48 24x24
    DIFF    [Video]: pos/size live 120,48 24x24 ours 80,48 24x24
    MISSING 148,48 24x24 input =CUSTOM [shader_beta_special_tooltip]
    MISSING 147,73 38x13 "Shader" 11px/450 #ffffff
    DIFF    [Paint type]: pos/size live 16,89 96x32 ours 8,80 96x24
    DIFF    T:Linear: pos/size live 24,99 33x13 ours 16,85 33x14
    SHIFT   from live y=93 ([Flip gradient]) ours is -13px (live 93, ours 80); was 0
    DIFF    T:Stops: pos/size live 16,195 31x13 ours 8,422 31x14
    MISSING 208,189 24x24 button [Add gradient stop] r=5px
    MISSING 16,225 48x24 label [Gradient stop position] bg=#383838 r=5px
    MISSING 77,229 16x16 button [Solid color hex: D9D9D9] bg=#d9d9d9 r=20%
    MISSING 93,225 58x24 input =D9D9D9 [Gradient Stop Color] r=5px
    DIFF    [Opacity]: pos/size live 151,225 48x24 ours 181,376 38x24
    DIFF    [Opacity]: pos/size live 152,225 32x24 ours 40,356 192x12; r live 0px 2px 2px 0px ours 9999px
    MISSING 208,225 24x24 button [Delete gradient stop] r=5px
    MISSING 16,257 48x24 label [Gradient stop position] bg=#383838 r=5px
    MISSING 77,261 16x16 button [Solid color hex: 737373] bg=#737373 r=20%
    MISSING 93,257 58x24 input =737373 [Gradient Stop Color] r=5px
    MISSING 151,257 48x24 label [Opacity] r=5px
    MISSING 152,257 32x24 input =100 [Opacity] r=0px 2px 2px 0px
    MISSING 208,257 24x24 button [Delete gradient stop] r=5px
    SHIFT   from live y=8 ([Close]) ours is +0px (live 8, ours 8); was -13
    EXTRA   8,8 119x24 tablist [Color source]
    EXTRA   16,13 41x14 "Custom" 11px/550 #ffffff
    EXTRA   73,13 46x14 "Libraries" 11px/450 #ffffffb2
    ... 34 more
  popup live @719,307,240,510 ours @968,459,240,594
    MISSING 16,14 60x13 "Shader fills" 11px/550 #ffffff
    MISSING 88,14 24x13 "Beta" 11px/450 #ffffffb2
    MISSING 32,48 200x24 input = [Search] r=5px
    MISSING 16,95 81x13 "Created by you" 11px/450 #ffffffb2
    MISSING 20,229 61x13 "Create new" 11px/450 #ffffff
    MISSING 97,229 11x13 "AI" 11px/450 #ffffff
    MISSING 16,257 49x13 "By Figma" 11px/450 #ffffffb2
    MISSING 20,389 86x13 "Moving gradient" 11px/450 #ffffff
    MISSING 132,389 76x13 "Mesh gradient" 11px/450 #ffffff
    MISSING 20,521 37x13 "Nebula" 11px/450 #ffffff
    MISSING 132,521 72x13 "Water caustic" 11px/450 #ffffff
    MISSING 20,653 68x13 "Fractal noise" 11px/450 #ffffff
    MISSING 132,653 37x13 "Clouds" 11px/450 #ffffff
    MISSING 20,785 30x13 "Moire" 11px/450 #ffffff
    MISSING 132,785 73x13 "Glowing wave" 11px/450 #ffffff
    MISSING 20,917 105x13 "Concentric patterns" 11px/450 #ffffff
    MISSING 132,917 62x13 "Pattern grid" 11px/450 #ffffff
    EXTRA   8,8 119x24 tablist [Color source]
    EXTRA   16,13 41x14 "Custom" 11px/550 #ffffff
    EXTRA   73,13 46x14 "Libraries" 11px/450 #ffffffb2
    EXTRA   8,48 96x24 radiogroup [Fill type] bg=#383838 r=5px
    EXTRA   8,48 24x24 radio [Solid] r=5px
    EXTRA   32,48 24x24 radio [Gradient] bg=#2c2c2c r=5px CHECKED
    EXTRA   56,48 24x24 radio [Image] r=5px
    EXTRA   80,48 24x24 radio [Video] r=5px
    EXTRA   208,48 24x24 button [Blend mode] r=5px
    EXTRA   8,80 96x24 combobox [Paint type] r=5px
    EXTRA   16,85 33x14 "Linear" 11px/450 #ffffff
    ... 38 more
## fill-picker-gradient_linear: live popups 959,307,240,297 | 719,307,240,510; ours 1240,574,77,24 | 968,459,240,594
  popup live @959,307,240,297 ours @968,459,240,594
    DIFF    [New style or variable]: pos/size live 180,8 24x24 ours 184,8 24x24
    DIFF    [Gradient]: pos/size live 36,48 24x24 ours 32,48 24x24
    MISSING 64,48 24x24 input =PATTERN [Pattern]
    DIFF    [Image]: pos/size live 92,48 24x24 ours 56,48 24x24
    DIFF    [Video]: pos/size live 120,48 24x24 ours 80,48 24x24
    MISSING 148,48 24x24 input =CUSTOM [shader_beta_special_tooltip]
    MISSING 147,73 38x13 "Shader" 11px/450 #ffffff
    DIFF    [Paint type]: pos/size live 16,89 96x32 ours 8,80 96x24
    DIFF    T:Linear: pos/size live 24,99 33x13 ours 16,85 33x14
    SHIFT   from live y=93 ([Flip gradient]) ours is -13px (live 93, ours 80); was 0
    DIFF    T:Stops: pos/size live 16,195 31x13 ours 8,422 31x14
    MISSING 208,189 24x24 button [Add gradient stop] r=5px
    MISSING 16,225 48x24 label [Gradient stop position] bg=#383838 r=5px
    MISSING 77,229 16x16 button [Solid color hex: D9D9D9] bg=#d9d9d9 r=20%
    MISSING 93,225 58x24 input =D9D9D9 [Gradient Stop Color] r=5px
    DIFF    [Opacity]: pos/size live 151,225 48x24 ours 181,376 38x24
    DIFF    [Opacity]: pos/size live 152,225 32x24 ours 40,356 192x12; r live 0px 2px 2px 0px ours 9999px
    MISSING 208,225 24x24 button [Delete gradient stop] r=5px
    MISSING 16,257 48x24 label [Gradient stop position] bg=#383838 r=5px
    MISSING 77,261 16x16 button [Solid color hex: 737373] bg=#737373 r=20%
    MISSING 93,257 58x24 input =737373 [Gradient Stop Color] r=5px
    MISSING 151,257 48x24 label [Opacity] r=5px
    MISSING 152,257 32x24 input =100 [Opacity] r=0px 2px 2px 0px
    MISSING 208,257 24x24 button [Delete gradient stop] r=5px
    SHIFT   from live y=8 ([Close]) ours is +0px (live 8, ours 8); was -13
    EXTRA   8,8 119x24 tablist [Color source]
    EXTRA   16,13 41x14 "Custom" 11px/550 #ffffff
    EXTRA   73,13 46x14 "Libraries" 11px/450 #ffffffb2
    ... 34 more
  popup live @719,307,240,510 ours @968,459,240,594
    MISSING 16,14 60x13 "Shader fills" 11px/550 #ffffff
    MISSING 88,14 24x13 "Beta" 11px/450 #ffffffb2
    MISSING 32,48 200x24 input = [Search] r=5px
    MISSING 16,95 81x13 "Created by you" 11px/450 #ffffffb2
    MISSING 20,229 61x13 "Create new" 11px/450 #ffffff
    MISSING 97,229 11x13 "AI" 11px/450 #ffffff
    MISSING 16,257 49x13 "By Figma" 11px/450 #ffffffb2
    MISSING 20,389 86x13 "Moving gradient" 11px/450 #ffffff
    MISSING 132,389 76x13 "Mesh gradient" 11px/450 #ffffff
    MISSING 20,521 37x13 "Nebula" 11px/450 #ffffff
    MISSING 132,521 72x13 "Water caustic" 11px/450 #ffffff
    MISSING 20,653 68x13 "Fractal noise" 11px/450 #ffffff
    MISSING 132,653 37x13 "Clouds" 11px/450 #ffffff
    MISSING 20,785 30x13 "Moire" 11px/450 #ffffff
    MISSING 132,785 73x13 "Glowing wave" 11px/450 #ffffff
    MISSING 20,917 105x13 "Concentric patterns" 11px/450 #ffffff
    MISSING 132,917 62x13 "Pattern grid" 11px/450 #ffffff
    EXTRA   8,8 119x24 tablist [Color source]
    EXTRA   16,13 41x14 "Custom" 11px/550 #ffffff
    EXTRA   73,13 46x14 "Libraries" 11px/450 #ffffffb2
    EXTRA   8,48 96x24 radiogroup [Fill type] bg=#383838 r=5px
    EXTRA   8,48 24x24 radio [Solid] r=5px
    EXTRA   32,48 24x24 radio [Gradient] bg=#2c2c2c r=5px CHECKED
    EXTRA   56,48 24x24 radio [Image] r=5px
    EXTRA   80,48 24x24 radio [Video] r=5px
    EXTRA   208,48 24x24 button [Blend mode] r=5px
    EXTRA   8,80 96x24 combobox [Paint type] r=5px
    EXTRA   16,85 33x14 "Linear" 11px/450 #ffffff
    ... 38 more
## fill-picker-image: live popups 959,307,240,577; ours 1240,574,77,24 | 968,459,240,520
  popup live @959,307,240,577 ours @968,459,240,520
    DIFF    [New style or variable]: pos/size live 180,8 24x24 ours 184,8 24x24
    DIFF    [Gradient]: pos/size live 36,48 24x24 ours 32,48 24x24
    MISSING 64,48 24x24 input =PATTERN [Pattern]
    DIFF    [Image]: pos/size live 92,48 24x24 ours 56,48 24x24
    DIFF    [Video]: pos/size live 120,48 24x24 ours 80,48 24x24
    MISSING 148,48 24x24 input =CUSTOM [shader_beta_special_tooltip]
    MISSING 147,73 38x13 "Shader" 11px/450 #ffffff
    SHIFT   from live y=93 ([Rotate 90º]) ours is +167px (live 93, ours 260); was 0
    MISSING 61,211 119x13 "Upload from computer" 11px/450 #ffffff
    MISSING 60,226 137x13 "Current selection has a fill" 11px/450 #ffffff
    MISSING 90,243 79x13 "Make an image" 11px/450 #ffffff
    DIFF    T:Exposure: pos/size live 16,355 49x13 ours 8,293 49x14
    DIFF    T:Contrast: pos/size live 16,387 46x13 ours 8,321 45x14
    DIFF    T:Saturation: pos/size live 16,419 55x13 ours 8,349 54x14
    DIFF    T:Temperature: pos/size live 16,451 67x13 ours 8,377 67x14
    DIFF    T:Tint: pos/size live 16,483 21x13 ours 8,405 20x14
    DIFF    T:Highlights: pos/size live 16,515 53x13 ours 8,433 53x14
    DIFF    T:Shadows: pos/size live 16,547 48x13 ours 8,461 48x14
    SHIFT   from live y=8 ([Close]) ours is +0px (live 8, ours 8); was 167
    EXTRA   8,8 119x24 tablist [Color source]
    EXTRA   16,13 41x14 "Custom" 11px/550 #ffffff
    EXTRA   73,13 46x14 "Libraries" 11px/450 #ffffffb2
    EXTRA   8,48 96x24 radiogroup [Fill type] bg=#383838 r=5px
    EXTRA   8,80 224x140 img [No image] bg=#383838 r=5px
    EXTRA   8,228 115x24 combobox [Image scale mode] r=5px
    EXTRA   16,233 15x14 "Fill" 11px/450 #ffffff
    EXTRA   139,233 86x14 "Choose image…" 11px/450 #ffffff
    EXTRA   96,292 136x16 input =0 [Exposure]
    ... 7 more
## fill-picker-libraries-tab: live popups 959,307,240,203; ours 968,459,240,176
  popup live @959,307,240,203 ours @968,459,240,176
    DIFF    [New style or variable]: pos/size live 180,8 24x24 ours 184,8 24x24
    DIFF    [Search]: pos/size live 40,48 200x24 ours 40,48 184x24
    MISSING 204,90 24x24 button [Show as grid] r=5px
    MISSING 70,157 100x13 "No colors available" 11px/450 #ffffff
    EXTRA   8,8 119x24 tablist [Color source]
    EXTRA   16,13 41x14 "Custom" 11px/450 #ffffffb2
    EXTRA   73,13 47x14 "Libraries" 11px/550 #ffffff
    EXTRA   8,80 224x40 menu [Libraries]
    EXTRA   24,89 168x14 "No styles or variables in this file" 11px/450 #ffffffb2
## fill-picker-pattern: live popups 959,347,240,522; ours none
  (no ours popup)
## fill-picker-solid: live popups 959,347,240,537; ours 968,459,240,433
  popup live @959,347,240,537 ours @968,459,240,433
    DIFF    [New style or variable]: pos/size live 180,8 24x24 ours 184,8 24x24
    DIFF    [Gradient]: pos/size live 36,48 24x24 ours 32,48 24x24
    MISSING 64,48 24x24 input =PATTERN [Pattern]
    DIFF    [Image]: pos/size live 92,48 24x24 ours 56,48 24x24
    DIFF    [Video]: pos/size live 120,48 24x24 ours 80,48 24x24
    MISSING 148,48 24x24 input =CUSTOM [shader_beta_special_tooltip]
    MISSING 147,73 38x13 "Shader" 11px/450 #ffffff
    DIFF    [Blend mode]: pos/size live 180,48 24x24 ours 144,48 24x24
    MISSING 16,97 208x208 group [Color picker reticle]
    MISSING 9,120 15x15 input =0 [Color picker reticle] bg=#3b3b3b
    MISSING 15,304 1x1 input =0.15 [Color picker reticle] bg=#3b3b3b
    MISSING 16,327 24x24 button [Sample color] r=5px
    DIFF    [Hue]: pos/size live 48,313 180x24 ours 40,272 192x12
    DIFF    [Opacity]: pos/size live 48,341 180x24 ours 40,292 192x12
    MISSING 16,373 55x24 combobox [Color format] bg=#2c2c2c r=5px
    MISSING 80,373 89x24 input =D9D9D9 [Color] r=5px 0px 0px 5px
    DIFF    [Opacity]: pos/size live 170,373 54x24 ours 181,312 38x24
    MISSING 171,373 38x24 input =100 [Opacity] r=0px 2px 2px 0px
    MISSING 16,425 208x24 combobox [Color swatch set selector] bg=#2c2c2c r=5px
    MISSING 16,457 16x16 button [Solid color hex: FFFFFF] bg=#ffffff r=20%
    MISSING 40,457 16x16 button [Solid color hex: E5664D] bg=#e5664d r=20%
    MISSING 64,457 16x16 button [Solid color hex: D9D9D9] bg=#d9d9d9 r=20%
    MISSING 88,457 16x16 button [Solid color hex: FFB200] bg=#ffb200 r=20%
    MISSING 112,457 16x16 button [Solid color hex: 66CC80] bg=#66cc80 r=20%
    MISSING 136,457 16x16 button [Solid color hex: 0D99FF] bg=#0d99ff r=20%
    MISSING 160,457 16x16 button [Solid color hex: 000000] bg=#000000 r=20%
    MISSING 184,457 16x16 button [Solid color hex: E6E6E6] bg=#e6e6e6 r=20%
    MISSING 208,457 16x16 button [Solid color hex: 99E5E5] bg=#99e5e5 r=20%
    ... 34 more
## fill-picker-swatch-set-menu: live popups 959,307,240,537; ours none
  (no ours popup)
## fill-picker-video: live popups 959,307,240,353; ours 1240,574,77,24 | 968,459,240,520
  popup live @959,307,240,353 ours @968,459,240,520
    DIFF    [New style or variable]: pos/size live 180,8 24x24 ours 184,8 24x24
    DIFF    [Gradient]: pos/size live 36,48 24x24 ours 32,48 24x24
    MISSING 64,48 24x24 input =PATTERN [Pattern]
    DIFF    [Image]: pos/size live 92,48 24x24 ours 56,48 24x24
    DIFF    [Video]: pos/size live 120,48 24x24 ours 80,48 24x24
    MISSING 148,48 24x24 input =CUSTOM [shader_beta_special_tooltip]
    MISSING 147,73 38x13 "Shader" 11px/450 #ffffff
    SHIFT   from live y=93 ([Rotate 90º]) ours is +167px (live 93, ours 260); was 0
    MISSING 61,227 119x13 "Upload from computer" 11px/450 #ffffff
    SHIFT   from live y=8 ([Close]) ours is +0px (live 8, ours 8); was 167
    EXTRA   8,8 119x24 tablist [Color source]
    EXTRA   16,13 41x14 "Custom" 11px/550 #ffffff
    EXTRA   73,13 46x14 "Libraries" 11px/450 #ffffffb2
    EXTRA   8,48 96x24 radiogroup [Fill type] bg=#383838 r=5px
    EXTRA   8,80 224x140 img [No image] bg=#383838 r=5px
    EXTRA   8,228 118x24 combobox [Image scale mode] r=5px
    EXTRA   16,233 15x14 "Fill" 11px/450 #ffffff
    EXTRA   142,233 82x14 "Choose video…" 11px/450 #ffffff
    EXTRA   8,293 49x14 "Exposure" 11px/450 #ffffffb2
    EXTRA   96,292 136x16 input =0 [Exposure]
    EXTRA   8,321 45x14 "Contrast" 11px/450 #ffffffb2
    EXTRA   96,320 136x16 input =0 [Contrast]
    EXTRA   8,349 54x14 "Saturation" 11px/450 #ffffffb2
    EXTRA   96,348 136x16 input =0 [Saturation]
    EXTRA   8,377 67x14 "Temperature" 11px/450 #ffffffb2
    EXTRA   96,376 136x16 input =0 [Temperature]
    EXTRA   8,405 20x14 "Tint" 11px/450 #ffffffb2
    EXTRA   96,404 136x16 input =0 [Tint]
    ... 5 more
## fill-styles-variables: live popups 960,531,240,203; ours 951,538,240,145
  popup live @960,531,240,203 ours @951,538,240,145
    MISSING 180,8 24x24 button [New style or variable] r=5px
    DIFF    [Search]: pos/size live 40,48 200x24 ours 32,40 200x24
    MISSING 204,90 24x24 button [Show as grid] r=5px
    MISSING 70,157 100x13 "No colors available" 11px/450 #ffffff
    EXTRA   16,13 47x14 "Libraries" 11px/550 #ffffff
    EXTRA   0,72 240x40 menu [Libraries]
    EXTRA   16,81 168x14 "No styles or variables in this file" 11px/450 #ffffffb2
    EXTRA   8,121 24x24 button [Create style] r=5px
    EXTRA   64,126 79x14 "Open variables" 11px/450 #ffffff
## font-picker-filter-menu: live popups 960,415,240,469 | 960,488,240,229; ours 939,476,142,160
  popup live @960,415,240,469 ours @939,476,142,160
    MISSING 16,14 30x13 "Fonts" 11px/550 #ffffff
    MISSING 32,40 176x24 input =Inter [Search fonts] r=5px EXPANDED
    MISSING 208,40 24x24 button [Clear search]
    MISSING 0,11 240x28 option [Ingrid Darling]
    MISSING 0,39 240x28 option [Inika]
    MISSING 0,67 240x28 option [Inknut Antiqua]
    MISSING 0,95 240x28 option [Inria Sans]
    MISSING 0,123 240x28 option [Inria Serif]
    MISSING 0,151 240x28 option [Inspiration]
    MISSING 0,179 240x28 option [Instrument Sans]
    MISSING 0,207 240x28 option [Instrument Serif]
    MISSING 0,235 240x28 option [Intel One Mono]
    MISSING 0,263 240x28 option [Inter] bg=#383838 SELECTED
    MISSING 0,291 240x28 option [Iosevka Charon]
    MISSING 0,319 240x28 option [Iosevka Charon Mono]
    MISSING 0,347 240x28 option [Irish Grover]
    MISSING 0,375 240x28 option [Island Moments]
    MISSING 0,403 240x28 option [Istok Web]
    MISSING 0,431 240x28 option [Italiana]
    MISSING 0,459 240x28 option [Italianno]
    MISSING 0,487 240x28 option [Itim]
    MISSING 0,515 240x28 option [Jacquard 12]
    MISSING 0,543 240x28 option [Jacquard 24]
    MISSING 0,571 240x28 option [Jacquarda Bastarda 9]
    MISSING 0,599 240x28 option [Jacques Francois]
    MISSING 0,627 240x28 option [Jacques Francois Shadow]
    MISSING 0,655 240x28 option [Jaini]
    MISSING 0,683 240x28 option [Jaini Purva]
    ... 9 more
  popup live @960,488,240,229 ours @939,476,142,160
    DIFF    T:All fonts: pos/size live 32,14 43x13 ours 36,12 46x15; font live 11px/450 ours 12px/450
    DIFF    T:In this file: pos/size live 32,53 51x13 ours 36,36 55x15; font live 11px/450 ours 12px/450
    MISSING 32,92 70x13 "Popular fonts" 11px/450 #ffffff
    DIFF    T:Google fonts: pos/size live 32,116 68x13 ours 36,108 73x15; font live 11px/450 ours 12px/450
    DIFF    T:Variable fonts: pos/size live 32,140 73x13 ours 36,132 78x15; font live 11px/450 ours 12px/450
    MISSING 32,179 89x13 "Uploaded by you" 11px/450 #ffffff
    DIFF    T:Installed by you: pos/size live 32,203 83x13 ours 36,84 90x15; font live 11px/450 ours 12px/450
    EXTRA   36,60 44x15 "Popular" 12px/450 #ffffff
## font-picker: live popups 960,415,240,469; ours 951,452,240,440
  popup live @960,415,240,469 ours @951,452,240,440
    MISSING 16,14 30x13 "Fonts" 11px/550 #ffffff
    DIFF    [Search fonts]: pos/size live 32,40 176x24 ours 32,0 200x24; value live "Inter" ours ""
    MISSING 208,40 24x24 button [Clear search]
    MISSING 0,11 240x28 option [Ingrid Darling]
    MISSING 0,39 240x28 option [Inika]
    MISSING 0,67 240x28 option [Inknut Antiqua]
    MISSING 0,95 240x28 option [Inria Sans]
    MISSING 0,123 240x28 option [Inria Serif]
    MISSING 0,151 240x28 option [Inspiration]
    MISSING 0,179 240x28 option [Instrument Sans]
    MISSING 0,207 240x28 option [Instrument Serif]
    MISSING 0,235 240x28 option [Intel One Mono]
    MISSING 0,263 240x28 option [Inter] bg=#383838 SELECTED
    MISSING 0,291 240x28 option [Iosevka Charon]
    MISSING 0,319 240x28 option [Iosevka Charon Mono]
    MISSING 0,347 240x28 option [Irish Grover]
    MISSING 0,375 240x28 option [Island Moments]
    MISSING 0,403 240x28 option [Istok Web]
    MISSING 0,431 240x28 option [Italiana]
    MISSING 0,459 240x28 option [Italianno]
    MISSING 0,487 240x28 option [Itim]
    MISSING 0,515 240x28 option [Jacquard 12]
    MISSING 0,543 240x28 option [Jacquard 24]
    MISSING 0,571 240x28 option [Jacquarda Bastarda 9]
    MISSING 0,599 240x28 option [Jacques Francois]
    MISSING 0,627 240x28 option [Jacques Francois Shadow]
    MISSING 0,655 240x28 option [Jaini]
    MISSING 0,683 240x28 option [Jaini Purva]
    ... 8 more
## font-size-menu: live popups 1312,455,96,437; ours 1224,451,208,441
  popup live @1312,455,96,437 ours @1224,451,208,441
    MISSING 8,8 80x24 option [10 px] r=5px
    DIFF    T:10: pos/size live 34,14 12x13 ours 36,12 13x15; font live 11px/400 ours 12px/450
    MISSING 8,32 80x24 option [11 px] r=5px
    DIFF    T:11: pos/size live 34,38 10x13 ours 36,36 10x15; font live 11px/400 ours 12px/450
    MISSING 8,56 80x24 option [12 px] r=5px
    DIFF    T:12: pos/size live 34,62 12x13 ours 36,60 12x15; font live 11px/400 ours 12px/450
    MISSING 8,80 80x24 option [13 px] r=5px
    DIFF    T:13: pos/size live 34,86 12x13 ours 36,84 12x15; font live 11px/400 ours 12px/450
    MISSING 8,104 80x24 option [14 px] r=5px
    DIFF    T:14: pos/size live 34,110 12x13 ours 36,108 13x15; font live 11px/400 ours 12px/450
    MISSING 8,128 80x24 option [15 px] r=5px
    DIFF    T:15: pos/size live 34,134 12x13 ours 36,132 12x15; font live 11px/400 ours 12px/450
    MISSING 8,152 80x24 option [16 px] r=5px
    DIFF    T:16: pos/size live 34,158 12x13 ours 36,156 12x15; font live 11px/400 ours 12px/450
    MISSING 8,176 80x24 option [20 px] r=5px
    DIFF    T:20: pos/size live 34,182 14x13 ours 36,180 15x15; font live 11px/400 ours 12px/450
    MISSING 8,200 80x24 option [24 px] bg=#0c8ce9 r=5px SELECTED
    DIFF    T:24: pos/size live 34,206 14x13 ours 36,204 15x15; font live 11px/400 ours 12px/450
    MISSING 8,224 80x24 option [32 px] r=5px
    DIFF    T:32: pos/size live 34,230 14x13 ours 36,228 15x15; font live 11px/400 ours 12px/450
    MISSING 8,248 80x24 option [36 px] r=5px
    DIFF    T:36: pos/size live 34,254 14x13 ours 36,252 15x15; font live 11px/400 ours 12px/450
    MISSING 8,272 80x24 option [40 px] r=5px
    DIFF    T:40: pos/size live 34,278 14x13 ours 36,276 15x15; font live 11px/400 ours 12px/450
    MISSING 8,296 80x24 option [48 px] r=5px
    DIFF    T:48: pos/size live 34,302 14x13 ours 36,300 15x15; font live 11px/400 ours 12px/450
    MISSING 8,320 80x24 option [64 px] r=5px
    DIFF    T:64: pos/size live 34,326 14x13 ours 36,324 15x15; font live 11px/400 ours 12px/450
    ... 5 more
## font-weight-menu: live popups 1208,575,167,313; ours 1196,444,143,448
  popup live @1208,575,167,313 ours @1196,444,143,448
    DIFF    T:Thin: pos/size live 32,14 23x13 ours 36,12 25x15; font live 11px/450 ours 12px/450
    DIFF    T:Extra Light: pos/size live 32,38 57x13 ours 36,60 61x15; font live 11px/450 ours 12px/450
    DIFF    T:Light: pos/size live 32,62 27x13 ours 36,108 28x15; font live 11px/450 ours 12px/450
    DIFF    T:Regular: pos/size live 32,86 40x13 ours 36,156 43x15; font live 11px/450 ours 12px/450
    DIFF    T:Medium: pos/size live 32,110 42x13 ours 36,204 46x15; font live 11px/450 ours 12px/450
    DIFF    T:Semi Bold: pos/size live 32,134 53x13 ours 36,252 57x15; font live 11px/450 ours 12px/450
    DIFF    T:Bold: pos/size live 32,158 24x13 ours 36,300 25x15; font live 11px/450 ours 12px/450
    DIFF    T:Extra Bold: pos/size live 32,182 54x13 ours 36,348 58x15; font live 11px/450 ours 12px/450
    DIFF    T:Black: pos/size live 32,206 29x13 ours 36,396 31x15; font live 11px/450 ours 12px/450
    DIFF    T:Thin Italic: pos/size live 32,245 51x13 ours 36,36 55x15; font live 11px/450 ours 12px/450
    DIFF    T:Extra Light Italic: pos/size live 32,269 85x13 ours 36,84 91x15; font live 11px/450 ours 12px/450
    DIFF    T:Light Italic: pos/size live 32,293 55x13 ours 36,132 59x15; font live 11px/450 ours 12px/450
    DIFF    T:Italic: pos/size live 32,317 25x13 ours 36,180 27x15; font live 11px/450 ours 12px/450
    DIFF    T:Medium Italic: pos/size live 32,341 70x13 ours 36,228 76x15; font live 11px/450 ours 12px/450
    DIFF    T:Semi Bold Italic: pos/size live 32,365 81x13 ours 36,276 87x15; font live 11px/450 ours 12px/450
    DIFF    T:Bold Italic: pos/size live 32,389 52x13 ours 36,324 56x15; font live 11px/450 ours 12px/450
    DIFF    T:Extra Bold Italic: pos/size live 32,413 82x13 ours 36,372 89x15; font live 11px/450 ours 12px/450
    DIFF    T:Black Italic: pos/size live 32,437 57x13 ours 36,420 62x15; font live 11px/450 ours 12px/450
    MISSING 32,476 103x13 "Variable font axes…" 11px/450 #ffffff
## frame-presets-menu: live popups 1208,125,222,1887; ours 1152,8,280,884
  popup live @1208,125,222,1887 ours @1152,8,280,884
    DIFF    T:Section: pos/size live 32,6 40x13 ours 36,36 43x15; font live 11px/450 ours 12px/450; color live #ffffff ours #ffffff59
    DIFF    T:Frame: pos/size live 32,30 33x13 ours 36,60 36x15; font live 11px/450 ours 12px/450
    DIFF    T:Group: pos/size live 32,54 32x13 ours 36,84 35x15; font live 11px/450 ours 12px/450
    DIFF    T:iPhone 17: pos/size live 32,93 51x13 ours 36,132 54x15; font live 11px/450 ours 12px/450
    MISSING 156,93 21x13 "402" 11px/450 #ffffff
    MISSING 177,93 9x13 "×" 11px/450 #ffffff
    MISSING 186,93 20x13 "874" 11px/450 #ffffff
    DIFF    T:iPhone 16 & 17 Pro: pos/size live 32,117 97x13 ours 36,156 104x15; font live 11px/450 ours 12px/450
    MISSING 156,117 21x13 "402" 11px/450 #ffffff
    MISSING 177,117 9x13 "×" 11px/450 #ffffff
    MISSING 186,117 20x13 "874" 11px/450 #ffffff
    DIFF    T:iPhone 16: pos/size live 32,141 51x13 ours 36,180 55x15; font live 11px/450 ours 12px/450
    MISSING 155,141 21x13 "393" 11px/450 #ffffff
    MISSING 176,141 9x13 "×" 11px/450 #ffffff
    MISSING 186,141 20x13 "852" 11px/450 #ffffff
    DIFF    T:iPhone 16 & 17 Pro Max: pos/size live 32,165 122x13 ours 36,204 131x15; font live 11px/450 ours 12px/450
    MISSING 154,165 21x13 "440" 11px/450 #ffffff
    MISSING 176,165 9x13 "×" 11px/450 #ffffff
    MISSING 185,165 21x13 "956" 11px/450 #ffffff
    DIFF    T:iPhone 16 Plus: pos/size live 32,189 77x13 ours 36,228 82x15; font live 11px/450 ours 12px/450
    MISSING 154,189 21x13 "430" 11px/450 #ffffff
    MISSING 176,189 9x13 "×" 11px/450 #ffffff
    MISSING 185,189 21x13 "932" 11px/450 #ffffff
    DIFF    T:iPhone Air: pos/size live 32,213 54x13 ours 36,252 58x15; font live 11px/450 ours 12px/450
    MISSING 157,213 21x13 "420" 11px/450 #ffffff
    MISSING 178,213 9x13 "×" 11px/450 #ffffff
    MISSING 187,213 19x13 "912" 11px/450 #ffffff
    DIFF    T:iPhone 14 & 15 Pro Max: pos/size live 32,237 123x13 ours 36,276 132x15; font live 11px/450 ours 12px/450
    ... 326 more
## height-sizing-menu: live popups 1234,399,166,129; ours 1224,462,208,170
  popup live @1234,399,166,129 ours @1224,462,208,170
    MISSING 8,8 150x24 option [Fixed height (72)] r=5px
    DIFF    T:Fixed height (72): pos/size live 58,14 89x13 ours 36,12 96x15; font live 11px/400 ours 12px/450
    MISSING 8,32 150x24 option [Hug contents] bg=#0c8ce9 r=5px SELECTED
    DIFF    T:Hug contents: pos/size live 58,38 71x13 ours 36,36 76x15; font live 11px/400 ours 12px/450
    MISSING 8,73 150x24 option [Add min height…] r=5px
    DIFF    T:Add min height…: pos/size live 58,79 88x13 ours 36,77 97x15; font live 11px/400 ours 12px/450
    MISSING 8,97 150x24 option [Add max height…] r=5px
    DIFF    T:Add max height…: pos/size live 58,103 92x13 ours 36,101 100x15; font live 11px/400 ours 12px/450
    EXTRA   36,142 92x15 "Apply variable…" 12px/450 #ffffff
## width-sizing-menu: live popups 1138,399,166,129; ours 1224,462,208,170
  popup live @1138,399,166,129 ours @1224,462,208,170
    MISSING 8,8 150x24 option [Fixed width (232)] r=5px
    DIFF    T:Fixed width (232): pos/size live 58,14 92x13 ours 36,12 100x15; font live 11px/400 ours 12px/450
    MISSING 8,32 150x24 option [Hug contents] bg=#0c8ce9 r=5px SELECTED
    DIFF    T:Hug contents: pos/size live 58,38 71x13 ours 36,36 76x15; font live 11px/400 ours 12px/450
    MISSING 8,73 150x24 option [Add min width…] r=5px
    DIFF    T:Add min width…: pos/size live 58,79 85x13 ours 36,77 93x15; font live 11px/400 ours 12px/450
    MISSING 8,97 150x24 option [Add max width…] r=5px
    DIFF    T:Add max width…: pos/size live 58,103 88x13 ours 36,101 96x15; font live 11px/400 ours 12px/450
    EXTRA   36,142 92x15 "Apply variable…" 12px/450 #ffffff
## instance-header-swap-menu: live popups 1160,117,240,441; ours 951,92,240,228
  popup live @1160,117,240,441 ours @951,92,240,228
    MISSING 35,52 197x16 input = [Search in this library]
    MISSING 208,84 24x24 button [Settings] r=5px
    MISSING 32,123 42x13 "Capture" 11px/450 #ffffff
    DIFF    T:Button: pos/size live 64,163 35x13 ours 44,105 35x14
    MISSING 64,211 25x13 "Card" 11px/450 #ffffff
    DIFF    T:Chip: pos/size live 64,259 24x13 ours 44,129 24x14
    MISSING 44,315 22x13 "Icon" 11px/450 #ffffff
    EXTRA   32,40 200x24 input = [Search]
    EXTRA   0,72 240x156 menu [Components]
    EXTRA   16,81 68x14 "Components" 11px/550 #ffffffb2
    EXTRA   16,153 29x14 "Icons" 11px/450 #ffffff66
    EXTRA   44,177 29x14 "Heart" 11px/450 #ffffff
    EXTRA   44,201 21x14 "Star" 11px/450 #ffffff
## instance-more-actions-menu: live popups 1211,129,221,309; ours 1186,120,246,153
  popup live @1211,129,221,309 ours @1186,120,246,153
    DIFF    T:Create component: pos/size live 44,45 98x13 ours 36,12 106x15; font live 11px/450 ours 12px/450
    DIFF    T:⌥⌘K: pos/size live 175,45 30x13 ours 199,12 31x15; font live 11px/450 ours 12px/450; color live #ffffffb2 ours #ffffff73
    DIFF    T:Detach instance: pos/size live 44,69 86x13 ours 36,36 92x15; font live 11px/450 ours 12px/450
    DIFF    T:⌥⌘B: pos/size live 175,69 30x13 ours 199,36 31x15; font live 11px/450 ours 12px/450; color live #ffffffb2 ours #ffffff73
    DIFF    T:Reset instance: pos/size live 44,93 78x13 ours 36,60 84x15; font live 11px/450 ours 12px/450
    MISSING 44,117 62x13 "Reset name" 11px/450 #ffffff
    DIFF    T:⌃⌘M: pos/size live 175,156 30x13 ours 197,125 33x15; font live 11px/450 ours 12px/450; color live #ffffffb2 ours #ffffff73
    MISSING 44,195 31x13 "Union" 11px/450 #ffffff
    MISSING 174,195 31x13 "⌥⇧U" 11px/450 #ffffffb2
    MISSING 44,219 45x13 "Subtract" 11px/450 #ffffff
    MISSING 175,219 30x13 "⌥⇧S" 11px/450 #ffffffb2
    MISSING 44,243 47x13 "Intersect" 11px/450 #ffffff
    MISSING 179,243 26x13 "⌥⇧I" 11px/450 #ffffffb2
    MISSING 44,267 41x13 "Exclude" 11px/450 #ffffff
    MISSING 175,267 29x13 "⌥⇧E" 11px/450 #ffffffb2
    MISSING 44,291 37x13 "Flatten" 11px/450 #ffffff
    MISSING 176,291 29x13 "⌥⇧F" 11px/450 #ffffffb2
    EXTRA   36,84 194x15 "Push changes to main component" 12px/450 #ffffff
    EXTRA   36,125 72x15 "Use as mask" 12px/450 #ffffff
## instance-swap-property-picker: live popups 1160,237,240,441; ours 951,212,240,304
  popup live @1160,237,240,441 ours @951,212,240,304
    MISSING 16,14 90x13 "Choose instance" 11px/550 #ffffff
    MISSING 35,52 197x16 input = [Search in this library]
    MISSING 208,84 24x24 button [Settings] r=5px
    DIFF    T:Icon: pos/size live 32,123 22x13 ours 16,13 23x14; font live 11px/450 ours 11px/550
    DIFF    T:Heart: pos/size live 64,163 30x13 ours 44,129 29x14
    DIFF    T:Star: pos/size live 64,211 22x13 ours 44,277 21x14
    EXTRA   32,40 200x24 input = [Search]
    EXTRA   0,72 240x232 menu [Components]
    EXTRA   16,81 50x14 "Preferred" 11px/550 #ffffffb2
    EXTRA   44,105 21x14 "Star" 11px/450 #ffffff
    EXTRA   16,157 68x14 "Components" 11px/550 #ffffffb2
    EXTRA   44,181 35x14 "Button" 11px/450 #ffffff
    EXTRA   44,205 24x14 "Chip" 11px/450 #ffffff
    EXTRA   16,229 29x14 "Icons" 11px/450 #ffffff66
    EXTRA   44,253 29x14 "Heart" 11px/450 #ffffff
## instance-variant-dropdown: live popups 1304,141,107,88; ours 1292,140,116,64
  popup live @1304,141,107,88 ours @1292,140,116,64
    DIFF    T:Default: pos/size live 32,14 38x13 ours 36,12 41x15; font live 11px/450 ours 12px/450
    DIFF    T:Hover: pos/size live 32,38 31x13 ours 36,36 34x15; font live 11px/450 ours 12px/450
    MISSING 32,62 43x13 "Pressed" 11px/450 #ffffff
## layout-guide-settings-columns: live popups 960,628,240,256; ours 1039,884,136,24 | 1039,916,136,24 | 1039,948,136,24 | 1039,980,136,24
  popup live @960,628,240,256 ours @1039,980,136,24
    MISSING 16,64 64x16 div [Count]
    MISSING 96,66 7x13 "5" 11px/450 #ffffff
    MISSING 88,60 136x24 label [Count] r=5px
    MISSING 96,60 127x24 input =5 [Count] r=2px
    MISSING 16,96 64x16 div [Color]
    MISSING 93,97 14x14 button [Solid color hex: FF0000] bg=#ff0000 r=2px
    MISSING 16,128 64x16 div [Type]
    MISSING 16,160 64x16 div [Width]
    MISSING 88,156 136x24 label [Width] bg=#383838 r=5px DISABLED
    MISSING 96,156 127x24 input = [Auto] r=2px DISABLED
    MISSING 16,192 64x16 div [Margin]
    MISSING 88,188 136x24 label [Offset] bg=#383838 r=5px
    MISSING 103,188 120x24 input =0 [Offset] r=2px
    DIFF    [Gutter]: pos/size live 16,224 64x16 ours 0,0 136x24
    MISSING 88,220 136x24 label [Gutter] bg=#383838 r=5px
    MISSING 103,220 120x24 input =20 [Gutter] r=2px
    MISSING 208,8 24x24 button [Close] r=5px
## layout-guide-settings-grid: live popups 960,756,240,128; ours 951,772,240,120
  popup live @960,756,240,128 ours @951,772,240,120
    SHIFT   from live y=66 (T:Size) ours is -13px (live 66, ours 53); was 0
    MISSING 103,60 98x24 input =10 [Width] r=2px
    MISSING 201,61 20x22 button [Apply variable]
    MISSING 93,97 14x14 button [Solid color hex: FF0000] bg=#ff0000 r=2px
    SHIFT   from live y=8 ([Close]) ours is +0px (live 8, ours 8); was -13
    EXTRA   8,8 50x24 combobox [Layout guide type] r=5px
    EXTRA   16,13 22x14 "Grid" 11px/450 #ffffff
    EXTRA   88,80 24x24 button [Layout guide color: pick colour] r=5px
    EXTRA   112,80 57x24 input =FF0000 [Layout guide color]
    EXTRA   170,80 38x24 input =10 [Layout guide color opacity]
## layout-guide-styles: live popups 984,719,216,165; ours 951,747,240,145
  popup live @984,719,216,165 ours @951,747,240,145
    DIFF    [Create style]: pos/size live 160,8 24x24 ours 8,121 24x24
    DIFF    [Search]: pos/size live 40,40 176x40 ours 32,40 200x24
    MISSING 49,99 119x13 "No layout guide styles." 11px/450 #ffffff66
    MISSING 43,129 129x24 button [Browse libraries…] r=5px
    DIFF    [Close]: pos/size live 184,8 24x24 ours 208,8 24x24
    EXTRA   0,72 240x40 menu [Layout guide styles]
    EXTRA   16,81 168x14 "No styles or variables in this file" 11px/450 #ffffffb2
## layout-guide-type-menu: live popups 960,756,240,128 | 968,792,110,88; ours 939,772,102,88
  popup live @960,756,240,128 ours @939,772,102,88
    MISSING 16,66 22x13 "Size" 11px/450 #ffffffb2
    MISSING 88,60 136x24 label [Width] bg=#383838 r=5px
    MISSING 103,60 120x24 input =10 [Width] r=2px
    MISSING 16,98 28x13 "Color" 11px/450 #ffffffb2
    MISSING 93,97 14x14 button [Solid color hex: FF0000] bg=#ff0000 r=2px
    MISSING 208,8 24x24 button [Close] r=5px
    EXTRA   36,12 24x15 "Grid" 12px/450 #ffffff
    EXTRA   36,36 50x15 "Columns" 12px/450 #ffffff
    EXTRA   36,60 31x15 "Rows" 12px/450 #ffffff
  popup live @968,792,110,88 ours @939,772,102,88
    DIFF    T:Grid: pos/size live 32,14 22x13 ours 36,12 24x15; font live 11px/450 ours 12px/450
    DIFF    T:Columns: pos/size live 32,38 46x13 ours 36,36 50x15; font live 11px/450 ours 12px/450
    DIFF    T:Rows: pos/size live 32,62 28x13 ours 36,60 31x15; font live 11px/450 ours 12px/450
## stroke-advanced-settings: live popups 960,660,240,224; ours 951,708,240,184
  popup live @960,660,240,224 ours @951,708,240,184
    MISSING 15,45 63x13 "Stroke Type" 11px/450 #ffffff
    MISSING 16,52 69x24 input =Basic [Basic]
    MISSING 85,52 69x24 input =Dynamic [Dynamic]
    MISSING 155,52 69x24 input =Brush [Brush]
    DIFF    T:Style: pos/size live 16,94 27x13 ours 61,85 27x14
    MISSING 95,89 27x13 "Style" 11px/450 #ffffff
    DIFF    T:Solid: pos/size live 129,93 26x13 ours 104,85 26x14
    MISSING 16,126 68x13 "Width profile" 11px/450 #ffffffb2
    MISSING 95,121 68x13 "Width profile" 11px/450 #ffffff
    MISSING 105,130 62x4 img [Uniform]
    MISSING 200,120 24x24 button [Flip width points] r=5px DISABLED
    DIFF    T:Join: pos/size live 16,158 22x13 ours 66,117 22x14
    MISSING 95,145 22x13 "Join" 11px/450 #ffffff
    MISSING 96,152 43x24 input =MITER [Miter]
    MISSING 139,152 43x24 input =BEVEL [Bevel]
    MISSING 181,152 43x24 input =ROUND [Round]
    DIFF    [Miter angle]: pos/size live 96,184 128x24 ours 120,144 104x24; bg live #383838 ours none
    EXTRA   16,48 208x24 radiogroup [Stroke Type] bg=#383838 r=5px
    EXTRA   36,53 29x14 "Basic" 11px/450 #ffffff
    EXTRA   97,53 46x14 "Dynamic" 11px/450 #ffffff66
    EXTRA   174,53 31x14 "Brush" 11px/450 #ffffff66
    EXTRA   96,80 128x24 combobox [Style] r=5px
    EXTRA   96,112 128x24 radiogroup [Join] bg=#383838 r=5px
    EXTRA   104,117 27x14 "Miter" 11px/450 #ffffff
    EXTRA   146,117 29x14 "Bevel" 11px/450 #ffffffb2
    EXTRA   186,117 34x14 "Round" 11px/450 #ffffffb2
    EXTRA   29,149 59x14 "Miter angle" 11px/450 #ffffffb2
## stroke-individual-strokes-menu: live popups 1315,539,117,159; ours 1224,732,208,160
  popup live @1315,539,117,159 ours @1224,732,208,160
    DIFF    T:All: pos/size live 60,6 13x13 ours 36,12 14x15; font live 11px/450 ours 12px/450
    DIFF    T:Top: pos/size live 60,30 20x13 ours 36,36 21x15; font live 11px/450 ours 12px/450
    DIFF    T:Bottom: pos/size live 60,54 38x13 ours 36,60 41x15; font live 11px/450 ours 12px/450
    DIFF    T:Left: pos/size live 60,78 21x13 ours 36,84 22x15; font live 11px/450 ours 12px/450
    DIFF    T:Right: pos/size live 60,102 27x13 ours 36,108 29x15; font live 11px/450 ours 12px/450
    DIFF    T:Custom: pos/size live 60,141 41x13 ours 36,132 44x15; font live 11px/450 ours 12px/450
## stroke-position-menu: live popups 1208,678,105,88; ours 1196,677,104,88
  popup live @1208,678,105,88 ours @1196,677,104,88
    DIFF    T:Center: pos/size live 32,14 36x13 ours 36,36 38x15; font live 11px/450 ours 12px/450
    DIFF    T:Inside: pos/size live 32,38 32x13 ours 36,12 34x15; font live 11px/450 ours 12px/450
    DIFF    T:Outside: pos/size live 32,62 41x13 ours 36,60 44x15; font live 11px/450 ours 12px/450
## type-settings-details: live popups 960,378,240,506; ours 951,472,240,1072
  popup live @960,378,240,506 ours @951,472,240,1072
    MISSING 32,106 60x20 "Preview" 16px/400 #ffffff66
    MISSING 16,194 62x13 "Indentation" 11px/550 #ffffff
    MISSING 16,226 110x13 "Hanging punctuation" 11px/450 #ffffff66
    MISSING 175,213 110x13 "Hanging punctuation" 11px/450 #ffffff
    MISSING 176,220 24x24 input =OFF [Disabled]
    MISSING 200,220 24x24 input =ON [Enabled]
    SHIFT   from live y=258 (T:Hanging lists) ours is -181px (live 258, ours 77); was 0
    DIFF    T:Hanging lists: color live #ffffff66 ours #ffffffb2
    MISSING 175,245 68x13 "Hanging lists" 11px/450 #ffffff
    MISSING 176,252 24x24 input =OFF [Disabled]
    MISSING 200,252 24x24 input =ON [Enabled]
    DIFF    [Paragraph indent]: pos/size live 153,284 72x24 ours 152,8 72x24; bg live #383838 ours none
    MISSING 161,284 63x24 input =0 [Paragraph indent] r=2px
    MISSING 16,343 61x13 "Letter case" 11px/550 #ffffff
    MISSING 16,375 27x13 "Case" 11px/450 #ffffffb2
    MISSING 103,362 27x13 "Case" 11px/450 #ffffff
    MISSING 104,369 24x24 input =ORIGINAL [As typed]
    MISSING 128,369 24x24 input =UPPER [Uppercase]
    MISSING 152,369 24x24 input =LOWER [Lowercase]
    MISSING 176,369 24x24 input =TITLE [Title case]
    MISSING 200,369 24x24 input =SMALL_CAPS [Font doesn't support small caps] DISABLED
    MISSING 16,405 144x16 label [Not applicable for selected text] r=2px
    SHIFT   from live y=407 (T:Case-sensitive forms) ours is -298px (live 407, ours 109); was -181
    DIFF    T:Case-sensitive forms: color live #ffffff66 ours #ffffffb2
    MISSING 175,394 112x13 "Case-sensitive forms" 11px/450 #ffffff
    MISSING 176,401 24x24 input =OFF [Disabled]
    MISSING 200,401 24x24 input =ON [Enabled]
    MISSING 175,426 81x13 "Capital spacing" 11px/450 #ffffff
    ... 141 more
## type-settings-variable: live popups 960,378,240,506; ours 951,472,240,80
  popup live @960,378,240,506 ours @951,472,240,80
    MISSING 32,106 60x20 "Preview" 16px/400 #ffffff66
    DIFF    [Slant]: pos/size live 143,188 81x24 ours 76,44 74x16; bg live #383838 ours #3b3b3b
    DIFF    [Weight]: pos/size live 143,253 81x24 ours 76,12 74x16; bg live #383838 ours #3b3b3b
    MISSING 208,8 24x24 button [Close] r=5px
    EXTRA   16,13 37x14 "Weight" 11px/450 #ffffffb2
    EXTRA   160,8 64x24 input =400 [Weight value]
    EXTRA   16,45 27x14 "Slant" 11px/450 #ffffffb2
    EXTRA   160,40 64x24 input =0 [Slant value]
## type-settings: live popups 960,378,240,506; ours 951,432,240,460
  popup live @960,378,240,506 ours @951,432,240,460
    MISSING 32,106 60x20 "Preview" 16px/400 #ffffff66
    SHIFT   from live y=194 (T:Alignment) ours is -141px (live 194, ours 53); was 0
    MISSING 127,181 53x13 "Alignment" 11px/450 #ffffff
    MISSING 127,213 58x13 "Decoration" 11px/450 #ffffff
    DIFF    [None]: pos/size live 128,220 24x24 ours 125,80 27x24
    MISSING 103,245 27x13 "Case" 11px/450 #ffffff
    DIFF    [As typed]: pos/size live 104,252 24x24 ours 77,112 27x24
    DIFF    [Uppercase]: pos/size live 128,252 24x24 ours 104,112 32x24
    DIFF    [Lowercase]: pos/size live 152,252 24x24 ours 136,112 29x24
    DIFF    [Title case]: pos/size live 176,252 24x24 ours 165,112 31x24
    DIFF    [Font doesn't support small caps]: pos/size live 200,252 24x24 ours 196,112 28x24
    SHIFT   from live y=311 (T:Vertical trim) ours is -162px (live 311, ours 149); was -141
    MISSING 175,298 64x13 "Vertical trim" 11px/450 #ffffff
    MISSING 151,330 47x13 "List style" 11px/450 #ffffff
    DIFF    [No list]: pos/size live 152,337 24x24 ours 149,176 27x24
    MISSING 161,369 63x24 input =0 [Paragraph spacing] r=2px
    MISSING 175,394 71x13 "Truncate text" 11px/450 #ffffff
    SHIFT   from live y=8 ([Close]) ours is +0px (live 8, ours 8); was -162
    EXTRA   8,8 162x24 tablist [Type settings]
    EXTRA   16,13 35x14 "Basics" 11px/550 #ffffff
    EXTRA   67,13 36x14 "Details" 11px/450 #ffffffb2
    EXTRA   119,13 43x14 "Variable" 11px/450 #ffffffb2
    EXTRA   128,48 96x24 radiogroup [Alignment] bg=#383838 r=5px
    EXTRA   125,80 75x24 radiogroup [Decoration] bg=#383838 r=5px
    EXTRA   133,85 11x14 "—" 11px/450 #ffffff
    EXTRA   77,112 147x24 radiogroup [Case] bg=#383838 r=5px
    EXTRA   85,117 11x14 "—" 11px/450 #ffffff
    EXTRA   112,117 16x14 "AG" 11px/450 #ffffffb2
    ... 10 more
## typography-styles: live popups 984,427,216,165; ours 951,586,240,145
  popup live @984,427,216,165 ours @951,586,240,145
    DIFF    [Create style]: pos/size live 160,8 24x24 ours 8,121 24x24
    DIFF    [Search]: pos/size live 40,40 176x40 ours 32,40 200x24
    MISSING 70,99 75x13 "No text styles." 11px/450 #ffffff66
    MISSING 43,129 129x24 button [Browse libraries…] r=5px
    DIFF    [Close]: pos/size live 184,8 24x24 ours 208,8 24x24
    EXTRA   0,72 240x40 menu [Text styles]
    EXTRA   16,81 168x14 "No styles or variables in this file" 11px/450 #ffffffb2
## grid-dimensions-picker: live popups 1204,427,210,204; ours 951,484,240,332
  popup live @1204,427,210,204 ours @951,484,240,332
    DIFF    [Number of columns]: pos/size live 8,8 85x24 ours 36,48 80x24; bg live #383838 ours none
    MISSING 32,8 61x24 input =3 [Number of columns] r=5px
    MISSING 101,14 7x13 "×" 11px/400 #ffffffb2
    DIFF    [Number of rows]: pos/size live 117,8 85x24 ours 148,48 80x24; bg live #383838 ours none
    MISSING 141,8 37x24 input =2 [Number of rows] r=5px 0px 0px 5px
    MISSING 178,8 24x24 button [Number of rows]
    MISSING 7,41 84x13 "Grid dimensions" 11px/400 #ffffff
    DIFF    [1 × 1]: pos/size live 8,40 16x16 ours 12,80 16x16
    DIFF    [2 × 1]: pos/size live 24,40 16x16 ours 30,80 16x16
    DIFF    [3 × 1]: pos/size live 40,40 16x16 ours 48,80 16x16
    DIFF    [4 × 1]: pos/size live 56,40 16x16 ours 66,80 16x16
    DIFF    [5 × 1]: pos/size live 73,40 16x16 ours 85,80 16x16
    DIFF    [6 × 1]: pos/size live 89,40 16x16 ours 103,80 16x16
    DIFF    [7 × 1]: pos/size live 105,40 16x16 ours 121,80 16x16
    DIFF    [8 × 1]: pos/size live 121,40 16x16 ours 139,80 16x16
    DIFF    [9 × 1]: pos/size live 137,40 16x16 ours 157,80 16x16
    DIFF    [10 × 1]: pos/size live 153,40 16x16 ours 175,80 16x16
    DIFF    [11 × 1]: pos/size live 170,40 16x16 ours 194,80 16x16
    DIFF    [12 × 1]: pos/size live 186,40 16x16 ours 212,80 16x16
    DIFF    [1 × 2]: pos/size live 8,56 16x16 ours 12,98 16x16
    DIFF    [2 × 2]: pos/size live 24,56 16x16 ours 30,98 16x16
    DIFF    [3 × 2]: pos/size live 40,56 16x16 ours 48,98 16x16
    DIFF    [4 × 2]: pos/size live 56,56 16x16 ours 66,98 16x16
    DIFF    [5 × 2]: pos/size live 73,56 16x16 ours 85,98 16x16
    DIFF    [6 × 2]: pos/size live 89,56 16x16 ours 103,98 16x16
    DIFF    [7 × 2]: pos/size live 105,56 16x16 ours 121,98 16x16
    DIFF    [8 × 2]: pos/size live 121,56 16x16 ours 139,98 16x16
    DIFF    [9 × 2]: pos/size live 137,56 16x16 ours 157,98 16x16
    ... 127 more
## grid-autolayout-settings: live popups 960,485,240,249; ours 891,484,300,120
  popup live @960,485,240,249 ours @891,484,300,120
    MISSING 89,90 61x20 "Preview" 16px/500 #ffffff66
    MISSING 16,179 68x13 "Inside stroke" 11px/450 #ffffffb2
    MISSING 121,178 45x13 "Included" 11px/450 #ffffff
    MISSING 16,211 36x13 "Layout" 11px/450 #ffffffb2
    MISSING 92,209 16x16 button [More info]
    MISSING 121,210 46x13 "Updated" 11px/450 #ffffff
    DIFF    [Close]: pos/size live 208,8 24x24 ours 268,8 24x24
    EXTRA   16,53 40x14 "Strokes" 11px/450 #ffffffb2
    EXTRA   134,48 150x24 combobox [Strokes] r=5px
    EXTRA   142,53 111x14 "Excluded from layout" 11px/450 #ffffff
    EXTRA   16,85 87x14 "Canvas stacking" 11px/450 #ffffffb2
    EXTRA   134,80 150x24 combobox [Canvas stacking] r=5px
    EXTRA   142,85 59x14 "Last on top" 11px/450 #ffffff
## context-empty-canvas: live popups 1013,614,200,218; ours 800,600,222,218
  popup live @1013,614,200,218 ours @800,600,222,218
    DIFF    T:Paste here: pos/size live 16,14 56x13 ours 36,12 61x15; font live 11px/400 ours 12px/450
    DIFF    T:Show/Hide UI: pos/size live 16,55 71x13 ours 36,53 78x15; font live 11px/400 ours 12px/450
    MISSING 167,54 13x15 "⌘" 12px/400 #ffffffb2
    MISSING 180,54 4x15 "\" 12px/400 #ffffffb2
    DIFF    T:Show/Hide comments: pos/size live 16,79 114x13 ours 36,77 126x15; font live 11px/400 ours 12px/450; color live #ffffff ours #ffffff59
    MISSING 162,78 13x15 "⇧" 12px/400 #ffffffb2
    MISSING 175,78 9x15 "C" 12px/400 #ffffffb2
    DIFF    T:Cursor chat: pos/size live 16,120 61x13 ours 36,118 67x15; font live 11px/400 ours 12px/450; color live #ffffff ours #ffffff59
    DIFF    T:/: pos/size live 180,119 4x15 ours 202,118 4x15; font live 12px/400 ours 12px/450; color live #ffffffb2 ours #ffffff73
    DIFF    T:Actions…: pos/size live 16,144 48x13 ours 36,142 54x15; font live 11px/400 ours 12px/450; color live #ffffff ours #ffffff59
    MISSING 163,143 13x15 "⌘" 12px/400 #ffffffb2
    MISSING 176,143 8x15 "K" 12px/400 #ffffffb2
    DIFF    T:Plugins: pos/size live 16,168 37x13 ours 36,166 42x15; font live 11px/400 ours 12px/450; color live #ffffff ours #ffffff59
    DIFF    T:Widgets: pos/size live 16,192 43x13 ours 36,190 47x15; font live 11px/400 ours 12px/450; color live #ffffff ours #ffffff59
    EXTRA   191,53 15x15 "⌘\" 12px/450 #ffffff73
    EXTRA   186,77 21x15 "⇧C" 12px/450 #ffffff73
    EXTRA   187,142 19x15 "⌘K" 12px/450 #ffffff73
## context-shape: live popups 358,179,200,653; ours 408,239,213,653
  popup live @358,179,200,653 ours @408,239,213,653
    DIFF    T:Copy: pos/size live 16,14 27x13 ours 36,12 30x15; font live 11px/400 ours 12px/450
    MISSING 162,13 13x15 "⌘" 12px/400 #ffffffb2
    MISSING 175,13 9x15 "C" 12px/400 #ffffffb2
    DIFF    T:Paste here: pos/size live 16,38 56x13 ours 36,36 61x15; font live 11px/400 ours 12px/450
    DIFF    T:Paste to replace: pos/size live 16,62 84x13 ours 36,60 92x15; font live 11px/400 ours 12px/450
    MISSING 150,61 13x15 "⇧" 12px/400 #ffffffb2
    MISSING 163,61 13x15 "⌘" 12px/400 #ffffffb2
    MISSING 176,61 8x15 "R" 12px/400 #ffffffb2
    DIFF    T:Copy/Paste as: pos/size live 16,86 75x13 ours 36,84 82x15; font live 11px/400 ours 12px/450
    DIFF    T:Send to Figma Make: pos/size live 16,110 106x13 ours 36,108 116x15; font live 11px/400 ours 12px/450; color live #ffffff ours #ffffff59
    DIFF    T:Find similar designs: pos/size live 16,134 102x13 ours 36,132 113x15; font live 11px/400 ours 12px/450; color live #ffffff ours #ffffff59
    DIFF    T:Add motion: pos/size live 16,158 60x13 ours 36,156 66x15; font live 11px/400 ours 12px/450; color live #ffffff ours #ffffff59
    DIFF    T:Move to page: pos/size live 16,199 71x13 ours 36,197 78x15; font live 11px/400 ours 12px/450; color live #ffffff ours #ffffff59
    DIFF    T:Bring to front: pos/size live 16,223 69x13 ours 36,221 75x15; font live 11px/400 ours 12px/450
    DIFF    T:]: pos/size live 180,222 4x15 ours 192,221 5x15; font live 12px/400 ours 12px/450; color live #ffffffb2 ours #ffffff73
    DIFF    T:Send to back: pos/size live 16,247 69x13 ours 36,245 75x15; font live 11px/400 ours 12px/450
    DIFF    T:[: pos/size live 180,246 4x15 ours 192,245 5x15; font live 12px/400 ours 12px/450; color live #ffffffb2 ours #ffffff73
    DIFF    T:Group selection: pos/size live 16,288 82x13 ours 36,286 90x15; font live 11px/400 ours 12px/450
    MISSING 162,287 13x15 "⌘" 12px/400 #ffffffb2
    MISSING 175,287 9x15 "G" 12px/400 #ffffffb2
    DIFF    T:Frame selection: pos/size live 16,312 83x13 ours 36,310 91x15; font live 11px/400 ours 12px/450
    MISSING 149,311 13x15 "⌥" 12px/400 #ffffffb2
    MISSING 162,311 13x15 "⌘" 12px/400 #ffffffb2
    MISSING 175,311 9x15 "G" 12px/400 #ffffffb2
    DIFF    T:Flatten: pos/size live 16,336 36x13 ours 36,334 39x15; font live 11px/400 ours 12px/450
    ... 47 more
## context-page-row: live popups 131,146,200,187; ours 181,121,208,129
  popup live @131,146,200,187 ours @181,121,208,129
    DIFF    T:Copy link to page: pos/size live 16,14 91x13 ours 16,12 99x15; font live 11px/400 ours 12px/450; color live #ffffff ours #ffffff59
    MISSING 16,55 71x13 "Rename page" 11px/400 #ffffff
    MISSING 16,79 78x13 "Duplicate page" 11px/400 #ffffff
    MISSING 16,120 45x13 "Move up" 11px/400 #ffffff
    MISSING 16,161 63x13 "Delete page" 11px/400 #ffffff
    EXTRA   16,53 46x15 "Rename" 12px/450 #ffffff
    EXTRA   16,77 54x15 "Duplicate" 12px/450 #ffffff
    EXTRA   16,101 37x15 "Delete" 12px/450 #ffffff59
## main-menu: live popups 12,44,194,444; ours 0,44,208,420
  popup live @12,44,194,444 ours @0,44,208,420
    DIFF    T:Back to files: pos/size live 16,14 65x13 ours 16,12 70x15; font live 11px/450 ours 12px/450
    DIFF    T:Actions…: pos/size live 40,55 49x13 ours 16,53 54x15; font live 11px/450 ours 12px/450; color live #ffffff ours #ffffff59
    DIFF    T:⌘K: pos/size live 160,55 18x13 ours 173,53 19x15; font live 11px/450 ours 12px/450; color live #ffffffb2 ours #ffffff73
    SHIFT   from live y=96 (T:File) ours is -2px (live 96, ours 94); was 0
    DIFF    T:File: font live 11px/450 ours 12px/450
    DIFF    T:Edit: font live 11px/450 ours 12px/450
    DIFF    T:View: font live 11px/450 ours 12px/450
    DIFF    T:Object: font live 11px/450 ours 12px/450
    DIFF    T:Text: font live 11px/450 ours 12px/450; color live #ffffff ours #ffffff59
    DIFF    T:Arrange: pos/size live 16,216 42x13 ours 16,214 46x15; font live 11px/450 ours 12px/450; color live #ffffff ours #ffffff59
    DIFF    T:Vector: font live 11px/450 ours 12px/450; color live #ffffff ours #ffffff59
    DIFF    T:Plugins: pos/size live 16,281 38x13 ours 16,279 42x15; font live 11px/450 ours 12px/450; color live #ffffff ours #ffffff59
    DIFF    T:Widgets: pos/size live 16,305 43x13 ours 16,303 47x15; font live 11px/450 ours 12px/450; color live #ffffff ours #ffffff59
    DIFF    T:Preferences: pos/size live 16,329 64x13 ours 16,327 69x15; font live 11px/450 ours 12px/450
    DIFF    T:Libraries: pos/size live 16,353 46x13 ours 16,351 50x15; font live 11px/450 ours 12px/450; color live #ffffff ours #ffffff59
    MISSING 16,394 110x13 "Open in desktop app" 11px/450 #ffffff
    DIFF    T:Help and account: pos/size live 16,418 93x13 ours 16,392 100x15; font live 11px/450 ours 12px/450
## main-file: live popups 12,44,194,444 | 210,126,198,324; ours 204,126,246,341
  popup live @12,44,194,444 ours @204,126,246,341
    MISSING 16,14 65x13 "Back to files" 11px/450 #ffffff
    MISSING 40,55 49x13 "Actions…" 11px/450 #ffffff
    MISSING 160,55 18x13 "⌘K" 11px/450 #ffffffb2
    MISSING 16,96 18x13 "File" 11px/450 #ffffff
    MISSING 16,120 20x13 "Edit" 11px/450 #ffffff
    MISSING 16,144 26x13 "View" 11px/450 #ffffff
    MISSING 16,168 35x13 "Object" 11px/450 #ffffff
    MISSING 16,192 23x13 "Text" 11px/450 #ffffff
    MISSING 16,216 42x13 "Arrange" 11px/450 #ffffff
    MISSING 16,240 35x13 "Vector" 11px/450 #ffffff
    MISSING 16,281 38x13 "Plugins" 11px/450 #ffffff
    MISSING 16,305 43x13 "Widgets" 11px/450 #ffffff
    MISSING 16,329 64x13 "Preferences" 11px/450 #ffffff
    MISSING 16,353 46x13 "Libraries" 11px/450 #ffffff
    MISSING 16,394 110x13 "Open in desktop app" 11px/450 #ffffff
    MISSING 16,418 93x13 "Help and account" 11px/450 #ffffff
    EXTRA   36,12 69x15 "New Design" 12px/450 #ffffff59
    EXTRA   36,53 116x15 "Place image/video…" 12px/450 #ffffff
    EXTRA   199,53 31x15 "⇧⌘K" 12px/450 #ffffff73
    EXTRA   36,94 54x15 "Duplicate" 12px/450 #ffffff59
    EXTRA   36,118 99x15 "Save local copy…" 12px/450 #ffffff59
    EXTRA   36,142 140x15 "Save to version history…" 12px/450 #ffffff59
    EXTRA   200,142 31x15 "⌥⌘S" 12px/450 #ffffff73
    EXTRA   36,166 120x15 "Show version history" 12px/450 #ffffff59
    EXTRA   36,207 48x15 "Export…" 12px/450 #ffffff
    ... 4 more
  popup live @210,126,198,324 ours @204,126,246,341
    DIFF    T:New Design: pos/size live 16,14 63x13 ours 36,12 69x15; font live 11px/450 ours 12px/450; color live #ffffff ours #ffffff59
    MISSING 16,38 24x13 "New" 11px/450 #ffffff
    DIFF    T:Place image/video…: pos/size live 16,79 106x13 ours 36,53 116x15; font live 11px/450 ours 12px/450
    DIFF    T:⇧⌘K: pos/size live 153,79 30x13 ours 199,53 31x15; font live 11px/450 ours 12px/450; color live #ffffffb2 ours #ffffff73
    DIFF    T:Duplicate: pos/size live 16,120 50x13 ours 36,94 54x15; font live 11px/450 ours 12px/450; color live #ffffff ours #ffffff59
    DIFF    T:Save local copy…: pos/size live 16,144 90x13 ours 36,118 99x15; font live 11px/450 ours 12px/450; color live #ffffff ours #ffffff59
    DIFF    T:Save to version history…: pos/size live 16,168 129x13 ours 36,142 140x15; font live 11px/450 ours 12px/450; color live #ffffff ours #ffffff59
    DIFF    T:⌥⌘S: pos/size live 153,168 29x13 ours 200,142 31x15; font live 11px/450 ours 12px/450; color live #ffffffb2 ours #ffffff73
    DIFF    T:Show version history: pos/size live 16,192 110x13 ours 36,166 120x15; font live 11px/450 ours 12px/450; color live #ffffff ours #ffffff59
    DIFF    T:Export…: pos/size live 16,233 44x13 ours 36,207 48x15; font live 11px/450 ours 12px/450
    DIFF    T:⇧⌘E: pos/size live 153,233 29x13 ours 200,207 30x15; font live 11px/450 ours 12px/450; color live #ffffffb2 ours #ffffff73
    DIFF    T:Export frames to PDF…: pos/size live 16,257 121x13 ours 36,231 131x15; font live 11px/450 ours 12px/450
    DIFF    T:Create branch…: pos/size live 16,298 84x13 ours 36,272 92x15; font live 11px/450 ours 12px/450; color live #ffffff ours #ffffff59
    EXTRA   36,313 91x15 "Share preview…" 12px/450 #ffffff
## main-edit: live popups 12,44,194,444 | 210,150,190,581; ours 204,150,216,581
  popup live @12,44,194,444 ours @204,150,216,581
    MISSING 16,14 65x13 "Back to files" 11px/450 #ffffff
    MISSING 40,55 49x13 "Actions…" 11px/450 #ffffff
    MISSING 160,55 18x13 "⌘K" 11px/450 #ffffffb2
    MISSING 16,96 18x13 "File" 11px/450 #ffffff
    MISSING 16,120 20x13 "Edit" 11px/450 #ffffff
    MISSING 16,144 26x13 "View" 11px/450 #ffffff
    MISSING 16,168 35x13 "Object" 11px/450 #ffffff
    MISSING 16,192 23x13 "Text" 11px/450 #ffffff
    MISSING 16,216 42x13 "Arrange" 11px/450 #ffffff
    MISSING 16,240 35x13 "Vector" 11px/450 #ffffff
    MISSING 16,281 38x13 "Plugins" 11px/450 #ffffff
    MISSING 16,305 43x13 "Widgets" 11px/450 #ffffff
    MISSING 16,329 64x13 "Preferences" 11px/450 #ffffff
    MISSING 16,353 46x13 "Libraries" 11px/450 #ffffff
    MISSING 16,394 110x13 "Open in desktop app" 11px/450 #ffffff
    MISSING 16,418 93x13 "Help and account" 11px/450 #ffffff
    EXTRA   16,12 31x15 "Undo" 12px/450 #ffffff59
    EXTRA   182,12 19x15 "⌘Z" 12px/450 #ffffff73
    EXTRA   16,36 29x15 "Redo" 12px/450 #ffffff59
    EXTRA   170,36 31x15 "⇧⌘Z" 12px/450 #ffffff73
    EXTRA   16,77 46x15 "Copy as" 12px/450 #ffffff59
    EXTRA   16,101 115x15 "Paste over selection" 12px/450 #ffffff
    EXTRA   169,101 31x15 "⇧⌘V" 12px/450 #ffffff73
    EXTRA   16,125 92x15 "Paste to replace" 12px/450 #ffffff59
    EXTRA   170,125 31x15 "⇧⌘R" 12px/450 #ffffff73
    ... 27 more
  popup live @210,150,190,581 ours @204,150,216,581
    SHIFT   from live y=14 (T:Undo) ours is -2px (live 14, ours 12); was 0
    DIFF    T:Undo: font live 11px/450 ours 12px/450; color live #ffffff ours #ffffff59
    DIFF    T:⌘Z: pos/size live 156,14 18x13 ours 182,12 19x15; font live 11px/450 ours 12px/450; color live #ffffffb2 ours #ffffff73
    DIFF    T:Redo: font live 11px/450 ours 12px/450; color live #ffffff66 ours #ffffff59
    DIFF    T:⇧⌘Z: pos/size live 144,38 29x13 ours 170,36 31x15; font live 11px/450 ours 12px/450; color live #ffffff66 ours #ffffff73
    DIFF    T:Copy as: font live 11px/450 ours 12px/450; color live #ffffff ours #ffffff59
    DIFF    T:Paste over selection: pos/size live 16,103 107x13 ours 16,101 115x15; font live 11px/450 ours 12px/450
    DIFF    T:⇧⌘V: pos/size live 144,103 30x13 ours 169,101 31x15; font live 11px/450 ours 12px/450; color live #ffffffb2 ours #ffffff73
    DIFF    T:Paste to replace: pos/size live 16,127 86x13 ours 16,125 92x15; font live 11px/450 ours 12px/450; color live #ffffff66 ours #ffffff59
    DIFF    T:⇧⌘R: pos/size live 144,127 30x13 ours 170,125 31x15; font live 11px/450 ours 12px/450; color live #ffffff66 ours #ffffff73
    DIFF    T:Duplicate: pos/size live 16,151 50x13 ours 16,149 54x15; font live 11px/450 ours 12px/450; color live #ffffff66 ours #ffffff59
    DIFF    T:⌘D: pos/size live 155,151 19x13 ours 181,149 20x15; font live 11px/450 ours 12px/450; color live #ffffff66 ours #ffffff73
    DIFF    T:Delete: font live 11px/450 ours 12px/450; color live #ffffff66 ours #ffffff59
    DIFF    T:⌫: pos/size live 160,175 13x13 ours 188,173 12x15; font live 11px/450 ours 12px/450; color live #ffffff66 ours #ffffff73
    DIFF    T:Find: font live 11px/450 ours 12px/450
    DIFF    T:⌘F: pos/size live 156,216 18x13 ours 182,214 18x15; font live 11px/450 ours 12px/450; color live #ffffffb2 ours #ffffff73
    DIFF    T:Find next: pos/size live 16,240 49x13 ours 16,238 53x15; font live 11px/450 ours 12px/450; color live #ffffff ours #ffffff59
    DIFF    T:⇧⌘F: pos/size live 145,240 29x13 ours 170,238 30x15; font live 11px/450 ours 12px/450; color live #ffffffb2 ours #ffffff73
    DIFF    T:Find previous: pos/size live 16,264 71x13 ours 16,262 77x15; font live 11px/450 ours 12px/450; color live #ffffff ours #ffffff59
    DIFF    T:⇧⌘D: pos/size live 143,264 30x13 ours 169,262 32x15; font live 11px/450 ours 12px/450; color live #ffffffb2 ours #ffffff73
    DIFF    T:Find and replace…: pos/size live 16,288 97x13 ours 16,286 106x15; font live 11px/450 ours 12px/450
    DIFF    T:Set default properties: pos/size live 16,329 115x13 ours 16,327 124x15; font live 11px/450 ours 12px/450; color live #ffffff66 ours #ffffff59
    DIFF    T:Copy properties: pos/size live 16,353 85x13 ours 16,351 92x15; font live 11px/450 ours 12px/450; color live #ffffff66 ours #ffffff59
    DIFF    T:⌥⌘C: pos/size live 143,353 30x13 ours 169,351 32x15; font live 11px/450 ours 12px/450; color live #ffffff66 ours #ffffff73
    DIFF    T:Paste properties: pos/size live 16,377 87x13 ours 16,375 94x15; font live 11px/450 ours 12px/450; color live #ffffff66 ours #ffffff59
    ... 13 more
## main-view: live popups 12,44,194,444 | 210,105,201,787; ours 204,81,233,811
  popup live @12,44,194,444 ours @204,81,233,811
    MISSING 16,14 65x13 "Back to files" 11px/450 #ffffff
    MISSING 40,55 49x13 "Actions…" 11px/450 #ffffff
    MISSING 160,55 18x13 "⌘K" 11px/450 #ffffffb2
    MISSING 16,96 18x13 "File" 11px/450 #ffffff
    MISSING 16,120 20x13 "Edit" 11px/450 #ffffff
    MISSING 16,144 26x13 "View" 11px/450 #ffffff
    MISSING 16,168 35x13 "Object" 11px/450 #ffffff
    MISSING 16,192 23x13 "Text" 11px/450 #ffffff
    MISSING 16,216 42x13 "Arrange" 11px/450 #ffffff
    MISSING 16,240 35x13 "Vector" 11px/450 #ffffff
    MISSING 16,281 38x13 "Plugins" 11px/450 #ffffff
    MISSING 16,305 43x13 "Widgets" 11px/450 #ffffff
    MISSING 16,329 64x13 "Preferences" 11px/450 #ffffff
    MISSING 16,353 46x13 "Libraries" 11px/450 #ffffff
    MISSING 16,394 110x13 "Open in desktop app" 11px/450 #ffffff
    MISSING 16,418 93x13 "Help and account" 11px/450 #ffffff
    EXTRA   36,12 53x15 "Pixel grid" 12px/450 #ffffff
    EXTRA   202,12 15x15 "⇧′" 12px/450 #ffffff73
    EXTRA   36,36 80x15 "Layout guides" 12px/450 #ffffff
    EXTRA   196,36 21x15 "⇧G" 12px/450 #ffffff73
    EXTRA   36,60 36x15 "Rulers" 12px/450 #ffffff
    EXTRA   197,60 20x15 "⇧R" 12px/450 #ffffff73
    EXTRA   36,84 68x15 "Show slices" 12px/450 #ffffff59
    EXTRA   36,108 62x15 "Comments" 12px/450 #ffffff59
    EXTRA   196,108 21x15 "⇧C" 12px/450 #ffffff73
    ... 43 more
  popup live @210,105,201,787 ours @204,81,233,811
    DIFF    T:Pixel grid: pos/size live 32,14 49x13 ours 36,12 53x15; font live 11px/450 ours 12px/450
    DIFF    T:⇧′: pos/size live 171,14 14x13 ours 202,12 15x15; font live 11px/450 ours 12px/450; color live #ffffffb2 ours #ffffff73
    DIFF    T:Layout guides: pos/size live 32,38 74x13 ours 36,36 80x15; font live 11px/450 ours 12px/450
    DIFF    T:⇧G: pos/size live 166,38 20x13 ours 196,36 21x15; font live 11px/450 ours 12px/450; color live #ffffffb2 ours #ffffff73
    DIFF    T:Rulers: pos/size live 32,62 33x13 ours 36,60 36x15; font live 11px/450 ours 12px/450
    DIFF    T:⇧R: pos/size live 167,62 19x13 ours 197,60 20x15; font live 11px/450 ours 12px/450; color live #ffffffb2 ours #ffffff73
    DIFF    T:Show slices: pos/size live 32,86 62x13 ours 36,84 68x15; font live 11px/450 ours 12px/450; color live #ffffff ours #ffffff59
    DIFF    T:Comments: pos/size live 32,110 57x13 ours 36,108 62x15; font live 11px/450 ours 12px/450; color live #ffffff ours #ffffff59
    DIFF    T:⇧C: pos/size live 166,110 20x13 ours 196,108 21x15; font live 11px/450 ours 12px/450; color live #ffffffb2 ours #ffffff73
    DIFF    T:Annotations: pos/size live 32,134 64x13 ours 36,132 69x15; font live 11px/450 ours 12px/450
    DIFF    T:⇧Y: pos/size live 167,134 19x13 ours 197,132 20x15; font live 11px/450 ours 12px/450; color live #ffffffb2 ours #ffffff73
    DIFF    T:Outlines: pos/size live 32,158 44x13 ours 36,156 47x15; font live 11px/450 ours 12px/450
    DIFF    T:Pixel preview: pos/size live 32,182 70x13 ours 36,180 75x15; font live 11px/450 ours 12px/450; color live #ffffff ours #ffffff59
    DIFF    T:⇧⌘P: pos/size live 156,182 30x13 ours 186,180 31x15; font live 11px/450 ours 12px/450; color live #ffffffb2 ours #ffffff73
    DIFF    T:Mask outlines: pos/size live 32,206 73x13 ours 36,204 79x15; font live 11px/450 ours 12px/450; color live #ffffff ours #ffffff59
    DIFF    T:Frame outlines: pos/size live 32,230 78x13 ours 36,228 84x15; font live 11px/450 ours 12px/450; color live #ffffff ours #ffffff59
    DIFF    T:Memory usage: pos/size live 32,254 78x13 ours 36,252 85x15; font live 11px/450 ours 12px/450; color live #ffffff ours #ffffff59
    DIFF    T:Additional labels: pos/size live 32,295 87x13 ours 36,276 94x15; font live 11px/450 ours 12px/450
    DIFF    T:Minimize left navigation bar: pos/size live 32,319 145x13 ours 36,341 157x15; font live 11px/450 ours 12px/450; color live #ffffff ours #ffffff59
    DIFF    T:Minimize UI: pos/size live 32,343 61x13 ours 36,365 66x15; font live 11px/450 ours 12px/450
    DIFF    T:⇧⌘\: pos/size live 159,343 27x13 ours 190,365 27x15; font live 11px/450 ours 12px/450; color live #ffffffb2 ours #ffffff73
    DIFF    T:Show/Hide UI: pos/size live 32,367 72x13 ours 36,389 78x15; font live 11px/450 ours 12px/450
    DIFF    T:⌘\: pos/size live 170,367 15x13 ours 202,389 15x15; font live 11px/450 ours 12px/450; color live #ffffffb2 ours #ffffff73
    DIFF    T:Multiplayer cursors: pos/size live 32,391 101x13 ours 36,413 110x15; font live 11px/450 ours 12px/450; color live #ffffff ours #ffffff59
    DIFF    T:⌥⌘\: pos/size live 159,391 26x13 ours 190,413 27x15; font live 11px/450 ours 12px/450; color live #ffffffb2 ours #ffffff73
    ... 31 more
## main-preferences: live popups 12,44,194,444 | 210,132,235,763; ours 204,359,208,153
  popup live @12,44,194,444 ours @204,359,208,153
    MISSING 16,14 65x13 "Back to files" 11px/450 #ffffff
    MISSING 40,55 49x13 "Actions…" 11px/450 #ffffff
    MISSING 160,55 18x13 "⌘K" 11px/450 #ffffffb2
    MISSING 16,96 18x13 "File" 11px/450 #ffffff
    MISSING 16,120 20x13 "Edit" 11px/450 #ffffff
    MISSING 16,144 26x13 "View" 11px/450 #ffffff
    MISSING 16,168 35x13 "Object" 11px/450 #ffffff
    MISSING 16,192 23x13 "Text" 11px/450 #ffffff
    MISSING 16,216 42x13 "Arrange" 11px/450 #ffffff
    MISSING 16,240 35x13 "Vector" 11px/450 #ffffff
    MISSING 16,281 38x13 "Plugins" 11px/450 #ffffff
    MISSING 16,305 43x13 "Widgets" 11px/450 #ffffff
    MISSING 16,329 64x13 "Preferences" 11px/450 #ffffff
    MISSING 16,353 46x13 "Libraries" 11px/450 #ffffff
    MISSING 16,394 110x13 "Open in desktop app" 11px/450 #ffffff
    MISSING 16,418 93x13 "Help and account" 11px/450 #ffffff
    EXTRA   36,12 99x15 "Snap to pixel grid" 12px/450 #ffffff59
    EXTRA   166,12 26x15 "⇧⌘′" 12px/450 #ffffff73
    EXTRA   36,36 142x15 "Highlight layers on hover" 12px/450 #ffffff
    EXTRA   36,77 40x15 "Theme" 12px/450 #ffffff
    EXTRA   36,101 81x15 "Color profile…" 12px/450 #ffffff59
    EXTRA   36,125 95x15 "Nudge amount…" 12px/450 #ffffff59
  popup live @210,132,235,763 ours @204,359,208,153
    MISSING 32,14 94x13 "Snap to geometry" 11px/450 #ffffff
    MISSING 32,38 82x13 "Snap to objects" 11px/450 #ffffff
    DIFF    T:Snap to pixel grid: pos/size live 32,62 92x13 ours 36,12 99x15; font live 11px/450 ours 12px/450; color live #ffffff ours #ffffff59
    DIFF    T:⇧⌘′: pos/size live 194,62 25x13 ours 166,12 26x15; font live 11px/450 ours 12px/450; color live #ffffffb2 ours #ffffff73
    MISSING 32,103 148x13 "Keep tool selected after use" 11px/450 #ffffff
    DIFF    T:Highlight layers on hover: pos/size live 32,127 131x13 ours 36,36 142x15; font live 11px/450 ours 12px/450
    MISSING 32,151 136x13 "Rename duplicated layers" 11px/450 #ffffff
    MISSING 32,175 151x13 "Show dimensions on objects" 11px/450 #ffffff
    MISSING 32,199 163x13 "Hide canvas UI during changes" 11px/450 #ffffff
    MISSING 32,223 142x13 "Use smart quotes/symbols" 11px/450 #ffffff
    MISSING 32,247 136x13 "Flip objects while resizing" 11px/450 #ffffff
    MISSING 32,271 162x13 "Keyboard zooms into selection" 11px/450 #ffffff
    MISSING 32,295 112x13 "Invert zoom direction" 11px/450 #ffffff
    MISSING 32,319 179x13 "Ctrl+click opens right click menus" 11px/450 #ffffff
    MISSING 32,343 151x13 "Use number keys for opacity" 11px/450 #ffffff
    MISSING 32,367 156x13 "Use old shortcuts for outlines" 11px/450 #ffffff
    MISSING 32,391 154x13 "Use ⌘⌥↑/↓ to rotate layers" 11px/450 #ffffff
    MISSING 32,415 175x13 "Play audio notifications in AI chat" 11px/450 #ffffff
    MISSING 32,439 137x13 "Open links in desktop app" 11px/450 #ffffff
    MISSING 32,463 120x13 "Show text suggestions" 11px/450 #ffffff
    MISSING 32,487 120x13 "Show tool suggestions" 11px/450 #ffffff
    MISSING 32,511 126x13 "Show Agents on canvas" 11px/450 #ffffff
    MISSING 32,552 118x13 "Use scroll wheel zoom" 11px/450 #ffffff
    MISSING 32,576 143x13 "Right-click and drag to pan" 11px/450 #ffffff
    DIFF    T:Theme: pos/size live 32,617 36x13 ours 36,77 40x15; font live 11px/450 ours 12px/450
    ... 5 more
## main-help: live popups 12,44,194,444 | 210,448,178,249; ours 204,424,208,40
  popup live @12,44,194,444 ours @204,424,208,40
    MISSING 16,14 65x13 "Back to files" 11px/450 #ffffff
    MISSING 40,55 49x13 "Actions…" 11px/450 #ffffff
    MISSING 160,55 18x13 "⌘K" 11px/450 #ffffffb2
    MISSING 16,96 18x13 "File" 11px/450 #ffffff
    MISSING 16,120 20x13 "Edit" 11px/450 #ffffff
    MISSING 16,144 26x13 "View" 11px/450 #ffffff
    MISSING 16,168 35x13 "Object" 11px/450 #ffffff
    MISSING 16,192 23x13 "Text" 11px/450 #ffffff
    MISSING 16,216 42x13 "Arrange" 11px/450 #ffffff
    MISSING 16,240 35x13 "Vector" 11px/450 #ffffff
    MISSING 16,281 38x13 "Plugins" 11px/450 #ffffff
    MISSING 16,305 43x13 "Widgets" 11px/450 #ffffff
    MISSING 16,329 64x13 "Preferences" 11px/450 #ffffff
    MISSING 16,353 46x13 "Libraries" 11px/450 #ffffff
    MISSING 16,394 110x13 "Open in desktop app" 11px/450 #ffffff
    MISSING 16,418 93x13 "Help and account" 11px/450 #ffffff
    EXTRA   16,12 112x15 "Keyboard shortcuts" 12px/450 #ffffff
    EXTRA   163,12 29x15 "⌃⇧?" 12px/450 #ffffff73
  popup live @210,448,178,249 ours @204,424,208,40
    MISSING 16,14 54x13 "Help page" 11px/450 #ffffff
    DIFF    T:Keyboard shortcuts: pos/size live 16,38 104x13 ours 16,12 112x15; font live 11px/450 ours 12px/450
    DIFF    T:⌃⇧?: pos/size live 136,38 26x13 ours 163,12 29x15; font live 11px/450 ours 12px/450; color live #ffffffb2 ours #ffffff73
    MISSING 16,62 77x13 "Support forum" 11px/450 #ffffff
    MISSING 16,86 77x13 "Video tutorials" 11px/450 #ffffff
    MISSING 16,110 74x13 "Release notes" 11px/450 #ffffff
    MISSING 16,134 98x13 "Open font settings" 11px/450 #ffffff
    MISSING 16,175 80x13 "Legal summary" 11px/450 #ffffff
    MISSING 16,199 90x13 "Account settings" 11px/450 #ffffff
    MISSING 16,223 40x13 "Log out" 11px/450 #ffffff
## main-view-panels: live popups 12,44,194,444 | 210,105,201,787 | 416,554,174,136; ours 433,554,220,136
  popup live @12,44,194,444 ours @433,554,220,136
    MISSING 16,14 65x13 "Back to files" 11px/450 #ffffff
    MISSING 40,55 49x13 "Actions…" 11px/450 #ffffff
    MISSING 160,55 18x13 "⌘K" 11px/450 #ffffffb2
    MISSING 16,96 18x13 "File" 11px/450 #ffffff
    MISSING 16,120 20x13 "Edit" 11px/450 #ffffff
    MISSING 16,144 26x13 "View" 11px/450 #ffffff
    MISSING 16,168 35x13 "Object" 11px/450 #ffffff
    MISSING 16,192 23x13 "Text" 11px/450 #ffffff
    MISSING 16,216 42x13 "Arrange" 11px/450 #ffffff
    MISSING 16,240 35x13 "Vector" 11px/450 #ffffff
    MISSING 16,281 38x13 "Plugins" 11px/450 #ffffff
    MISSING 16,305 43x13 "Widgets" 11px/450 #ffffff
    MISSING 16,329 64x13 "Preferences" 11px/450 #ffffff
    DIFF    T:Libraries: pos/size live 16,353 46x13 ours 36,36 50x15; font live 11px/450 ours 12px/450
    MISSING 16,394 110x13 "Open in desktop app" 11px/450 #ffffff
    MISSING 16,418 93x13 "Help and account" 11px/450 #ffffff
    EXTRA   36,12 103x15 "Open layers panel" 12px/450 #ffffff
    EXTRA   184,12 20x15 "⌥1" 12px/450 #ffffff73
    EXTRA   184,36 20x15 "⌥2" 12px/450 #ffffff73
    EXTRA   36,60 107x15 "Open design panel" 12px/450 #ffffff
    EXTRA   184,60 20x15 "⌥8" 12px/450 #ffffff73
    EXTRA   36,84 124x15 "Open prototype panel" 12px/450 #ffffff
    EXTRA   184,84 20x15 "⌥9" 12px/450 #ffffff73
    EXTRA   36,108 94x15 "Toggle variables" 12px/450 #ffffff
  popup live @210,105,201,787 ours @433,554,220,136
    MISSING 32,14 49x13 "Pixel grid" 11px/450 #ffffff
    MISSING 171,14 14x13 "⇧′" 11px/450 #ffffffb2
    MISSING 32,38 74x13 "Layout guides" 11px/450 #ffffff
    MISSING 166,38 20x13 "⇧G" 11px/450 #ffffffb2
    MISSING 32,62 33x13 "Rulers" 11px/450 #ffffff
    MISSING 167,62 19x13 "⇧R" 11px/450 #ffffffb2
    MISSING 32,86 62x13 "Show slices" 11px/450 #ffffff
    MISSING 32,110 57x13 "Comments" 11px/450 #ffffff
    MISSING 166,110 20x13 "⇧C" 11px/450 #ffffffb2
    MISSING 32,134 64x13 "Annotations" 11px/450 #ffffff
    MISSING 167,134 19x13 "⇧Y" 11px/450 #ffffffb2
    MISSING 32,158 44x13 "Outlines" 11px/450 #ffffff
    MISSING 32,182 70x13 "Pixel preview" 11px/450 #ffffff
    MISSING 156,182 30x13 "⇧⌘P" 11px/450 #ffffffb2
    MISSING 32,206 73x13 "Mask outlines" 11px/450 #ffffff
    MISSING 32,230 78x13 "Frame outlines" 11px/450 #ffffff
    MISSING 32,254 78x13 "Memory usage" 11px/450 #ffffff
    MISSING 32,295 87x13 "Additional labels" 11px/450 #ffffff
    MISSING 32,319 145x13 "Minimize left navigation bar" 11px/450 #ffffff
    MISSING 32,343 61x13 "Minimize UI" 11px/450 #ffffff
    MISSING 159,343 27x13 "⇧⌘\" 11px/450 #ffffffb2
    MISSING 32,367 72x13 "Show/Hide UI" 11px/450 #ffffff
    MISSING 170,367 15x13 "⌘\" 11px/450 #ffffffb2
    MISSING 32,391 101x13 "Multiplayer cursors" 11px/450 #ffffff
    MISSING 159,391 26x13 "⌥⌘\" 11px/450 #ffffffb2
    ... 35 more
  popup live @416,554,174,136 ours @433,554,220,136
    DIFF    T:Open layers panel: pos/size live 16,14 95x13 ours 36,12 103x15; font live 11px/450 ours 12px/450
    DIFF    T:⌥1: pos/size live 139,14 19x13 ours 184,12 20x15; font live 11px/450 ours 12px/450; color live #ffffffb2 ours #ffffff73
    DIFF    T:Libraries: pos/size live 16,38 46x13 ours 36,36 50x15; font live 11px/450 ours 12px/450
    DIFF    T:⌥2: pos/size live 139,38 19x13 ours 184,36 20x15; font live 11px/450 ours 12px/450; color live #ffffffb2 ours #ffffff73
    DIFF    T:Open design panel: pos/size live 16,62 99x13 ours 36,60 107x15; font live 11px/450 ours 12px/450
    DIFF    T:⌥8: pos/size live 139,62 19x13 ours 184,60 20x15; font live 11px/450 ours 12px/450; color live #ffffffb2 ours #ffffff73
    DIFF    T:Open prototype panel: pos/size live 16,86 115x13 ours 36,84 124x15; font live 11px/450 ours 12px/450
    DIFF    T:⌥9: pos/size live 139,86 19x13 ours 184,84 20x15; font live 11px/450 ours 12px/450; color live #ffffffb2 ours #ffffff73
    DIFF    T:Toggle variables: pos/size live 16,110 86x13 ours 36,108 94x15; font live 11px/450 ours 12px/450
## main-object: live popups 12,44,194,444 | 210,6,185,1050; ours 204,8,232,884
  popup live @12,44,194,444 ours @204,8,232,884
    MISSING 16,14 65x13 "Back to files" 11px/450 #ffffff
    MISSING 40,55 49x13 "Actions…" 11px/450 #ffffff
    MISSING 160,55 18x13 "⌘K" 11px/450 #ffffffb2
    MISSING 16,96 18x13 "File" 11px/450 #ffffff
    MISSING 16,120 20x13 "Edit" 11px/450 #ffffff
    MISSING 16,144 26x13 "View" 11px/450 #ffffff
    MISSING 16,168 35x13 "Object" 11px/450 #ffffff
    MISSING 16,192 23x13 "Text" 11px/450 #ffffff
    MISSING 16,216 42x13 "Arrange" 11px/450 #ffffff
    MISSING 16,240 35x13 "Vector" 11px/450 #ffffff
    MISSING 16,281 38x13 "Plugins" 11px/450 #ffffff
    MISSING 16,305 43x13 "Widgets" 11px/450 #ffffff
    MISSING 16,329 64x13 "Preferences" 11px/450 #ffffff
    MISSING 16,353 46x13 "Libraries" 11px/450 #ffffff
    MISSING 16,394 110x13 "Open in desktop app" 11px/450 #ffffff
    MISSING 16,418 93x13 "Help and account" 11px/450 #ffffff
    EXTRA   36,12 91x15 "Frame selection" 12px/450 #ffffff59
    EXTRA   185,12 32x15 "⌥⌘G" 12px/450 #ffffff73
    EXTRA   36,36 90x15 "Group selection" 12px/450 #ffffff59
    EXTRA   196,36 20x15 "⌘G" 12px/450 #ffffff73
    EXTRA   36,60 105x15 "Ungroup selection" 12px/450 #ffffff59
    EXTRA   193,60 23x15 "⌘⌫" 12px/450 #ffffff73
    EXTRA   36,101 116x15 "Wrap in new section" 12px/450 #ffffff59
    EXTRA   198,101 19x15 "⌘S" 12px/450 #ffffff73
    EXTRA   36,125 105x15 "Convert to section" 12px/450 #ffffff59
    ... 49 more
  popup live @210,6,185,1050 ours @204,8,232,884
    DIFF    T:Frame selection: pos/size live 16,14 84x13 ours 36,12 91x15; font live 11px/450 ours 12px/450; color live #ffffff66 ours #ffffff59
    DIFF    T:⌥⌘G: pos/size live 139,14 31x13 ours 185,12 32x15; font live 11px/450 ours 12px/450; color live #ffffff66 ours #ffffff73
    DIFF    T:Group selection: pos/size live 16,38 83x13 ours 36,36 90x15; font live 11px/450 ours 12px/450; color live #ffffff66 ours #ffffff59
    DIFF    T:⌘G: pos/size live 150,38 19x13 ours 196,36 20x15; font live 11px/450 ours 12px/450; color live #ffffff66 ours #ffffff73
    DIFF    T:Ungroup selection: pos/size live 16,62 96x13 ours 36,60 105x15; font live 11px/450 ours 12px/450; color live #ffffff66 ours #ffffff59
    DIFF    T:⌘⌫: pos/size live 145,62 24x13 ours 193,60 23x15; font live 11px/450 ours 12px/450; color live #ffffff66 ours #ffffff73
    DIFF    T:Wrap in new section: pos/size live 16,103 107x13 ours 36,101 116x15; font live 11px/450 ours 12px/450; color live #ffffff66 ours #ffffff59
    DIFF    T:⌘S: pos/size live 151,103 18x13 ours 198,101 19x15; font live 11px/450 ours 12px/450; color live #ffffff66 ours #ffffff73
    DIFF    T:Convert to section: pos/size live 16,127 98x13 ours 36,125 105x15; font live 11px/450 ours 12px/450; color live #ffffff66 ours #ffffff59
    DIFF    T:Convert to frame: pos/size live 16,151 90x13 ours 36,149 96x15; font live 11px/450 ours 12px/450; color live #ffffff66 ours #ffffff59
    DIFF    T:Restore default thumbnail: pos/size live 16,192 136x13 ours 36,190 146x15; font live 11px/450 ours 12px/450; color live #ffffff66 ours #ffffff59
    DIFF    T:Use as mask: pos/size live 16,233 67x13 ours 36,231 72x15; font live 11px/450 ours 12px/450; color live #ffffff66 ours #ffffff59
    DIFF    T:⌃⌘M: pos/size live 140,233 30x13 ours 184,231 33x15; font live 11px/450 ours 12px/450; color live #ffffff66 ours #ffffff73
    DIFF    T:Add auto layout: pos/size live 16,274 83x13 ours 36,272 89x15; font live 11px/450 ours 12px/450; color live #ffffff66 ours #ffffff59
    DIFF    T:⇧A: pos/size live 150,274 19x13 ours 196,272 20x15; font live 11px/450 ours 12px/450; color live #ffffff66 ours #ffffff73
    DIFF    T:More layout options: pos/size live 16,298 105x13 ours 36,296 113x15; font live 11px/450 ours 12px/450; color live #ffffff ours #ffffff59
    DIFF    T:Create component: pos/size live 16,339 98x13 ours 36,337 106x15; font live 11px/450 ours 12px/450; color live #ffffff66 ours #ffffff59
    DIFF    T:⌥⌘K: pos/size live 140,339 30x13 ours 185,337 31x15; font live 11px/450 ours 12px/450; color live #ffffff66 ours #ffffff73
    DIFF    T:Slots: pos/size live 16,363 26x13 ours 36,361 28x15; font live 11px/450 ours 12px/450; color live #ffffff ours #ffffff59
    MISSING 16,387 78x13 "Reset instance" 11px/450 #ffffff66
    DIFF    T:Detach instance: pos/size live 16,411 86x13 ours 36,385 92x15; font live 11px/450 ours 12px/450; color live #ffffff66 ours #ffffff59
    DIFF    T:⌥⌘B: pos/size live 140,411 30x13 ours 186,385 31x15; font live 11px/450 ours 12px/450; color live #ffffff66 ours #ffffff73
    DIFF    T:Main component: pos/size live 16,435 88x13 ours 36,409 96x15; font live 11px/450 ours 12px/450; color live #ffffff ours #ffffff59
    DIFF    T:Bring to front: pos/size live 16,476 70x13 ours 36,450 75x15; font live 11px/450 ours 12px/450; color live #ffffff66 ours #ffffff59
    DIFF    T:]: pos/size live 165,476 4x13 ours 212,450 5x15; font live 11px/450 ours 12px/450; color live #ffffff66 ours #ffffff73
    ... 36 more
## bottom-toolbar: live popups 456,840,529,48; ours 460,840,529,48
  popup live @456,840,529,48 ours @460,840,529,48
    DIFF    [Move]: pos/size live 8,8 49x32 ours 8,8 32x32
    DIFF    [Frame]: pos/size live 65,8 49x32 ours 65,8 32x32
    DIFF    [Rectangle]: pos/size live 122,8 49x32 ours 122,8 32x32
    DIFF    [Pen]: pos/size live 179,8 49x32 ours 179,8 32x32
    DIFF    [Text]: pos/size live 236,8 49x32 ours 236,8 32x32
    DIFF    [Comment]: pos/size live 293,8 49x32 ours 293,8 32x32
    MISSING 400,11 74x13 "Toolbelt Mode" 11px/400 #ffffff
    MISSING 415,25 27x13 "Draw" 11px/400 #ffffff
    DIFF    [Design]: pos/size live 432,11 26x26 ours 431,10 28x28
    MISSING 445,25 36x13 "Design" 11px/400 #ffffff
    MISSING 475,25 36x13 "Motion" 11px/400 #ffffff
    MISSING 505,25 53x13 "Dev Mode" 11px/400 #ffffff
## move-tools-menu: live popups 497,764,151,72; ours 468,752,208,88
  popup live @497,764,151,72 ours @468,752,208,88
    SHIFT   from live y=6 (T:Move) ours is +6px (live 6, ours 12); was 0
    DIFF    T:Move: font live 11px/450 ours 12px/450
    DIFF    T:V: pos/size live 128,6 8x13 ours 184,12 8x15; font live 11px/450 ours 12px/450; color live #ffffffcc ours #ffffff73
    DIFF    T:Hand tool: pos/size live 60,30 51x13 ours 60,36 55x15; font live 11px/450 ours 12px/450
    DIFF    T:H: pos/size live 127,30 8x13 ours 183,36 9x15; font live 11px/450 ours 12px/450; color live #ffffffb2 ours #ffffff73
    DIFF    T:Scale: font live 11px/450 ours 12px/450; color live #ffffff ours #ffffff59
    DIFF    T:K: pos/size live 128,54 7x13 ours 184,60 8x15; font live 11px/450 ours 12px/450; color live #ffffffb2 ours #ffffff73
## region-tools-menu: live popups 554,764,150,72; ours 525,752,208,88
  popup live @554,764,150,72 ours @525,752,208,88
    SHIFT   from live y=6 (T:Frame) ours is +6px (live 6, ours 12); was 0
    DIFF    T:Frame: font live 11px/450 ours 12px/450
    DIFF    T:F: pos/size live 128,6 7x13 ours 185,12 7x15; font live 11px/450 ours 12px/450; color live #ffffffcc ours #ffffff73
    DIFF    T:Section: font live 11px/450 ours 12px/450
    DIFF    T:⇧S: pos/size live 116,30 19x13 ours 172,36 20x15; font live 11px/450 ours 12px/450; color live #ffffffb2 ours #ffffff73
    DIFF    T:Slice: font live 11px/450 ours 12px/450; color live #ffffff ours #ffffff59
    DIFF    T:S: pos/size live 127,54 7x13 ours 184,60 8x15; font live 11px/450 ours 12px/450; color live #ffffffb2 ours #ffffff73
## shape-tools-menu: live popups 611,668,196,168; ours 582,656,213,184
  popup live @611,668,196,168 ours @582,656,213,184
    DIFF    T:Rectangle: pos/size live 60,6 53x13 ours 60,12 57x15; font live 11px/450 ours 12px/450
    DIFF    T:R: pos/size live 173,6 7x13 ours 189,12 8x15; font live 11px/450 ours 12px/450; color live #ffffffcc ours #ffffff73
    SHIFT   from live y=30 (T:Line) ours is +6px (live 30, ours 36); was 0
    DIFF    T:Line: font live 11px/450 ours 12px/450
    DIFF    T:L: pos/size live 174,30 6x13 ours 190,36 7x15; font live 11px/450 ours 12px/450; color live #ffffffb2 ours #ffffff73
    DIFF    T:Arrow: font live 11px/450 ours 12px/450
    DIFF    T:⇧L: pos/size live 162,54 18x13 ours 178,60 19x15; font live 11px/450 ours 12px/450; color live #ffffffb2 ours #ffffff73
    DIFF    T:Ellipse: font live 11px/450 ours 12px/450
    DIFF    T:O: pos/size live 172,78 8x13 ours 187,84 9x15; font live 11px/450 ours 12px/450; color live #ffffffb2 ours #ffffff73
    DIFF    T:Polygon: pos/size live 60,102 42x13 ours 60,108 46x15; font live 11px/450 ours 12px/450
    DIFF    T:Star: font live 11px/450 ours 12px/450
    DIFF    T:Image/video…: pos/size live 60,150 74x13 ours 60,156 81x15; font live 11px/450 ours 12px/450
    DIFF    T:⇧⌘K: pos/size live 150,150 30x13 ours 165,156 31x15; font live 11px/450 ours 12px/450; color live #ffffffb2 ours #ffffff73
## creation-tools-menu: live popups 668,788,142,48; ours 639,776,208,64
  popup live @668,788,142,48 ours @639,776,208,64
    SHIFT   from live y=6 (T:Pen) ours is +6px (live 6, ours 12); was 0
    DIFF    T:Pen: font live 11px/450 ours 12px/450
    DIFF    T:P: pos/size live 119,6 7x13 ours 184,12 8x15; font live 11px/450 ours 12px/450; color live #ffffffcc ours #ffffff73
    DIFF    T:Pencil: font live 11px/450 ours 12px/450
    DIFF    T:⇧P: pos/size live 108,30 19x13 ours 172,36 20x15; font live 11px/450 ours 12px/450; color live #ffffffb2 ours #ffffff73
## comment-tools-menu: live popups 782,764,186,72; ours 753,752,208,88
  popup live @782,764,186,72 ours @753,752,208,88
    DIFF    T:Comment: pos/size live 60,6 51x13 ours 60,12 55x15; font live 11px/450 ours 12px/450; color live #ffffff ours #ffffff59
    DIFF    T:C: pos/size live 162,6 8x13 ours 183,12 9x15; font live 11px/450 ours 12px/450; color live #ffffffcc ours #ffffff73
    DIFF    T:Annotation: pos/size live 60,30 58x13 ours 60,36 62x15; font live 11px/450 ours 12px/450
    MISSING 162,30 7x13 "Y" 11px/450 #ffffffb2
    DIFF    T:Measurement: pos/size live 60,54 72x13 ours 60,60 79x15; font live 11px/450 ours 12px/450
    DIFF    T:⇧M: pos/size live 148,54 21x13 ours 169,60 23x15; font live 11px/450 ours 12px/450; color live #ffffffb2 ours #ffffff73
    EXTRA   172,36 20x15 "⇧T" 12px/450 #ffffff73
## actions-panel: live popups 456,478,529,354; ours 643,792,155,40
  popup live @456,478,529,354 ours @643,792,155,40
    MISSING 44,8 431x32 input = [Search] bg=#383838
    MISSING 491,12 24x24 button [Visual search (AI beta)] r=5px
    MISSING 16,54 14x13 "All" 11px/550 #ffffff
    MISSING 54,54 36x13 "Assets" 11px/450 #ffffffb2
    MISSING 113,54 93x13 "Plugins & widgets" 11px/450 #ffffffb2
    MISSING 16,86 43x13 "Recents" 11px/450 #ffffffb2
    MISSING 44,112 84x16 "Translate to..." 13px/400 #ffffff
    MISSING 493,112 20x16 a [AI, Learn more] r=5px
    MISSING 498,114 10x13 "AI" 11px/400 #ffffffb2
    MISSING 44,144 184x16 "Lorem Ipsum — by ‹div›RIOTS" 13px/400 #ffffff
    MISSING 473,146 17x13 "tab" 11px/500 #ffffff66
    MISSING 44,176 83x16 "Rewrite this..." 13px/400 #ffffff
    MISSING 16,214 72x13 "Image editing" 11px/450 #ffffffb2
    MISSING 44,240 93x16 "Make an image" 13px/400 #ffffff
    MISSING 44,272 126x16 "Remove background" 13px/400 #ffffff
    MISSING 44,304 100x16 "Boost resolution" 13px/400 #ffffff
    MISSING 44,336 142x16 "Edit image with prompt" 13px/400 #ffffff
    MISSING 16,374 65x13 "Design tools" 11px/450 #ffffffb2
    MISSING 44,400 90x16 "Rename layers" 13px/400 #ffffff
    MISSING 44,432 100x16 "Replace content" 13px/400 #ffffff
    MISSING 44,464 101x16 "Add interactions" 13px/400 #ffffff
    MISSING 16,502 96x13 "Riffing and writing" 11px/450 #ffffffb2
    MISSING 44,528 49x16 "Shorten" 13px/400 #ffffff
    EXTRA   16,13 99x14 "Actions come later" 11px/450 #ffffff
    EXTRA   123,8 24x24 button [Dismiss] r=5px
```
