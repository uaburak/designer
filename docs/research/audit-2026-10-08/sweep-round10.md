# Visual-parity sweep, round 10 (Design side vs real Figma)

Measured on `main` at `85cbb5c` on 2026-10-09, after the round 10 merges (r10-design-panel-popovers, r10-canvas-chrome, r10-menus-commands). Read-only sweep: no repo edits except this file.

**Truth:** `docs/research/figma/live/` (DOM dumps in design/, popovers/, grid/, menus/, left/, toolbar/; canvas screenshots in img/). Live wins over everything; where live has no data a point is marked **unverified**.

## Method

- Server: `vite --config vite.web.config.ts --mode demo --port 5691` (the owner's dev app on 5173 untouched); headless Chrome for Testing 1440 x 900 (DPR 1, SwiftShader; DPR 1.5 for the canvas shots), dark theme, one browser at a time, every run under 180 s and closed in `finally`; `memory_pressure` was 50-52 % free before each run. `?editor&doc=capture` (the live file: `Page 1` first, then `Capture`, with the live capture's components, instances, set, Card and the triangle Vector) for every state below; `doc=components` was opened once as a smoke check (loads, Assets / Layers dump) because every component state of the live capture is already in `doc=capture`.
- Design panel: `live/tools/panel.mjs` for the 31 resting selection states (the page, shapes, frame, groups, auto layout in five flavours, grid child, text, vector, components, set, variant, instances, nested instance and its parent); a second driver for the 13 interactive ones (Add stroke, Add export settings, Add effect with a stroke, Individual corners, Individual padding, Constraints, Add layout guide, text edit with a caret and with the last 4 characters selected, vector edit, vector edit with a point clicked, grid Auto layout settings, grid dimensions picker) plus the grid row track selected by its canvas pill (Grid panel).
- Popovers: `live/tools/popover.mjs` (all 52 cases, 49 with live files), plus the cases it has not got: Create slot property, Shader effects browser (Add effect without the onboarding flag), layer / background blur Progressive, layout guide Columns.
- Menus: a driver that right-clicks the capture's layers on canvas (Rect, Text, a three-shape selection, the AL_vertical frame's label, the main component Button, the Button instance, empty canvas), the Layers row and the Pages row; opens the Figma menu and hovers File, Edit, View (and View > Panels), Object, Text, Arrange, Vector, Plugins, Widgets, Preferences, Help and account; opens the six bottom-toolbar dropdowns, the Actions palette and the vector edit toolbar with its More menu; dumps every open popup with `dumpPopups.js`.
- Left side: whole-window dump (absolute x, y like the live left files) for Assets (3 depths), Tools, Variables (empty on `doc=capture`, with collections on `doc=variables`), and the left panel region (`@57,65 240x835`) for Layers hover, hover plus selection, Find (+ its filter menu) and Pages add.
- Canvas: engine `setCamera` + `setSelection` + mouse hover at DPR 1.5, clipped around the node and put next to `live/img/canvas-*` (28 shots, one pill hover moved by the engine's own `kPillLine`).
- Diff: a second diff (`diff2`) layered on the same dumps, as in round 9: texts matched by string and nearest position (+-2 px, font, colour), controls by aria label or geometry (+-2 px, size, DISABLED, "live checked, ours not"), exact duplicate lines in the live dumps (they list every text twice) removed, live-only hidden accessibility text (11px/450 or 400 duplicates of aria labels, `Autofill available…`, clipped option lists at negative y, `Not applicable for selected text` labels) filtered, radio / checkbox `value=`, CHECKED-vs-SELECTED-vs-EXPANDED wording and wrapper `div` / `label` rows ignored (it is the dumpers, not the UI), swatch lists ignored (they follow the document). Raw numbers per state are in Appendix A (Design), B (popovers), C (menus, toolbar).

**Caveats**
- Many live captures were taken after earlier edits in the same live file: the Rect already carries a stroke and a Drop shadow (rectangle-with-export, individual-corners), `autolayout-individual-padding` was captured with the panel 4 px higher, `frame-child-constraints` after the Constraints toggle. Those differences are fixture, not UI, and are the large `diff` counts of Appendix A (`autolayout-individual-padding` 90, `frame-child-constraints` 35, `frame-with-layout-guide` 75, `variant-instance` 31).
- Live menus are not clipped by the window (blend mode 555 tall, Object submenu 1050, frame presets 1887); ours: blend 555 and frame presets 1887 now run past the window like live, Object submenu is still clamped (889).
- The live file has no variable collection at the time of the Design captures (so no `[Apply variable mode]` on the Page), a second page "Page 1" holding a component `Rectangle 1` (the Assets first card says "6 components"), and a `Hello Figma text` text where the capture fixture has `Hello, Capture` (a stored 184 px width the fixture's text does not fill).
- Headless DPR 1 / 1.5, SwiftShader: the canvas shots are for forms and presence, not for the last pixel.
- The Electron app (store, real files) was not run: every command that depends on the document source (`New Design`, `Duplicate`, `Save local copy…`, `Save to version history…`, `Show version history`, `Create branch…`) is listed disabled on `?editor` (no file operations) and is **unverified** in the app.
- The live `behaviour/*.md` notes are about interactions, not layouts; they were not re-measured.

## Summary

- Round 9 ended with the list in "Re-check on main c8bbc9f" and 3 fix groups; round 10 merged all three. Re-measured here (table "Round 9 re-check", 38 entries): **30 CLOSED, 3 partly closed (what is left is listed), 3 still OPEN** (Actions palette default content, typography styles y, font size list height), 1 WONTFIX, 1 UNVERIFIED. Two items round 9 called closed are carried over because they are still off live's numbers (the panel-anchored list menus' y, S11) or were never compared with the empty-file capture (the Variables empty state). Everything that was a *systematic* difference in round 9 (S3, S5, S8, S9, S10) is closed or reduced to a state difference.
- All 52 popover cases and all 22 menu / toolbar dumps open at live's place with live's size to +-1 px except: the width / height / gap / child-width list menus (7-11 px higher, 2 px wider), the typography styles popover (586 vs 427), the font size list (400 vs 437), the Object submenu (clamped), Vector (195 vs 198), the Create slot property popover (a stub), the fill picker's gradient type and swatch set menus (live has no capture of them) and the live-only shader tiles.
- The resting Design panel is within +-2 px of live for rectangle, ellipse, polygon, star, line, arrow, vector, section, group, boolean, frame, auto layout (vertical, horizontal, wrap, grid, child, parent), grid child, component, set, variant, instance, nested instance, image fill, multi-selection, text and the page. What is left in the panel are **three real differences** (an instance's Flow row, a mixed selection's W / H, the text edit header) and a handful of field geometries.
- What is still different, in order of size: (1) **features live has and we do not**: Slot properties and slot layers (the Create slot property popover is a 240 x 164 stub of live's 304 x 626 form), Shader fills / effects (every tile of the 25-preset browser is disabled), ~~the Google fonts catalogue (the font list holds only Inter)~~ (CLOSED on desktop, see Re-check ba7ed56), Figma Draw's Shape builder and Variable width (listed disabled); (2) **canvas**: the component set's "3 Variants" pill with its "+" button, the hovered text layer's baseline underline (ours draws a box), a selected top-level instance has no title in live; (3) **Variables empty state** (wording, buttons); (4) **Actions palette default content** (Recents + AI sections; ours falls back to the command list); (5) popover details listed per section.

## Round 9 re-check (every open entry)

| r9 entry | Now | Evidence (live -> ours) |
|---|---|---|
| S3 text weight (X / Y in effect popovers, Find's "This page") | CLOSED | no weight DIFF in the 7 effect popovers or in Find |
| S5 caption widths (Alignment, Position, Rotation, Dimensions, Corner radius, Start point, Letter spacing, Line height) | CLOSED | no caption DIFF in any of the 44 states |
| S8 menu vertical padding | CLOSED | Boolean 151 x 120 at (1253,129) -> 150 x 120 at (1254,128); Create property 156 x 207 -> 156 x 207; Instance more actions 221 x 309 -> 221 x 309; Individual strokes 117 x 159 at (1315,539) -> (1315,538); blend 118 x 555 -> 117 x 555; frame presets 222 x 1887 -> 222 x 1887 |
| S9 stubbed commands live enables | CLOSED, remainder is state | Duplicate, Save local copy…, Create branch…, Comments, Mask / Frame outlines, Memory usage, Minimize left navigation bar, Multiplayer cursors, Switch to Draw, Find previous / next frame, Convert to section / frame, Set as thumbnail, More layout options, Hide other layers, Copy / Paste properties, Distribute, Pack, Round to pixel, Join / Split / Simplify / Offset, Spell check, Text direction all enabled in the menus; the remaining disabled ones need the file source (see caveats), a selection with a stroke (Outline stroke), an undo history, an active search |
| S10 shortcut glyph colours | CLOSED for menus; **PARTLY** toolbar | disabled rows #ffffff66 and the lit row #ffffffcc as live in the Figma menu / context menus; the toolbar dropdowns light only the active tool's row, live lights the slot's own tool (see M7) |
| Nested instance: disabled X, Y, Rotation, Rotate 90, Flip, Flow, Wrap, Ignore auto layout, Lock aspect, Align | CLOSED | `nested-instance` 0 DISABLED diffs |
| Align buttons on a single Frame / Group / Boolean | CLOSED | `frame`, `group`, `boolean` 0 diffs |
| Ellipse Corner radius, Line / Arrow Height, text W / H DISABLED | CLOSED | `ellipse`, `line`, `arrow`, `text` 0 diffs |
| Grid child `Column span` / `Row span` | CLOSED | `grid-child` has both captions at (16,340) / (112,340) |
| Selection colors (4 rows) | CLOSED | `mixed-multi` D9D9D9, 000000, 3380FF, FFFFFF at 1009 / 1041 / 1073 / 1105 as live |
| Fill picker y 347 vs 307 (Libraries / Gradient / Video / Shader / Custom) | CLOSED | (959,307) in all five, (959,347) for Solid and Pattern |
| Fill picker Shader tab | CLOSED | 240 x 353 at (959,307), browser 240 x 510 at (719,307) |
| Gradient type / colour format / swatch set menus | **PARTLY** | colour format 87 x 136 at (967,672) identical; live's gradient type and swatch set captures hold no menu, so ours (112 x 112 at (967,392), 224 x 40 at (967,724)) are **unverified** |
| Stroke settings / position / individual strokes | CLOSED | (960,660) 240 x 224; (1208,677) 105 x 88; (1315,538) 117 x 159 |
| Effect settings field geometry, Glass, X / Y labels | CLOSED | 7 effect popovers: sizes identical, 0 field DIFFs |
| Effect styles / Layout guide styles y | CLOSED | (984,719) 216 x 165 both |
| Typography styles y | **OPEN** | (984,427) -> (984,586) |
| Font filter | CLOSED | 240 x 229 at (960,488), 5 groups |
| Font style list | CLOSED | (1208,574) 168 x 314 (live 167 x 313) |
| Font size list | **OPEN** | 96 x 437 -> 96 x 400 |
| Frame presets menu | CLOSED | 222 x 1887, flat list, no headings, rows within 1 px |
| Grid row track menu / panel | CLOSED | list 156 x 72 with the value in "Fixed height (84)"; Grid panel (Columns / Rows) as live; the menu anchored by the pill's chevron on canvas is unverified |
| Instance swap / more actions / Create property / component configuration | CLOSED | all identical +-1 |
| Frame title right-click, Layers row `Rename`, instance `Select layer`, main component rows | CLOSED | all nine context dumps the same size and rows (shape 200 x 653, text 200 x 653, multi 200 x 677, frame 200 x 749, instance 201 x 749, component 200 x 677, Layers row 200 x 677, page row 200 x 187, empty 200 x 218) |
| Page-row menu, Move to page, Delete page (fixture) | CLOSED | `Page 1` first: 200 x 187 with `Move up` |
| Actions palette default content | **OPEN** | see M9 |
| Vector edit secondary toolbar | CLOSED | 529 x 40 at (455,792), Move / Lasso / Paint / Bend / Cut / Erase / More / Close |
| Vector edit panel (Vector, Alignment, Mirroring, Corner radius, Fill, Stroke) | CLOSED | `vector-edit-mode`, `vector-edit-point-selected` (X 900, Y 300 enabled) 0 diffs |
| Vector edit More menu | **PARTLY** | 189 x 48 at (870,736); Shape builder / Variable width disabled in ours |
| Assets component grid, Resize handle | CLOSED | tiles at (73,125), (185,125), (73,257); handle at 295 |
| Page rows 224 x 24 buttons | CLOSED | `pages-add-page-rename` identical |
| Find colours / parent names | CLOSED | `find-filter-menu` 166 x 338 at (237,105) (live 167) |
| Shape handles (arc, star, polygon), 2 px path outline | CLOSED | on hover, as live |
| Gap badge size, padding badge | CLOSED | badge 10 right of its bar, 17 high |
| Hovered grid column outline, pills | CLOSED | the expanded `1fr` pill (grabber, label, chevron) and the 2 px column outline as live; row pill the same |
| Capture fixture: first page `Page 1`, a real Vector path | CLOSED | opens on `Capture`; the triangle at (900,300) |
| Tools promo / suggested, MCP, AI sparkle | WONTFIX | unchanged |
| Unselected top-level frame hover | UNVERIFIED | no live capture |

## Systematic differences

| # | Severity | Difference |
|---|---|---|
| S11 **[carry-over]** | low | Panel-anchored **list** menus (Horizontal / Vertical resizing, Gap, the child's Width) open 7-11 px above live and 2 px wider: width menu (1136,392) 168 x 129 vs live (1138,399) 166 x 129, height (1232,392) vs (1234,399), gap (1244,466) vs (1244,473), child width (1140,368) 164 x 129 vs (1142,379) 162 x 129. Round 9 had them "CLOSED, 1-9 px"; unchanged. Files: `ds/components/Select*`, `panels/design/Layout.tsx`. |
| S12 **[carry-over]** | low | Text metrics: the key glyphs of the context menus sit 3 px off live in rows that start with ⌥ (153 vs 150) or end in a letter (176 vs 179); the Preferences row `Use ⌘⌥↑/↓ to rotate layers` is 150 vs 154 wide; Vector submenu 195 vs 198; Edit 189 vs 190; instance context menu 201 vs 203. Same cause as round 9 (fallback face for the glyphs). |

## Design panel, by state

Appendix A lists every state. Resting states are identical within +-2 px apart from the entries below (hidden accessibility text and wrapper rows aside).

- **[OPEN]** *(med)* **Instance of a component without auto layout** (`variant-instance`, the Chip instance): live shows `Layout` > `Dimensions` directly (Dimensions at y=350, no Flow row, no `Use auto layout`); ours draws `Use auto layout` (208,314), `Flow` and four radios (Freeform checked) at 350 and pushes every section below 48 px lower (Appearance 501 vs 453, Fill 604 vs 556, Export 812 vs 764).
- **[OPEN]** *(low-med)* **Instance of an auto layout component** (`instance` = Button instance, `nested-instance-parent` = Card instance): live shows the five Flow radios (Freeform, Vertical, Horizontal, Grid) and Wrap **DISABLED**; ours enables them. (Nested instance is closed.)
- **[OPEN]** *(low)* **Mixed selection with a frame** (`mixed-multi`: Rect + Ellipse + Text + F_frame): live disables Width and Height (value `Mixed`); ours leaves them enabled.
- **[OPEN]** *(low)* **Text edit mode header**: live while editing shows `[text-edit-hyperlink]` at 152, `Apply variable` at 180, `Create component` at 208 and no More actions; ours keeps the resting header (Create link 124, Apply variable 152, Create component 180, More actions 208). The caret / partial selection state itself (enter with Enter selects all text in ours; live: double click, caret at the end) is not comparable.
- **[OPEN]** *(low)* `autolayout-advanced-settings` popover: the `Between` option is #ffffff66 in live (it only applies with Auto gap) and white in ours; Inside stroke shows `Included` in live, `Excluded` in ours (the live frames were created by the plugin API; new frames' default **unverified**).
- **[OPEN]** *(low)* Type settings: Paragraph spacing / Paragraph indent boxes are 72 x 24 at x=152 in ours, 63 x 24 at 161 in live; `Underline details` is enabled in live and disabled in ours, `No truncation` is disabled in live and enabled in ours; **Details** tab: long feature names wrap to two lines in live (`r curves into round neighbors` 100 x 29, `Disambiguation without slashed zero` 125 x 29) and stay on one line in ours, so every row below sits 17 px higher (Character variants 1034 vs 1051, More features 1524 vs 1541); OpenType features the font lacks are #ffffff66 in live (Hanging punctuation, Case-sensitive forms, Slashed zero, Rare ligatures, Open digits, Alternate one…) and #ffffffb2 in ours (font dependent).
- **[OPEN]** *(low)* Layout guide Columns settings: Count 136 x 24 at x=88 vs live 127 x 24 at 96, Offset / Gutter 136 x 24 at 88 vs live 120 x 24 at 103; the `Width` disabled field shows `Auto` in live.
- **[CLOSED, fixture]** `frame-child-constraints`, `rectangle-with-export`, `individual-corners`, `frame-with-layout-guide`, `autolayout-individual-padding`: the live offsets come from earlier edits (see caveats). Component fills (`Solid color hex: FFB200 / E6E6E6 / 99E5E5` live vs `FFC700 / E5F4FF` ours), the Chip variant's corner radius (8 vs 20) are fixture values.
- **[CLOSED]** Components: name, Properties rows, Create property menu, Variant panel, Instance header, apply buttons, instance swap picker, variant dropdown (`variant`, `variant-instance` aside from the Flow row above).
- **[CLOSED]** Constraints, Individual corners, strokes, effects, export, Selection colors, grid child, Line / Arrow captions, Vector edit.
- **[WONTFIX]** *(MCP / agents)* Page with nothing selected: `MCP` section, `Figma MCP in Claude`, `Set up agents for Figma MCP`; `[Apply variable mode]` needs a collection (the capture fixture has none, `doc=variables` verified in r8).

## Popovers and menus opened from the Design panel

Appendix B has every case. Placement and size, live -> ours (only the entries that differ):

| Popover | Live | Ours | Status |
|---|---|---|---|
| Width / Height sizing, Gap, child Width menus | (1138,399) 166 x 129 / (1234,399) / (1244,473) 156 x 64 / (1142,379) 162 x 129 | (1136,392) 168 x 129 / (1232,392) / (1244,466) / (1140,368) 164 x 129 | **[OPEN]** *(low)* S11 |
| Typography styles | (984,427) 216 x 165 | (984,586) | **[OPEN]** *(low)* live's y does not follow from its anchor |
| Font size list | 96 x 437 at (1312,455) | 96 x 400 at (1312,454) | **[OPEN]** *(low)* a trailing 80 x 20 block whose purpose the capture does not show |
| Fill picker Solid / Pattern / Image / Video / Libraries | 240 x 537 / 522 / 577 / 353 / 203 | identical | **[CLOSED]**; text differences: the percent sign is #ffffffb2 in live and white in ours (Color row, `%`); Libraries tab `No colors available` at y=157 vs ours 143 and the Variable set button 92 x 24 vs ours 87 x 24; Pattern `Select source…` text at x=89 vs ours 79; Image `Make an image` disabled (AI) |
| Fill picker Gradient | stop colour field 58 x 24 at x=93, opacity field 32 x 24 at 152, `Delete gradient stop` enabled with two stops, `Paint type` box 96 x 32 | 55 x 24 at 97, 38 x 24 at 153, Delete disabled with two stops, 96 x 24 | **[OPEN]** *(low)* |
| Shader fills / effects browser (240 x 510 at (719,307) / (959,374)) | rows and tiles: `Created by you` y=95, `Create new` 229, `By Figma` 257, first tile row 389 | 85, 217, 247, 379 (10-12 px higher); **every one of the 25 tiles is `DISABLED`**, `Create with agents` disabled | **[OPEN]** *(low for the rows; med: tiles = shader paints / effects are not built)* |
| Gradient type menu, swatch set menu | no menu in live's captures (the first catches the Shader tab, the second the plain picker) | 112 x 112 at (967,392), 224 x 40 at (967,724) | **UNVERIFIED** |
| Background blur settings | 240 x 156 (Progressive) | Uniform 240 x 124; Progressive 240 x 156 | **[CLOSED]** (state) |
| Layer blur Progressive | 240 x 156 | 240 x 156 | **[CLOSED]** |
| Stroke settings | `Solid` style text at x=129 | x=120 | **[OPEN]** *(low)* live likely draws a dash glyph first |
| Auto layout settings | (960,481) 240 x 345 | (960,480) | **[CLOSED]**; see Design panel for `Between` / Included |
| Layout guide settings (Grid, type menu) | 240 x 128 at (960,756), list 110 x 88 at (968,792) | identical | **[CLOSED]**; `Layout guide type` title hidden; Width 120 x 24 vs 98 x 24 + Apply variable 20 x 22 outside the field |
| Create slot property | **304 x 626 at (896,121)**: Name `Slot`, Description (rich text editor with 9 toolbar toggles), Settings (Minimum / Maximum layers, Only allow preferred instances, By default display empty slot, By default fill items on slot's counter axis, `Slot must have auto layout`), Preferred instances + Learn more, `Create property` | **240 x 164 at (960,124)**: "Create slot property", a name field, "Apply it to a frame inside the component.", Create | **[OPEN]** *(med)* feature gap: see "Lacks entirely" |
| Font picker | list of Google fonts around Inter (Ingrid Darling … Jaro, 28 rows) | one row (`Inter`) in the headless web build | **[CLOSED on desktop, re-check ba7ed56]** a web-build artefact: the headless build has no font index; the desktop path (`src/main/fonts.ts` index + `src/main/googleFonts.ts` Google Fonts catalogue, round 5) lists every installed family and the whole catalogue; the Electron picker itself was not run (**unverified**) |
| Export, layout guide, instance popovers, Create property, Component configuration, constraint menus, Frame presets, Boolean, blend, individual strokes, effect type menu | identical +-1 | | **[CLOSED]** |

## Menus

Appendix C has every dump: coordinates and sizes, live -> ours.

- **[CLOSED]** Figma menu 194 x 444 at (12,44); File 198 x 324, Edit 189 vs 190, View 201 x 787 at (210,108) vs (210,105) (3 px lower), Text 199 x 379, Arrange 220 x 533, Plugins 181 x 122, Widgets 152 x 64, Preferences 235 x 763, Help 178 x 249, View > Panels 173 vs 174 at (415,557) vs (416,554); every item text present with live's wording, nothing missing or extra. **[OPEN]** *(low)* Object 185 x 889 vs live 1050 (clamped to the window), Vector 195 vs 198 (S12).
- **[CLOSED]** Context menus: sizes and rows of all nine dumps as live (see the re-check table). Remaining *(low)*: (a) disabled in ours where live is enabled: **Flatten on an instance** (ours disabled, live enabled), Send to Figma Make, Find similar designs, Add motion, Rename layers (AI; intended exclusions); `Outline stroke` is a state (the live Rect had a stroke); (b) in headless runs one row of a freshly opened menu is lit with `#ffffffcc` keys (`Paste to replace` ⇧⌘R in the shape and text menus, `Show/Hide` ⇧H in the Layers row menu) and the multi-selection menu opened with its `Copy/Paste as` submenu (200 x 177) beside it: **unverified** whether it comes from the pointer's position; live's dumps show no lit row.
- **[OPEN]** *(low, state)* Figma menu items disabled in ours on `?editor` (no file source): New Design, Duplicate, Save local copy…, Save to version history… (⌥⌘S), Show version history, Create branch…; Undo (no history), Find next / previous (no search), Zoom to selection (no selection). Intended exclusions as before: Open in desktop app, Manage plugins…, Manage widgets…, Select all widgets, Color profile…, Keyboard layout…, Accessibility settings…, Permissions and helpers…, Open font settings, Account settings, Log out, Text on path.
- **[CLOSED]** Bottom toolbar: group at (456,840) 529 x 48, all six dropdowns identical (Move tools 151 x 72 at (497,764), Region tools 150 x 72 at (554,764), Shape tools 196 x 168 at (611,668), Creation tools 142 x 48 at (668,788), Type tools 142 x 48 at (725,788), Comment tools 186 x 72 at (782,764)).
- **[OPEN]** *(low)* **M7** the dropdown's lit row: live lights the slot's own tool (its key #ffffffcc: `F` Frame in Region tools, `R` in Shape tools, `P` in Creation tools, `T` in Type tools, `C` in Comment tools) whatever tool is active; ours lights only the active tool's row (`V` in Move tools matches because Move is active), the others' keys are #ffffffb2.
- **[OPEN]** *(med)* **M9** Actions palette (529 x 354 at (456,478), search 431 x 32, tabs, `Visual search (AI beta)` at (491,12): geometry identical): with no Recents ours falls back to the command list (File: Back to files, New Design, Place image/video…, Duplicate…); live lists **Recents** (Translate to…, Lorem Ipsum — by ‹div›RIOTS, Rewrite this…, with `tab` and AI badges), **Image editing** (Make an image, Remove background, Boost resolution, Edit image with prompt), **Design tools** (Rename layers, Replace content, Add interactions), **Riffing and writing** (Shorten…) and the status line "11 results available." above "Results will update as you type." (ours 3 px lower: (-1,6) vs (-1,3)). Most of live's list is AI; the Recents block is not (ours has it, it is empty on a fresh load: live's own default with no recents is **unverified**).
- **[OPEN]** *(low)* **M10** Vector editing tools menu (189 x 48 at (870,736), live (869,736)): `Shape builder` M and `Variable width` ⇧W are listed disabled (#ffffff66): Figma Draw's tools are not built.

## Left side

- **[CLOSED]** Rail (Main menu 32 x 32 at (12,8), items and labels), Assets (header, Libraries, search, cards, "Created in this file" card, Back row, tiles at (73,125) / (185,125) / (73,257), names 6 under, variant dots, Resize handle 8 x 900 at (295,0)), Pages add and inline rename (identical), Find (scope, results, filter menu 166 x 338), Layers rows (hover, selected + hover). Residual (fixture / dumper): first card "5 components" vs "6", the page list of "Created in this file" has one page (live also `Page 1` with a component `Rectangle 1`), ours' layer order differs (the fixture's z-order), layer glyph boxes 16 x 16 in ours vs 16 x 10 / 10 x 10 measured in live (an svg's own box).
- **[WONTFIX]** Tools: live's promo ("More AI image tools to explore"), `Suggested` plugins and shaders; ours says plugins, widgets and shaders are not part of this app. `Filter by price and type` is enabled in live and disabled in ours (low). Header (Tools + Create), search and the Source 79 / Category 91 filters match.
- **[OPEN]** *(med-low)* **Variables empty state** (live `rail-variables-full-view`: a file with no collection): the title `Variables` (13 / 450 at (322,16)), the Minimize toggle at (1339,12), the centre text "No variables created in this file" (15 / 550 at (759,414)), "Save colors, numbers, text, and states to reuse them in styles, prototypes, and across files." with a `Learn more →` link, and two buttons `Create` (blue, 71 x 24 at (794,491)) and `Import` (71 x 24 at (873,491)); the left panel shows only `Collections` (11 / 600) with Collections options and Create collection. Ours: no title, a search box and filter at the top right, a centred glyph, "Create your first collection", "Variables store reusable values — …" and one `Create collection` button, no Import.
- **[CLOSED]** Variables table (collections with counts, Groups, Create variable, columns, modes): same structure; the file-name header shows the document's name (`Variables and styles` on `doc=variables`), ours draws a settings glyph at the right of every row (known), the selected collection has no highlight bar where live's `Tokens` row does *(low)*, the search sits at 1127 in both.

## Canvas (screenshots vs `live/img/canvas-*`)

- **[CLOSED]** rect selected (handles, `120 × 90` pill) and hovered (4 radius rings), ellipse arc handle, star (3) and polygon (2) handles, rotated star, group, section label, hover outline (2 px), auto layout selected (title blue, `</>`, padding / gap bars), gap hover (pink `10` badge 10 right of its bar), padding hover badge, auto layout child, grid frame (cells, mid-edge bars), column pill hover (`||| 1fr ▾`, the column's 2 px outline), row pill hover, compact pills, top pill, main component (purple title, `</>`, purple handles), text edit box and partial selection, layout guide (live's capture used a Columns guide, ours the default Grid guide: not comparable).
- **[OPEN]** *(med)* **Component set selected**: live draws a purple pill reading `3 Variants` (not the size) with a `+` (Add variant) button under it, `</>` and a title row (`❖ Chip`) plus a pink box for each gap between variants; ours draws the dashed set outline and the size pill `364 Hug × 40` only, no `+`, no `</>`.
- **[OPEN]** *(low-med)* **Hovered text layer**: live draws a 2 px blue **baseline underline** under the text (and keeps one while a selected text is hovered); ours draws a 2 px outline box around it (`canvas-text-hover-baseline-underline`; the README of the live captures lists the underline). No baseline underline exists in `Overlay.cpp`.
- **[OPEN]** *(low)* **Selected top-level instance** (`canvas-instance-selected`): live shows no title above it (only the purple outline, handles and the `95 Hug × 44 Hug` pill); ours draws `◇ Button instance`. The unselected state has no live capture (**unverified**).
- **[OPEN]** *(low)* Selection centre marks: live shows tiny light dots (about 2 px) at the centres of the selected shapes in a group or a multi-selection; ours draws 5 px magenta rings there.
- **[UNVERIFIED]** *(low)* arrow / line selected: live draws the 1 px blue line over the black stroke (`120 × 0` pill); ours' blue line is not visible over the stroke in the DPR 1.5 shot (needs a GPU shot at DPR 2).
- **[UNVERIFIED]** unselected-frame hover (no live capture).
- **Unchanged**: the pixel grid from 300 % zoom.

## Anything live shows that ours lacks entirely

1. **Slots**: `Create property` > `Slot` opens a full form (Name, rich-text Description, Minimum / Maximum layers, Only allow preferred instances, display empty slot, fill counter axis, Preferred instances) in live (`component-create-slot-property.txt`, 304 x 626); `component-with-slot` and `instance-with-slot` (the Slot layer, its icon in the Layers panel, the Slot row in the instance panel) could not be reproduced. Ours: a 240 x 164 stub (med).
2. **Shader fills and effects**: the Fill picker's Shader tab and the Effects "+" browser list 25 presets (Moving gradient, Mesh gradient, Nebula, Water caustic, Fractal noise, Clouds, Moire, Glowing wave, Concentric patterns, Pattern grid…) that live applies; every tile is disabled in ours (med; the schema has no shader paint yet).
3. **Fonts** *(CLOSED on desktop, re-check ba7ed56: the one row is the headless web build's missing font index; desktop lists installed families + the Google catalogue)*: the font picker lists the Google fonts catalogue around the current family (28 rows visible, `Font set`, Popular / Google / Variable / Uploaded by you / Installed by you filters).
4. **Component set overlay**: the `3 Variants` pill and `+` button (med).
5. **Text hover underline** (low-med).
6. **Figma Draw**: Shape builder, Variable width (listed disabled); the Draw toolbelt's own toolbar and panel (not captured live either besides the toggle).
7. **Variables empty state** wording / Import button (med-low).
8. **Actions**: live's Recents + AI sections (mostly AI).
9. MCP, AI actions (Rename layers, Visual search, Make an image, Create with agents), plugins, widgets, Make, Dev Mode annotation tools: intended exclusions.

## Re-check on main ba7ed56 (2026-10-09; every OPEN / PARTLY / NEW item)

`main` is `ba7ed56`; the only difference from the measured `85cbb5c` is this file (`git diff --stat 85cbb5c..HEAD`: 1 file), so no code changed since the sweep and every number above still holds. Re-verified on top of that: headless Chrome 1440 x 900 dark against `vite --mode demo` (port 5701, `?editor&doc=capture`, panel dump with `live/tools/dumpPanel.js`) for the instance Flow rows (below), and by reading the code for the canvas, popover and toolbar items (`engine/src/render/Overlay.cpp` has no `Variants` pill and no baseline underline; hover goes through `nodeOutline`; `Component.tsx` still has the "Apply it to a frame" stub; `Effects.tsx` lists `SHADER_PRESETS` / `SHADER_FILL_PRESETS` as names only; the schema has no shader paint or effect). **No item of the sweep was fixed by round 8-10 beyond what the "Round 9 re-check" table already marks CLOSED.** The only change in status: **Font picker is CLOSED on desktop** (web-build artefact).

Status per item, with the numbers measured now:

| # | Item | Status | Now (live -> ours) |
|---|---|---|---|
| R1 | Instance of a non-auto-layout component (Chip instance): Flow row | **OPEN** (verified headless) | live: `Layout` > `Dimensions` at y=350, no `Use auto layout`, no Flow; ours: `Use auto layout` (208,314), `Flow` at 350, `Freeform` CHECKED at (16,366), `Dimensions` at 398 (48 px lower) |
| R2 | Instance of an auto layout component (Button instance, Card instance): Flow radios | **OPEN** (verified headless) | live: Freeform / Vertical / Horizontal / Grid radios and Wrap DISABLED (`instance.txt` 16,430 and 208,430); ours: the radio is enabled (`radio [Freeform]` without DISABLED, Wrap enabled) |
| R3 | Mixed selection with a frame: Width / Height | **OPEN** | live DISABLED with value `Mixed`; ours enabled (`Layout.tsx` `sizeLocked` does not cover a mixed selection with a frame) |
| R4 | Text edit header | **OPEN** | live: `[text-edit-hyperlink]` 152, `Apply variable` 180, `Create component` 208, no More actions; ours Create link 124, Apply variable 152, Create component 180, More actions 208 |
| R5 | Auto layout settings: `Between` dim, Inside stroke `Included` | **OPEN** | `Between` #ffffff66 in live (only with Auto gap), white in ours; stroke default `Included` live vs `Excluded` ours (new frames' default unverified) |
| R6 | Type settings | **OPEN** | Paragraph spacing / indent boxes 63 x 24 at x=161 live vs 72 x 24 at 152; `Underline details` enabled live / disabled ours; `No truncation` disabled live / enabled ours; Details tab: long feature names wrap to 2 lines (100 x 29, 125 x 29) live vs 1 line ours (rows below 17 px higher: Character variants 1034 vs 1051, More features 1524 vs 1541); features the font lacks #ffffff66 live vs #ffffffb2 ours (font dependent) |
| R7 | Layout guide Columns settings | **OPEN** | Count 127 x 24 at x=96 live vs 136 x 24 at 88; Offset / Gutter 120 x 24 at 103 vs 136 x 24 at 88; `Width` disabled shows `Auto` |
| R8 | Fill picker Gradient | **OPEN** | stop colour 58 x 24 at x=93 / opacity 32 x 24 at 152 / `Delete gradient stop` enabled with two stops / `Paint type` box 96 x 32 live; ours 55 x 24 at 97 / 38 x 24 at 153 / Delete disabled / 96 x 24 |
| R9 | Fill picker details: percent sign colour, Libraries tab (`No colors available` y=157 vs 143, Variable set button 92 x 24 vs 87 x 24), Pattern `Select source…` x=89 vs 79, Stroke settings `Solid` text x=129 vs 120 | **OPEN** (low) | as listed |
| R10 | Panel-anchored list menus (S11) | **OPEN** | width menu (1138,399) 166 x 129 live vs (1136,392) 168 x 129; height (1234,399) vs (1232,392); gap (1244,473) vs (1244,466); child width (1142,379) 162 x 129 vs (1140,368) 164 x 129 |
| R11 | Typography styles popover y | **OPEN** | (984,427) 216 x 165 live vs (984,586) |
| R12 | Font size list | **OPEN** | 96 x 437 at (1312,455) live vs 96 x 400 at (1312,454) (live has a trailing 80 x 20 block) |
| R13 | Create slot property popover | **OPEN** (med) | live 304 x 626 at (896,121): title `Create property`, Name input `Slot` (272 x 24 at 16,72), Description rich-text editor (272 x 155 at 16,128, placeholder `How to use this slot`, toolbar of 9 24 x 24 toggles at y=250: Bold ⌘B, Italic ⌘I, Strikethrough ⌘⇧X, Header 1, Bulleted list, Ordered list, Link ⌘⇧U, Code ⌘⇧C, Code block ⌘⇧⌥C), `Settings` (16,310), Minimum layers / Maximum layers (120 x 24 fields at x=168, y=336 / 372), checkboxes `Only allow preferred instances` (412), `By default, display empty slot` (448), `By default, fill items on slot's counter axis` (480, disabled #ffffff66 unless the slot has auto layout, with an info icon), `Preferred instances` + `Learn more` + `+` (272,545 "Select preferred values"), blue `Create property` button 100 x 24 at (188,594), Close at (272,8); ours 240 x 164 at (960,124): "Create slot property", a name field, "Apply it to a frame inside the component." (`panels/design/Component.tsx` ~l.1138), Create. The settings fields (min / max, preferred only, empty, fill counter axis) already exist for a created slot (`updateSlotSettings`); the form must collect them first and create the property with them |
| R14 | Shader fills / effects | **OPEN** (med-hard; not buildable in a panel-only change) | all 25 effect tiles + 10 fill tiles are disabled name lists (`Effects.tsx` `SHADER_PRESETS`, `SHADER_FILL_PRESETS`); the schema has no shader paint / effect; browser rows 85 / 217 / 247 / 379 vs live 95 / 229 / 257 / 389; `Create with agents` disabled (AI, stays) |
| R15 | Font picker | **CLOSED on desktop** | web-build artefact (no font index in the headless build); desktop = system index + Google catalogue (`src/main/fonts.ts`, `src/main/googleFonts.ts`); Electron picker not run (**unverified**) |
| R16 | Object submenu | **OPEN** (low) | 185 x 1050 at (210,6) live vs 185 x 889 ours (clamped to the window; live's menus run past the window) |
| R17 | S12 text metrics of key glyphs | **OPEN** (low) | ⌥-rows 153 vs 150, letter-ending rows 176 vs 179, Preferences row 150 vs 154, Vector submenu 195 vs 198, Edit 189 vs 190, instance context menu 201 vs 203 |
| R18 | Flatten on an instance | **OPEN** (low) | live enabled, ours disabled |
| R19 | Toolbar dropdown lit row (M7) | **OPEN** (low) | live lights the slot's own tool (key #ffffffcc: `F` Region, `R` Shape, `P` Creation, `T` Type, `C` Comment) whatever tool is active; ours only the active tool's row |
| R20 | Actions palette default content (M9) | **OPEN** (med) | live: status line `11 results available.` above `Results will update as you type.` (ours 3 px lower, (-1,6) vs (-1,3)), Recents block, Image editing / Design tools / Riffing and writing (AI: skip); ours falls back to the command list (File: Back to files, New Design, Place image/video…, Duplicate…) when no Recents exist |
| R21 | Vector edit More menu (M10) | **OPEN** (low, hard) | `Shape builder` M and `Variable width` ⇧W listed disabled (Figma Draw tools not built) |
| R22 | Variables empty state | **OPEN** (med-low) | live: title `Variables` (13 / 450 at (322,16)), Minimize toggle (1339,12), "No variables created in this file" (15 / 550 at (759,414)), "Save colors, numbers, text, and states to reuse them in styles, prototypes, and across files." + `Learn more →`, buttons `Create` (blue, 71 x 24 at (794,491)) and `Import` (71 x 24 at (873,491)); left panel only `Collections` (11 / 600); ours: no title, a search box and filter, a glyph, "Create your first collection", one `Create collection` button, no Import |
| R23 | Variables selected collection highlight; per-row settings glyph; Tools `Filter by price and type` enabled in live | **OPEN** (low) | live's `Tokens` row has the highlight bar; ours none; ours draws a settings glyph on every row; Filter by price and type disabled ours |
| R24 | Canvas: component set selected | **OPEN** (med; verified in the live shot `canvas-component-set-selected.png`) | live: purple pill `3 Variants` (not the size) at the bottom centre with a purple `+` (Add variant) button under it, titles `❖ Chip` / `❖ Card` plus `</>` on the top row, pink boxes in each gap between variants; ours: dashed outline and the size pill `364 Hug × 40`, no `+`, no `</>`, no gap boxes. `Overlay.cpp` has no variants pill |
| R25 | Canvas: hovered text baseline underline | **OPEN** (low-med; verified in `canvas-text-hover-baseline-underline.jpg`) | live: 2 px blue line under the text's baseline across its width (kept while a selected text is hovered); ours: `nodeOutline(h, hoverWidth, true)` draws the 2 px box |
| R26 | Canvas: selected top-level instance title | **OPEN** (low; live shot `canvas-instance-selected.png` shows none, verified in ours headless: `◇ Butto…` drawn above the selected Button instance at (430,447)) | live: purple outline, handles and the `95 Hug × 44 Hug` pill only; unselected instances do show a title in live's hover shot (`❖ Button`), so hide the title only while the instance is selected (the unselected state of an *instance* is **unverified**) |
| R27 | Canvas: selection centre marks | **OPEN** (low) | live ~2 px light dots at the centres in a group / multi-selection; ours 5 px magenta rings |
| R28 | Gradient type menu / swatch set menu; grid row track menu anchored by the pill; unselected top-level frame hover; arrow / line blue line at DPR 2 | **UNVERIFIED** | no live capture; stays |
| R29 | Figma menu items disabled on `?editor`; headless-lit row in a freshly opened context menu | **OPEN / UNVERIFIED** (state) | need the Electron app (file source) to verify |
| R30 | MCP / AI items (Tools promo, Suggested, MCP section, AI sparkle, Rename layers, Visual search, Make an image, Create with agents) | **WONTFIX** | unchanged |

## Fix groups (open items after the re-check on ba7ed56)

Four groups with disjoint file sets, to run in parallel. Live wins; where live has no data (help.figma.com), mark the point **unverified** in the docs.

1. **canvas-chrome** (engine C++, medium): R24 component set overlay (`N Variants` pill, `+` button, `</>`, variant titles, pink gap boxes), R25 text hover baseline underline, R26 no title on a selected top-level instance (title back when unselected), R27 selection centre dots. Files: `engine/src/render/Overlay.cpp`, `engine/src/render/FrameTitles.cpp`, `engine/src/hit/*` (the `+` button's hit-test and the Add variant command), `engine/tests`, `src/renderer/src/engine` bindings only if a new overlay field is needed. Shots: `?engine`, `live/img/canvas-component-set-selected.png`, `-text-hover-baseline-underline.jpg`, `-instance-selected.png`.
2. **design-panel** (no engine, medium): R1, R2 (`panels/design/Layout.tsx`, `shared.ts`), R3, R4 (`Header.tsx`, text edit header), R5 (`AutoLayout*.tsx`), R6 (`TypeSettings*`), R7 (layout guide popover), R8, R9 (`ds/components/ColorPicker.tsx`, `Stroke*.tsx`), R10 (`ds/components/Select*`), R11, R12 (typography styles / font size list popovers). Must not touch `Effects.tsx`'s `ShaderEffects` / `SHADER_*` or `Component.tsx` (the features group owns them).
3. **menus-left-toolbar** (no engine, low-medium): R16 (Object submenu not clamped), R17 (key glyph metrics in `ds/components/Menu*`), R18 (Flatten on an instance: `editor/commands.ts`), R19 (`canvas/BottomToolbar.tsx`), R20 (`panels/ActionsPanel.tsx`: status line, Recents, 3 px), R22, R23 (`panels/variables/*`), R21 only if Shape builder / Variable width are built (hard; otherwise leave), verify R29 in the Electron app.
4. **features** (engine + schema, hard): R13 the Create slot property form per live (304 x 626, `Component.tsx` + `Component.module.css`, a rich-text Description field stored as the property's description, then the settings into the SLOT def: no engine change, medium); R14 shader fills and effects (schema paint / effect type, engine runtime on the WebGL2 / WebGPU backends, the ten fill and 25 effect presets with their parameters, `Effects.tsx` tiles enabled and browser rows 10 px lower: out of reach as a panel change; prefer building, split off from R13 when the round is short; Figma documents shaders as WebGPU-only, so the WebGL2 backend may draw a fallback). No live data for the shaders' parameters: take names and defaults from the live popovers (`effects-add-shader-effects.txt`, `fill-picker-custom.txt`) and mark the rest **unverified**.

## Appendix A: Design panel, live vs ours (counts after filtering hidden accessibility text, wrapper rows and the swatch lists; the large ones are live captures taken after earlier edits, which shift every row below the edit: autolayout-individual-padding, frame-child-constraints, frame-with-layout-guide, variant-instance, component-set, rectangle-with-export, rectangle-individual-corners; `component-with-slot` and `instance-with-slot` not reproduced)

| Design state | missing | diff | extra |
|---|---|---|---|
| arrow | 2 | 0 | 1 |
| autolayout-child | 0 | 2 | 2 |
| autolayout-grid | 0 | 2 | 2 |
| autolayout-horizontal | 1 | 0 | 2 |
| autolayout-individual-padding | 6 | 90 | 8 |
| autolayout-parent-fixed | 1 | 2 | 2 |
| autolayout-vertical | 1 | 0 | 2 |
| autolayout-wrap | 2 | 1 | 2 |
| boolean | 0 | 0 | 0 |
| component | 2 | 0 | 2 |
| component-set | 6 | 15 | 27 |
| ellipse | 0 | 0 | 0 |
| frame | 0 | 0 | 0 |
| frame-child-constraints | 10 | 35 | 3 |
| frame-child-constraints-expanded | 2 | 0 | 6 |
| frame-with-layout-guide | 6 | 75 | 6 |
| grid-autolayout-settings | 1 | 0 | 1 |
| grid-child | 6 | 2 | 2 |
| grid-dimensions-picker | 0 | 0 | 0 |
| group | 0 | 0 | 0 |
| image-fill | 0 | 1 | 2 |
| instance | 2 | 5 | 2 |
| line | 2 | 0 | 1 |
| mixed-multi | 8 | 3 | 0 |
| multi-two-shapes | 0 | 0 | 0 |
| nested-instance | 2 | 0 | 0 |
| nested-instance-parent | 1 | 5 | 2 |
| page-nothing-selected | 5 | 0 | 0 |
| polygon | 0 | 0 | 0 |
| rectangle | 0 | 0 | 0 |
| rectangle-individual-corners | 14 | 6 | 0 |
| rectangle-with-effect | 0 | 1 | 1 |
| rectangle-with-export | 15 | 14 | 1 |
| rectangle-with-stroke | 0 | 0 | 0 |
| row-track-selected-panel | 0 | 0 | 41 |
| section | 0 | 0 | 0 |
| star | 0 | 0 | 0 |
| text | 8 | 1 | 0 |
| text-editing-caret | 8 | 3 | 2 |
| text-editing-partial | 8 | 3 | 2 |
| variant | 1 | 2 | 2 |
| variant-instance | 5 | 31 | 10 |
| vector | 0 | 0 | 0 |
| vector-edit-mode | 0 | 0 | 0 |
| vector-edit-point-selected | 0 | 0 | 0 |

## Appendix B: popovers opened from the Design panel (live vs ours, popup coordinates and entry counts)

Counts are lines of the filtered diff: `missing` = live text / control not found in ours, `diff` = found but position / size / font / colour / state differs, `extra` = ours with no live match (wrapper rows excluded). Popups are listed in the live dump's order, `EXTRA` = a popup ours opens that live's capture has not.

| Popover | popups live → ours | missing | diff | extra |
|---|---|---|---|---|
| autolayout-advanced-settings | @960,481 240x345 -> @960,480 240x345 | 2 | 1 | 1 |
| autolayout-child-width-menu | @1142,379 162x129 -> @1140,368 164x129 | 0 | 0 | 4 |
| blend-mode-menu | @1315,472 118x555 -> @1315,471 117x555 | 0 | 0 | 0 |
| boolean-operations-menu | @1253,129 151x120 -> @1254,128 150x120 | 0 | 0 | 0 |
| component-configuration | @880,81 320x317 -> @880,80 320x317 | 0 | 0 | 1 |
| component-create-property-menu | @1277,161 156x207 -> @1276,160 156x207 | 0 | 0 | 0 |
| component-create-slot-property | @896,121 304x626 -> @960,124 240x164 | 16 | 3 | 4 |
| constraint-horizontal-menu | @1208,280 126x136 -> @1208,279 125x136 | 0 | 0 | 0 |
| constraint-vertical-menu | @1208,312 136x136 -> @1208,311 135x136 | 0 | 0 | 0 |
| effect-settings-background-blur | @959,660 240x156 -> @959,660 240x124 | 1 | 2 | 2 |
| effect-settings-drop-shadow | @959,660 240x224 -> @959,660 240x224 | 1 | 0 | 4 |
| effect-settings-glass | @959,571 240x313 -> @959,571 240x313 | 0 | 0 | 7 |
| effect-settings-inner-shadow | @959,660 240x224 -> @959,660 240x224 | 1 | 0 | 4 |
| effect-settings-layer-blur | @959,660 240x124 -> @959,660 240x124 | 0 | 0 | 1 |
| effect-settings-layer-blur-progressive | @959,660 240x156 -> @959,660 240x156 | 0 | 0 | 3 |
| effect-settings-noise | @959,660 240x224 -> @959,660 240x224 | 1 | 0 | 3 |
| effect-settings-texture | @959,660 240x213 -> @959,660 240x213 | 0 | 0 | 2 |
| effect-styles | @984,719 216x165 -> @984,719 216x165 | 0 | 1 | 1 |
| effect-type-menu | @967,449 147x207 -> @967,449 147x207 ; @959,660 240x224 -> @959,660 240x224 | 1 | 1 | 11 |
| effects-add-shader-effects | @959,374 240x510 -> @959,374 240x510 | 0 | 3 | 0 |
| export-advanced-settings | @960,700 240x184 -> @960,700 240x184 | 0 | 0 | 0 |
| export-format-menu | @1290,764 92x112 -> @1290,765 92x112 | 0 | 0 | 0 |
| fill-picker-color-format-menu | @967,672 87x136 -> @967,672 87x136 ; @959,307 240x537 -> @959,307 240x537 | 7 | 6 | 0 |
| fill-picker-custom | @719,307 240x510 -> @719,307 240x510 ; @959,307 240x353 -> @959,307 240x353 | 5 | 16 | 1 |
| fill-picker-gradient-type-menu | EXTRA @967,392 112x112 ; @719,307 240x510 -> @719,307 240x510 ; @959,307 240x297 -> @959,307 240x297 | 9 | 22 | 9 |
| fill-picker-gradient_linear | @719,307 240x510 -> @719,307 240x510 ; @959,307 240x297 -> @959,307 240x297 | 9 | 22 | 5 |
| fill-picker-image | @959,307 240x577 -> @959,307 240x577 | 5 | 2 | 8 |
| fill-picker-libraries-tab | @959,307 240x203 -> @959,307 240x203 | 4 | 2 | 1 |
| fill-picker-pattern | @959,347 240x522 -> @959,347 240x522 | 8 | 2 | 3 |
| fill-picker-solid | @959,347 240x537 -> @959,347 240x537 | 7 | 4 | 0 |
| fill-picker-swatch-set-menu | EXTRA @967,724 224x40 ; @959,307 240x537 -> @959,307 240x537 | 6 | 6 | 0 |
| fill-picker-video | @959,307 240x353 -> @959,307 240x353 | 4 | 1 | 1 |
| fill-styles-variables | @960,531 240x203 -> @960,530 240x203 | 4 | 2 | 1 |
| font-picker | @960,415 240x469 -> @960,415 240x469 | 28 | 1 | 2 |
| font-picker-filter-menu | @960,488 240x229 -> @960,488 240x229 ; @960,415 240x469 -> @960,415 240x469 | 28 | 1 | 2 |
| font-size-menu | @1312,455 96x437 -> @1312,454 96x400 | 0 | 0 | 0 |
| font-weight-menu | @1208,575 167x313 -> @1208,574 168x314 | 0 | 0 | 0 |
| frame-presets-menu | @1208,125 222x1887 -> @1208,124 222x1887 | 0 | 1 | 10 |
| gap-menu | @1244,473 156x64 -> @1244,466 156x64 | 0 | 0 | 2 |
| height-sizing-menu | @1234,399 166x129 -> @1232,392 168x129 | 0 | 0 | 4 |
| instance-header-swap-menu | @1160,117 240x441 -> @1160,116 240x441 | 0 | 0 | 0 |
| instance-more-actions-menu | @1211,129 221x309 -> @1211,128 221x309 | 0 | 0 | 0 |
| instance-swap-property-picker | @1160,237 240x441 -> @1160,236 240x441 | 0 | 0 | 0 |
| instance-variant-dropdown | @1304,141 107x88 -> @1304,140 107x88 | 0 | 0 | 0 |
| layout-guide-settings-columns | @960,628 240x256 -> @960,628 240x256 | 8 | 3 | 6 |
| layout-guide-settings-grid | @960,756 240x128 -> @960,756 240x128 | 1 | 0 | 0 |
| layout-guide-styles | @984,719 216x165 -> @984,719 216x165 | 0 | 1 | 1 |
| layout-guide-type-menu | @968,792 110x88 -> @968,792 110x88 ; @960,756 240x128 -> @960,756 240x128 | 1 | 1 | 1 |
| stroke-advanced-settings | @960,660 240x224 -> @960,660 240x224 | 6 | 1 | 5 |
| stroke-individual-strokes-menu | @1315,539 117x159 -> @1315,538 117x159 | 0 | 0 | 1 |
| stroke-position-menu | @1208,678 105x88 -> @1208,677 105x88 | 0 | 0 | 0 |
| type-settings | @960,378 240x506 -> @960,378 240x506 | 9 | 5 | 5 |
| type-settings-details | @960,378 240x506 -> @960,378 240x506 | 54 | 59 | 21 |
| type-settings-variable | @960,378 240x506 -> @960,378 240x506 | 5 | 2 | 4 |
| typography-styles | @984,427 216x165 -> @984,586 216x165 | 0 | 1 | 1 |
| width-sizing-menu | @1138,399 166x129 -> @1136,392 168x129 | 0 | 0 | 4 |

## Appendix C: menus and toolbar (live popup coordinates vs ours; context menus open where they are clicked, so only their size is comparable)

| Menu / toolbar | popups live → ours | missing | diff | extra |
|---|---|---|---|---|
| context-component | @455,155 200x677 -> @602,215 200x677 | 0 | 11 | 0 |
| context-empty-canvas | @1013,614 200x218 -> @1013,614 200x218 | 0 | 0 | 0 |
| context-frame | @617,35 200x749 -> @618,143 200x749 | 0 | 9 | 0 |
| context-instance | @436,83 203x749 -> @645,143 201x749 | 0 | 13 | 0 |
| context-layer-row | @185,155 200x677 -> @175,215 200x677 | 0 | 11 | 0 |
| context-multi | EXTRA @862,287 200x177 ; @493,155 200x677 -> @658,215 200x677 | 0 | 7 | 15 |
| context-page-row | @131,146 200x187 -> @181,153 200x187 | 0 | 1 | 0 |
| context-shape | @358,179 200x653 -> @658,239 200x653 | 0 | 11 | 0 |
| context-text | @387,179 200x653 -> @648,239 200x653 | 0 | 8 | 0 |
| main-arrange | @210,246 220x533 -> @210,246 220x533 ; @12,44 194x444 -> @12,44 194x444 | 2 | 1 | 0 |
| main-edit | @210,150 190x581 -> @210,150 189x581 ; @12,44 194x444 -> @12,44 194x444 | 0 | 7 | 0 |
| main-file | @210,126 198x324 -> @210,126 198x324 ; @12,44 194x444 -> @12,44 194x444 | 0 | 8 | 0 |
| main-help | @210,448 178x249 -> @210,448 178x249 ; @12,44 194x444 -> @12,44 194x444 | 1 | 4 | 0 |
| main-menu | @12,44 194x444 -> @12,44 194x444 | 0 | 1 | 0 |
| main-object | @210,6 185x1050 -> @210,6 185x889 ; @12,44 194x444 -> @12,44 194x444 | 2 | 1 | 0 |
| main-plugins | @210,311 181x122 -> @210,311 181x122 ; @12,44 194x444 -> @12,44 194x444 | 1 | 2 | 0 |
| main-preferences | @210,132 235x763 -> @210,132 235x763 ; @12,44 194x444 -> @12,44 194x444 | 1 | 6 | 0 |
| main-text | @210,222 199x379 -> @210,222 199x379 ; @12,44 194x444 -> @12,44 194x444 | 2 | 1 | 0 |
| main-vector | @210,270 198x160 -> @210,270 195x160 ; @12,44 194x444 -> @12,44 194x444 | 6 | 2 | 0 |
| main-view | @210,105 201x787 -> @210,108 201x787 ; @12,44 194x444 -> @12,44 194x444 | 1 | 3 | 0 |
| main-view-panels | @416,554 174x136 -> @415,557 173x136 ; @210,105 201x787 -> @210,108 201x787 ; @12,44 194x444 -> @12,44 194x444 | 1 | 3 | 0 |
| main-widgets | @210,335 152x64 -> @210,335 152x64 ; @12,44 194x444 -> @12,44 194x444 | 0 | 3 | 0 |

| Menu / toolbar | popups live → ours | missing | diff | extra |
|---|---|---|---|---|
| actions-panel | @456,478 529x354 -> @456,478 529x354 | 19 | 2 | 12 |
| bottom-toolbar | @456,840 529x48 -> @456,840 529x48 | 8 | 0 | 0 |
| comment-tools-menu | @782,764 186x72 -> @782,764 186x72 | 0 | 1 | 1 |
| creation-tools-menu | @668,788 142x48 -> @668,788 142x48 | 0 | 1 | 1 |
| move-tools-menu | @497,764 151x72 -> @497,764 151x72 | 0 | 0 | 1 |
| region-tools-menu | @554,764 150x72 -> @554,764 150x72 | 0 | 1 | 1 |
| shape-tools-menu | @611,668 196x168 -> @611,668 196x168 | 0 | 1 | 1 |
| type-tools-menu | @725,788 142x48 -> @725,788 142x48 | 0 | 2 | 1 |
| vector-edit-more-menu | @869,736 189x48 -> @870,736 189x48 | 0 | 4 | 1 |
| vector-edit-toolbar | @455,792 529x40 -> @455,792 529x40 | 0 | 0 | 7 |

Left side and canvas: see the sections above (whole-window and left-panel dumps are compared by hand because live's captures were taken with a scrolled Layers list and a selected grid child).
